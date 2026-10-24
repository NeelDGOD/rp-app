// Some model sources refuse requests that come from the app's server (their bot protection treats the server's
// datacenter address as a bot) but answer the user's own browser. Those sources are called from the browser; every
// other source is still called by the server. The model order is kept: consecutive entries that share a side form a
// segment, and segments are tried one after the other until one answers before any text has been shown.
import { PROVIDERS } from "./providers";

export const isBrowserSource = provider => !!PROVIDERS[provider]?.browserBase;

export class ModelError extends Error {
  constructor(message, { started = false, fatal = false, rateLimited = false } = {}) {
    super(message);
    this.started = started;
    this.fatal = fatal;
    this.rateLimited = rateLimited;
  }
}

// Tries a segment's models in order. The models of one source share its account limit, so once a source is rate
// limited (after waiting for it) its other models are not asked; the next segment gets its turn instead.
export async function tryInOrder(items, attempt) {
  let failure = new ModelError("No model available");
  for (const item of items) {
    try {
      return await attempt(item);
    } catch (err) {
      if (err.started) err.fatal = true;
      if (err.fatal || err.rateLimited) throw err;
      failure = err;
    }
  }
  throw failure;
}

// [{provider, model, token}] in order -> [{ browser, items }] runs of entries that are called the same way.
export function splitSegments(list) {
  const segments = [];
  for (const item of list) {
    const browser = isBrowserSource(item.provider);
    const last = segments[segments.length - 1];
    if (last && last.browser === browser) last.items.push(item);
    else segments.push({ browser, items: [item] });
  }
  return segments;
}

// Tries each segment in turn. A segment that fails before any text reached the screen hands over to the next one;
// once text has been shown (or the failure is marked fatal) the error is final, as splicing two replies would be wrong.
export async function runSegments(segments, runBrowser, runServer, onDelta, onDone, onError) {
  let started = false;
  const delta = text => { started = true; onDelta(text); };
  let failure = null;
  for (const segment of segments) {
    try {
      const evt = await (segment.browser ? runBrowser : runServer)(segment.items, delta);
      return onDone(evt);
    } catch (err) {
      failure = err;
      if (started || err.fatal) break;
    }
  }
  return onError(failure || new ModelError("No model available"));
}

// Server-sent events: calls onData with the payload of every `data:` line, however the text was chunked.
export async function readSse(body, onData, onChunk = () => {}) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const flush = line => {
    const text = line.trim();
    if (text.startsWith("data:")) onData(text.slice(5).trim());
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    onChunk();
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop();
    lines.forEach(flush);
  }
  flush(buffer);
}

function describeFailure(status, text) {
  if (/<html|<!doctype/i.test(text)) {
    const blocked = /just a moment|challenges\.cloudflare\.com/i.test(text);
    return `${blocked ? "the provider's bot check (Cloudflare) blocked this request" : "the provider returned a web page instead of an answer"} (HTTP ${status})`;
  }
  try {
    const message = JSON.parse(text)?.error?.message;
    if (message) return `${message} (HTTP ${status})`;
  } catch { /* not JSON */ }
  return `HTTP ${status}${text ? `: ${text.slice(0, 200)}` : ""}`;
}

// A source that allows one request at a time answers a second one with 429 "retry after 1s". That is an instruction to
// wait, so the call waits and tries again (the app open on two devices, say). Each further refusal doubles the wait, so
// a source that stays busy is not hammered; every refused attempt can count against its limit too.
function retryAfterMs(res, text, refusals) {
  const header = Number(res.headers.get("retry-after"));
  const seconds = header > 0 ? header : Number(/retry after (\d+(?:\.\d+)?)\s*s/i.exec(text)?.[1]) || 1;
  return Math.min(15000, Math.max(1000, seconds * 1000) * 2 ** Math.min(refusals, 4)) + Math.random() * 400;
}

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

// Sources that allow only one request at a time (`browserConcurrency` in providers.js) get a queue here, so the app never
// sends them two requests at once (a memory update and a message, say). Lower priority numbers go first; memory
// updates wait behind replies. Requests from another device are still answered with 429 and handled below.
const queues = new Map();

function startNext(queue, limit) {
  while (queue.running < limit && queue.waiting.length) {
    const best = queue.waiting.reduce((lowest, job, index) => (job.priority < queue.waiting[lowest].priority ? index : lowest), 0);
    queue.waiting.splice(best, 1)[0].start();
  }
}

function inQueue(provider, priority, task) {
  const limit = PROVIDERS[provider].browserConcurrency;
  if (!limit) return task();
  if (!queues.has(provider)) queues.set(provider, { running: 0, waiting: [] });
  const queue = queues.get(provider);
  return new Promise((resolve, reject) => {
    const start = () => {
      queue.running++;
      task().then(resolve, reject).finally(() => { queue.running--; startNext(queue, limit); });
    };
    queue.waiting.push({ priority, start });
    startNext(queue, limit);
  });
}

// One streamed chat completion straight from the browser. Resolves with the full reply text. The error says whether
// text had already been shown (`started`).
export function streamCompletion(candidate, messages, onDelta, options = {}) {
  return inQueue(candidate.provider, options.priority ?? 0, () => runCompletion(candidate, messages, onDelta, options));
}

// Reasoning models think for a long time, and some relays hold the whole response until the model has finished, so the
// first response may take minutes (firstByteMs); once it is arriving, silence of idleMs means it has stalled.
async function runCompletion({ provider, model, token }, messages, onDelta,
  { fetchImpl = fetch, idleMs = 60000, firstByteMs = 240000, maxWaitMs = 90000, sleep = pause } = {}) {
  const controller = new AbortController();
  let timer;
  const alive = (ms = idleMs) => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), ms);
  };
  alive(firstByteMs);
  let text = "";
  const got = delta => {
    if (!delta) return;
    text += delta;
    onDelta(delta);
  };
  try {
    let res;
    for (let waited = 0, refusals = 0; ; refusals++) {
      res = await fetchImpl(`${PROVIDERS[provider].browserBase}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token.trim()}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, messages, stream: true }),
        signal: controller.signal,
      });
      if (res.status !== 429) break;
      const failure = await res.text().catch(() => "");
      const wait = retryAfterMs(res, failure, refusals);
      if (waited + wait > maxWaitMs) throw new ModelError(describeFailure(429, failure), { rateLimited: true });
      await sleep(wait);
      waited += wait;
      alive(firstByteMs);
    }
    alive();
    if (!res.ok) throw new ModelError(describeFailure(res.status, await res.text().catch(() => "")));
    if ((res.headers.get("content-type") || "").includes("application/json")) {
      got((await res.json()).choices?.[0]?.message?.content);
    } else {
      await readSse(res.body, data => {
        if (data === "[DONE]") return;
        let evt;
        try { evt = JSON.parse(data); } catch { return; }
        if (evt.error) throw new ModelError(evt.error.message || "The model reported an error");
        got(evt.choices?.[0]?.delta?.content);
      }, alive);
    }
  } catch (err) {
    const message = err.name === "AbortError" ? "No answer in time" : err instanceof ModelError ? err.message : `Couldn't reach ${PROVIDERS[provider].label} from the browser (${err.message})`;
    throw new ModelError(message, { started: text.length > 0, rateLimited: err.rateLimited === true });
  } finally {
    clearTimeout(timer);
  }
  if (!text.trim()) throw new ModelError("The model returned an empty reply");
  return text;
}
