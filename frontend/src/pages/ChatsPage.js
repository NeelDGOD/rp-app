import React, { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { Plus, MoreHorizontal, Copy, Trash2, PenLine, X, Check } from "lucide-react";
import { api } from "../lib/api";
import BottomSheet from "../components/BottomSheet";
import { useToast } from "../components/Toast";

export default function ChatsPage() {
  const [chats, setChats] = useState([]);
  const [bots, setBots]   = useState([]);
  const [loading, setLoading] = useState(true);
  const [sheet, setSheet] = useState(null); // "new" | {chat}
  const [newName, setNewName] = useState("");
  const [newBot, setNewBot]   = useState("");
  const [renameVal, setRenameVal] = useState("");
  const nav   = useNavigate();
  const toast = useToast();

  const load = useCallback(async () => {
    try {
      const [c, b] = await Promise.all([api.getChats(), api.getBots()]);
      setChats(c); setBots(b);
      if (b.length && !newBot) setNewBot(b[0].id);
    } catch (e) { toast(e.message, "error"); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function createChat() {
    if (!newName.trim() || !newBot) return;
    try {
      const c = await api.createChat({ name: newName.trim(), bot_id: newBot });
      setSheet(null); setNewName("");
      nav(`/chats/${c.id}`);
    } catch (e) { toast(e.message, "error"); }
  }

  async function deleteChat(id) {
    try { await api.deleteChat(id); setSheet(null); load(); }
    catch (e) { toast(e.message, "error"); }
  }

  async function renameChat(id) {
    if (!renameVal.trim()) return;
    try { await api.renameChat(id, renameVal.trim()); setSheet(null); load(); }
    catch (e) { toast(e.message, "error"); }
  }

  async function cloneChat(id, name) {
    try { await api.cloneChat(id, `${name} (copy)`); load(); setSheet(null); toast("Chat cloned", "success"); }
    catch (e) { toast(e.message, "error"); }
  }

  return (
    <div className="page">
      <div className="page-header">
        <span className="page-title">Chats</span>
        <button className="btn-icon" onClick={() => { setNewName(""); setSheet("new"); }}>
          <Plus size={22} />
        </button>
      </div>

      {loading && <div style={{ padding: 32, textAlign: "center", color: "var(--text3)" }}>Loading…</div>}

      {!loading && chats.length === 0 && (
        <div style={{ padding: 48, textAlign: "center", color: "var(--text3)" }}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>✦</div>
          <div>No chats yet</div>
          <div style={{ fontSize: 14, marginTop: 6 }}>Tap + to start a new one</div>
        </div>
      )}

      {chats.map(c => {
        const bot = bots.find(b => b.id === c.bot_id);
        return (
          <div key={c.id} className="chat-item" onClick={() => nav(`/chats/${c.id}`)}>
            <div className="chat-item-info">
              <div className="chat-item-name">{c.name}</div>
              <div className="chat-item-sub">{bot?.name || "Unknown bot"}</div>
            </div>
            <button className="btn-icon" onClick={e => { e.stopPropagation(); setRenameVal(c.name); setSheet(c); }}>
              <MoreHorizontal size={18} />
            </button>
          </div>
        );
      })}

      {/* New chat sheet */}
      {sheet === "new" && (
        <BottomSheet title="New Chat" onClose={() => setSheet(null)}>
          <input className="input" placeholder="Chat name…" value={newName}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => e.key === "Enter" && createChat()} autoFocus />
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ fontSize: 13, color: "var(--text3)", fontFamily: "var(--mono)" }}>Select bot</div>
            {bots.map(b => (
              <button key={b.id} onClick={() => setNewBot(b.id)} style={{
                padding: "11px 14px", borderRadius: "var(--radius-sm)", border: "1px solid",
                borderColor: newBot === b.id ? "var(--accent)" : "var(--border)",
                background: newBot === b.id ? "var(--accent-bg)" : "var(--bg3)",
                color: newBot === b.id ? "var(--accent)" : "var(--text)",
                textAlign: "left", cursor: "pointer", fontFamily: "var(--font)", fontSize: 16,
              }}>{b.name}</button>
            ))}
            {bots.length === 0 && <div style={{ color: "var(--text3)", fontSize: 14 }}>No bots yet — create one in the Bots tab first.</div>}
          </div>
          <button className="btn btn-primary" style={{ width: "100%" }} onClick={createChat}
            disabled={!newName.trim() || !newBot}>
            Create Chat
          </button>
        </BottomSheet>
      )}

      {/* Chat options sheet */}
      {sheet && sheet !== "new" && (
        <BottomSheet title={sheet.name} onClose={() => setSheet(null)}>
          <input className="input" placeholder="Rename…" value={renameVal}
            onChange={e => setRenameVal(e.target.value)} />
          <button className="btn btn-ghost" style={{ width: "100%", justifyContent: "flex-start", gap: 10 }}
            onClick={() => renameChat(sheet.id)}>
            <PenLine size={16} /> Rename
          </button>
          <button className="btn btn-ghost" style={{ width: "100%", justifyContent: "flex-start", gap: 10 }}
            onClick={() => cloneChat(sheet.id, sheet.name)}>
            <Copy size={16} /> Clone
          </button>
          <button className="btn btn-danger" style={{ width: "100%", justifyContent: "flex-start", gap: 10 }}
            onClick={() => deleteChat(sheet.id)}>
            <Trash2 size={16} /> Delete
          </button>
        </BottomSheet>
      )}
    </div>
  );
}
