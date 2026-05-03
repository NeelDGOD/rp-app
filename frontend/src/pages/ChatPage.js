import React, {
  useEffect, useState, useRef, useCallback, useMemo
} from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  ChevronLeft, RotateCcw, Undo2, Bookmark, BookmarkCheck,
  ChevronLeft as ArrowL, ChevronRight as ArrowR,
  Sparkles, Brain, Search, X, Send
} from "lucide-react";
import { api } from "../lib/api";
import BottomSheet from "../components/BottomSheet";
import { useToast } from "../components/Toast";

const COMMANDS_REF = `GENERAL
  retry              re-generate last reply
  retry [hint]       re-generate with direction
  undo               remove last turn
  remember           trigger memory update now

STYLE  (tap Style button or type in { })
  {short}            2-3 sentence reply
  {long}             full 3-5 paragraph scene
  {continue}         bot advances scene alone
  {narrator} text    third-person transition
  {as mood}          shift tone for one reply

CHAT
  bookmark name      save current state
  loadbookmark       restore a saved state

TYPE /commands anytime to see this again`;

function visibleMessages(branch) {
  return branch.history.filter(m => m.role === "user" || m.role === "assistant");
}

// ── BRANCH FORK MAP ──────────────────────────────────────────────────────────
// Uses fork_message_index from the database — the exact history index where
// each branch was created. Converts that to a visible message index and groups
// branches that fork at the same point.
// Returns Map<visibleMsgIndex, branch[]> — only entries with 2+ branches.
function buildForkMap(activeBranch, allBranches) {
  const forkMap = new Map();
  if (!activeBranch || allBranches.length <= 1) return forkMap;

  // Build a lookup: full history index → visible message index
  // for the active branch
  const h = activeBranch.history;
  const fullToVisible = {};
  let visCount = 0;
  h.forEach((m, i) => {
    if (m.role === "user" || m.role === "assistant") {
      fullToVisible[i] = visCount++;
    }
  });

  // Group all branches by their fork_message_index
  // fork_message_index is the length of hist_base at fork time
  // meaning the new branch's first new message is at that index
  // which is an assistant message (the new reply)
  const byForkIdx = {};
  allBranches.forEach(b => {
    const fmi = b.fork_message_index;
    if (fmi === 0 && !b.parent_branch_id) return; // root branch, skip
    if (!byForkIdx[fmi]) byForkIdx[fmi] = [];
    byForkIdx[fmi].push(b);
  });

  // For each fork point, find what visible index the forked assistant reply is at
  Object.entries(byForkIdx).forEach(([fmi, branches]) => {
    const forkIdx = parseInt(fmi);
    // The forked assistant message is at full history index forkIdx
    // (hist_base ends at forkIdx, new assistant reply is appended right after)
    // Find the visible index of that position
    const visIdx = fullToVisible[forkIdx];
    if (visIdx === undefined) return;

    // Include the active branch itself if it shares this fork point
    // (active branch is either one of the siblings or the parent)
    const activeFmi = activeBranch.fork_message_index;
    const activeParent = activeBranch.parent_branch_id;

    // Collect all branches at this fork: the siblings + parent if active is a sibling
    let allAtFork = [...branches];

    // Find the parent branch of these siblings
    const parentId = branches[0]?.parent_branch_id;
    if (parentId) {
      const parentBranch = allBranches.find(b => b.id === parentId);
      if (parentBranch && !allAtFork.find(b => b.id === parentBranch.id)) {
        allAtFork = [parentBranch, ...allAtFork];
      }
    }

    if (allAtFork.length >= 2) {
      // Only show if active branch is one of these or the parent
      const isRelevant = allAtFork.some(b => b.id === activeBranch.id);
      if (isRelevant) {
        forkMap.set(visIdx, allAtFork);
      }
    }
  });

  return forkMap;
}

export default function ChatPage() {
  const { chatId } = useParams();
  const nav = useNavigate();
  const toast = useToast();

  const [chat, setChat]                 = useState(null);
  const [activeBranch, setActiveBranch] = useState(null);
  const [allBranches, setAllBranches]   = useState([]);
  const [streaming, setStreaming]       = useState(false);
  const [streamText, setStreamText]     = useState("");
  const [input, setInput]               = useState("");
  const [isFirstTurn, setIsFirstTurn]   = useState(false);
  const [sheet, setSheet]               = useState(null);
  const [retryHint, setRetryHint]       = useState("");
  const [bookmarkLabel, setBookmarkLabel] = useState("");
  const [bookmarks, setBookmarks]       = useState([]);
  const [searchQuery, setSearchQuery]   = useState("");
  const [editingMsg, setEditingMsg]     = useState(null); // {visibleIndex, role, content}
  const [editText, setEditText]         = useState("");

  const bottomRef = useRef(null);
  const inputRef  = useRef(null);
  const fontSz    = parseInt(localStorage.getItem("font_size") || "17");
  const autoMem   = localStorage.getItem("auto_memory") !== "false";

  // ── LOAD ──
  const loadChat = useCallback(async () => {
    try {
      const data = await api.getChat(chatId);
      setChat(data);
      const branches = data.branches || [];
      setAllBranches(branches);
      if (branches.length === 0) return;
      setActiveBranch(prev => {
        if (prev) {
          const stillExists = branches.find(b => b.id === prev.id);
          if (stillExists) return stillExists;
        }
        const sorted = [...branches].sort((a, b) => b.updated_at > a.updated_at ? 1 : -1);
        return sorted[0];
      });
      const saved = sessionStorage.getItem(`draft_${chatId}`);
      if (saved) setInput(saved);
    } catch (e) { toast(e.message, "error"); }
  }, [chatId]);

  useEffect(() => {
    loadChat().then(() => {
      setActiveBranch(prev => {
        if (prev) {
          const hasReplies = prev.history.filter(m => m.role === "assistant").length > 0;
          setIsFirstTurn(!hasReplies);
        }
        return prev;
      });
    });
  }, [loadChat]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [activeBranch?.history, streamText]);

  useEffect(() => {
    sessionStorage.setItem(`draft_${chatId}`, input);
  }, [input, chatId]);

  function switchBranch(branch) {
    setActiveBranch(branch);
    setStreamText("");
  }

  // ── SEND ──
  async function sendMessage() {
    if (!input.trim() || streaming || !activeBranch) return;
    const text = input.trim();
    setInput(""); sessionStorage.removeItem(`draft_${chatId}`);

    if (text === "/commands") { setSheet("commands"); return; }

    setStreaming(true); setStreamText("");

    const optimisticHistory = [
      ...activeBranch.history,
      { role: "user", content: text.replace(/{[^}]+}/g, "").trim() }
    ];
    setActiveBranch(b => ({ ...b, history: optimisticHistory }));

    const branchIdAtSend = activeBranch.id;
    const historyAtSend  = activeBranch.history;

    api.sendStream(
      chatId,
      { content: text, branch_id: branchIdAtSend, is_first_turn: isFirstTurn },
      (delta) => setStreamText(t => t + delta),
      async (evt) => {
        setStreaming(false);
        setStreamText("");
        setIsFirstTurn(false);
        if (evt.needs_memory && autoMem) triggerMemoryUpdate(branchIdAtSend, true);
        await loadChat();
      },
      (err) => {
        setStreaming(false); setStreamText("");
        setActiveBranch(b => ({ ...b, history: historyAtSend }));
        toast(`API error: ${err.message}`, "error", 6000);
      }
    );
  }

  // ── RETRY ──
  async function doRetry() {
    if (streaming || !activeBranch) return;
    setSheet(null); setStreaming(true); setStreamText("");

    const branchIdAtRetry = activeBranch.id;

    api.retryStream(
      chatId,
      { branch_id: branchIdAtRetry, hint: retryHint },
      (delta) => setStreamText(t => t + delta),
      async (evt) => {
        setStreaming(false); setStreamText("");
        setRetryHint("");
        if (evt.needs_memory && autoMem) triggerMemoryUpdate(evt.branch_id, true);
        const updated = await api.getChat(chatId);
        const branches = updated.branches || [];
        setAllBranches(branches);
        setChat(updated);
        const newBranch = branches.find(b => b.id === evt.branch_id);
        if (newBranch) setActiveBranch(newBranch);
      },
      (err) => {
        setStreaming(false); setStreamText("");
        toast(`Retry error: ${err.message}`, "error", 6000);
      }
    );
  }

  // ── UNDO ──
  async function doUndo() {
    if (streaming || !activeBranch) return;
    try {
      const res = await api.undo(activeBranch.id);
      setActiveBranch(b => ({ ...b, history: res.history }));
      toast("Last turn removed", "info", 2000);
    } catch (e) { toast(e.message, "error"); }
  }

  // ── EDIT LUNA MESSAGE (in-place, no branch) ──
  async function doEditLuna(visibleIndex, newContent) {
    if (!activeBranch) return;
    try {
      const res = await api.editMessage(activeBranch.id, visibleIndex, newContent);
      setActiveBranch(b => ({ ...b, history: res.history }));
      setEditingMsg(null);
      toast("Reply updated", "success", 2000);
    } catch (e) { toast(e.message, "error"); }
  }

  // ── EDIT USER MESSAGE (creates new branch like retry) ──
  async function doEditUser(visibleIndex, newContent) {
    if (!activeBranch || streaming) return;
    setEditingMsg(null);
    setStreaming(true); setStreamText("");
    const branchIdAtEdit = activeBranch.id;

    api.editUserStream(
      chatId,
      { branch_id: branchIdAtEdit, visible_index: visibleIndex, new_content: newContent },
      (delta) => setStreamText(t => t + delta),
      async (evt) => {
        setStreaming(false); setStreamText("");
        if (evt.needs_memory && autoMem) triggerMemoryUpdate(evt.branch_id, true);
        const updated = await api.getChat(chatId);
        const branches = updated.branches || [];
        setAllBranches(branches);
        setChat(updated);
        const newBranch = branches.find(b => b.id === evt.branch_id);
        if (newBranch) setActiveBranch(newBranch);
      },
      (err) => {
        setStreaming(false); setStreamText("");
        toast(`Edit error: ${err.message}`, "error", 6000);
      }
    );
  }

  // ── MEMORY ──
  async function triggerMemoryUpdate(branchId, silent = false) {
    try {
      await api.updateMemory(branchId || activeBranch.id);
      if (!silent) toast("Memory updated", "success", 2000);
    } catch (e) {
      toast(`Memory update failed: ${e.message}`, "error", 7000);
    }
  }

  // ── BOOKMARK ──
  async function saveBookmark() {
    if (!bookmarkLabel.trim()) return;
    try {
      await api.createBookmark(chatId, { branch_id: activeBranch.id, label: bookmarkLabel.trim() });
      setSheet(null); setBookmarkLabel("");
      toast("Bookmark saved", "success", 2000);
    } catch (e) { toast(e.message, "error"); }
  }

  async function openBookmarks() {
    try {
      const bms = await api.getBookmarks(chatId);
      setBookmarks(bms); setSheet("bookmarks");
    } catch (e) { toast(e.message, "error"); }
  }

  async function restoreBookmark(bmId) {
    try {
      const res = await api.restoreBookmark(bmId);
      setSheet(null);
      const updated = await api.getChat(chatId);
      const branches = updated.branches || [];
      setAllBranches(branches);
      setChat(updated);
      const nb = branches.find(b => b.id === res.branch_id);
      if (nb) setActiveBranch(nb);
      toast("Bookmark restored", "success", 2000);
    } catch (e) { toast(e.message, "error"); }
  }

  function injectStyle(cmd) {
    setInput(prev => `{${cmd}} ${prev}`.trimEnd());
    setSheet(null);
    inputRef.current?.focus();
  }

  // ── MESSAGES + FORK MAP ──
  const messages = useMemo(() => {
    if (!activeBranch) return [];
    return visibleMessages(activeBranch);
  }, [activeBranch]);

  const forkMap = useMemo(() => {
    return buildForkMap(activeBranch, allBranches);
  }, [activeBranch, allBranches]);

  const filteredMessages = useMemo(() => {
    if (!searchQuery.trim()) return messages;
    const q = searchQuery.toLowerCase();
    return messages.filter(m => m.content.toLowerCase().includes(q));
  }, [messages, searchQuery]);

  if (!chat || !activeBranch) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100dvh", color: "var(--text3)" }}>
        Loading…
      </div>
    );
  }

  const displayMessages = sheet === "search" ? filteredMessages : messages;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100dvh", background: "var(--bg)" }}>

      {/* ── HEADER ── */}
      <div style={{
        display: "flex", alignItems: "center", gap: 10, padding: "12px 12px 10px",
        borderBottom: "1px solid var(--border)", background: "var(--bg)",
        position: "sticky", top: 0, zIndex: 20,
      }}>
        <button className="btn-icon" onClick={() => nav("/chats")}><ChevronLeft size={22} /></button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 17, fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {chat.name}
          </div>
          <div style={{ fontSize: 11, fontFamily: "var(--mono)", color: "var(--text3)", marginTop: 1 }}>
            {allBranches.length > 1 ? `${allBranches.length} branches` : ""}
          </div>
        </div>
        <button className="btn-icon" onClick={() => setSheet("search")}><Search size={18} /></button>
        <button className="btn-icon" onClick={openBookmarks}><BookmarkCheck size={18} /></button>
      </div>

      {/* ── MESSAGES ── */}
      <div style={{ flex: 1, overflowY: "auto", padding: "12px 12px 4px" }}>
        {displayMessages.map((msg, i) => {
          const forks = msg.role === "assistant" ? forkMap.get(i) : null;
          return (
            <React.Fragment key={i}>
              <MessageBubble
                msg={msg}
                fontSize={fontSz}
                visibleIndex={i}
                isEditing={editingMsg?.visibleIndex === i}
                editText={editingMsg?.visibleIndex === i ? editText : ""}
                onEditStart={() => { setEditingMsg({ visibleIndex: i, role: msg.role }); setEditText(msg.content); }}
                onEditChange={setEditText}
                onEditConfirm={() => {
                  if (msg.role === "assistant") doEditLuna(i, editText);
                  else doEditUser(i, editText);
                }}
                onEditCancel={() => setEditingMsg(null)}
              />
              {forks && (
                <InlineBranchArrows
                  forks={forks}
                  activeBranch={activeBranch}
                  msgIndex={i}
                  onSwitch={(branch) => switchBranch(branch)}
                />
              )}
            </React.Fragment>
          );
        })}

        {streaming && streamText && (
          <MessageBubble msg={{ role: "assistant", content: streamText }} fontSize={fontSz} isStreaming />
        )}
        {streaming && !streamText && (
          <div style={{ display: "flex", gap: 6, padding: "10px 4px", alignItems: "center" }}>
            {[0,1,2].map(i => (
              <div key={i} style={{
                width: 6, height: 6, borderRadius: "50%", background: "var(--accent)",
                animation: "pulse 1.2s infinite", animationDelay: `${i * 0.2}s`
              }} />
            ))}
          </div>
        )}

        <div ref={bottomRef} style={{ height: 8 }} />
      </div>

      {/* ── TOOLBAR ── */}
      <div style={{
        display: "flex", gap: 4, padding: "8px 12px 4px",
        borderTop: "1px solid var(--border)",
        overflowX: "auto", scrollbarWidth: "none",
      }}>
        <ToolBtn icon={<RotateCcw size={15} />} label="Retry" onClick={() => setSheet("retry")} disabled={streaming} />
        <ToolBtn icon={<Undo2 size={15} />} label="Undo" onClick={doUndo} disabled={streaming} />
        <ToolBtn icon={<Sparkles size={15} />} label="Style" onClick={() => setSheet("style")} disabled={streaming} />
        <ToolBtn icon={<Bookmark size={15} />} label="Save" onClick={() => setSheet("bookmark")} disabled={streaming} />
        {!autoMem && (
          <ToolBtn icon={<Brain size={15} />} label="Remember" onClick={() => triggerMemoryUpdate()} disabled={streaming} />
        )}
      </div>

      {/* ── INPUT ── */}
      <div style={{
        display: "flex", gap: 8, padding: "8px 12px",
        paddingBottom: "calc(8px + env(safe-area-inset-bottom, 0px))",
        background: "var(--bg)",
      }}>
        <textarea
          ref={inputRef}
          className="input"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
          placeholder="Type a message…"
          rows={1}
          style={{ flex: 1, resize: "none", fontSize: fontSz, maxHeight: 120, overflowY: "auto" }}
        />
        <button onClick={sendMessage} disabled={!input.trim() || streaming} style={{
          width: 42, height: 42, borderRadius: "50%", border: "none",
          background: input.trim() && !streaming ? "var(--accent)" : "var(--bg4)",
          color: input.trim() && !streaming ? "#1a1208" : "var(--text3)",
          display: "flex", alignItems: "center", justifyContent: "center",
          cursor: input.trim() && !streaming ? "pointer" : "default",
          transition: "all 0.15s", flexShrink: 0, alignSelf: "flex-end",
        }}>
          <Send size={18} />
        </button>
      </div>

      {/* ── SHEETS ── */}
      {sheet === "retry" && (
        <BottomSheet title="Retry" onClose={() => setSheet(null)}>
          <input className="input" placeholder="Direction (optional) — e.g. be more shy…"
            value={retryHint} onChange={e => setRetryHint(e.target.value)}
            onKeyDown={e => e.key === "Enter" && doRetry()} autoFocus />
          <button className="btn btn-primary" style={{ width: "100%" }} onClick={doRetry}>
            <RotateCcw size={16} /> Retry
          </button>
        </BottomSheet>
      )}

      {sheet === "style" && (
        <BottomSheet title="Reply Style" onClose={() => setSheet(null)}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            {[
              { cmd: "short",    label: "Short",    sub: "2-3 sentences" },
              { cmd: "long",     label: "Long",     sub: "Full scene" },
              { cmd: "continue", label: "Continue", sub: "Bot advances" },
              { cmd: "narrator", label: "Narrator", sub: "3rd person" },
            ].map(({ cmd, label, sub }) => (
              <button key={cmd} onClick={() => injectStyle(cmd)} style={{
                padding: "12px 10px", borderRadius: "var(--radius-sm)",
                background: "var(--bg3)", border: "1px solid var(--border)",
                cursor: "pointer", textAlign: "left",
              }}>
                <div style={{ fontSize: 15, color: "var(--text)", fontFamily: "var(--font)" }}>{label}</div>
                <div style={{ fontSize: 12, color: "var(--text3)", fontFamily: "var(--mono)", marginTop: 2 }}>{sub}</div>
              </button>
            ))}
          </div>
          <div style={{ fontSize: 12, color: "var(--text3)", fontFamily: "var(--mono)", marginTop: 4 }}>Custom tone</div>
          <div style={{ display: "flex", gap: 8 }}>
            <input className="input" placeholder='e.g. drunk, cold and distant…' id="as-input" style={{ flex: 1 }} />
            <button className="btn btn-ghost btn-sm" onClick={() => {
              const val = document.getElementById("as-input").value.trim();
              if (val) injectStyle(`as ${val}`);
            }}>Apply</button>
          </div>
        </BottomSheet>
      )}

      {sheet === "bookmark" && (
        <BottomSheet title="Save Bookmark" onClose={() => setSheet(null)}>
          <input className="input" placeholder="Label — e.g. before the argument…"
            value={bookmarkLabel} onChange={e => setBookmarkLabel(e.target.value)}
            onKeyDown={e => e.key === "Enter" && saveBookmark()} autoFocus />
          <button className="btn btn-primary" style={{ width: "100%" }} onClick={saveBookmark}>
            <Bookmark size={16} /> Save Bookmark
          </button>
        </BottomSheet>
      )}

      {sheet === "bookmarks" && (
        <BottomSheet title="Bookmarks" onClose={() => setSheet(null)}>
          {bookmarks.length === 0 && (
            <div style={{ color: "var(--text3)", textAlign: "center", padding: 16, fontSize: 14 }}>
              No bookmarks saved yet.
            </div>
          )}
          {bookmarks.map(bm => (
            <div key={bm.id} style={{
              display: "flex", alignItems: "center", gap: 10,
              padding: "12px 0", borderBottom: "1px solid var(--border)"
            }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 15 }}>{bm.label}</div>
                <div style={{ fontSize: 12, color: "var(--text3)", fontFamily: "var(--mono)", marginTop: 2 }}>
                  {new Date(bm.created_at).toLocaleDateString()}
                </div>
              </div>
              <button className="btn btn-ghost btn-sm" onClick={() => restoreBookmark(bm.id)}>Restore</button>
              <button className="btn-icon" style={{ color: "var(--error)" }}
                onClick={async () => {
                  await api.deleteBookmark(bm.id);
                  setBookmarks(bs => bs.filter(b => b.id !== bm.id));
                }}>
                <X size={15} />
              </button>
            </div>
          ))}
        </BottomSheet>
      )}

      {sheet === "search" && (
        <BottomSheet title="Search Chat" onClose={() => { setSheet(null); setSearchQuery(""); }}>
          <input className="input" placeholder="Search messages…" value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)} autoFocus />
          {searchQuery && (
            <div style={{ fontSize: 13, color: "var(--text3)", fontFamily: "var(--mono)" }}>
              {filteredMessages.length} result{filteredMessages.length !== 1 ? "s" : ""}
            </div>
          )}
        </BottomSheet>
      )}

      {sheet === "commands" && (
        <BottomSheet title="/commands" onClose={() => setSheet(null)}>
          <pre style={{
            fontFamily: "var(--mono)", fontSize: 13, color: "var(--text2)",
            lineHeight: 1.8, whiteSpace: "pre-wrap", padding: "4px 0"
          }}>{COMMANDS_REF}</pre>
        </BottomSheet>
      )}
    </div>
  );
}

// ── INLINE BRANCH ARROWS ──────────────────────────────────────────────────────
// Renders arrows directly under the forked assistant message.
// forks = array of branches that all have a reply at this message index.
// The "current" version is whichever branch's reply matches activeBranch at this index.
function InlineBranchArrows({ forks, activeBranch, msgIndex, onSwitch }) {
  const activeVisible = visibleMessages(activeBranch);
  const activeContent = activeVisible[msgIndex]?.content;

  // Find which fork index is currently active
  const currentIdx = forks.findIndex(b => {
    const bVisible = visibleMessages(b);
    return bVisible[msgIndex]?.content === activeContent;
  });

  const idx = currentIdx === -1 ? 0 : currentIdx;

  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 6,
      padding: "2px 0 10px", marginLeft: 4,
    }}>
      <button
        className="btn-icon"
        disabled={idx <= 0}
        onClick={() => onSwitch(forks[idx - 1])}
      >
        <ArrowL size={14} style={{ opacity: idx <= 0 ? 0.25 : 1 }} />
      </button>
      <span style={{ fontSize: 11, fontFamily: "var(--mono)", color: "var(--text3)" }}>
        {idx + 1} / {forks.length}
      </span>
      <button
        className="btn-icon"
        disabled={idx >= forks.length - 1}
        onClick={() => onSwitch(forks[idx + 1])}
      >
        <ArrowR size={14} style={{ opacity: idx >= forks.length - 1 ? 0.25 : 1 }} />
      </button>
      <span style={{ fontSize: 11, fontFamily: "var(--mono)", color: "var(--text3)" }}>versions</span>
    </div>
  );
}

// ── MESSAGE BUBBLE ────────────────────────────────────────────────────────────
function MessageBubble({ msg, fontSize, isStreaming, visibleIndex,
  isEditing, editText, onEditStart, onEditChange, onEditConfirm, onEditCancel }) {
  const isUser = msg.role === "user";

  if (isEditing) {
    return (
      <div style={{ display: "flex", justifyContent: isUser ? "flex-end" : "flex-start", marginBottom: 12 }}>
        <div style={{ maxWidth: "90%", width: "90%", display: "flex", flexDirection: "column", gap: 8 }}>
          <textarea
            autoFocus
            value={editText}
            onChange={e => onEditChange(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); onEditConfirm(); } }}
            style={{
              width: "100%", padding: "10px 14px", borderRadius: "var(--radius-sm)",
              background: "var(--bg3)", border: "1px solid var(--accent)",
              color: "var(--text)", fontFamily: "var(--font)", fontSize,
              lineHeight: 1.6, resize: "none", minHeight: 80, outline: "none",
            }}
          />
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button className="btn btn-ghost btn-sm" onClick={onEditCancel}>Cancel</button>
            <button className="btn btn-primary btn-sm" onClick={onEditConfirm}>
              {isUser ? "Send edited" : "Save"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", justifyContent: isUser ? "flex-end" : "flex-start", marginBottom: 4 }}
      onClick={onEditStart}>
      <div style={{
        maxWidth: "85%",
        padding: isUser ? "10px 14px" : "12px 16px",
        borderRadius: isUser
          ? "var(--radius-lg) var(--radius-lg) 4px var(--radius-lg)"
          : "var(--radius-lg) var(--radius-lg) var(--radius-lg) 4px",
        background: isUser ? "var(--bg4)" : "var(--bg2)",
        border: isUser ? "1px solid var(--border)" : "1px solid var(--border2)",
        fontSize, lineHeight: 1.65,
        color: isUser ? "var(--text2)" : "var(--text)",
        whiteSpace: "pre-wrap", wordBreak: "break-word",
        cursor: "text",
      }} className={isStreaming ? "streaming-cursor" : ""}>
        {msg.content}
      </div>
    </div>
  );
}

// ── TOOLBAR BUTTON ────────────────────────────────────────────────────────────
function ToolBtn({ icon, label, onClick, disabled }) {
  return (
    <button onClick={onClick} disabled={disabled} style={{
      display: "flex", flexDirection: "column", alignItems: "center", gap: 3,
      padding: "6px 10px", borderRadius: "var(--radius-sm)", border: "none",
      background: "transparent", cursor: disabled ? "default" : "pointer",
      color: disabled ? "var(--text3)" : "var(--text2)",
      opacity: disabled ? 0.4 : 1, minWidth: 52, flexShrink: 0,
      transition: "all 0.15s", WebkitTapHighlightColor: "transparent",
    }}>
      {icon}
      <span style={{ fontSize: 10, fontFamily: "var(--mono)", letterSpacing: "0.2px" }}>{label}</span>
    </button>
  );
}
