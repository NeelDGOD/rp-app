import React, {
  useEffect, useState, useRef, useCallback, useMemo
} from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  ChevronLeft, RotateCcw, Undo2, Bookmark, BookmarkCheck,
  ChevronLeft as ArrowL, ChevronRight as ArrowR,
  Sparkles, Brain, Search, X, Send, Zap
} from "lucide-react";
import { api } from "../lib/api";
import BottomSheet from "../components/BottomSheet";
import { useToast } from "../components/Toast";

// ── COMMANDS REFERENCE ────────────────────────────────────────────────────────
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

// ── HELPERS ───────────────────────────────────────────────────────────────────
function buildTree(branches) {
  // Returns map: fork_message_index → [branch, ...]
  // For the root (index 0) there's one root branch
  const byParent = {};
  for (const b of branches) {
    const key = b.parent_branch_id || "root";
    if (!byParent[key]) byParent[key] = [];
    byParent[key].push(b);
  }
  return byParent;
}

function visibleMessages(branch) {
  // Returns only user/assistant messages (not system)
  return branch.history.filter(m => m.role === "user" || m.role === "assistant");
}

// ── MAIN COMPONENT ────────────────────────────────────────────────────────────
export default function ChatPage() {
  const { chatId } = useParams();
  const nav = useNavigate();
  const toast = useToast();

  const [chat, setChat]           = useState(null);
  const [activeBranch, setActiveBranch] = useState(null);
  const [allBranches, setAllBranches]   = useState([]);
  const [streaming, setStreaming] = useState(false);
  const [streamText, setStreamText] = useState("");
  const [input, setInput]         = useState("");
  const [draft, setDraft]         = useState(""); // saved draft
  const [isFirstTurn, setIsFirstTurn] = useState(false);

  // Sheets
  const [sheet, setSheet]         = useState(null);
  // sheet values: null | "retry" | "style" | "bookmark" | "bookmarks" | "search" | "commands"
  const [retryHint, setRetryHint] = useState("");
  const [bookmarkLabel, setBookmarkLabel] = useState("");
  const [bookmarks, setBookmarks] = useState([]);
  const [searchQuery, setSearchQuery] = useState("");

  const bottomRef = useRef(null);
  const inputRef  = useRef(null);
  const fontSz    = parseInt(localStorage.getItem("font_size") || "17");
  const autoMem   = localStorage.getItem("auto_memory") !== "false";

  // ── LOAD ──
  const loadChat = useCallback(async () => {
    try {
      const data = await api.getChat(chatId);
      setChat(data);
      setAllBranches(data.branches);
      // Active branch = most recently updated
      const sorted = [...data.branches].sort((a,b) => b.updated_at > a.updated_at ? 1 : -1);
      const active = sorted[0];
      setActiveBranch(active);
      setIsFirstTurn(active.history.filter(m => m.role === "assistant").length > 0);
      // Restore draft
      const saved = sessionStorage.getItem(`draft_${chatId}`);
      if (saved) setInput(saved);
    } catch (e) { toast(e.message, "error"); }
  }, [chatId]);

  useEffect(() => { loadChat(); }, [loadChat]);

  // Scroll to bottom when messages change
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [activeBranch?.history, streamText]);

  // Save draft to sessionStorage
  useEffect(() => {
    sessionStorage.setItem(`draft_${chatId}`, input);
  }, [input, chatId]);

  // ── BRANCH NAVIGATION ──
  // For a given message index, find sibling branches
  function getSiblings(msgIndex) {
    // Find all branches that forked at this message index
    return allBranches.filter(b =>
      b.fork_message_index === msgIndex ||
      (msgIndex === 0 && !b.parent_branch_id)
    );
  }

  function switchBranch(branch) {
    setActiveBranch(branch);
    setStreamText("");
  }

  // ── SEND ──
  async function sendMessage() {
    if (!input.trim() || streaming || !activeBranch) return;

    const text = input.trim();
    setInput(""); sessionStorage.removeItem(`draft_${chatId}`);

    // Handle /commands
    if (text === "/commands") {
      setSheet("commands"); return;
    }

    setStreaming(true); setStreamText("");

    const firstTurn = isFirstTurn && activeBranch.history.filter(m => m.role === "assistant").length === 0;

    // Optimistically show user message
    const optimisticHistory = [
      ...activeBranch.history,
      { role: "user", content: text.replace(/{[^}]+}/g, "").trim() }
    ];
    setActiveBranch(b => ({ ...b, history: optimisticHistory }));

    api.sendStream(
      chatId,
      { content: text, branch_id: activeBranch.id, is_first_turn: firstTurn },
      (delta) => setStreamText(t => t + delta),
      async (evt) => {
        setStreaming(false);
        if (evt.needs_memory && autoMem) {
          triggerMemoryUpdate(activeBranch.id, true);
        }
        await loadChat();
        setStreamText("");
        setIsFirstTurn(false);
      },
      (err) => {
        setStreaming(false); setStreamText("");
        // Roll back optimistic update
        setActiveBranch(b => ({ ...b, history: activeBranch.history }));
        toast(`API error: ${err.message}`, "error", 6000);
      }
    );
  }

  // ── RETRY ──
  async function doRetry() {
    if (streaming || !activeBranch) return;
    setSheet(null); setStreaming(true); setStreamText("");

    api.retryStream(
      chatId,
      { branch_id: activeBranch.id, hint: retryHint },
      (delta) => setStreamText(t => t + delta),
      async (evt) => {
        setStreaming(false);
        if (evt.needs_memory && autoMem) triggerMemoryUpdate(evt.branch_id, true);
        setRetryHint("");
        await loadChat();
        // Switch to newly created branch
        const updated = await api.getChat(chatId);
        setAllBranches(updated.branches);
        const newBranch = updated.branches.find(b => b.id === evt.branch_id);
        if (newBranch) setActiveBranch(newBranch);
        setStreamText("");
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
      await loadChat();
      const updated = await api.getChat(chatId);
      setAllBranches(updated.branches);
      const nb = updated.branches.find(b => b.id === res.branch_id);
      if (nb) setActiveBranch(nb);
      toast("Bookmark restored", "success", 2000);
    } catch (e) { toast(e.message, "error"); }
  }

  // ── STYLE INJECT ──
  function injectStyle(cmd) {
    setInput(prev => `{${cmd}} ${prev}`.trimEnd());
    setSheet(null);
    inputRef.current?.focus();
  }

  // ── MESSAGES ──
  const messages = useMemo(() => {
    if (!activeBranch) return [];
    return visibleMessages(activeBranch);
  }, [activeBranch]);

  // Search filter
  const filteredMessages = useMemo(() => {
    if (!searchQuery.trim()) return messages;
    const q = searchQuery.toLowerCase();
    return messages.filter(m => m.content.toLowerCase().includes(q));
  }, [messages, searchQuery]);

  // ── BRANCH SIBLINGS ──
  const siblings = React.useMemo(() => {
    if (!activeBranch) return [];
    const same = allBranches.filter(b =>
      b.parent_branch_id === activeBranch.parent_branch_id &&
      b.fork_message_index === activeBranch.fork_message_index
    );
    if (activeBranch.parent_branch_id) {
      const parent = allBranches.find(b => b.id === activeBranch.parent_branch_id);
      if (parent && !same.find(b => b.id === parent.id)) {
        return [parent, ...same];
      }
    }
    return same;
  }, [activeBranch, allBranches]);

  function BranchArrows() {
    if (!activeBranch || siblings.length <= 1) return null;
    const idx = siblings.findIndex(b => b.id === activeBranch.id);
    return (
      <div style={{
        display: "flex", alignItems: "center", gap: 8,
        padding: "4px 0 8px", marginLeft: 4,
      }}>
        <button className="btn-icon" disabled={idx <= 0}
          onClick={() => switchBranch(siblings[idx - 1])}>
          <ArrowL size={15} style={{ opacity: idx <= 0 ? 0.25 : 1 }} />
        </button>
        <span style={{ fontSize: 12, fontFamily: "var(--mono)", color: "var(--text3)" }}>
          {idx + 1} / {siblings.length}
        </span>
        <button className="btn-icon" disabled={idx >= siblings.length - 1}
          onClick={() => switchBranch(siblings[idx + 1])}>
          <ArrowR size={15} style={{ opacity: idx >= siblings.length - 1 ? 0.25 : 1 }} />
        </button>
        <span style={{ fontSize: 11, fontFamily: "var(--mono)", color: "var(--text3)" }}>versions</span>
      </div>
    );
  }

  if (!chat || !activeBranch) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100dvh", color: "var(--text3)" }}>
        Loading…
      </div>
    );
  }

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
        {(sheet === "search" ? filteredMessages : messages).map((msg, i) => (
          <MessageBubble key={i} msg={msg} fontSize={fontSz} />
        ))}

        {/* Streaming bubble */}
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

        {/* Branch arrows under last assistant reply */}
        <BranchArrows />

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
          onKeyDown={e => {
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
          }}
          placeholder="Type a message…"
          rows={1}
          style={{
            flex: 1, resize: "none", fontSize: fontSz,
            maxHeight: 120, overflowY: "auto",
            fontStyle: input.trim() === "" ? "normal" : "normal",
          }}
        />
        <button
          onClick={sendMessage}
          disabled={!input.trim() || streaming}
          style={{
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

      {/* Retry sheet */}
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

      {/* Style sheet */}
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
            <input className="input" placeholder='e.g. drunk, cold and distant…'
              id="as-input" style={{ flex: 1 }} />
            <button className="btn btn-ghost btn-sm" onClick={() => {
              const val = document.getElementById("as-input").value.trim();
              if (val) injectStyle(`as ${val}`);
            }}>Apply</button>
          </div>
        </BottomSheet>
      )}

      {/* Bookmark save sheet */}
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

      {/* Bookmarks list sheet */}
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

      {/* Search sheet */}
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

      {/* Commands reference sheet */}
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

// ── MESSAGE BUBBLE ─────────────────────────────────────────────────────────────
function MessageBubble({ msg, fontSize, isStreaming }) {
  const isUser = msg.role === "user";
  return (
    <div style={{
      display: "flex",
      justifyContent: isUser ? "flex-end" : "flex-start",
      marginBottom: 12,
    }}>
      <div style={{
        maxWidth: "85%",
        padding: isUser ? "10px 14px" : "12px 16px",
        borderRadius: isUser
          ? "var(--radius-lg) var(--radius-lg) 4px var(--radius-lg)"
          : "var(--radius-lg) var(--radius-lg) var(--radius-lg) 4px",
        background: isUser ? "var(--bg4)" : "var(--bg2)",
        border: isUser ? "1px solid var(--border)" : "1px solid var(--border2)",
        fontSize,
        lineHeight: 1.65,
        color: isUser ? "var(--text2)" : "var(--text)",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
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
