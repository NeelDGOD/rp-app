import React, { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { Eye, EyeOff, Send, Trash2, LogOut } from "lucide-react";
import { api } from "../lib/api";

export default function SettingsPage() {
  const nav = useNavigate();
  const [token, setToken]       = useState("");
  const [showToken, setShowToken] = useState(false);
  const [model, setModel]       = useState("deepseek-ai/DeepSeek-V3");
  const [autoMem, setAutoMem]   = useState(true);
  const [useRag, setUseRag]     = useState(false);
  const [fontSize, setFontSize] = useState(17);
  const [savedModels, setSavedModels] = useState([]);
  const [newModelStr, setNewModelStr] = useState("");
  const [newModelName, setNewModelName] = useState("");

  // Test chat
  const [testMessages, setTestMessages] = useState([]);
  const [testInput, setTestInput]       = useState("");
  const [testStreaming, setTestStreaming] = useState(false);
  const [testStreamText, setTestStreamText] = useState("");
  const testBottomRef = useRef(null);

  useEffect(() => {
    setToken(localStorage.getItem("hf_token") || "");
    setModel(localStorage.getItem("hf_model") || "deepseek-ai/DeepSeek-V3");
    setAutoMem(localStorage.getItem("auto_memory") !== "false");
    setUseRag(localStorage.getItem("use_rag") === "true");
    setFontSize(parseInt(localStorage.getItem("font_size") || "17"));
    try {
      const saved = JSON.parse(localStorage.getItem("saved_models") || "[]");
      setSavedModels(saved);
    } catch { setSavedModels([]); }
  }, []);

  useEffect(() => {
    testBottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [testMessages, testStreamText]);

  function save(key, val) { localStorage.setItem(key, String(val)); }

  function addSavedModel() {
    if (!newModelStr.trim()) return;
    const entry = { name: newModelName.trim() || newModelStr.trim(), model: newModelStr.trim() };
    const updated = [...savedModels, entry];
    setSavedModels(updated);
    localStorage.setItem("saved_models", JSON.stringify(updated));
    setNewModelStr(""); setNewModelName("");
  }

  function removeSavedModel(idx) {
    const updated = savedModels.filter((_, i) => i !== idx);
    setSavedModels(updated);
    localStorage.setItem("saved_models", JSON.stringify(updated));
  }

  function selectSavedModel(m) {
    setModel(m); save("hf_model", m);
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

      {/* ── HF TOKEN ── */}
      <div style={{ padding: "16px 16px 0" }}>
        <div style={{ fontSize: 12, fontFamily: "var(--mono)", color: "var(--text3)", marginBottom: 8, letterSpacing: "0.5px", textTransform: "uppercase" }}>
          Hugging Face Token
        </div>
        <div style={{ position: "relative" }}>
          <input
            className="input"
            type={showToken ? "text" : "password"}
            placeholder="hf_…"
            value={token}
            onChange={e => { setToken(e.target.value); save("hf_token", e.target.value); }}
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
          placeholder="deepseek-ai/DeepSeek-V3"
          value={model}
          onChange={e => { setModel(e.target.value); save("hf_model", e.target.value); }}
          style={{ fontFamily: "var(--mono)", fontSize: 14 }}
        />
        <div style={{ fontSize: 12, color: "var(--text3)", marginTop: 6 }}>
          Full model string e.g. <span style={{ color: "var(--text2)", fontFamily: "var(--mono)" }}>deepseek-ai/DeepSeek-V4-Pro:novita</span>
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
          <div className="settings-sub">Saves each memory update so old details can be recalled in very long chats</div>
        </div>
        <label className="toggle">
          <input type="checkbox" checked={useRag} onChange={e => {
            setUseRag(e.target.checked); save("use_rag", e.target.checked);
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
          {savedModels.length === 0 && (
            <div style={{ fontSize: 13, color: "var(--text3)" }}>No saved models yet.</div>
          )}
          {savedModels.map((m, i) => (
            <div key={i} style={{
              display: "flex", alignItems: "center", gap: 10,
              padding: "10px 12px", borderRadius: "var(--radius-sm)",
              background: model === m.model ? "var(--accent-bg2)" : "var(--bg3)",
              border: `1px solid ${model === m.model ? "var(--accent)" : "var(--border)"}`,
              cursor: "pointer",
            }} onClick={() => selectSavedModel(m.model)}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 15, color: model === m.model ? "var(--accent)" : "var(--text)" }}>
                  {m.name}
                </div>
                <div style={{ fontSize: 11, fontFamily: "var(--mono)", color: "var(--text3)", marginTop: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {m.model}
                </div>
              </div>
              <button className="btn-icon" style={{ color: "var(--text3)", flexShrink: 0 }}
                onClick={e => { e.stopPropagation(); removeSavedModel(i); }}>
                ✕
              </button>
            </div>
          ))}
        </div>

        {/* Add new model */}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <input className="input" placeholder="Nickname (optional) — e.g. V4 Pro"
            value={newModelName} onChange={e => setNewModelName(e.target.value)}
            style={{ fontSize: 15 }} />
          <div style={{ display: "flex", gap: 8 }}>
            <input className="input" placeholder="deepseek-ai/DeepSeek-V4-Pro:novita"
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
          localStorage.removeItem("auth_token");
          localStorage.removeItem("auth_email");
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

      <div style={{ height: 32 }} />
    </div>
  );
}
