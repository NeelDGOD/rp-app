import { ALL_PROVIDERS, PROVIDERS } from "./providers";
import { activeRequest, CHAIN_KEY } from "./chain";
import { ModelError, isBrowserSource, readSse, runSegments, splitSegments, streamCompletion, tryInOrder } from "./browserModels";

export { PROVIDERS };

const BASE = process.env.REACT_APP_API_URL || "http://localhost:8000";

const SYNCED_NAMES = [
  ...Object.values(ALL_PROVIDERS).flatMap(p => [p.tokenKey, p.modelKey]),
  "llm_provider", "saved_models", "use_fallbacks", CHAIN_KEY,
];

export function clearSession() {
  ["auth_token", "auth_email", ...SYNCED_NAMES].forEach(k => localStorage.removeItem(k));
}

function localSettings() {
  return Object.fromEntries(SYNCED_NAMES.map(k => [k, localStorage.getItem(k) || ""]).filter(([, v]) => v));
}

// The free-tier backend takes 30-60s to wake up, so poll often at first: the first
// attempt that lands after it is up succeeds within seconds instead of waiting out a long gap.
const SYNC_RETRY_DELAYS_MS = [2000, 2000, 3000, 3000, 5000, 5000, 10000, 10000, 15000];
const syncListeners = new Set();
const pulledListeners = new Set();
let pushTimer;
let pushPending = false;
let pullInFlight = null;

export function onSyncFailed(listener) {
  syncListeners.add(listener);
  return () => syncListeners.delete(listener);
}

// UI feedback only: true while a settings change is waiting to be uploaded.
const syncPendingListeners = new Set();
const emitSyncPending = () => syncPendingListeners.forEach(fn => fn(pushPending));

export function onSyncPending(listener) {
  syncPendingListeners.add(listener);
  listener(pushPending);
  return () => syncPendingListeners.delete(listener);
}

export function onSettingsPulled(listener) {
  pulledListeners.add(listener);
  return () => pulledListeners.delete(listener);
}

// The server copy is authoritative so a cleared setting stays cleared on every
// device; the one exception is an account with nothing stored yet, which adopts
// this device's settings instead of wiping them. Skipped while a local edit is
// still waiting to be uploaded, so a slow download can't overwrite what was just typed.
export async function pullSettings() {
  if (pushPending) return;
  const { settings } = await api.getSettings();
  if (pushPending) return;
  if (Object.keys(settings).length === 0) {
    if (Object.keys(localSettings()).length) await api.saveSettings(localSettings());
    return;
  }
  SYNCED_NAMES.forEach(k => (settings[k] ? localStorage.setItem(k, settings[k]) : localStorage.removeItem(k)));
  pulledListeners.forEach(fn => fn());
}

export function pullSettingsPersistently() {
  pullInFlight ??= (async () => {
    try {
      for (let attempt = 0; ; attempt++) {
        try { return await pullSettings(); } catch (err) {
          if (attempt >= SYNC_RETRY_DELAYS_MS.length) throw err;
          await new Promise(r => setTimeout(r, SYNC_RETRY_DELAYS_MS[attempt]));
        }
      }
    } finally { pullInFlight = null; }
  })();
  return pullInFlight;
}

async function pushSettings(attempt = 0) {
  try {
    await api.saveSettings(localSettings());
    pushPending = false;
    syncListeners.forEach(fn => fn(false));
  } catch {
    syncListeners.forEach(fn => fn(true));
    if (attempt < SYNC_RETRY_DELAYS_MS.length) {
      pushTimer = setTimeout(() => pushSettings(attempt + 1), SYNC_RETRY_DELAYS_MS[attempt]);
    } else {
      pushPending = false;
    }
  }
  emitSyncPending();
}

export function pushSettingsSoon() {
  clearTimeout(pushTimer);
  pushPending = true;
  pushTimer = setTimeout(pushSettings, 800);
  emitSyncPending();
}

function getHeaders(req = activeRequest(), extra = {}) {
  const { provider, model, token, fallbacks } = req;
  const useRag = localStorage.getItem("use_rag") === "true";
  const authToken = localStorage.getItem("auth_token") || "";
  // RAG embeddings always go through Gemini regardless of which provider is
  // selected for chat, so this is the raw Gemini key, not the
  // provider-conditional one above.
  const embedToken = localStorage.getItem("gemini_token") || "";
  return {
    "Content-Type": "application/json",
    "x-hf-token": token,
    "x-model": model,
    "x-provider": provider,
    "x-fallbacks": JSON.stringify(fallbacks),
    "x-use-rag": String(useRag),
    "x-embed-token": embedToken,
    "x-auth-token": authToken,
    ...extra,
  };
}

// Render's free tier randomly drops a fraction of connections outright (confirmed
// via direct curl testing against the host, unrelated to headers/CORS/browser —
// it's the hosting infra itself), on top of the usual cold-start-after-idle delay.
// Retries with growing delays absorb both: a quick retry catches a short-lived
// drop, a longer one gives a cold instance more time to finish waking up.
const RETRY_DELAYS_MS = [800, 2500];

// UI activity feedback only: how many requests are waiting for a response, and how many are retrying.
// `awake` flips once the server has answered anything, so the cold-start notice shows only until then.
const activity = { pending: 0, retrying: 0, awake: false };
const activityListeners = new Set();
const emitActivity = () => activityListeners.forEach(fn => fn({ ...activity }));

export function onActivity(listener) {
  activityListeners.add(listener);
  listener({ ...activity });
  return () => activityListeners.delete(listener);
}

async function fetchWithRetry(url, options) {
  activity.pending++; emitActivity();
  let retried = false;
  try {
    for (let i = 0; ; i++) {
      try {
        const res = await fetch(url, options);
        activity.awake = true;
        return res;
      } catch (err) {
        if (i >= RETRY_DELAYS_MS.length) throw err;
        if (!retried) { retried = true; activity.retrying++; emitActivity(); }
        await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[i]));
      }
    }
  } finally {
    activity.pending--;
    if (retried) activity.retrying--;
    emitActivity();
  }
}

async function request(method, path, body, headers = getHeaders()) {
  const res = await fetchWithRetry(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) clearSession();
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || "Request failed");
  }
  return res.json();
}

// ── Model calls made from the browser ─────────────────────────────────────────
// Sources with a `browserBase` (see providers.js) refuse requests from the server, so the browser calls them itself:
// the server prepares the exact messages, the browser streams the reply, and the server saves it. Everything else
// is unchanged: when no entry of the model order is a browser source, the plain server-side calls below are used.
const candidates = () => {
  const { provider, model, token, retries, fallbacks } = activeRequest();
  return [{ provider, model, token, retries }, ...fallbacks];
};
const usesBrowser = () => candidates().some(c => isBrowserSource(c.provider));
const asRequest = items => ({ provider: items[0].provider, model: items[0].model, token: items[0].token, fallbacks: items.slice(1) });
const stepHeaders = (items, step) => getHeaders(asRequest(items), { "x-phase": step });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function serverTurn(path, body, items, onDelta) {
  const res = await fetchWithRetry(`${BASE}${path}`, { method: "POST", headers: getHeaders(asRequest(items)), body: JSON.stringify(body) });
  if (!res.ok) throw new ModelError(`Request failed (${res.status})`);
  let done = null;
  let failure = null;
  await readSse(res.body, data => {
    try {
      const evt = JSON.parse(data);
      if (evt.type === "delta") onDelta(evt.content);
      else if (evt.type === "done") done = evt;
      else if (evt.type === "error") failure = new ModelError(evt.message);
    } catch { /* keepalive or partial line */ }
  });
  if (failure) throw failure;
  if (!done) throw new ModelError("The reply was cut off");
  return done;
}

// The reply is already on screen, so saving it is retried before giving up.
async function commitReply(path, body, items) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await request("POST", path, body, stepHeaders(items, "commit"));
    } catch (err) {
      if (attempt >= 2) throw new ModelError(`The reply arrived but could not be saved: ${err.message}`, { fatal: true });
      await sleep(1500 * (attempt + 1));
    }
  }
}

async function browserTurn(path, body, items, onDelta) {
  const { messages } = await request("POST", path, body, stepHeaders(items, "prepare"));
  return tryInOrder(items, async item => {
    const reply = await streamCompletion(item, messages, onDelta);
    return commitReply(path, { ...body, reply, served_by: `${item.provider} / ${item.model}` }, items);
  });
}

// Test chat: no prompt to prepare and nothing to save, so the browser just talks to the model.
const directTurn = (messages, items, onDelta) =>
  tryInOrder(items, async item => {
    await streamCompletion(item, messages, onDelta);
    return { type: "done" };
  });

// A memory update waits behind replies and is never dropped: it keeps asking again, for about ten minutes.
async function updateMemoryViaBrowser(branchId) {
  const path = `/branches/${branchId}/memory`;
  let failure = new ModelError("No model available");
  for (const segment of splitSegments(candidates())) {
    try {
      if (!segment.browser) return await request("POST", path, null, getHeaders(asRequest(segment.items)));
      const { messages } = await request("POST", path, null, stepHeaders(segment.items, "prepare"));
      return await tryInOrder(segment.items, async item => {
        const reply = await streamCompletion(item, messages, () => {}, { priority: 1, retries: 40 });
        return request("POST", path, { reply }, stepHeaders(segment.items, "commit")).catch(err => { throw new ModelError(err.message, { fatal: true }); });
      });
    } catch (err) {
      failure = err;
      if (err.fatal) throw err;
    }
  }
  throw failure;
}

const legacyStream = (path, failure, body, onDelta, onDone, onError) => fetchWithRetry(`${BASE}${path}`, {
  method: "POST",
  headers: getHeaders(),
  body: JSON.stringify(body),
}).then((res) => {
  if (!res.ok) throw new Error(failure);
  return readStream(res.body, onDelta, onDone, onError);
}).catch(onError);

const turnStream = (path, failure, body, onDelta, onDone, onError) => (usesBrowser()
  ? runSegments(splitSegments(candidates()), (items, delta) => browserTurn(path, body, items, delta),
    (items, delta) => serverTurn(path, body, items, delta), onDelta, onDone, onError)
  : legacyStream(path, failure, body, onDelta, onDone, onError));

export const api = {
  // Auth
  register: (email, password) => request("POST", "/auth/register", { email, password }),
  login: (email, password) => request("POST", "/auth/login", { email, password }),
  logout: () => request("POST", "/auth/logout"),
  getLogs: () => request("GET", "/logs"),
  clearLogs: () => request("DELETE", "/logs"),
  getSettings: () => request("GET", "/settings"),
  saveSettings: (settings) => request("PUT", "/settings", { settings }),
  me: () => request("GET", "/auth/me"),

  // Bots
  getBots: () => request("GET", "/bots"),
  createBot: (data) => request("POST", "/bots", data),
  updateBot: (id, data) => request("PUT", `/bots/${id}`, data),
  deleteBot: (id) => request("DELETE", `/bots/${id}`),

  // Chats
  getChats: () => request("GET", "/chats"),
  createChat: (data) => request("POST", "/chats", data),
  getChat: (id) => request("GET", `/chats/${id}`),
  setActiveBranch: (chatId, branchId) => request("PUT", `/chats/${chatId}/active-branch`, { branch_id: branchId }),
  renameChat: (id, name) => request("PUT", `/chats/${id}/rename`, { name }),
  deleteChat: (id) => request("DELETE", `/chats/${id}`),
  cloneChat: (id, name) => request("POST", `/chats/${id}/clone`, { name }),

  // Bookmarks
  getBookmarks: (chatId) => request("GET", `/chats/${chatId}/bookmarks`),
  createBookmark: (chatId, data) => request("POST", `/chats/${chatId}/bookmarks`, data),
  restoreBookmark: (bmId) => request("POST", `/bookmarks/${bmId}/restore`),
  deleteBookmark: (bmId) => request("DELETE", `/bookmarks/${bmId}`),

  // Undo
  undo: (branchId) => request("POST", `/branches/${branchId}/undo`),

  // Test chat — bare model, no system prompt
  testChatStream: (messages, onDelta, onDone, onError) => (usesBrowser()
    ? runSegments(splitSegments(candidates()), (items, delta) => directTurn(messages, items, delta),
      (items, delta) => serverTurn("/test-chat", { messages }, items, delta), onDelta, onDone, onError)
    : legacyStream("/test-chat", "Test chat failed", { messages }, onDelta, onDone, onError)),

  // Edit message in branch history (Luna's messages — in place)
  editMessage: (branchId, visibleIndex, newContent) =>
    request("POST", `/branches/${branchId}/edit-message`, { visible_index: visibleIndex, new_content: newContent }),

  // Edit user message — streaming, creates new branch
  editUserStream: (chatId, ...rest) => turnStream(`/chats/${chatId}/edit-user`, "Edit failed", ...rest),

  // Memory
  updateMemory: (branchId) => (usesBrowser() ? updateMemoryViaBrowser(branchId) : request("POST", `/branches/${branchId}/memory`)),

  // Streaming send
  sendStream: (chatId, ...rest) => turnStream(`/chats/${chatId}/send`, "Send failed", ...rest),

  // Streaming retry
  retryStream: (chatId, ...rest) => turnStream(`/chats/${chatId}/retry`, "Retry failed", ...rest),

  // AI Chat (plain assistant, no bot/persona)
  getAIChats: () => request("GET", "/ai-chats"),
  createAIChat: (data) => request("POST", "/ai-chats", data),
  getAIChat: (id) => request("GET", `/ai-chats/${id}`),
  renameAIChat: (id, name) => request("PUT", `/ai-chats/${id}/rename`, { name }),
  deleteAIChat: (id) => request("DELETE", `/ai-chats/${id}`),
  sendAIChatStream: (chatId, ...rest) => turnStream(`/ai-chats/${chatId}/send`, "Send failed", ...rest),
};

async function readStream(body, onDelta, onDone, onError) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      try {
        const evt = JSON.parse(line.slice(6));
        if (evt.type === "delta") onDelta(evt.content);
        else if (evt.type === "done") onDone(evt);
        else if (evt.type === "error") onError(new Error(evt.message));
      } catch {}
    }
  }
}
