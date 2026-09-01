import React, { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { Plus, MoreHorizontal, Trash2, PenLine } from "lucide-react";
import { api } from "../lib/api";
import { useSlowLoad } from "../lib/useSlowLoad";
import BottomSheet from "../components/BottomSheet";
import { useToast } from "../components/Toast";

export default function AIChatsPage() {
  const [chats, setChats] = useState([]);
  const [loading, setLoading] = useState(true);
  const [sheet, setSheet] = useState(null); // {chat} for options
  const [renameVal, setRenameVal] = useState("");
  const nav   = useNavigate();
  const toast = useToast();
  const slowLoad = useSlowLoad(loading);

  const load = useCallback(async () => {
    try {
      const c = await api.getAIChats();
      setChats(c);
    } catch (e) { toast(e.message, "error"); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function createChat() {
    try {
      const c = await api.createAIChat({ name: "New Chat" });
      nav(`/ai-chats/${c.id}`);
    } catch (e) { toast(e.message, "error"); }
  }

  async function deleteChat(id) {
    try { await api.deleteAIChat(id); setSheet(null); load(); }
    catch (e) { toast(e.message, "error"); }
  }

  async function renameChat(id) {
    if (!renameVal.trim()) return;
    try { await api.renameAIChat(id, renameVal.trim()); setSheet(null); load(); }
    catch (e) { toast(e.message, "error"); }
  }

  return (
    <div className="page">
      <div className="page-header">
        <span className="page-title">AI Chat</span>
        <button className="btn-icon" onClick={createChat}>
          <Plus size={22} />
        </button>
      </div>

      {loading && (
        <div style={{ padding: 32, textAlign: "center", color: "var(--text3)" }}>
          Loading…
          {slowLoad && (
            <div style={{ marginTop: 8, fontSize: 13 }}>
              ⚡ Waking up the server — this can take up to a minute on the free tier.
            </div>
          )}
        </div>
      )}

      {!loading && chats.length === 0 && (
        <div style={{ padding: 48, textAlign: "center", color: "var(--text3)" }}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>✦</div>
          <div>No AI chats yet</div>
          <div style={{ fontSize: 14, marginTop: 6 }}>Tap + to start a plain assistant chat</div>
        </div>
      )}

      {chats.map(c => (
        <div key={c.id} className="chat-item" onClick={() => nav(`/ai-chats/${c.id}`)}>
          <div className="chat-item-info">
            <div className="chat-item-name">{c.name}</div>
            <div className="chat-item-sub">Assistant</div>
          </div>
          <button className="btn-icon" onClick={e => { e.stopPropagation(); setRenameVal(c.name); setSheet(c); }}>
            <MoreHorizontal size={18} />
          </button>
        </div>
      ))}

      {/* Chat options sheet */}
      {sheet && (
        <BottomSheet title={sheet.name} onClose={() => setSheet(null)}>
          <input className="input" placeholder="Rename…" value={renameVal}
            onChange={e => setRenameVal(e.target.value)}
            onKeyDown={e => e.key === "Enter" && renameChat(sheet.id)} autoFocus />
          <button className="btn btn-ghost" style={{ width: "100%", justifyContent: "flex-start", gap: 10 }}
            onClick={() => renameChat(sheet.id)}>
            <PenLine size={16} /> Rename
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
