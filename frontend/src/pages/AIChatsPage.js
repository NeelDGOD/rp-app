import React, { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { Plus, PenLine, Sparkles, Trash2 } from "lucide-react";
import { api } from "../lib/api";
import { useBusy, useConfirmTap } from "../lib/ui";
import BottomSheet from "../components/BottomSheet";
import ChatList from "../components/ChatList";
import { BusyIcon, EmptyState, ErrorState, ListSkeleton, PageHeader } from "../components/States";
import { useToast } from "../components/Toast";

export default function AIChatsPage() {
  const [chats, setChats] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [sheet, setSheet] = useState(null); // {chat} for options
  const [renameVal, setRenameVal] = useState("");
  const nav   = useNavigate();
  const toast = useToast();
  const [busy, runBusy] = useBusy();
  const { armed, confirm } = useConfirmTap();

  const load = useCallback(async () => {
    try {
      const c = await api.getAIChats();
      setChats(c); setLoadError("");
    } catch (e) { setLoadError(e.message); toast(e.message, "error"); }
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
      <PageHeader title="AI" kicker="Plain assistant, no character">
        {(loading || chats.length > 0) && (
          <button className="btn btn-ghost btn-sm" onClick={() => runBusy("create", createChat)} disabled={busy === "create"}>
            <BusyIcon busy={busy === "create"} Icon={Plus} /> New chat
          </button>
        )}
      </PageHeader>

      <div className="col">
        {loading && <ListSkeleton />}

        {!loading && loadError && chats.length === 0 && (
          <ErrorState message={loadError} onRetry={() => { setLoading(true); load(); }} />
        )}

        {!loading && !loadError && chats.length === 0 && (
          <EmptyState
            icon={Sparkles}
            title="Nothing asked yet"
            text="For plain questions, research and quick drafts."
            action={<button className="btn btn-primary" onClick={() => runBusy("create", createChat)} disabled={busy === "create"}><BusyIcon busy={busy === "create"} Icon={Plus} size={17} /> New AI chat</button>}
          />
        )}

        {!loading && chats.length > 0 && (
          <ChatList
            chats={chats}
            metaFor={() => "Assistant"}
            onOpen={c => nav(`/ai-chats/${c.id}`)}
            onMore={c => { setRenameVal(c.name); setSheet(c); }}
          />
        )}
      </div>

      {sheet && (
        <BottomSheet title={sheet.name} onClose={() => setSheet(null)}>
          <div className="input-row">
            <input className="input" aria-label="New name" placeholder="Rename…" value={renameVal}
              onChange={e => setRenameVal(e.target.value)}
              onKeyDown={e => e.key === "Enter" && runBusy("rename", () => renameChat(sheet.id))} autoFocus />
            <button className="btn btn-ghost" onClick={() => runBusy("rename", () => renameChat(sheet.id))} disabled={!renameVal.trim() || !!busy}>
              <BusyIcon busy={busy === "rename"} Icon={PenLine} /> Rename
            </button>
          </div>
          <div className="action-list">
            <button className={`action action--danger${armed === sheet.id ? " is-armed" : ""}`} disabled={!!busy}
              onClick={() => confirm(sheet.id, () => runBusy("delete", () => deleteChat(sheet.id)))}>
              <BusyIcon busy={busy === "delete"} Icon={Trash2} size={18} />
              {busy === "delete" ? "Deleting…" : armed === sheet.id ? "Tap again to delete for good" : "Delete chat"}
            </button>
          </div>
        </BottomSheet>
      )}
    </div>
  );
}
