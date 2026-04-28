const BASE = process.env.REACT_APP_API_URL || "http://localhost:8000";

function getHeaders() {
  const token = localStorage.getItem("hf_token") || "";
  const model = localStorage.getItem("hf_model") || "deepseek-ai/DeepSeek-V3";
  return {
    "Content-Type": "application/json",
    "x-hf-token": token,
    "x-model": model,
  };
}

async function request(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: getHeaders(),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || "Request failed");
  }
  return res.json();
}

export const api = {
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

  // Memory
  updateMemory: (branchId) => request("POST", `/branches/${branchId}/memory`),

  // Streaming send
  sendStream: (chatId, body, onDelta, onDone, onError) => {
    return fetch(`${BASE}/chats/${chatId}/send`, {
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
    return fetch(`${BASE}/chats/${chatId}/retry`, {
      method: "POST",
      headers: getHeaders(),
      body: JSON.stringify(body),
    }).then((res) => {
      if (!res.ok) throw new Error("Retry failed");
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
