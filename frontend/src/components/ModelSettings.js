import React, { useState, useEffect } from "react";
import { Check, Eye, EyeOff, Plus, X } from "lucide-react";
import { PROVIDERS, currentProvider, pushSettingsSoon, onSyncFailed, onSettingsPulled } from "../lib/api";
import { useSyncPending } from "../lib/ui";
import { Spinner } from "./States";

const tokenKey = p => PROVIDERS[p].tokenKey;
const modelKey = p => PROVIDERS[p].modelKey;
const defaultModel = p => PROVIDERS[p].defaultModel;

function save(key, val) { localStorage.setItem(key, String(val)); pushSettingsSoon(); }

function readState() {
  const provider = currentProvider();
  let savedModels = [];
  try { savedModels = JSON.parse(localStorage.getItem("saved_models") || "[]"); } catch {}
  return {
    provider,
    token: localStorage.getItem(tokenKey(provider)) || "",
    model: localStorage.getItem(modelKey(provider)) || defaultModel(provider),
    savedModels,
  };
}

export default function ModelSettings() {
  const [provider, setProvider] = useState(() => readState().provider);
  const [token, setToken]       = useState(() => readState().token);
  const [showToken, setShowToken] = useState(false);
  const [model, setModel]       = useState(() => readState().model);
  const [savedModels, setSavedModels] = useState(() => readState().savedModels);
  const [newModelStr, setNewModelStr] = useState("");
  const [newModelName, setNewModelName] = useState("");
  const [syncFailed, setSyncFailed] = useState(false);
  const syncPending = useSyncPending();

  useEffect(() => onSyncFailed(setSyncFailed), []);

  useEffect(() => onSettingsPulled(() => {
    const fresh = readState();
    setProvider(fresh.provider);
    setToken(fresh.token);
    setModel(fresh.model);
    setSavedModels(fresh.savedModels);
  }), []);

  const cfg = PROVIDERS[provider];
  const providerModels = savedModels
    .map((m, index) => ({ ...m, index }))
    .filter(m => m.provider === provider);

  function selectProvider(p) {
    setProvider(p);
    save("llm_provider", p);
    setToken(localStorage.getItem(tokenKey(p)) || "");
    setModel(localStorage.getItem(modelKey(p)) || defaultModel(p));
  }

  function addSavedModel() {
    if (!newModelStr.trim()) return;
    const entry = { name: newModelName.trim() || newModelStr.trim(), model: newModelStr.trim(), provider };
    const updated = [...savedModels, entry];
    setSavedModels(updated);
    save("saved_models", JSON.stringify(updated));
    setNewModelStr(""); setNewModelName("");
  }

  function removeSavedModel(idx) {
    const updated = savedModels.filter((_, i) => i !== idx);
    setSavedModels(updated);
    save("saved_models", JSON.stringify(updated));
  }

  function selectSavedModel(m) {
    setModel(m.model);
    save(modelKey(provider), m.model);
  }

  return (
    <div className="model-settings">
      <div className="field">
        <div className="field-label" id="provider-label">Provider</div>
        <div className="segmented" role="radiogroup" aria-labelledby="provider-label">
          {Object.entries(PROVIDERS).map(([id, p]) => (
            <button
              key={id}
              role="radio"
              aria-checked={provider === id}
              className={`segment${provider === id ? " is-active" : ""}`}
              onClick={() => selectProvider(id)}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <div className="field">
        <label className="field-label" htmlFor="provider-token">{cfg.tokenLabel}</label>
        <div className="input-wrap">
          <input
            id="provider-token"
            key={tokenKey(provider)}
            name={tokenKey(provider)}
            autoComplete="new-password"
            data-lpignore="true"
            data-1p-ignore="true"
            className="input input-mono"
            type={showToken ? "text" : "password"}
            placeholder={cfg.tokenPlaceholder}
            value={token}
            onChange={e => { setToken(e.target.value); save(tokenKey(provider), e.target.value); }}
          />
          <button className="icon-btn" onClick={() => setShowToken(v => !v)} aria-label={showToken ? "Hide key" : "Show key"}>
            {showToken ? <EyeOff size={17} /> : <Eye size={17} />}
          </button>
        </div>
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

      <div className="field">
        <label className="field-label" htmlFor="provider-model">Model</label>
        <input
          id="provider-model"
          className="input input-mono"
          placeholder={cfg.modelExample}
          value={model}
          onChange={e => { setModel(e.target.value); save(modelKey(provider), e.target.value); }}
        />
        <div className="field-hint">
          {cfg.modelHint}, e.g. <span className="mono">{cfg.modelExample}</span>
        </div>
      </div>

      <div className="field">
        <div className="field-label">Saved models · {cfg.label}</div>
        {providerModels.length === 0 ? (
          <div className="saved-empty">No saved models yet.</div>
        ) : (
          <div className="saved-list">
            {providerModels.map(m => {
              const active = model === m.model;
              return (
                <div key={m.index} className={`saved-item${active ? " is-active" : ""}`}>
                  <button className="saved-item__main" onClick={() => selectSavedModel(m)} aria-pressed={active}>
                    <span className="saved-item__check">{active && <Check size={16} />}</span>
                    <span className="saved-item__text">
                      <span className="saved-item__name">{m.name}</span>
                      <span className="saved-item__model">{m.model}</span>
                    </span>
                  </button>
                  <button className="icon-btn" onClick={() => removeSavedModel(m.index)} aria-label={`Remove ${m.name}`}>
                    <X size={16} />
                  </button>
                </div>
              );
            })}
          </div>
        )}

        <div className="add-model">
          <input className="input" placeholder="Nickname (optional), e.g. V4 Pro"
            value={newModelName} onChange={e => setNewModelName(e.target.value)} />
          <div className="input-row">
            <input className="input input-mono" placeholder={cfg.modelExample}
              value={newModelStr} onChange={e => setNewModelStr(e.target.value)}
              onKeyDown={e => e.key === "Enter" && addSavedModel()} />
            <button className="btn btn-ghost" onClick={addSavedModel} disabled={!newModelStr.trim()}>
              <Plus size={16} /> Add
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
