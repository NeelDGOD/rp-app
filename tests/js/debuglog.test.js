// Tests for frontend/src/lib/debugLog.js: the app's own log. Run: tests/js/run.sh
import test from "node:test";
import assert from "node:assert/strict";
import { scrub, maskSecrets, logEvent, getLocalLog, clearLocalLog, connectLog, flushLog, formatLog } from "../../frontend/src/lib/debugLog.js";
import { streamCompletion } from "../../frontend/src/lib/browserModels.js";

const fresh = () => { connectLog(null); clearLocalLog(); };

test("fields that could hold a key or chat text are dropped, other fields kept", () => {
  assert.deepEqual(
    scrub({ provider: "budsai", model: "m", status: 429, token: "t", api_key: "k", Authorization: "Bearer x", content: "private reply", prompt: "p", text: "t", messages: [1], error: "boom" }),
    { provider: "budsai", model: "m", status: 429, error: "boom" });
});

test("scrub cuts long strings and lists, limits depth, and works on nested data", () => {
  const out = scrub({ long: "x".repeat(900), list: Array.from({ length: 100 }, (_, i) => i), deep: { a: { b: { c: { d: { e: 1 } } } } }, nested: { ok: 1, secret: "s" } });
  assert.equal(out.long.length, 300);
  assert.equal(out.list.length, 30);
  assert.deepEqual(out.nested, { ok: 1 });
  assert.deepEqual(out.deep.a.b.c, {}, "very deep data is dropped");
});

test("anything shaped like a key is masked, wherever it appears", () => {
  const keys = ["sk-TXQQIv0UdP6BZV6z7qbmjrd2qd27JMfXAMkWaekbVaIMXGRn", "sk_2e35baf8f1f9e18fd9178dfd79b09698edc7f43df58388c0ba65050ca43bb156",
    "ftai_5e95a972a98c5457f60559a7845deede878ca03e7675b692", "gsk_abcdefghijklmnop1234", "AIzaSyDabcdefghijklmnopqrstuvwxyz1234",
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ0IjoidCIsInYiOiIyIn0.sig_abcdefghij"];
  for (const key of keys) {
    const masked = maskSecrets(`HTTP 401: Incorrect API key provided: ${key}. Check it.`);
    assert.ok(!masked.includes(key.slice(6)), `still contains ${key.slice(0, 8)}…`);
    assert.match(masked, /\[key\]/);
  }
  assert.equal(maskSecrets("rate limit exceeded, retry after 1s"), "rate limit exceeded, retry after 1s", "ordinary text is untouched");
});

test("an event keeps its time, kind and a short message, with scrubbed data", () => {
  fresh();
  logEvent("model-call", "budsai/glm answered", { status: 200, token: "nope" });
  const [event] = getLocalLog();
  assert.equal(event.kind, "model-call");
  assert.equal(event.message, "budsai/glm answered");
  assert.deepEqual(event.data, { status: 200 });
  assert.ok(!Number.isNaN(Date.parse(event.t)));
  assert.equal(event.uploaded, false);
});

test("only the newest 400 events are kept", () => {
  fresh();
  for (let i = 0; i < 450; i++) logEvent("x", `e${i}`);
  const log = getLocalLog();
  assert.equal(log.length, 400);
  assert.equal(log[0].message, "e50");
  assert.equal(log.at(-1).message, "e449");
});

test("events are uploaded in batches without local bookkeeping fields, and only once", async () => {
  fresh();
  const sent = [];
  connectLog(async (device, events) => { sent.push({ device, events }); });
  for (let i = 0; i < 130; i++) logEvent("x", `e${i}`, { n: i });
  await flushLog();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].events.length, 100, "one batch is at most 100 events");
  assert.deepEqual(Object.keys(sent[0].events[0]).sort(), ["data", "kind", "message", "t"], "no ids or flags are sent");
  await flushLog();
  assert.equal(sent[1].events.length, 30);
  assert.equal(sent[1].events[0].message, "e100");
  await flushLog();
  assert.equal(sent.length, 2, "nothing left to send");
  assert.ok(getLocalLog().every(e => e.uploaded));
  connectLog(null);
});

test("a failed upload keeps the events for the next try", async () => {
  fresh();
  let fail = true;
  const sent = [];
  connectLog(async (device, events) => { if (fail) throw new Error("backend asleep"); sent.push(...events); });
  logEvent("x", "first");
  await flushLog();
  assert.equal(getLocalLog()[0].uploaded, false);
  fail = false;
  logEvent("x", "second");
  await flushLog();
  assert.deepEqual(sent.map(e => e.message), ["first", "second"]);
  connectLog(null);
});

test("formatLog writes one readable line per event", () => {
  const text = formatLog([{ t: "2026-10-24T12:00:00.000Z", kind: "model-call", message: "budsai/m answered", data: { status: 200 } }, { t: "2026-10-24T12:00:01.000Z", kind: "app-start", message: "app opened", data: {} }]);
  assert.equal(text, '2026-10-24T12:00:00.000Z  model-call  budsai/m answered  {"status":200}\n2026-10-24T12:00:01.000Z  app-start  app opened');
});

// ---- the model calls write to the log without ever leaking the key ------------------------------------------------
const TOKEN = "sk-TXQQIv0UdP6BZV6z7qbmjrd2qd27JMfXAMkWaekbVaIMXGRn";
const candidate = { provider: "budsai", model: "glm-5-3-flash", token: TOKEN, retries: 2 };
const stream = text => ({ ok: true, status: 200, headers: new Headers({ "content-type": "text/event-stream" }),
  body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`)); c.close(); } }) });
const refuse = (status, body) => ({ ok: false, status, headers: new Headers(), text: async () => body });

test("a provider error that echoes the key is logged with the key masked", async () => {
  fresh();
  const body = JSON.stringify({ error: { message: `Incorrect API key provided: ${TOKEN}` } });
  await assert.rejects(streamCompletion(candidate, [{ role: "user", content: "hi" }], () => {}, { fetchImpl: async () => refuse(401, body) }));
  const log = JSON.stringify(getLocalLog());
  assert.ok(!log.includes(TOKEN) && !log.includes(TOKEN.slice(8)), "the key is nowhere in the log");
  assert.match(log, /model-error/);
  assert.match(log, /glm-5-3-flash failed/);
});

test("every attempt is logged: refusals with the retry number and wait, then the answer", async () => {
  fresh();
  let calls = 0;
  const fetchImpl = async () => (++calls <= 2 ? refuse(429, JSON.stringify({ error: { message: "rate limit exceeded, retry after 1s" } })) : stream("Hello"));
  await streamCompletion(candidate, [{ role: "user", content: "a private message" }], () => {}, { fetchImpl, sleep: async () => {} });
  const log = getLocalLog();
  assert.deepEqual(log.map(e => e.kind), ["model-call", "model-call", "model-call"]);
  assert.match(log[0].message, /busy \(429\), retry 1 of 2/);
  assert.match(log[1].message, /retry 2 of 2/);
  assert.equal(log[2].message, "budsai/glm-5-3-flash answered");
  assert.equal(log[2].data.status, 200);
  assert.equal(log[2].data.retriesUsed, 2);
  assert.equal(log[2].data.chars, 5);
  assert.ok(!JSON.stringify(log).includes("a private message"), "chat text is never logged");
});

test("running out of retries is logged as an error with the number used", async () => {
  fresh();
  await assert.rejects(streamCompletion(candidate, [{ role: "user", content: "hi" }], () => {}, { fetchImpl: async () => refuse(429, "{}"), sleep: async () => {} }));
  const log = getLocalLog();
  assert.equal(log.at(-1).kind, "model-error");
  assert.match(log.at(-1).message, /no retries left \(2 used\)/);
});
