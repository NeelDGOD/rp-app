import React, { useEffect, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { PROVIDERS, pushSettingsSoon, onSyncFailed, onSettingsPulled } from "../lib/api";
import { useSyncPending } from "../lib/ui";
import { Spinner } from "./States";

const readKeys = () => Object.fromEntries(Object.entries(PROVIDERS).map(([id, p]) => [id, localStorage.getItem(p.tokenKey) || ""]));

// One API key per source. Every entry in the model list that uses a source uses that source's key.
export default function ProviderKeys({ onChange }) {
  const [keys, setKeys] = useState(readKeys);
  const [shown, setShown] = useState(null);
  const [syncFailed, setSyncFailed] = useState(false);
  const syncPending = useSyncPending();

  useEffect(() => onSyncFailed(setSyncFailed), []);
  useEffect(() => onSettingsPulled(() => setKeys(readKeys())), []);

  function setKey(id, value) {
    setKeys(k => ({ ...k, [id]: value }));
    localStorage.setItem(PROVIDERS[id].tokenKey, value);
    pushSettingsSoon();
    onChange();
  }

  return (
    <div className="field">
      <div className="field-label">API keys</div>
      <div className="field-hint">One key per source; every model that uses a source shares it.</div>
      {Object.entries(PROVIDERS).map(([id, p]) => (
        <div className="field" key={id}>
          <label className="field-label" htmlFor={`key-${id}`}>{p.tokenLabel}</label>
          <div className="input-wrap">
            <input
              id={`key-${id}`}
              name={p.tokenKey}
              autoComplete="new-password"
              data-lpignore="true"
              data-1p-ignore="true"
              className="input input-mono"
              type={shown === id ? "text" : "password"}
              placeholder={p.tokenPlaceholder}
              value={keys[id]}
              onChange={e => setKey(id, e.target.value)}
            />
            <button type="button" className="icon-btn" onClick={() => setShown(shown === id ? null : id)} aria-label={shown === id ? "Hide key" : "Show key"}>
              {shown === id ? <EyeOff size={17} /> : <Eye size={17} />}
            </button>
          </div>
        </div>
      ))}
      <div className={`status-line${syncFailed ? " is-warn" : ""}`} role="status">
        {syncPending && !syncFailed ? <Spinner size={12} /> : <span className="status-line__dot" />}
        <span>
          {syncFailed
            ? "Saved on this device, but syncing to your account failed. Retrying…"
            : syncPending
              ? "Saved on this device. Syncing to your account…"
              : "Saved on this device and synced to your account (encrypted)."}
        </span>
      </div>
    </div>
  );
}
