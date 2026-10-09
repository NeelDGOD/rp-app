import React, { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { BookOpen, Copy, Plus, PenLine, Trash2 } from "lucide-react";
import { api } from "../lib/api";
import { useBusy, useConfirmTap } from "../lib/ui";
import BottomSheet from "../components/BottomSheet";
import ChatList from "../components/ChatList";
import { BusyIcon, EmptyState, ErrorState, ListSkeleton, PageHeader, Spinner } from "../components/States";
import { useToast } from "../components/Toast";

export default function ChatsPage() {
  const [chats, setChats] = useState([]);
  const [bots, setBots]   = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [sheet, setSheet] = useState(null); // "new" | {chat}
  const [newName, setNewName] = useState("");
  const [newBot, setNewBot]   = useState("");
  const [renameVal, setRenameVal] = useState("");
  const nav   = useNavigate();
  const toast = useToast();
  const { armed, confirm } = useConfirmTap();
  const [busy, runBusy] = useBusy();

  const load = useCallback(async () => {
    try {
      const [c, b] = await Promise.all([api.getChats(), api.getBots()]);
      setChats(c); setBots(b); setLoadError("");
      if (b.length && !newBot) setNewBot(b[0].id);
    } catch (e) { setLoadError(e.message); toast(e.message, "error"); }
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

  const openNew = () => { setNewName(""); setSheet("new"); };
  const botName = id => bots.find(b => b.id === id)?.name || "Unknown bot";
  const create = () => runBusy("create", createChat);
  const rename = id => runBusy("rename", () => renameChat(id));

  return (
    <div className="page">
      <PageHeader title="Chats" kicker={!loading && chats.length > 0 ? `${chats.length} ${chats.length === 1 ? "story" : "stories"}` : null}>
        {(loading || chats.length > 0) && <button className="btn btn-ghost btn-sm" onClick={openNew}><Plus size={16} /> New chat</button>}
      </PageHeader>

      <div className="col">
        {loading && <ListSkeleton />}

        {!loading && loadError && chats.length === 0 && (
          <ErrorState message={loadError} onRetry={() => { setLoading(true); load(); }} />
        )}

        {!loading && !loadError && chats.length === 0 && (
          <EmptyState
            icon={BookOpen}
            title="No stories yet"
            text="Pick a character and open the first page."
            action={<button className="btn btn-primary" onClick={openNew}><Plus size={17} /> New chat</button>}
          />
        )}

        {!loading && chats.length > 0 && (
          <ChatList
            chats={chats}
            metaFor={c => botName(c.bot_id)}
            onOpen={c => nav(`/chats/${c.id}`)}
            onMore={c => { setRenameVal(c.name); setSheet(c); }}
          />
        )}
      </div>

      {sheet === "new" && (
        <BottomSheet title="New chat" onClose={() => setSheet(null)}>
          <div className="field">
            <label className="field-label" htmlFor="new-chat-name">Title</label>
            <input id="new-chat-name" className="input" placeholder="e.g. The fourth floor" value={newName}
              onChange={e => setNewName(e.target.value)}
              onKeyDown={e => e.key === "Enter" && create()} autoFocus />
          </div>
          <div className="field">
            <div className="field-label" id="new-chat-bot">Character</div>
            {bots.length === 0 ? (
              <div className="sheet-note">No bots yet. Create one in the Bots tab first.</div>
            ) : (
              <div className="option-list" role="radiogroup" aria-labelledby="new-chat-bot">
                {bots.map(b => (
                  <button key={b.id} role="radio" aria-checked={newBot === b.id}
                    className={`option${newBot === b.id ? " is-active" : ""}`} onClick={() => setNewBot(b.id)}>
                    <span className="option__mark" />
                    <span className="option__body"><span className="option__title">{b.name}</span></span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <button className="btn btn-primary btn-block" onClick={create} disabled={!newName.trim() || !newBot || busy === "create"}>
            {busy === "create" ? <><Spinner /> Creating…</> : "Begin"}
          </button>
        </BottomSheet>
      )}

      {sheet && sheet !== "new" && (
        <BottomSheet title={sheet.name} onClose={() => setSheet(null)}>
          <div className="input-row">
            <input className="input" aria-label="New name" placeholder="Rename…" value={renameVal}
              onChange={e => setRenameVal(e.target.value)}
              onKeyDown={e => e.key === "Enter" && rename(sheet.id)} />
            <button className="btn btn-ghost" onClick={() => rename(sheet.id)} disabled={!renameVal.trim() || !!busy}>
              <BusyIcon busy={busy === "rename"} Icon={PenLine} /> Rename
            </button>
          </div>
          <div className="action-list">
            <button className="action" disabled={!!busy} onClick={() => runBusy("clone", () => cloneChat(sheet.id, sheet.name))}>
              <BusyIcon busy={busy === "clone"} Icon={Copy} size={18} /> {busy === "clone" ? "Cloning…" : "Clone this chat"}
            </button>
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
