// Some model sources refuse requests that come from the app's server (their bot protection treats the server's
// datacenter address as a bot) but answer the user's own browser. Those sources are called from the browser; every
// other source is still called by the server. The model order is kept: consecutive entries that share a side form a
// segment, and segments are tried one after the other until one answers before any text has been shown.
import { PROVIDERS } from "./providers";

export const isBrowserSource = provider => !!PROVIDERS[provider]?.browserBase;

export class ModelError extends Error {
  constructor(message, { started = false, fatal = false } = {}) {
    super(message);
    this.started = started;
    this.fatal = fatal;
  }
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

async function readableError(res) {
  const text = await res.text().catch(() => "");
  if (/<html|<!doctype/i.test(text)) {
    const blocked = /just a moment|challenges\.cloudflare\.com/i.test(text);
    return `${blocked ? "the provider's bot check (Cloudflare) blocked this request" : "the provider returned a web page instead of an answer"} (HTTP ${res.status})`;
  }
  try {
    const message = JSON.parse(text)?.error?.message;
    if (message) return `${message} (HTTP ${res.status})`;
  } catch { /* not JSON */ }
  return `HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`;
}

// One streamed chat completion straight from the browser. Resolves with the full reply text. The error says whether
// text had already been shown (`started`). Reasoning models spend a long time "thinking" before the first word, so the
// time limit is on silence: it gives up only when nothing at all (text, reasoning or keepalive) arrives for idleMs.
export async function streamCompletion({ provider, model, token }, messages, onDelta, { fetchImpl = fetch, idleMs = 60000 } = {}) {
  const controller = new AbortController();
  let timer;
  const alive = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), idleMs);
  };
  alive();
  let text = "";
  const got = delta => {
    if (!delta) return;
    text += delta;
    onDelta(delta);
  };
  try {
    const res = await fetchImpl(`${PROVIDERS[provider].browserBase}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token.trim()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages, stream: true }),
      signal: controller.signal,
    });
    if (!res.ok) throw new ModelError(await readableError(res));
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
    throw new ModelError(message, { started: text.length > 0 });
  } finally {
    clearTimeout(timer);
  }
  if (!text.trim()) throw new ModelError("The model returned an empty reply");
  return text;
}
