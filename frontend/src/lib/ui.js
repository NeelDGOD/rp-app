import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { onActivity, onSyncPending } from "./api";

export function useActivity() {
  const [state, setState] = useState({ pending: 0, retrying: 0, awake: false });
  useEffect(() => onActivity(setState), []);
  return state;
}

export function useSyncPending() {
  const [pending, setPending] = useState(false);
  useEffect(() => onSyncPending(setPending), []);
  return pending;
}

export function useOnline() {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => { window.removeEventListener("online", up); window.removeEventListener("offline", down); };
  }, []);
  return online;
}

// Whole seconds since the calling component mounted.
export function useElapsed() {
  const [secs, setSecs] = useState(0);
  useEffect(() => {
    const start = Date.now();
    const t = setInterval(() => setSecs(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(t);
  }, []);
  return secs;
}

// Runs one async action at a time and reports which one is running, so its button can show a
// spinner and every other action can ignore taps until it finishes.
export function useBusy() {
  const [busy, setBusy] = useState(null);
  const lock = useRef(false);
  const run = useCallback(async (key, fn) => {
    if (lock.current) return;
    lock.current = true; setBusy(key);
    try { await fn(); } finally { lock.current = false; setBusy(null); }
  }, []);
  return [busy, run];
}

const NETWORK_ERROR = /failed to fetch|networkerror|load failed/i;

// Browsers report an unreachable server with cryptic, browser-specific messages.
export function friendlyError(message) {
  return NETWORK_ERROR.test(message) ? "Can't reach the server. Check your connection; it may also still be waking up." : message;
}

export function scrollBehavior() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
}

// Keeps a transcript pinned to its newest line whenever `history` or `streamText` change.
// The first jump happens instantly (and again once web fonts settle) so opening a long chat
// lands at the bottom instead of visibly scrolling through the whole story.
export function useScrollToEnd(scrollerRef, history, streamText) {
  const settled = useRef(false);
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    if (!settled.current) {
      settled.current = true;
      el.scrollTop = el.scrollHeight;
      document.fonts?.ready.then(() => { if (scrollerRef.current) scrollerRef.current.scrollTop = scrollerRef.current.scrollHeight; });
      return;
    }
    el.scrollTo({ top: el.scrollHeight, behavior: scrollBehavior() });
  }, [scrollerRef, history, streamText]);
}

// Grows a textarea with its content; the CSS max-height caps it and lets it scroll beyond that.
export function useAutoGrow(ref, value) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [ref, value]);
}

// Destructive actions need a second tap within a few seconds.
export function useConfirmTap(timeoutMs = 3000) {
  const [armed, setArmed] = useState(null);

  useEffect(() => {
    if (armed === null) return;
    const t = setTimeout(() => setArmed(null), timeoutMs);
    return () => clearTimeout(t);
  }, [armed, timeoutMs]);

  function confirm(key, action) {
    if (armed === key) { setArmed(null); action(); }
    else setArmed(key);
  }

  return { armed, confirm };
}
