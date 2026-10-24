// The app's own log: what happened on this device (settings changes, every model call and retry, memory updates, sync
// results, errors). It is kept here, uploaded to the backend in small batches, and can be downloaded or read with a
// debug key. It never holds chat text, replies or keys: fields with such names are dropped, and anything that looks
// like a key is masked.
const STORE = "debug_log";
const MAX_EVENTS = 400;
const SENSITIVE = /token|key|secret|password|authorization|content|message|prompt|text/i;
const KEY_SHAPES = /\b(?:sk|gsk|ftai|hf)[-_][A-Za-z0-9_-]{10,}|\bAIza[A-Za-z0-9_-]{20,}|\bAQ\.[A-Za-z0-9_.-]{20,}|\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_.-]{10,}/g;

export const maskSecrets = text => String(text).replace(KEY_SHAPES, "[key]");

export function scrub(value, depth = 0) {
  if (Array.isArray(value)) return depth < 4 ? value.slice(0, 30).map(v => scrub(v, depth + 1)) : [];
  if (value && typeof value === "object") {
    if (depth >= 4) return {};
    return Object.fromEntries(Object.entries(value).filter(([k]) => !SENSITIVE.test(k)).map(([k, v]) => [k, scrub(v, depth + 1)]));
  }
  return typeof value === "string" ? maskSecrets(value).slice(0, 300) : value;
}

let memory = [];          // used where localStorage does not exist (tests)
let transport = null;
let timer = null;
let counter = 0;

const hasStorage = () => typeof localStorage !== "undefined";

function readAll() {
  if (!hasStorage()) return memory;
  try { return JSON.parse(localStorage.getItem(STORE)) || []; } catch { return []; }
}

function writeAll(list) {
  if (!hasStorage()) { memory = list; return; }
  try { localStorage.setItem(STORE, JSON.stringify(list)); } catch { /* storage full: the log is best effort */ }
}

export const getLocalLog = () => readAll().map(({ id, s, ...event }) => ({ ...event, uploaded: !!s }));

export function clearLocalLog() {
  writeAll([]);
}

export function logEvent(kind, message = "", data = {}) {
  const event = {
    id: `${Date.now().toString(36)}${(counter++).toString(36)}`,
    t: new Date().toISOString(),
    kind,
    message: maskSecrets(message).slice(0, 300),
    data: scrub(data),
  };
  writeAll([...readAll(), event].slice(-MAX_EVENTS));
  if (transport) schedule(/error|fail/.test(kind) ? 1500 : 20000);
  return event;
}

// Which device and build wrote the log, so entries from a phone and a PC can be told apart.
export function deviceLabel() {
  if (typeof navigator === "undefined") return "node";
  const platform = /Android|iPhone|iPad|Windows|Mac OS|Linux/.exec(navigator.userAgent)?.[0] || "unknown";
  const standalone = typeof window !== "undefined" && window.matchMedia?.("(display-mode: standalone)").matches;
  return `${platform} ${standalone ? "app" : "browser"}`;
}

export function buildId() {
  if (typeof document === "undefined") return "";
  return /main\.([0-9a-f]+)\./.exec([...document.scripts].map(s => s.src).find(src => /main\.[0-9a-f]+\./.test(src)) || "")?.[1] || "dev";
}

// `send(device, events)` uploads one batch and throws if it could not.
export function connectLog(send) {
  transport = send;
}

function schedule(delay) {
  if (timer) {
    if (delay >= 20000) return;
    clearTimeout(timer);
  }
  timer = setTimeout(() => { timer = null; flushLog(); }, delay);
  timer.unref?.();
}

let flushing = false;

export async function flushLog() {
  if (!transport || flushing) return;
  const batch = readAll().filter(e => !e.s).slice(0, 100);
  if (!batch.length) return;
  flushing = true;
  try {
    await transport(`${deviceLabel()} ${buildId()}`.trim(), batch.map(({ id, s, ...event }) => event));
    const sent = new Set(batch.map(e => e.id));
    writeAll(readAll().map(e => (sent.has(e.id) ? { ...e, s: true } : e)));
    if (readAll().some(e => !e.s)) schedule(1500);
  } catch { /* offline or backend asleep: the events stay and go with the next batch */ } finally {
    flushing = false;
  }
}

export const formatLog = events => events.map(e => `${e.t}  ${e.kind}  ${e.message}${Object.keys(e.data || {}).length ? `  ${JSON.stringify(e.data)}` : ""}`).join("\n");

// Errors nobody caught, going online/offline, and the start of every session.
export function installGlobalLogging() {
  if (typeof window === "undefined") return;
  logEvent("app-start", "app opened", { build: buildId(), device: deviceLabel(), online: navigator.onLine, path: location.pathname });
  window.addEventListener("error", e => logEvent("js-error", e.message || "script error", { where: `${String(e.filename).split("/").pop()}:${e.lineno}` }));
  window.addEventListener("unhandledrejection", e => logEvent("js-error", `unhandled: ${e.reason?.message || e.reason}`));
  window.addEventListener("online", () => logEvent("network", "back online"));
  window.addEventListener("offline", () => logEvent("network", "went offline"));
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flushLog(); });
}
