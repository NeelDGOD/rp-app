import React, { useEffect, useState, useCallback } from "react";
import { Plus, ChevronLeft, Trash2, Check } from "lucide-react";
import { api } from "../lib/api";
import { useToast } from "../components/Toast";

export default function BotsPage() {
  const [bots, setBots]     = useState([]);
  const [editing, setEditing] = useState(null); // null | "new" | bot object
  const [name, setName]     = useState("");
  const [content, setContent] = useState("");
  const [saving, setSaving] = useState(false);
  const toast = useToast();

  const load = useCallback(async () => {
    try { setBots(await api.getBots()); }
    catch (e) { toast(e.message, "error"); }
  }, []);

  useEffect(() => { load(); }, [load]);

  function openNew() { setName(""); setContent(""); setEditing("new"); }
  function openEdit(b) { setName(b.name); setContent(b.content); setEditing(b); }

  async function save() {
    if (!name.trim()) return;
    setSaving(true);
    try {
      if (editing === "new") {
        await api.createBot({ name: name.trim(), content });
        toast("Bot created", "success");
      } else {
        await api.updateBot(editing.id, { name: name.trim(), content });
        toast("Saved", "success");
      }
      await load(); setEditing(null);
    } catch (e) { toast(e.message, "error"); }
    finally { setSaving(false); }
  }

  async function deleteBot(id) {
    try { await api.deleteBot(id); await load(); setEditing(null); toast("Bot deleted", "info"); }
    catch (e) { toast(e.message, "error"); }
  }

  // ── Editor view ──
  if (editing !== null) {
    return (
      <div className="page" style={{ display: "flex", flexDirection: "column" }}>
        <div className="page-header">
          <button className="btn-icon" onClick={() => setEditing(null)}><ChevronLeft size={22} /></button>
          <span className="page-title" style={{ fontSize: 18 }}>
            {editing === "new" ? "New Bot" : "Edit Bot"}
          </span>
          {editing !== "new" && (
            <button className="btn-icon" style={{ color: "var(--error)" }} onClick={() => deleteBot(editing.id)}>
              <Trash2 size={18} />
            </button>
          )}
          <button className="btn-icon" style={{ color: "var(--accent)" }} onClick={save} disabled={saving}>
            <Check size={22} />
          </button>
        </div>
        <div className="bot-editor" style={{ flex: 1 }}>
          <input className="input" placeholder="Bot name…" value={name}
            onChange={e => setName(e.target.value)} />
          <textarea className="input" placeholder="Paste bot prompt here…" value={content}
            onChange={e => setContent(e.target.value)}
            style={{ flex: 1, minHeight: "60vh", fontFamily: "var(--mono)", fontSize: 14, lineHeight: 1.6 }} />
        </div>
      </div>
    );
  }

  // ── List view ──
  return (
    <div className="page">
      <div className="page-header">
        <span className="page-title">Bots</span>
        <button className="btn-icon" onClick={openNew}><Plus size={22} /></button>
      </div>

      {bots.length === 0 && (
        <div style={{ padding: 48, textAlign: "center", color: "var(--text3)" }}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>✦</div>
          <div>No bots yet</div>
          <div style={{ fontSize: 14, marginTop: 6 }}>Tap + to create your first bot</div>
        </div>
      )}

      {bots.map(b => (
        <div key={b.id} className="chat-item" onClick={() => openEdit(b)}>
          <div className="chat-item-info">
            <div className="chat-item-name">{b.name}</div>
            <div className="chat-item-sub" style={{ fontFamily: "var(--mono)" }}>
              {b.content.slice(0, 60)}…
            </div>
          </div>
          <ChevronLeft size={16} style={{ color: "var(--text3)", transform: "rotate(180deg)" }} />
        </div>
      ))}
    </div>
  );
}
