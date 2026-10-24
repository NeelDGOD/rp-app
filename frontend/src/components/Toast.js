import React, { createContext, useContext, useState, useCallback } from "react";
import { ActivityNotice } from "./Activity";
import { friendlyError } from "../lib/ui";
import { logEvent } from "../lib/debugLog";

const ToastCtx = createContext(null);

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);

  const add = useCallback((msg, type = "info", duration = 4000) => {
    const id = Date.now() + Math.random();
    const text = friendlyError(msg);
    if (type === "error") logEvent("toast-error", text);
    setToasts(t => (t.some(x => x.msg === text) ? t : [...t, { id, msg: text, type }]));
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), duration);
  }, []);

  return (
    <ToastCtx.Provider value={add}>
      {children}
      <div className="toast-container" role="status" aria-live="polite">
        <ActivityNotice />
        {toasts.map(t => (
          <div key={t.id} className={`toast toast-${t.type}`}>{t.msg}</div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast() {
  return useContext(ToastCtx);
}
