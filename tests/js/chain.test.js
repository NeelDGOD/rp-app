// Tests for frontend/src/lib/chain.js (the model order list). Run: tests/js/run.sh
import test from "node:test";
import assert from "node:assert/strict";
import { readChain, writeChain, chainToRequest, activeRequest, addEntry, updateEntry, removeEntry, moveEntry, MAX_CHAIN, CHAIN_KEY } from "../../frontend/src/lib/chain.js";
import { PROVIDERS } from "../../frontend/src/lib/providers.js";

const store = (obj = {}) => ({ getItem: k => (k in obj ? obj[k] : null), setItem: (k, v) => { obj[k] = String(v); }, data: obj });
const keys = (...ps) => p => (ps.includes(p) ? `key-${p}` : "");
const ids = chain => chain.map(e => `${e.provider}:${e.model}`);

// the owner's own example: 1 puter 4.1 free, 2 puter 3.2 paid, 3 puter nvidia free, 4 gemini, 5 groq
const EXAMPLE = [
  { id: "a", provider: "puter", model: "deepseek/deepseek-v4.1-flash:free", name: "" },
  { id: "b", provider: "puter", model: "openrouter:deepseek/deepseek-v3.2", name: "" },
  { id: "c", provider: "puter", model: "nvidia/nemotron-3-ultra-550b-a55b:free", name: "" },
  { id: "d", provider: "gemini", model: "gemini-3.8-flash", name: "" },
  { id: "e", provider: "groq", model: "llama-3.3-70b-versatile", name: "" },
];

test("the owner's example: same source three times, then two others, in that exact order", () => {
  const req = chainToRequest(EXAMPLE, keys("puter", "gemini", "groq"), true);
  assert.deepEqual([req.provider, req.model, req.token], ["puter", "deepseek/deepseek-v4.1-flash:free", "key-puter"]);
  assert.deepEqual(req.fallbacks.map(f => `${f.provider}:${f.model}`), [
    "puter:openrouter:deepseek/deepseek-v3.2", "puter:nvidia/nemotron-3-ultra-550b-a55b:free", "gemini:gemini-3.8-flash", "groq:llama-3.3-70b-versatile"]);
  assert.ok(req.fallbacks.every(f => f.token === `key-${f.provider}`), "each entry uses its source's key");
});

test("fallback switched off: only the first usable entry is used", () => {
  const req = chainToRequest(EXAMPLE, keys("puter", "gemini", "groq"), false);
  assert.equal(req.model, "deepseek/deepseek-v4.1-flash:free");
  assert.deepEqual(req.fallbacks, []);
});

test("entries whose source has no key are skipped; the next usable one becomes the first", () => {
  const req = chainToRequest(EXAMPLE, keys("gemini", "groq"), true);
  assert.deepEqual([req.provider, req.model], ["gemini", "gemini-3.8-flash"]);
  assert.deepEqual(req.fallbacks.map(f => f.provider), ["groq"]);
  const off = chainToRequest(EXAMPLE, keys("gemini", "groq"), false);
  assert.deepEqual([off.provider, off.fallbacks.length], ["gemini", 0]);
});

test("entries without a model id are skipped", () => {
  const chain = [{ id: "x", provider: "puter", model: "  ", name: "" }, ...EXAMPLE.slice(3)];
  const req = chainToRequest(chain, keys("puter", "gemini", "groq"), true);
  assert.equal(req.provider, "gemini");
});

test("nothing usable: the first entry is still sent so the error names the missing key", () => {
  const req = chainToRequest(EXAMPLE, keys(), true);
  assert.deepEqual([req.provider, req.model, req.token, req.fallbacks], ["puter", "deepseek/deepseek-v4.1-flash:free", "", []]);
  const empty = chainToRequest([], keys(), true);
  assert.equal(empty.provider, "gemini");
});

test("the list is capped so request headers stay small", () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ id: `m${i}`, provider: "puter", model: `model-${i}`, name: "" }));
  const req = chainToRequest(many, keys("puter"), true);
  assert.equal(1 + req.fallbacks.length, MAX_CHAIN);
  assert.equal(req.model, "model-0");
});

test("unknown sources (e.g. the disabled Hugging Face) are ignored", () => {
  const chain = [{ id: "h", provider: "huggingface", model: "x", name: "" }, ...EXAMPLE.slice(3, 4)];
  const req = chainToRequest(chain, keys("gemini"), true);
  assert.equal(req.provider, "gemini");
});

// ---- migration from the settings the app used before ---------------------------------------------------
test("existing users: the selected source/model first, then saved models in saved order", () => {
  const s = store({
    llm_provider: "puter", puter_model: "deepseek/deepseek-v4.1-flash:free",
    saved_models: JSON.stringify([
      { name: "V3.2", model: "openrouter:deepseek/deepseek-v3.2", provider: "puter" },
      { name: "deepseek/deepseek-v4.1-flash:free", model: "deepseek/deepseek-v4.1-flash:free", provider: "puter" },   // duplicate of the first
      { name: "Gem", model: "gemini-3.8-flash", provider: "gemini" },
      { name: "old", model: "meta/llama", provider: "huggingface" },                                                    // disabled source
    ]),
  });
  const chain = readChain(s);
  assert.deepEqual(ids(chain), ["puter:deepseek/deepseek-v4.1-flash:free", "puter:openrouter:deepseek/deepseek-v3.2", "gemini:gemini-3.8-flash"]);
  assert.equal(chain[1].name, "V3.2");
  assert.equal(chain[2].name, "Gem");
  assert.equal(new Set(chain.map(e => e.id)).size, chain.length, "ids are unique");
});

test("fresh install: a single default entry", () => {
  const chain = readChain(store());
  assert.deepEqual(ids(chain), [`gemini:${PROVIDERS.gemini.defaultModel}`]);
});

test("a saved model list takes over; broken or empty storage falls back to the old settings", () => {
  const s = store({ llm_provider: "groq" });
  writeChain(EXAMPLE, s);
  assert.deepEqual(ids(readChain(s)), ids(EXAMPLE));
  s.data[CHAIN_KEY] = "{not json";
  assert.deepEqual(ids(readChain(s)), [`groq:${PROVIDERS.groq.defaultModel}`]);
  s.data[CHAIN_KEY] = "[]";
  assert.deepEqual(readChain(s), [], "an explicitly empty list stays empty (the user removed everything)");
});

test("saved entries with bad data are dropped on read", () => {
  const s = store({ [CHAIN_KEY]: JSON.stringify([{ provider: "puter", model: "ok" }, { provider: "nope", model: "x" }, { provider: "groq" }, null]) });
  assert.deepEqual(ids(readChain(s)), ["puter:ok"]);
});

// ---- editing ----------------------------------------------------------------------------------------------
test("add / update / remove", () => {
  let chain = addEntry([], { provider: "puter", model: "  m1  ", name: " Nick " });
  assert.deepEqual([chain[0].model, chain[0].name], ["m1", "Nick"]);
  chain = addEntry(chain, { provider: "puter", model: "m2" });
  assert.equal(new Set(chain.map(e => e.id)).size, 2, "the same source can be added again");
  chain = updateEntry(chain, chain[1].id, { model: "m2b" });
  assert.deepEqual(ids(chain), ["puter:m1", "puter:m2b"]);
  chain = removeEntry(chain, chain[0].id);
  assert.deepEqual(ids(chain), ["puter:m2b"]);
});

test("moveEntry: reorder by index, clamped, never mutating", () => {
  const original = EXAMPLE.map(e => e.id);
  const order = (c) => c.map(e => e.id).join("");
  assert.equal(order(moveEntry(EXAMPLE, 0, 4)), "bcdea");
  assert.equal(order(moveEntry(EXAMPLE, 4, 0)), "eabcd");
  assert.equal(order(moveEntry(EXAMPLE, 2, 3)), "abdce");
  assert.equal(order(moveEntry(EXAMPLE, 3, 1)), "adbce");
  assert.equal(moveEntry(EXAMPLE, 1, 1), EXAMPLE, "same position returns the same list");
  assert.equal(order(moveEntry(EXAMPLE, 0, 99)), "bcdea", "past the end clamps to the end");
  assert.equal(order(moveEntry(EXAMPLE, 4, -5)), "eabcd", "before the start clamps to the start");
  assert.equal(moveEntry(EXAMPLE, 9, 0), EXAMPLE, "an invalid source index changes nothing");
  assert.deepEqual(EXAMPLE.map(e => e.id), original);
});

test("moving entries changes which model is tried first", () => {
  const moved = moveEntry(EXAMPLE, 3, 0);                       // gemini to the top
  const req = chainToRequest(moved, keys("puter", "gemini", "groq"), true);
  assert.deepEqual([req.provider, req.fallbacks[0].model], ["gemini", "deepseek/deepseek-v4.1-flash:free"]);
});

test("activeRequest reads the list, the per-source keys and the fallback switch from storage", () => {
  const s = store({ puter_token: "P", gemini_token: "G", use_fallbacks: "true" });
  writeChain(EXAMPLE, s);
  const on = activeRequest(s);
  assert.deepEqual([on.provider, on.token], ["puter", "P"]);
  assert.deepEqual(on.fallbacks.map(f => f.provider), ["puter", "puter", "gemini"], "groq has no key, so it is skipped");
  s.data.use_fallbacks = "false";
  assert.equal(activeRequest(s).fallbacks.length, 0);
});

test("activeRequest keeps working for someone who never used the list (old settings only)", () => {
  const s = store({ llm_provider: "groq", groq_token: "GK", groq_model: "llama-3.3-70b-versatile" });
  const req = activeRequest(s);
  assert.deepEqual([req.provider, req.model, req.token, req.fallbacks.length], ["groq", "llama-3.3-70b-versatile", "GK", 0]);
});
