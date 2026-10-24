// Tests for frontend/src/lib/browserModels.js: sources the server cannot reach are called from the browser.
// Run: tests/js/run.sh
import test from "node:test";
import assert from "node:assert/strict";
import { ModelError, isBrowserSource, readSse, runSegments, splitSegments, streamCompletion, tryInOrder } from "../../frontend/src/lib/browserModels.js";

const item = (provider, model) => ({ provider, model, token: "key" });
const chunks = parts => new ReadableStream({
  start(controller) {
    const encoder = new TextEncoder();
    parts.forEach(p => controller.enqueue(encoder.encode(p)));
    controller.close();
  },
});
const sse = (...texts) => texts.map(t => `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`);
const streamResponse = parts => ({ ok: true, status: 200, headers: new Headers({ "content-type": "text/event-stream" }), body: chunks(parts) });
const failure = (status, text) => ({ ok: false, status, text: async () => text, headers: new Headers() });
const run = (model, fetchImpl, extra = {}) => {
  const seen = [];
  return streamCompletion(item("budsai", model), [{ role: "user", content: "hi" }], t => seen.push(t), { fetchImpl, ...extra }).then(text => ({ text, seen }));
};

test("only sources with a browser address are called from the browser", () => {
  assert.equal(isBrowserSource("budsai"), true);
  assert.equal(isBrowserSource("puter"), false);
  assert.equal(isBrowserSource("groq"), false, "a hidden or unknown source is never a browser source");
});

test("segments keep the model order and group consecutive entries that are called the same way", () => {
  const list = [item("puter", "p1"), item("budsai", "b1"), item("budsai", "b2"), item("gemini", "g1"), item("budsai", "b3")];
  const segments = splitSegments(list);
  assert.deepEqual(segments.map(s => [s.browser, s.items.map(i => i.model)]),
    [[false, ["p1"]], [true, ["b1", "b2"]], [false, ["g1"]], [true, ["b3"]]]);
  assert.deepEqual(splitSegments([]), []);
  assert.equal(splitSegments([item("puter", "x")])[0].browser, false);
});

test("readSse reassembles data lines however the text is chunked, and ignores comments", async () => {
  const seen = [];
  await readSse(chunks([": keepalive\n\nda", 'ta: {"a":1}\r\n\r\ndata: {"b"', ":2}\n\ndata: [DONE]"]), d => seen.push(d));
  assert.deepEqual(seen, ['{"a":1}', '{"b":2}', "[DONE]"]);
});

test("a streamed reply is assembled from the chunks and every piece is shown as it arrives", async () => {
  const { text, seen } = await run("m", async () => streamResponse([...sse("Hel", "lo"), "data: [DONE]\n\n"]));
  assert.equal(text, "Hello");
  assert.deepEqual(seen, ["Hel", "lo"]);
});

test("a chunk split in the middle of a line still parses", async () => {
  const [one, two] = sse("Hello");
  const { text } = await run("m", async () => streamResponse([one.slice(0, 20), one.slice(20), two ?? ""]));
  assert.equal(text, "Hello");
});

test("the request goes to the model's own address with the key, the model and stream on", async () => {
  let call;
  await run("glm-5-3-flash", async (url, options) => { call = { url, options }; return streamResponse(sse("ok")); });
  assert.match(call.url, /\/chat\/completions$/);
  assert.equal(call.options.headers.Authorization, "Bearer key");
  assert.deepEqual(JSON.parse(call.options.body), { model: "glm-5-3-flash", messages: [{ role: "user", content: "hi" }], stream: true });
});

test("a provider that ignores stream and answers with JSON still works", async () => {
  const res = { ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }), json: async () => ({ choices: [{ message: { content: "whole reply" } }] }) };
  const { text, seen } = await run("m", async () => res);
  assert.equal(text, "whole reply");
  assert.deepEqual(seen, ["whole reply"]);
});

test("errors are readable: a JSON error keeps its message and status", async () => {
  await assert.rejects(run("m", async () => failure(401, JSON.stringify({ error: { message: "Invalid token" } }))),
    e => e instanceof ModelError && /Invalid token/.test(e.message) && /401/.test(e.message) && e.started === false);
});

const limited = JSON.stringify({ error: { message: "rate limit exceeded, retry after 1s" } });

test("a 429 means wait and try again, waiting longer each time: the call succeeds once a slot is free", async () => {
  let calls = 0;
  const waits = [];
  const fetchImpl = async () => (++calls <= 3 ? failure(429, limited) : streamResponse([...sse("Finally"), "data: [DONE]\n\n"]));
  const { text } = await run("m", fetchImpl, { sleep: async ms => { waits.push(ms); } });
  assert.equal(text, "Finally");
  assert.equal(calls, 4);
  assert.equal(waits.length, 3);
  assert.ok(waits[0] >= 1000 && waits[0] <= 1400, `first wait follows "retry after 1s": ${waits}`);
  assert.ok(waits[1] >= 2000 && waits[1] <= 2400, `then doubles: ${waits}`);
  assert.ok(waits[2] >= 4000 && waits[2] <= 4400, `and again: ${waits}`);
});

test("the Retry-After header is honoured, and no single wait is longer than 15 seconds", async () => {
  const waits = [];
  let calls = 0;
  const fetchImpl = async () => {
    if (++calls === 1) return { ...failure(429, "{}"), headers: new Headers({ "retry-after": "3" }) };
    if (calls === 2) return { ...failure(429, "{}"), headers: new Headers({ "retry-after": "600" }) };
    return streamResponse(sse("ok"));
  };
  await run("m", fetchImpl, { sleep: async ms => { waits.push(ms); } });
  assert.ok(waits[0] >= 3000 && waits[0] <= 3400);
  assert.ok(waits[1] >= 15000 && waits[1] <= 15400, "a huge value is capped at 15 seconds");
});

test("an entry asks again as many times as its retries, then gives up with the source's own message", async () => {
  let calls = 0;
  await assert.rejects(run("m", async () => { calls++; return failure(429, limited); }, { sleep: async () => {}, retries: 2 }),
    e => e instanceof ModelError && /rate limit exceeded/.test(e.message) && /429/.test(e.message) && e.started === false);
  assert.equal(calls, 3, "the first try plus 2 retries");
});

test("the retry count can be chosen: none, or many", async () => {
  let calls = 0;
  await assert.rejects(run("m", async () => { calls++; return failure(429, limited); }, { sleep: async () => {}, retries: 0 }));
  assert.equal(calls, 1, "0 retries: one try, then the next model");
  calls = 0;
  const fetchImpl = async () => (++calls <= 6 ? failure(429, limited) : streamResponse(sse("ok")));
  const { text } = await run("m", fetchImpl, { sleep: async () => {}, retries: 8 });
  assert.equal(text, "ok");
  assert.equal(calls, 7);
});

test("an entry's own retries setting is used, three when it has none", async () => {
  const count = async candidate => {
    let calls = 0;
    await streamCompletion(candidate, [{ role: "user", content: "hi" }], () => {}, { fetchImpl: async () => { calls++; return failure(429, limited); }, sleep: async () => {} }).catch(() => {});
    return calls;
  };
  assert.equal(await count({ ...item("budsai", "m"), retries: 1 }), 2);
  assert.equal(await count({ ...item("budsai", "m"), retries: 5 }), 6);
  assert.equal(await count(item("budsai", "m")), 4, "the default is 3 retries");
});

test("after the retries are used up the next model of the same source still gets its own turn", async () => {
  const asked = [];
  const result = await tryInOrder([item("budsai", "a"), item("budsai", "b")], async it => {
    asked.push(it.model);
    if (it.model === "a") throw new ModelError("busy after 3 retries");
    return "answered";
  });
  assert.equal(result, "answered");
  assert.deepEqual(asked, ["a", "b"]);
});

test("an ordinary failure moves on to the next model of the same source", async () => {
  const asked = [];
  const result = await tryInOrder([item("budsai", "a"), item("budsai", "b")], async it => {
    asked.push(it.model);
    if (it.model === "a") throw new ModelError("broken");
    return "answered";
  });
  assert.equal(result, "answered");
  assert.deepEqual(asked, ["a", "b"]);
});

test("a failure after text was shown, or a fatal one, stops at once", async () => {
  const asked = [];
  await assert.rejects(tryInOrder([item("budsai", "a"), item("budsai", "b")], async it => { asked.push(it.model); throw new ModelError("died", { started: true }); }),
    e => e.fatal === true);
  assert.deepEqual(asked, ["a"]);
});

test("errors are readable: a Cloudflare bot-check page becomes one line", async () => {
  const page = "<!DOCTYPE html><html><head><title>Just a moment...</title><script src='https://challenges.cloudflare.com/x'></script></head></html>";
  await assert.rejects(run("m", async () => failure(403, page)), e => /bot check/.test(e.message) && /403/.test(e.message) && !/</.test(e.message));
  await assert.rejects(run("m", async () => failure(502, "<html><body>Bad gateway</body></html>")), e => /web page/.test(e.message) && /502/.test(e.message));
});

test("an empty reply is an error, so the next model gets a turn", async () => {
  await assert.rejects(run("m", async () => streamResponse(["data: [DONE]\n\n"])), e => /empty reply/.test(e.message));
});

test("an error event in the middle of a reply is reported as started, so it is final", async () => {
  const parts = [...sse("Half a sent"), `data: ${JSON.stringify({ error: { message: "upstream died" } })}\n\n`];
  await assert.rejects(run("m", async () => streamResponse(parts)), e => e.started === true && /upstream died/.test(e.message));
});

const hung = (url, options) => new Promise((_, reject) => options.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));

test("silence past the limit is an error that has not started", async () => {
  await assert.rejects(run("m", hung, { firstByteMs: 30 }), e => /No answer in time/.test(e.message) && e.started === false);
});

const slowStream = (events, gapMs) => new ReadableStream({
  async start(controller) {
    const encoder = new TextEncoder();
    for (const event of events) {
      await new Promise(r => setTimeout(r, gapMs));
      controller.enqueue(encoder.encode(event));
    }
    controller.close();
  },
});
const reasoning = text => `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: text } }] })}\n\n`;

test("a long thinking phase does not time out while data keeps arriving, and its text is never shown", async () => {
  const events = [...Array.from({ length: 8 }, (_, i) => reasoning(`thought ${i}`)), ...sse("Hi there"), "data: [DONE]\n\n"];
  const res = { ok: true, status: 200, headers: new Headers({ "content-type": "text/event-stream" }), body: slowStream(events, 15) };
  const { text, seen } = await run("m", async () => res, { idleMs: 60 });
  assert.equal(text, "Hi there", "only the answer, not the reasoning");
  assert.deepEqual(seen, ["Hi there"]);
});

test("a stream that goes quiet after some text is cut off and reported as started", async () => {
  const quietAfterText = async (url, options) => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(sse("Half")[0]));
        options.signal.addEventListener("abort", () => controller.error(Object.assign(new Error("aborted"), { name: "AbortError" })));
      },
    });
    return { ok: true, status: 200, headers: new Headers({ "content-type": "text/event-stream" }), body };
  };
  await assert.rejects(run("m", quietAfterText, { idleMs: 40 }), e => e.started === true && /No answer in time/.test(e.message));
});

test("a network failure says the browser could not reach the source", async () => {
  await assert.rejects(run("m", async () => { throw new TypeError("Failed to fetch"); }), e => /from the browser/.test(e.message) && /BudsAI/.test(e.message));
});

// ---- running the segments of a model order ---------------------------------------------------------------------
const recorder = () => {
  const log = { shown: [], done: null, error: null, ran: [] };
  return { log, onDelta: t => log.shown.push(t), onDone: e => { log.done = e; }, onError: e => { log.error = e; } };
};

test("the first segment that answers wins and later segments are never run", async () => {
  const { log, onDelta, onDone, onError } = recorder();
  const segments = splitSegments([item("budsai", "b1"), item("puter", "p1")]);
  await runSegments(segments, async (items, delta) => { log.ran.push("browser"); delta("hi"); return { type: "done" }; },
    async () => { log.ran.push("server"); return { type: "done" }; }, onDelta, onDone, onError);
  assert.deepEqual(log.ran, ["browser"]);
  assert.deepEqual(log.done, { type: "done" });
  assert.equal(log.error, null);
});

test("a segment that fails before showing text hands over to the next, in order", async () => {
  const { log, onDelta, onDone, onError } = recorder();
  const segments = splitSegments([item("budsai", "b1"), item("puter", "p1"), item("budsai", "b2")]);
  await runSegments(segments,
    async items => { log.ran.push(`browser:${items[0].model}`); throw new ModelError("blocked"); },
    async (items, delta) => { log.ran.push(`server:${items[0].model}`); delta("from puter"); return { type: "done", needs_memory: false }; },
    onDelta, onDone, onError);
  assert.deepEqual(log.ran, ["browser:b1", "server:p1"]);
  assert.deepEqual(log.shown, ["from puter"]);
  assert.equal(log.done.type, "done");
});

test("once text has been shown a failure is final and no other segment runs", async () => {
  const { log, onDelta, onDone, onError } = recorder();
  const segments = splitSegments([item("budsai", "b1"), item("puter", "p1")]);
  await runSegments(segments, async (items, delta) => { log.ran.push("browser"); delta("partial"); throw new ModelError("died"); },
    async () => { log.ran.push("server"); return { type: "done" }; }, onDelta, onDone, onError);
  assert.deepEqual(log.ran, ["browser"]);
  assert.match(log.error.message, /died/);
  assert.equal(log.done, null);
});

test("a fatal error, such as a reply that could not be saved, stops everything", async () => {
  const { log, onDelta, onDone, onError } = recorder();
  const segments = splitSegments([item("budsai", "b1"), item("puter", "p1")]);
  await runSegments(segments, async () => { log.ran.push("browser"); throw new ModelError("could not be saved", { fatal: true }); },
    async () => { log.ran.push("server"); return { type: "done" }; }, onDelta, onDone, onError);
  assert.deepEqual(log.ran, ["browser"]);
  assert.match(log.error.message, /could not be saved/);
});

test("when every segment fails, the last error is reported", async () => {
  const { log, onDelta, onDone, onError } = recorder();
  const segments = splitSegments([item("budsai", "b1"), item("puter", "p1")]);
  await runSegments(segments, async () => { throw new ModelError("browser failed"); }, async () => { throw new ModelError("server failed"); }, onDelta, onDone, onError);
  assert.match(log.error.message, /server failed/);
});

// ---- one request at a time for sources that allow only one -----------------------------------------------------
const heldResponse = gate => ({
  ok: true, status: 200, headers: new Headers({ "content-type": "text/event-stream" }),
  body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(sse("held")[0])); gate.then(() => controller.close()); } }),
});
const modelOf = options => JSON.parse(options.body).model;
const later = ms => new Promise(resolve => setTimeout(resolve, ms));

test("a source that allows one request at a time is never sent two at once", async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const started = [];
  const fetchImpl = async (url, options) => {
    started.push(modelOf(options));
    return started.length === 1 ? heldResponse(gate) : streamResponse(sse("second"));
  };
  const first = run("one", fetchImpl);
  const second = run("two", fetchImpl);
  await later(60);
  assert.deepEqual(started, ["one"], "the second request waits in the app's queue, it is not sent");
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.text, "held");
  assert.equal(b.text, "second");
  assert.deepEqual(started, ["one", "two"]);
});

test("a reply jumps ahead of a memory update that is still waiting", async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const started = [];
  const fetchImpl = async (url, options) => {
    started.push(modelOf(options));
    return started.length === 1 ? heldResponse(gate) : streamResponse(sse("x"));
  };
  const running = run("running", fetchImpl);
  const memory = run("memory", fetchImpl, { priority: 1 });
  const reply = run("reply", fetchImpl);
  await later(40);
  release();
  await Promise.all([running, memory, reply]);
  assert.deepEqual(started, ["running", "reply", "memory"]);
});

test("a failed call frees the queue for the next one", async () => {
  const outcomes = await Promise.allSettled([run("a", async () => failure(401, "{}")), run("b", async () => streamResponse(sse("fine")))]);
  assert.equal(outcomes[0].status, "rejected");
  assert.equal(outcomes[1].status, "fulfilled");
  assert.equal(outcomes[1].value.text, "fine");
});

test("a slow first response is waited for, and only silence after it starts counts as a stall", async () => {
  const slow = async () => { await later(120); return streamResponse([...sse("late"), "data: [DONE]\n\n"]); };
  const { text } = await run("m", slow, { firstByteMs: 1000, idleMs: 30 });
  assert.equal(text, "late");
});

test("a refused memory update waits outside the queue, so a reply that arrives meanwhile goes first, and the memory update is not dropped", async () => {
  const order = [];
  let memoryRefusals = 0;
  let releaseSleep;
  const sleepGate = new Promise(resolve => { releaseSleep = resolve; });
  const fetchImpl = async (url, options) => {
    const label = modelOf(options);
    order.push(label);
    if (label === "memory" && memoryRefusals++ === 0) return failure(429, limited);
    return streamResponse(sse(label));
  };
  const memory = run("memory", fetchImpl, { priority: 1, retries: 40, sleep: () => sleepGate });
  await later(20);
  const reply = run("reply", fetchImpl);
  const replyResult = await reply;
  assert.equal(replyResult.text, "reply", "the reply was not stuck behind the waiting memory update");
  assert.deepEqual(order, ["memory", "reply"], "the memory update is waiting, not holding the slot");
  releaseSleep();
  const memoryResult = await memory;
  assert.equal(memoryResult.text, "memory");
  assert.deepEqual(order, ["memory", "reply", "memory"], "and it asked again once it could");
});

test("a memory update keeps trying through many refusals instead of giving up", async () => {
  let calls = 0;
  const fetchImpl = async () => (++calls <= 12 ? failure(429, limited) : streamResponse(sse("done")));
  const { text } = await run("m", fetchImpl, { priority: 1, retries: 40, sleep: async () => {} });
  assert.equal(text, "done");
  assert.equal(calls, 13);
});
