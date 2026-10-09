import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { AlertCircle } from "lucide-react";
import { api, pullSettings } from "../lib/api";

const MODES = [
  { id: "login", label: "Sign in" },
  { id: "register", label: "Create account" },
];

export default function LoginPage() {
  const nav = useNavigate();
  const [mode, setMode] = useState("login"); // "login" | "register"
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(e) {
    e.preventDefault();
    if (!email.trim() || !password || loading) return;
    setLoading(true); setError("");
    try {
      const res = mode === "login"
        ? await api.login(email.trim(), password)
        : await api.register(email.trim(), password);
      localStorage.setItem("auth_token", res.token);
      localStorage.setItem("auth_email", res.email);
      await pullSettings().catch(() => {});
      nav("/chats", { replace: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="login">
      <div className="login__inner">
        <div className="login__kicker">RP</div>
        <h1 className="login__mark">The <em>Reading</em> Room</h1>
        <p className="login__line">Your characters and their stories, kept for you.</p>
        <div className="login__rule" />

        <div className="tabs" role="tablist">
          {MODES.map(m => (
            <button
              key={m.id}
              role="tab"
              aria-selected={mode === m.id}
              className={`tab${mode === m.id ? " is-active" : ""}`}
              onClick={() => { setMode(m.id); setError(""); }}
            >
              {m.label}
            </button>
          ))}
        </div>

        <form onSubmit={submit} className="form">
          <div className="field">
            <label className="field-label" htmlFor="login-email">Email</label>
            <input id="login-email" className="input" type="email" autoComplete="email" value={email}
              onChange={e => setEmail(e.target.value)} autoFocus />
          </div>
          <div className="field">
            <label className="field-label" htmlFor="login-password">Password</label>
            <input id="login-password" className="input" type="password" value={password}
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              onChange={e => setPassword(e.target.value)} />
          </div>
          {error && (
            <div className="form-error" role="alert"><AlertCircle size={16} /><span>{error}</span></div>
          )}
          <button className="btn btn-primary btn-block" type="submit" disabled={loading || !email.trim() || !password}>
            {loading ? "One moment…" : mode === "login" ? "Sign in" : "Create account"}
          </button>
        </form>
      </div>
    </main>
  );
}
