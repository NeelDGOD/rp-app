import React, { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { Eye, EyeOff, Send, Trash2, LogOut, RefreshCw } from "lucide-react";
import { api, PROVIDERS, clearSession, pushSettingsSoon, currentProvider } from "../lib/api";

export default function SettingsPage() {
  const nav = useNavigate();
  const [provider, setProvider] = useState(currentProvider);
  const [token, setToken]       = useState("");
  const [showToken, setShowToken] = useState(false);
  const [model, setModel]       = useState(() => PROVIDERS[currentProvider()].defaultModel);
  const [autoMem, setAutoMem]   = useState(true);
  const [useRag, setUseRag]     = useState(false);
  const [useFallbacks, setUseFallbacks] = useState(false);
  const [errorLog, setErrorLog] = useState(null);
  const [fontSize, setFontSize] = useState(17);
  const [savedModels, setSavedModels] = useState([]);
  const [newModelStr, setNewModelStr] = useState("");
  const [newModelName, setNewModelName] = useState("");

  const tokenKey = p => PROVIDERS[p].tokenKey;
  const modelKey = p => PROVIDERS[p].modelKey;
  const defaultModel = p => PROVIDERS[p].defaultModel;
  const cfg = PROVIDERS[provider];
  const providerModels = savedModels
    .map((m, index) => ({ ...m, index }))
    .filter(m => m.provider === provider);

  // Test chat
  const [testMessages, setTestMessages] = useState([]);
  const [testInput, setTestInput]       = useState("");
  const [testStreaming, setTestStreaming] = useState(false);
  const [testStreamText, setTestStreamText] = useState("");
  const testBottomRef = useRef(null);

  useEffect(() => {
    const p = currentProvider();
    setProvider(p);
    setToken(localStorage.getItem(tokenKey(p)) || "");
    setModel(localStorage.getItem(modelKey(p)) || defaultModel(p));
    setAutoMem(localStorage.getItem("auto_memory") !== "false");
    setUseRag(localStorage.getItem("use_rag") === "true");
    setUseFallbacks(localStorage.getItem("use_fallbacks") === "true");
    setFontSize(parseInt(localStorage.getItem("font_size") || "17"));
    try {
      const saved = JSON.parse(localStorage.getItem("saved_models") || "[]");
      setSavedModels(saved);
    } catch { setSavedModels([]); }
  }, []);

  useEffect(() => {
    testBottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [testMessages, testStreamText]);

  async function loadErrorLog() {
    try { setErrorLog(await api.getLogs()); } catch { setErrorLog([]); }
  }

  async function clearErrorLog() {
    await api.clearLogs();
    setErrorLog([]);
  }

  function save(key, val) { localStorage.setItem(key, String(val)); pushSettingsSoon(); }

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

  async function sendTestMessage() {
    if (!testInput.trim() || testStreaming) return;
    const text = testInput.trim();
    setTestInput("");
    const newMessages = [...testMessages, { role: "user", content: text }];
    setTestMessages(newMessages);
    setTestStreaming(true);
    let accumulated = "";
    setTestStreamText("");

    api.testChatStream(
      newMessages,
      (delta) => {
        accumulated += delta;
        setTestStreamText(accumulated);
      },
      () => {
        setTestMessages(msgs => [...msgs, { role: "assistant", content: accumulated }]);
        setTestStreaming(false);
        setTestStreamText("");
      },
      (err) => {
        setTestStreaming(false);
        setTestStreamText("");
        setTestInput(text);
        setTestMessages(prev => prev.slice(0, -1));
        alert(`Error: ${err.message}`);
      }
    );
  }

  return (
    <div className="page">
      <div className="page-header">
        <span className="page-title">Settings</span>
      </div>

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

      {/* ── AUTO MEMORY ── */}
      <div className="settings-item">
        <div>
          <div className="settings-label">Auto Memory Update</div>
          <div className="settings-sub">Updates memory every 6 turns automatically</div>
        </div>
        <label className="toggle">
          <input type="checkbox" checked={autoMem} onChange={e => {
            setAutoMem(e.target.checked); save("auto_memory", e.target.checked);
          }} />
          <div className="toggle-track" />
          <div className="toggle-thumb" />
        </label>
      </div>

      {/* ── RAG MEMORY ── */}
      <div className="settings-item">
        <div>
          <div className="settings-label">Embed Memory for Retrieval</div>
          <div className="settings-sub">Saves each memory update so old details can be recalled in very long chats (uses your Gemini key)</div>
        </div>
        <label className="toggle">
          <input type="checkbox" checked={useRag} onChange={e => {
            setUseRag(e.target.checked); save("use_rag", e.target.checked);
          }} />
          <div className="toggle-track" />
          <div className="toggle-thumb" />
        </label>
      </div>

      {/* ── MODEL FALLBACK ── */}
      <div className="settings-item">
        <div>
          <div className="settings-label">Fall Back to Saved Models</div>
          <div className="settings-sub">If the current model fails before replying, try your other saved models in list order</div>
        </div>
        <label className="toggle">
          <input type="checkbox" checked={useFallbacks} onChange={e => {
            setUseFallbacks(e.target.checked); save("use_fallbacks", e.target.checked);
          }} />
          <div className="toggle-track" />
          <div className="toggle-thumb" />
        </label>
      </div>

      {/* ── FONT SIZE ── */}
      <div style={{ padding: "16px" }}>
        <div style={{ fontSize: 12, fontFamily: "var(--mono)", color: "var(--text3)", marginBottom: 12, letterSpacing: "0.5px", textTransform: "uppercase" }}>
          Chat Font Size — {fontSize}px
        </div>
        <input type="range" min={14} max={22} value={fontSize}
          onChange={e => { const v = parseInt(e.target.value); setFontSize(v); save("font_size", v); }}
          style={{ width: "100%", accentColor: "var(--accent)" }} />
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}>
          <span style={{ fontSize: 12, color: "var(--text3)" }}>Small</span>
          <span style={{ fontSize: 12, color: "var(--text3)" }}>Large</span>
        </div>
        <div style={{ marginTop: 16, padding: 14, background: "var(--bg3)", borderRadius: "var(--radius-sm)", fontSize, fontStyle: "italic", color: "var(--text2)" }}>
          She looked away, biting her lip as if weighing whether to say it.
        </div>
      </div>

      <div style={{ height: 1, background: "var(--border)", margin: "4px 0 0" }} />

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

      <div style={{ height: 1, background: "var(--border)", margin: "4px 0 0" }} />

      {/* ── ACCOUNT ── */}
      <div className="settings-item">
        <div>
          <div className="settings-label">Signed in</div>
          <div className="settings-sub">{localStorage.getItem("auth_email") || ""}</div>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={async () => {
          try { await api.logout(); } catch {}
          clearSession();
          nav("/login", { replace: true });
        }}>
          <LogOut size={14} /> Log out
        </button>
      </div>

      <div style={{ height: 1, background: "var(--border)", margin: "4px 0 0" }} />

      {/* ── TEST CHAT ── */}
      <div style={{ padding: "16px 16px 8px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
          <div>
            <div style={{ fontSize: 12, fontFamily: "var(--mono)", color: "var(--text3)", letterSpacing: "0.5px", textTransform: "uppercase" }}>
              Model Test Chat
            </div>
            <div style={{ fontSize: 12, color: "var(--text3)", marginTop: 3 }}>
              Raw model, no character context
            </div>
          </div>
          {testMessages.length > 0 && (
            <button className="btn-icon" style={{ color: "var(--text3)" }}
              onClick={() => { setTestMessages([]); setTestStreamText(""); }}>
              <Trash2 size={16} />
            </button>
          )}
        </div>

        {/* Messages */}
        <div style={{
          background: "var(--bg2)", borderRadius: "var(--radius-sm)",
          border: "1px solid var(--border)", minHeight: 120, maxHeight: 320,
          overflowY: "auto", padding: 12, display: "flex", flexDirection: "column", gap: 10,
        }}>
          {testMessages.length === 0 && !testStreaming && (
            <div style={{ color: "var(--text3)", fontSize: 14, textAlign: "center", margin: "auto" }}>
              Send a message to test the model
            </div>
          )}
          {testMessages.map((m, i) => (
            <div key={i} style={{
              display: "flex", justifyContent: m.role === "user" ? "flex-end" : "flex-start"
            }}>
              <div style={{
                maxWidth: "85%", padding: "8px 12px", fontSize: 15, lineHeight: 1.6,
                borderRadius: m.role === "user"
                  ? "var(--radius-lg) var(--radius-lg) 4px var(--radius-lg)"
                  : "var(--radius-lg) var(--radius-lg) var(--radius-lg) 4px",
                background: m.role === "user" ? "var(--bg4)" : "var(--bg3)",
                border: `1px solid ${m.role === "user" ? "var(--border)" : "var(--border2)"}`,
                color: m.role === "user" ? "var(--text2)" : "var(--text)",
                whiteSpace: "pre-wrap", wordBreak: "break-word",
              }}>
                {m.content}
              </div>
            </div>
          ))}
          {testStreaming && testStreamText && (
            <div style={{ display: "flex", justifyContent: "flex-start" }}>
              <div style={{
                maxWidth: "85%", padding: "8px 12px", fontSize: 15, lineHeight: 1.6,
                borderRadius: "var(--radius-lg) var(--radius-lg) var(--radius-lg) 4px",
                background: "var(--bg3)", border: "1px solid var(--border2)",
                color: "var(--text)", whiteSpace: "pre-wrap", wordBreak: "break-word",
              }} className="streaming-cursor">
                {testStreamText}
              </div>
            </div>
          )}
          {testStreaming && !testStreamText && (
            <div style={{ display: "flex", gap: 5, padding: "4px 0", alignItems: "center" }}>
              {[0,1,2].map(i => (
                <div key={i} style={{
                  width: 5, height: 5, borderRadius: "50%", background: "var(--accent)",
                  animation: "pulse 1.2s infinite", animationDelay: `${i * 0.2}s`
                }} />
              ))}
            </div>
          )}
          <div ref={testBottomRef} />
        </div>

        {/* Input */}
        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <input
            className="input"
            placeholder="Type to test model…"
            value={testInput}
            onChange={e => setTestInput(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") sendTestMessage(); }}
            style={{ flex: 1, fontSize: 15 }}
            disabled={testStreaming}
          />
          <button onClick={sendTestMessage} disabled={!testInput.trim() || testStreaming} style={{
            width: 40, height: 40, borderRadius: "50%", border: "none", flexShrink: 0,
            background: testInput.trim() && !testStreaming ? "var(--accent)" : "var(--bg4)",
            color: testInput.trim() && !testStreaming ? "#1a1208" : "var(--text3)",
            display: "flex", alignItems: "center", justifyContent: "center",
            cursor: testInput.trim() && !testStreaming ? "pointer" : "default",
            transition: "all 0.15s",
          }}>
            <Send size={16} />
          </button>
        </div>
      </div>

      <div style={{ height: 1, background: "var(--border)", margin: "8px 0 0" }} />

      {/* ── ERROR LOG ── */}
      <div style={{ padding: "16px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
          <div>
            <div style={{ fontSize: 12, fontFamily: "var(--mono)", color: "var(--text3)", letterSpacing: "0.5px", textTransform: "uppercase" }}>
              Error Log
            </div>
            <div style={{ fontSize: 12, color: "var(--text3)", marginTop: 3 }}>
              Failed model calls from the last 14 days
            </div>
          </div>
          <div style={{ display: "flex", gap: 4 }}>
            <button className="btn-icon" style={{ color: "var(--text3)" }} onClick={loadErrorLog}>
              <RefreshCw size={16} />
            </button>
            {errorLog?.length > 0 && (
              <button className="btn-icon" style={{ color: "var(--text3)" }} onClick={clearErrorLog}>
                <Trash2 size={16} />
              </button>
            )}
          </div>
        </div>

        {errorLog === null ? (
          <button className="btn btn-ghost btn-sm" onClick={loadErrorLog}>Show errors</button>
        ) : errorLog.length === 0 ? (
          <div style={{ fontSize: 13, color: "var(--text3)" }}>No errors logged.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: 360, overflowY: "auto" }}>
            {errorLog.map(e => (
              <div key={e.id} style={{
                padding: "10px 12px", borderRadius: "var(--radius-sm)",
                background: "var(--bg3)", border: "1px solid var(--border)",
              }}>
                <div style={{ fontSize: 12, fontFamily: "var(--mono)", color: "var(--text2)" }}>
                  {e.kind} · {e.provider} / {e.model}
                  {e.fell_back ? <span style={{ color: "var(--accent)", marginLeft: 8 }}>fell back</span> : null}
                </div>
                <div style={{ fontSize: 11, color: "var(--text3)", marginTop: 2 }}>
                  {new Date(e.created_at + "Z").toLocaleString()}
                </div>
                <div style={{ fontSize: 12, fontFamily: "var(--mono)", color: "var(--error)", marginTop: 6, wordBreak: "break-word" }}>
                  {e.message}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={{ height: 32 }} />
    </div>
  );
}
