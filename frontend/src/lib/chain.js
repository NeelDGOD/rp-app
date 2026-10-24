// The model order: one list of (source, model id) entries. Entry 1 is tried first; if it fails before
// producing any text the next one is tried, and so on. A source can appear many times with different
// model ids. Pure functions over a storage-like object so they can be tested without a browser.
import { ALL_PROVIDERS, PROVIDERS, DEFAULT_PROVIDER } from "./providers";

export const CHAIN_KEY = "model_chain";
// A request carries every key it may need in headers, so the list is capped to keep them small.
export const MAX_CHAIN = 20;

const isEntry = e => e && typeof e.model === "string" && PROVIDERS[e.provider];

let idCounter = 0;
export const newEntryId = () => `e${Date.now().toString(36)}${(idCounter++).toString(36)}`;

// An older version let one entry hold several model ids (`variants`). Those become ordinary entries in the same
// order, so a saved list keeps working; ids that were switched off inside the old tile are dropped.
const expandGroup = e => (Array.isArray(e.variants)
  ? e.variants
    .filter(v => v && typeof v.model === "string" && v.model.trim() && v.enabled !== false)
    .map((v, i) => ({ id: `${e.id || "group"}-${v.id || i}`, provider: e.provider, model: v.model.trim(), name: "" }))
  : [e]);

// What the app used before the list existed: the selected source and its model, then the saved
// models in saved order. Gives existing users the same behaviour as a starting list.
function legacyChain(storage) {
  const stored = storage.getItem("llm_provider");
  const provider = PROVIDERS[stored] ? stored : DEFAULT_PROVIDER;
  const cfg = PROVIDERS[provider];
  const primary = { id: "legacy-0", provider, model: storage.getItem(cfg.modelKey) || cfg.defaultModel, name: "" };
  let saved = [];
  try { saved = JSON.parse(storage.getItem("saved_models") || "[]"); } catch { saved = []; }
  const extra = saved
    .filter(m => isEntry(m) && m.model.trim() && !(m.provider === primary.provider && m.model === primary.model))
    .map((m, i) => ({ id: `legacy-${i + 1}`, provider: m.provider, model: m.model, name: m.name && m.name !== m.model ? m.name : "" }));
  return [primary, ...extra];
}

export function readChain(storage = localStorage) {
  try {
    const parsed = JSON.parse(storage.getItem(CHAIN_KEY));
    if (Array.isArray(parsed)) {
      return parsed
        .flatMap(e => (e && typeof e === "object" ? expandGroup(e) : []))
        .filter(isEntry)
        .map((e, i) => ({ id: e.id || `entry-${i}`, provider: e.provider, model: e.model, name: e.name || "" }));
    }
  } catch { /* fall through to the starting list */ }
  return legacyChain(storage);
}

// Entries of sources that are switched off are not shown, but they stay in storage so they come back with the source.
export function writeChain(chain, storage = localStorage) {
  let stored = [];
  try { stored = JSON.parse(storage.getItem(CHAIN_KEY)) || []; } catch { stored = []; }
  const hidden = Array.isArray(stored) ? stored.filter(e => e && ALL_PROVIDERS[e.provider] && !PROVIDERS[e.provider]) : [];
  storage.setItem(CHAIN_KEY, JSON.stringify([...chain, ...hidden]));
}

// Header values for one request: the first usable entry becomes the primary and the rest the fallbacks.
// An entry is usable when its source has a key and it has a model id. With fallback off only the first
// usable entry is used. If nothing is usable the first entry is still sent, so the error names the problem.
export function chainToRequest(chain, tokenOf, useFallbacks) {
  const usable = chain
    .filter(e => PROVIDERS[e.provider] && e.model.trim() && tokenOf(e.provider))
    .map(e => ({ provider: e.provider, model: e.model, token: tokenOf(e.provider) }));
  const picked = (useFallbacks ? usable : usable.slice(0, 1)).slice(0, MAX_CHAIN);
  if (!picked.length) {
    const e = chain[0] || { provider: DEFAULT_PROVIDER, model: PROVIDERS[DEFAULT_PROVIDER].defaultModel };
    return { provider: e.provider, model: e.model, token: tokenOf(e.provider) || "", fallbacks: [] };
  }
  const [first, ...rest] = picked;
  return { ...first, fallbacks: rest };
}

// The request as it would be sent right now, from what is in storage. Used for the request headers and
// the model chip, so they can never disagree.
export function activeRequest(storage = localStorage) {
  return chainToRequest(
    readChain(storage),
    provider => storage.getItem(PROVIDERS[provider].tokenKey) || "",
    storage.getItem("use_fallbacks") === "true",
  );
}

export function addEntry(chain, { provider, model, name = "" }) {
  return [...chain, { id: newEntryId(), provider, model: model.trim(), name: name.trim() }];
}

export function updateEntry(chain, id, patch) {
  return chain.map(e => (e.id === id ? { ...e, ...patch } : e));
}

export function removeEntry(chain, id) {
  return chain.filter(e => e.id !== id);
}

export function moveEntry(chain, from, to) {
  const target = Math.max(0, Math.min(chain.length - 1, to));
  if (from < 0 || from >= chain.length || from === target) return chain;
  const next = [...chain];
  const [item] = next.splice(from, 1);
  next.splice(target, 0, item);
  return next;
}
