import React, { useState, useEffect } from "react";
import { Eye, EyeOff } from "lucide-react";

export default function SettingsPage() {
  const [token, setToken]     = useState("");
  const [showToken, setShowToken] = useState(false);
  const [autoMem, setAutoMem] = useState(true);
  const [fontSize, setFontSize] = useState(17);

  useEffect(() => {
    setToken(localStorage.getItem("hf_token") || "");
    setAutoMem(localStorage.getItem("auto_memory") !== "false");
    setFontSize(parseInt(localStorage.getItem("font_size") || "17"));
  }, []);

  function save(key, val) {
    localStorage.setItem(key, val);
  }

  return (
    <div className="page">
      <div className="page-header">
        <span className="page-title">Settings</span>
      </div>

      {/* HF Token */}
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
          Stored locally in your browser. Never sent anywhere except the API.
        </div>
      </div>

      <div style={{ height: 1, background: "var(--border)", margin: "20px 0" }} />

      {/* Auto memory */}
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

      {/* Font size */}
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

      <div style={{ height: 1, background: "var(--border)", margin: "4px 0" }} />

      {/* About */}
      <div style={{ padding: 16 }}>
        <div style={{ fontSize: 12, fontFamily: "var(--mono)", color: "var(--text3)", marginBottom: 8, letterSpacing: "0.5px", textTransform: "uppercase" }}>
          About
        </div>
        <div style={{ fontSize: 14, color: "var(--text3)", lineHeight: 1.7 }}>
          Model: <span style={{ color: "var(--text2)", fontFamily: "var(--mono)" }}>deepseek-ai/DeepSeek-V3</span><br />
          Backend streams responses via Hugging Face Inference API.<br />
          All chats stored in your private Turso database.
        </div>
      </div>
    </div>
  );
}
