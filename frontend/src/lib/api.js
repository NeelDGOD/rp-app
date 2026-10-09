const BASE = process.env.REACT_APP_API_URL || "http://localhost:8000";

export const PROVIDERS = {
  // Hugging Face is disabled: free accounts no longer get Inference Providers credits.
  // huggingface: {
  //   label: "Hugging Face",
  //   tokenKey: "hf_token", modelKey: "hf_model", defaultModel: "deepseek-ai/DeepSeek-V3",
  //   tokenLabel: "Hugging Face Token", tokenPlaceholder: "hf_…",
  //   modelHint: "Full model string", modelExample: "deepseek-ai/DeepSeek-V4-Pro:novita",
  // },
  openrouter: {
    label: "OpenRouter",
    tokenKey: "openrouter_token", modelKey: "openrouter_model", defaultModel: "",
    tokenLabel: "OpenRouter API Key", tokenPlaceholder: "sk-or-…",
    modelHint: "Full model slug", modelExample: "anthropic/claude-sonnet-5",
  },
  nvidia: {
    label: "NVIDIA",
    tokenKey: "nvidia_token", modelKey: "nvidia_model", defaultModel: "deepseek-ai/deepseek-v4.1-flash",
    tokenLabel: "NVIDIA API Key", tokenPlaceholder: "nvapi-…",
    modelHint: "Model id from build.nvidia.com", modelExample: "deepseek-ai/deepseek-v4.1-flash",
  },
  gemini: {
    label: "Gemini",
    tokenKey: "gemini_token", modelKey: "gemini_model", defaultModel: "gemini-3.8-flash",
    tokenLabel: "Google AI Studio API Key", tokenPlaceholder: "AIza…",
    modelHint: "Gemini model id", modelExample: "gemini-3.8-flash",
  },
  mistral: {
    label: "Mistral",
    tokenKey: "mistral_token", modelKey: "mistral_model", defaultModel: "mistral-large-latest",
    tokenLabel: "Mistral API Key", tokenPlaceholder: "Mistral API key",
    modelHint: "Mistral model id", modelExample: "mistral-large-latest",
  },
  groq: {
    label: "Groq",
    tokenKey: "groq_token", modelKey: "groq_model", defaultModel: "llama-3.3-70b-versatile",
    tokenLabel: "Groq API Key", tokenPlaceholder: "gsk_…",
    modelHint: "Groq model id", modelExample: "llama-3.3-70b-versatile",
  },
  navy: {
    label: "NavyAI",
    tokenKey: "navy_token", modelKey: "navy_model", defaultModel: "",
    tokenLabel: "NavyAI API Key", tokenPlaceholder: "sk-navy-…",
    modelHint: "Model id from NavyAI's model list", modelExample: "model-id-from-api.navy",
  },
  puter: {
    label: "Puter",
    tokenKey: "puter_token", modelKey: "puter_model", defaultModel: "deepseek/deepseek-v4.1-flash:free",
    tokenLabel: "Puter Auth Token", tokenPlaceholder: "Puter auth token",
    modelHint: "Model id; the ones ending in :free cost nothing", modelExample: "deepseek/deepseek-v4.1-flash:free",
  },
};

const DEFAULT_PROVIDER = "gemini";

export function currentProvider() {
  const stored = localStorage.getItem("llm_provider");
  return PROVIDERS[stored] ? stored : DEFAULT_PROVIDER;
}

const SYNCED_NAMES = [
  ...Object.values(PROVIDERS).flatMap(p => [p.tokenKey, p.modelKey]),
  "llm_provider", "saved_models", "use_fallbacks",
];

export function clearSession() {
  ["auth_token", "auth_email", ...SYNCED_NAMES].forEach(k => localStorage.removeItem(k));
}

function localSettings() {
  return Object.fromEntries(SYNCED_NAMES.map(k => [k, localStorage.getItem(k) || ""]).filter(([, v]) => v));
}

// The server copy is authoritative so a cleared setting stays cleared on every
// device; the one exception is an account with nothing stored yet, which adopts
// this device's settings instead of wiping them.
export async function pullSettings() {
  const { settings } = await api.getSettings();
  if (Object.keys(settings).length === 0) {
    if (Object.keys(localSettings()).length) await api.saveSettings(localSettings());
    return;
  }
  SYNCED_NAMES.forEach(k => (settings[k] ? localStorage.setItem(k, settings[k]) : localStorage.removeItem(k)));
}

let pushTimer;
export function pushSettingsSoon() {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => api.saveSettings(localSettings()).catch(() => {}), 800);
}

function fallbackModels(provider, model) {
  if (localStorage.getItem("use_fallbacks") !== "true") return [];
  const saved = JSON.parse(localStorage.getItem("saved_models") || "[]");
  return saved
    .filter(m => PROVIDERS[m.provider] && !(m.provider === provider && m.model === model))
    .map(m => ({ provider: m.provider, model: m.model, token: localStorage.getItem(PROVIDERS[m.provider].tokenKey) || "" }))
    .filter(m => m.token);
}

function getHeaders() {
  const provider = currentProvider();
  const cfg = PROVIDERS[provider];
  const token = localStorage.getItem(cfg.tokenKey) || "";
  const model = localStorage.getItem(cfg.modelKey) || cfg.defaultModel;
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
    "x-fallbacks": JSON.stringify(fallbackModels(provider, model)),
    "x-use-rag": String(useRag),
    "x-embed-token": embedToken,
    "x-auth-token": authToken,
  };
}

// Render's free tier randomly drops a fraction of connections outright (confirmed
// via direct curl testing against the host, unrelated to headers/CORS/browser —
// it's the hosting infra itself), on top of the usual cold-start-after-idle delay.
// Retries with growing delays absorb both: a quick retry catches a short-lived
// drop, a longer one gives a cold instance more time to finish waking up.
const RETRY_DELAYS_MS = [800, 2500];

async function fetchWithRetry(url, options) {
  for (let i = 0; ; i++) {
    try {
      return await fetch(url, options);
    } catch (err) {
      if (i >= RETRY_DELAYS_MS.length) throw err;
      await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[i]));
    }
  }
}

async function request(method, path, body) {
  const res = await fetchWithRetry(`${BASE}${path}`, {
    method,
    headers: getHeaders(),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) clearSession();
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || "Request failed");
  }
  return res.json();
}

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
  testChatStream: (messages, onDelta, onDone, onError) => {
    return fetchWithRetry(`${BASE}/test-chat`, {
      method: "POST",
      headers: getHeaders(),
      body: JSON.stringify({ messages }),
    }).then((res) => {
      if (!res.ok) throw new Error("Test chat failed");
      return readStream(res.body, onDelta, onDone, onError);
    }).catch(onError);
  },

  // Edit message in branch history (Luna's messages — in place)
  editMessage: (branchId, visibleIndex, newContent) =>
    request("POST", `/branches/${branchId}/edit-message`, { visible_index: visibleIndex, new_content: newContent }),

  // Edit user message — streaming, creates new branch
  editUserStream: (chatId, body, onDelta, onDone, onError) => {
    return fetchWithRetry(`${BASE}/chats/${chatId}/edit-user`, {
      method: "POST",
      headers: getHeaders(),
      body: JSON.stringify(body),
    }).then((res) => {
      if (!res.ok) throw new Error("Edit failed");
      return readStream(res.body, onDelta, onDone, onError);
    }).catch(onError);
  },

  // Memory
  updateMemory: (branchId) => request("POST", `/branches/${branchId}/memory`),

  // Streaming send
  sendStream: (chatId, body, onDelta, onDone, onError) => {
    return fetchWithRetry(`${BASE}/chats/${chatId}/send`, {
      method: "POST",
      headers: getHeaders(),
      body: JSON.stringify(body),
    }).then((res) => {
      if (!res.ok) throw new Error("Send failed");
      return readStream(res.body, onDelta, onDone, onError);
    }).catch(onError);
  },

  // Streaming retry
  retryStream: (chatId, body, onDelta, onDone, onError) => {
    return fetchWithRetry(`${BASE}/chats/${chatId}/retry`, {
      method: "POST",
      headers: getHeaders(),
      body: JSON.stringify(body),
    }).then((res) => {
      if (!res.ok) throw new Error("Retry failed");
      return readStream(res.body, onDelta, onDone, onError);
    }).catch(onError);
  },

  // AI Chat (plain assistant, no bot/persona)
  getAIChats: () => request("GET", "/ai-chats"),
  createAIChat: (data) => request("POST", "/ai-chats", data),
  getAIChat: (id) => request("GET", `/ai-chats/${id}`),
  renameAIChat: (id, name) => request("PUT", `/ai-chats/${id}/rename`, { name }),
  deleteAIChat: (id) => request("DELETE", `/ai-chats/${id}`),
  sendAIChatStream: (chatId, body, onDelta, onDone, onError) => {
    return fetchWithRetry(`${BASE}/ai-chats/${chatId}/send`, {
      method: "POST",
      headers: getHeaders(),
      body: JSON.stringify(body),
    }).then((res) => {
      if (!res.ok) throw new Error("Send failed");
      return readStream(res.body, onDelta, onDone, onError);
    }).catch(onError);
  },
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
