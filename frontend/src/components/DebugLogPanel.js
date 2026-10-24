import React, { useEffect, useState } from "react";
import { Copy, Download, KeyRound, RefreshCw, Trash2, UploadCloud } from "lucide-react";
import { api } from "../lib/api";
import { clearLocalLog, flushLog, formatLog, getLocalLog } from "../lib/debugLog";
import { useBusy } from "../lib/ui";
import { BusyIcon } from "./States";
import { useToast } from "./Toast";

const SHOWN = 40;

// The app's own log: look at it, download it, clear it, and hand someone a revocable key to read it.
export default function DebugLogPanel() {
  const toast = useToast();
  const [busy, runBusy] = useBusy();
  const [events, setEvents] = useState(() => getLocalLog());
  const [keyActive, setKeyActive] = useState(null);
  const [newKey, setNewKey] = useState("");

  const refresh = () => setEvents(getLocalLog());

  useEffect(() => {
    api.getDebugKey().then(s => setKeyActive(s.active)).catch(() => setKeyActive(null));
  }, []);

  const waiting = events.filter(e => !e.uploaded).length;

  async function sendNow() {
    await flushLog();
    refresh();
  }

  function download() {
    const url = URL.createObjectURL(new Blob([formatLog(getLocalLog())], { type: "text/plain" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `rp-debug-log-${new Date().toISOString().slice(0, 10)}.txt`;
    link.click();
    URL.revokeObjectURL(url);
  }

  async function clear() {
    clearLocalLog();
    try { await api.clearClientLog(); } catch { /* the device copy is gone either way */ }
    refresh();
  }

  async function createKey() {
    const { key } = await api.createDebugKey();
    setNewKey(key);
    setKeyActive(true);
  }

  async function revokeKey() {
    await api.revokeDebugKey();
    setNewKey("");
    setKeyActive(false);
  }

  async function copyKey() {
    try { await navigator.clipboard.writeText(newKey); toast("Key copied", "success", 2000); } catch { toast("Couldn't copy, select the key and copy it by hand", "error"); }
  }

  return (
    <div className="field">
      <div className="subhead">
        <div>
          <div className="subhead__title">Debug log</div>
          <div className="subhead__sub">Settings changes, model calls, retries, errors. Never keys or chat text.</div>
        </div>
        <div className="btn-row">
          <button className="icon-btn" aria-label="Refresh the debug log" onClick={refresh}><RefreshCw size={16} /></button>
          <button className="icon-btn" aria-label="Upload the debug log now" disabled={!!busy || waiting === 0} onClick={() => runBusy("send-log", sendNow)}>
            <BusyIcon busy={busy === "send-log"} Icon={UploadCloud} />
          </button>
          <button className="icon-btn" aria-label="Download the debug log as a file" disabled={events.length === 0} onClick={download}><Download size={16} /></button>
          <button className="icon-btn" aria-label="Clear the debug log" disabled={!!busy || events.length === 0} onClick={() => runBusy("clear-log", clear)}>
            <BusyIcon busy={busy === "clear-log"} Icon={Trash2} />
          </button>
        </div>
      </div>

      <div className="field-hint">
        {events.length} entries on this device{waiting > 0 ? `, ${waiting} not uploaded yet` : ", all uploaded to your account"}.
      </div>

      {events.length === 0 ? (
        <div className="saved-empty">Nothing logged yet.</div>
      ) : (
        <div className="debug-lines" role="log">
          {events.slice(-SHOWN).reverse().map((e, i) => (
            <div key={`${e.t}-${i}`} className={`debug-line${/error|fail/.test(e.kind) ? " is-error" : ""}`}>
              <span className="debug-line__time">{new Date(e.t).toLocaleTimeString()}</span>
              <span className="debug-line__kind">{e.kind}</span>
              <span className="debug-line__msg">{e.message}</span>
            </div>
          ))}
        </div>
      )}

      <div className="subhead" style={{ marginTop: 18 }}>
        <div>
          <div className="subhead__title">Debug key</div>
          <div className="subhead__sub">Lets whoever you give it to read this log and a summary of your settings, nothing else.</div>
        </div>
        <div className="btn-row">
          <button className="btn btn-ghost btn-sm" disabled={!!busy} onClick={() => runBusy("make-key", createKey)}>
            <BusyIcon busy={busy === "make-key"} Icon={KeyRound} size={15} /> {keyActive ? "New key" : "Create key"}
          </button>
          {keyActive && (
            <button className="btn btn-ghost btn-sm" disabled={!!busy} onClick={() => runBusy("revoke-key", revokeKey)}>Revoke</button>
          )}
        </div>
      </div>
      {newKey && (
        <div className="input-wrap">
          <input className="input input-mono" readOnly value={newKey} aria-label="Debug key" onFocus={e => e.target.select()} />
          <button type="button" className="icon-btn" onClick={copyKey} aria-label="Copy the debug key"><Copy size={17} /></button>
        </div>
      )}
      {keyActive && !newKey && <div className="field-hint">A key is active. Make a new one to see it again; the old one stops working.</div>}
    </div>
  );
}
