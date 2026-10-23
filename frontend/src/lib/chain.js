// The model order: one list of entries. Entry 1 is tried first; if it fails before producing any text the
// next one is tried, and so on. An entry is either one (source, model id) or a group: one tile that holds
// an ordered list of model ids for the same source (`variants`), each of which can be switched off.
// Pure functions over a storage-like object so they can be tested without a browser.
import { ALL_PROVIDERS, PROVIDERS, DEFAULT_PROVIDER } from "./providers";

export const CHAIN_KEY = "model_chain";
// A request carries every key it may need in headers, so the list is capped to keep them small.
export const MAX_CHAIN = 20;

const isEntry = e => e && typeof e.model === "string" && PROVIDERS[e.provider];

let idCounter = 0;
export const newEntryId = () => `e${Date.now().toString(36)}${(idCounter++).toString(36)}`;

const cleanVariants = list => (Array.isArray(list) ? list : [])
  .filter(v => v && typeof v.model === "string" && v.model.trim())
  .map((v, i) => ({ id: v.id || `v${i}`, model: v.model.trim(), enabled: v.enabled !== false }));

// The model ids an entry stands for, in the order they are tried.
export const entryModels = e => (e.variants
  ? e.variants.filter(v => v.enabled && v.model.trim()).map(v => v.model.trim())
  : [e.model.trim()].filter(Boolean));

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
      return parsed.filter(isEntry).map((e, i) => ({
        id: e.id || `entry-${i}`, provider: e.provider, model: e.model, name: e.name || "",
        ...(Array.isArray(e.variants) && { variants: cleanVariants(e.variants) }),
      }));
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
// An entry is usable when its source has a key and it has a model id; a group contributes each of its
// switched-on ids in order. With fallback off only the first usable model is used. If nothing is usable
// the first entry is still sent, so the error names the problem.
export function chainToRequest(chain, tokenOf, useFallbacks) {
  const usable = chain
    .filter(e => PROVIDERS[e.provider] && tokenOf(e.provider))
    .flatMap(e => entryModels(e).map(model => ({ provider: e.provider, model, token: tokenOf(e.provider) })));
  const picked = (useFallbacks ? usable : usable.slice(0, 1)).slice(0, MAX_CHAIN);
  if (!picked.length) {
    const e = chain[0] || { provider: DEFAULT_PROVIDER, model: PROVIDERS[DEFAULT_PROVIDER].defaultModel };
    return { provider: e.provider, model: entryModels(e)[0] || e.model, token: tokenOf(e.provider) || "", fallbacks: [] };
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

// A group: one tile holding several model ids of one source, tried in the order given.
export function addGroup(chain, { provider, name = "", models }) {
  const variants = models.map(m => ({ id: newEntryId(), model: m.model.trim(), enabled: m.enabled !== false }));
  return [...chain, { id: newEntryId(), provider, model: "", name: name.trim(), variants }];
}

const withVariants = (chain, id, fn) => chain.map(e => (e.id === id && e.variants ? { ...e, variants: fn(e.variants) } : e));

export const addVariant = (chain, id, model) => withVariants(chain, id, vs => [...vs, { id: newEntryId(), model: model.trim(), enabled: true }]);
export const updateVariant = (chain, id, variantId, patch) => withVariants(chain, id, vs => vs.map(v => (v.id === variantId ? { ...v, ...patch } : v)));
export const removeVariant = (chain, id, variantId) => withVariants(chain, id, vs => vs.filter(v => v.id !== variantId));
export const moveVariant = (chain, id, from, to) => withVariants(chain, id, vs => moveEntry(vs, from, to));

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
