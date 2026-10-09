import React, { useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { PROVIDERS, currentProvider, pushSettingsSoon } from "../lib/api";

const tokenKey = p => PROVIDERS[p].tokenKey;
const modelKey = p => PROVIDERS[p].modelKey;
const defaultModel = p => PROVIDERS[p].defaultModel;

function save(key, val) { localStorage.setItem(key, String(val)); pushSettingsSoon(); }

export default function ModelSettings() {
  const [provider, setProvider] = useState(currentProvider);
  const [token, setToken]       = useState(() => localStorage.getItem(tokenKey(currentProvider())) || "");
  const [showToken, setShowToken] = useState(false);
  const [model, setModel]       = useState(() => localStorage.getItem(modelKey(currentProvider())) || defaultModel(currentProvider()));
  const [savedModels, setSavedModels] = useState(() => {
    try { return JSON.parse(localStorage.getItem("saved_models") || "[]"); } catch { return []; }
  });
  const [newModelStr, setNewModelStr] = useState("");
  const [newModelName, setNewModelName] = useState("");

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
    <>
      {/* ── PROVIDER ── */}
      <div style={{ padding: "16px 16px 0" }}>
        <div style={{ fontSize: 12, fontFamily: "var(--mono)", color: "var(--text3)", marginBottom: 8, letterSpacing: "0.5px", textTransform: "uppercase" }}>
          Provider
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
          {Object.entries(PROVIDERS).map(([id, p]) => (
            <button
              key={id}
              className="btn btn-sm"
              onClick={() => selectProvider(id)}
              style={{
                background: provider === id ? "var(--accent-bg2)" : "var(--bg3)",
                border: `1px solid ${provider === id ? "var(--accent)" : "var(--border)"}`,
                color: provider === id ? "var(--accent)" : "var(--text2)",
              }}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <div style={{ height: 1, background: "var(--border)", margin: "20px 0" }} />

      {/* ── TOKEN ── */}
      <div style={{ padding: "16px 16px 0" }}>
        <div style={{ fontSize: 12, fontFamily: "var(--mono)", color: "var(--text3)", marginBottom: 8, letterSpacing: "0.5px", textTransform: "uppercase" }}>
          {cfg.tokenLabel}
        </div>
        <div style={{ position: "relative" }}>
          <input
            key={tokenKey(provider)}
            name={tokenKey(provider)}
            autoComplete="new-password"
            data-lpignore="true"
            data-1p-ignore="true"
            className="input"
            type={showToken ? "text" : "password"}
            placeholder={cfg.tokenPlaceholder}
            value={token}
            onChange={e => { setToken(e.target.value); save(tokenKey(provider), e.target.value); }}
            style={{ paddingRight: 44, fontFamily: "var(--mono)", fontSize: 14 }}
          />
          <button className="btn-icon" onClick={() => setShowToken(v => !v)} style={{
            position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)"
          }}>
            {showToken ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
        </div>
        <div style={{ fontSize: 12, color: "var(--text3)", marginTop: 6 }}>
          Stored locally in your browser only.
        </div>
      </div>

      <div style={{ height: 1, background: "var(--border)", margin: "20px 0" }} />

      {/* ── MODEL ── */}
      <div style={{ padding: "0 16px" }}>
        <div style={{ fontSize: 12, fontFamily: "var(--mono)", color: "var(--text3)", marginBottom: 8, letterSpacing: "0.5px", textTransform: "uppercase" }}>
          Model
        </div>
        <input
          className="input"
          placeholder={cfg.modelExample}
          value={model}
          onChange={e => { setModel(e.target.value); save(modelKey(provider), e.target.value); }}
          style={{ fontFamily: "var(--mono)", fontSize: 14 }}
        />
        <div style={{ fontSize: 12, color: "var(--text3)", marginTop: 6 }}>
          {cfg.modelHint} e.g. <span style={{ color: "var(--text2)", fontFamily: "var(--mono)" }}>{cfg.modelExample}</span>
        </div>
      </div>

      <div style={{ height: 1, background: "var(--border)", margin: "20px 0" }} />

      {/* ── SAVED MODELS ── */}
      <div style={{ padding: "16px" }}>
        <div style={{ fontSize: 12, fontFamily: "var(--mono)", color: "var(--text3)", marginBottom: 12, letterSpacing: "0.5px", textTransform: "uppercase" }}>
          Saved Models
        </div>

        {/* Saved model pills */}
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 14 }}>
          {providerModels.length === 0 && (
            <div style={{ fontSize: 13, color: "var(--text3)" }}>No saved models yet.</div>
          )}
          {providerModels.map(m => {
            const active = model === m.model;
            return (
            <div key={m.index} style={{
              display: "flex", alignItems: "center", gap: 10,
              padding: "10px 12px", borderRadius: "var(--radius-sm)",
              background: active ? "var(--accent-bg2)" : "var(--bg3)",
              border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
              cursor: "pointer",
            }} onClick={() => selectSavedModel(m)}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 15, color: active ? "var(--accent)" : "var(--text)" }}>
                  {m.name}
                </div>
                <div style={{ fontSize: 11, fontFamily: "var(--mono)", color: "var(--text3)", marginTop: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {m.model}
                </div>
              </div>
              <button className="btn-icon" style={{ color: "var(--text3)", flexShrink: 0 }}
                onClick={e => { e.stopPropagation(); removeSavedModel(m.index); }}>
                ✕
              </button>
            </div>
            );
          })}
        </div>

        {/* Add new model */}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <input className="input" placeholder="Nickname (optional) — e.g. V4 Pro"
            value={newModelName} onChange={e => setNewModelName(e.target.value)}
            style={{ fontSize: 15 }} />
          <div style={{ display: "flex", gap: 8 }}>
            <input className="input" placeholder={cfg.modelExample}
              value={newModelStr} onChange={e => setNewModelStr(e.target.value)}
              onKeyDown={e => e.key === "Enter" && addSavedModel()}
              style={{ flex: 1, fontFamily: "var(--mono)", fontSize: 13 }} />
            <button className="btn btn-primary btn-sm" onClick={addSavedModel}
              disabled={!newModelStr.trim()}>
              Add
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
