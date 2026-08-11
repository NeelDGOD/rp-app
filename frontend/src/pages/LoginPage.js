import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";

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
      nav("/chats", { replace: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", justifyContent: "center", height: "100dvh", padding: 24 }}>
      <div style={{ fontSize: 28, fontWeight: 500, marginBottom: 6, textAlign: "center" }}>
        {mode === "login" ? "Sign in" : "Create account"}
      </div>
      <div style={{ fontSize: 14, color: "var(--text3)", marginBottom: 28, textAlign: "center" }}>
        Your bots and chats are tied to your account
      </div>
      <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <input className="input" type="email" placeholder="Email" value={email}
          onChange={e => setEmail(e.target.value)} autoFocus />
        <input className="input" type="password" placeholder="Password" value={password}
          onChange={e => setPassword(e.target.value)} />
        {error && <div style={{ color: "var(--error)", fontSize: 13 }}>{error}</div>}
        <button className="btn btn-primary" type="submit" disabled={loading} style={{ marginTop: 8 }}>
          {loading ? "…" : mode === "login" ? "Sign in" : "Create account"}
        </button>
      </form>
      <button
        className="btn btn-ghost btn-sm"
        style={{ marginTop: 16, alignSelf: "center", border: "none" }}
        onClick={() => { setMode(m => m === "login" ? "register" : "login"); setError(""); }}
      >
        {mode === "login" ? "New here? Create an account" : "Already have an account? Sign in"}
      </button>
    </div>
  );
}
