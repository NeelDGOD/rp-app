import React, {
  useEffect, useState, useRef, useCallback, useMemo
} from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  ChevronLeft, RotateCcw, Undo2, Bookmark, BookmarkCheck,
  ChevronLeft as ArrowL, ChevronRight as ArrowR,
  Sparkles, Brain, Search, X
} from "lucide-react";
import { api } from "../lib/api";
import { useAutoGrow, useBusy, useScrollToEnd } from "../lib/ui";
import { parseServerDate } from "../lib/time";
import BottomSheet from "../components/BottomSheet";
import { useToast } from "../components/Toast";
import ModelPickerButton from "../components/ModelPickerButton";
import { BusyIcon, ErrorState, Spinner, TranscriptSkeleton } from "../components/States";
import { Composer, Thinking, Turn } from "../components/Transcript";

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

DIRECTOR NOTE  (stays in effect until changed)
  {direct: text}     override behavior until cleared
  {normal}           clear the active director note

CHAT
  bookmark name      save current state
  loadbookmark       restore a saved state

TYPE /commands anytime to see this again`;

function visibleMessages(branch) {
  return branch.history.filter(m => m.role === "user" || m.role === "assistant");
}

// ── BRANCH FORK MAP ──────────────────────────────────────────────────────────
// Groups branches into "fork clusters" — sets of branches that are alternate
// versions of the same reply/edit. A retry chain (branch1 → branch2 → branch3,
// each parented to the previous) all share the same fork_message_index, so we
// walk each branch's parent_branch_id chain back to the true common ancestor
// ("anchor") instead of trusting the raw index number alone. That number is
// just an array-length int — two *unrelated* fork points (e.g. a retry at one
// spot and an edited message at a different spot) can coincidentally produce
// the same value, which would wrongly merge them if we grouped by number alone.
// Keying by (anchor id + fork index) instead makes that collision impossible.
// Returns Map<visibleMsgIndex, branch[]> — only entries with 2+ versions.
function buildForkMap(activeBranch, allBranches) {
  const forkMap = new Map();
  if (!activeBranch || allBranches.length <= 1) return forkMap;

  const byId = new Map(allBranches.map(b => [b.id, b]));

  // Walk up the parent chain while the fork index stays the same — that's
  // still the same fork cluster (e.g. retry chains). Stop at the branch whose
  // parent has a *different* fork index (or no parent) — that parent is the
  // true anchor all versions in this cluster diverged from.
  function findAnchor(branch) {
    let current = branch;
    while (current.parent_branch_id) {
      const parent = byId.get(current.parent_branch_id);
      if (!parent || parent.fork_message_index !== branch.fork_message_index) break;
      current = parent;
    }
    return current.parent_branch_id ? byId.get(current.parent_branch_id) : current;
  }

  const clusters = new Map(); // "anchorId:fmi" → { anchor, fmi, members: [] }
  allBranches.forEach(b => {
    if (!b.parent_branch_id) return; // root branch, not a forked child
    const anchor = findAnchor(b);
    if (!anchor) return;
    const key = `${anchor.id}:${b.fork_message_index}`;
    if (!clusters.has(key)) clusters.set(key, { anchor, fmi: b.fork_message_index, members: [] });
    clusters.get(key).members.push(b);
  });

  // Lookup: full history index → visible message index, for the active branch
  const h = activeBranch.history;
  const fullToVisible = {};
  let visCount = 0;
  h.forEach((m, i) => {
    if (m.role === "user" || m.role === "assistant") {
      fullToVisible[i] = visCount++;
    }
  });

  clusters.forEach(({ anchor, fmi, members }) => {
    const visIdx = fullToVisible[fmi];
    if (visIdx === undefined) return;

    const allAtFork = [anchor, ...members];
    const isRelevant = allAtFork.some(b => b.id === activeBranch.id);
    if (isRelevant) {
      forkMap.set(visIdx, allAtFork);
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
  const [loadError, setLoadError]       = useState("");
  const [botName, setBotName]           = useState("");
  const [reloadKey, setReloadKey]       = useState(0);
  const [memState, setMemState]         = useState(null); // null | "working" | "done" | "failed"
  const [busy, runBusy]                 = useBusy();

  const scrollerRef = useRef(null);
  const inputRef  = useRef(null);
  const fontSz    = parseInt(localStorage.getItem("font_size") || "17");
  const autoMem   = localStorage.getItem("auto_memory") !== "false";

  // ── LOAD ──
  const loadChat = useCallback(async () => {
    try {
      const data = await api.getChat(chatId);
      setChat(data);
      setLoadError("");
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
    } catch (e) { setLoadError(e.message); toast(e.message, "error"); }
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
  }, [loadChat, reloadKey]);

  useScrollToEnd(scrollerRef, activeBranch?.history, streamText);

  // Only for the small name label above the character's lines.
  useEffect(() => {
    if (!chat?.bot_id) return;
    api.getBots()
      .then(bs => setBotName(bs.find(b => b.id === chat.bot_id)?.name || ""))
      .catch(() => {});
  }, [chat?.bot_id]);

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
        setInput(text);
        sessionStorage.setItem(`draft_${chatId}`, text);
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
    setMemState("working");
    try {
      await api.updateMemory(branchId || activeBranch.id);
      setMemState("done");
      if (!silent) toast("Memory updated", "success", 2000);
    } catch (e) {
      setMemState("failed");
      toast(`Memory update failed: ${e.message}`, "error", 7000);
    }
  }

  useEffect(() => {
    if (memState !== "done" && memState !== "failed") return;
    const t = setTimeout(() => setMemState(null), 3500);
    return () => clearTimeout(t);
  }, [memState]);

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

  const proseVars = { "--prose-size": `${fontSz}px` };

  if (!chat || !activeBranch) {
    return (
      <div className="chat-screen" style={proseVars}>
        <header className="bar">
          <div className="chat-col bar__inner">
            <button className="icon-btn bar__back" onClick={() => nav("/chats")} aria-label="Back to chats"><ChevronLeft size={22} /></button>
          </div>
        </header>
        {loadError && !chat ? (
          <div className="center-state">
            <ErrorState message={loadError} onRetry={() => { setLoadError(""); setReloadKey(k => k + 1); }} />
          </div>
        ) : (
          <div className="scroller"><div className="chat-col"><TranscriptSkeleton /></div></div>
        )}
      </div>
    );
  }

  const displayMessages = sheet === "search" ? filteredMessages : messages;
  const tools = [
    { label: "Retry", Icon: RotateCcw, onClick: () => setSheet("retry") },
    { label: "Undo", Icon: Undo2, onClick: () => runBusy("undo", doUndo), busy: busy === "undo" },
    { label: "Style", Icon: Sparkles, onClick: () => setSheet("style") },
    { label: "Save", Icon: Bookmark, onClick: () => setSheet("bookmark") },
    ...(!autoMem ? [{ label: "Remember", Icon: Brain, onClick: () => triggerMemoryUpdate(), busy: memState === "working" }] : []),
  ];
  const memChip = memState && (
    <span className={`status-chip${memState === "failed" ? " is-error" : ""}`} role="status">
      {memState === "working" && <><Spinner size={13} /> Updating memory…</>}
      {memState === "done" && "Memory updated"}
      {memState === "failed" && "Memory update failed"}
    </span>
  );

  return (
    <div className="chat-screen" style={proseVars}>

      {/* ── HEADER ── */}
      <header className="bar">
        <div className="chat-col bar__inner">
          <button className="icon-btn bar__back" onClick={() => nav("/chats")} aria-label="Back to chats"><ChevronLeft size={22} /></button>
          <div className="bar__title">
            <h1 className="bar__name">{chat.name}</h1>
            <div className="bar__sub">
              <ModelPickerButton />
              {allBranches.length > 1 && <span className="bar__branches">{allBranches.length} branches</span>}
            </div>
          </div>
          <button className="icon-btn" onClick={() => setSheet("search")} aria-label="Search this chat"><Search size={19} /></button>
          <button className="icon-btn" onClick={() => runBusy("bookmarks", openBookmarks)} disabled={busy === "bookmarks"} aria-label="Bookmarks">
            <BusyIcon busy={busy === "bookmarks"} Icon={BookmarkCheck} size={19} />
          </button>
        </div>
      </header>

      {/* ── TRANSCRIPT ── */}
      <div className="scroller" ref={scrollerRef}>
        <div className="chat-col transcript">
          {messages.length === 0 && !streaming && (
            <div className="chat-empty">
              <div className="chat-empty__orn" aria-hidden="true">⁂</div>
              <div className="chat-empty__title">A blank page</div>
              <p className="chat-empty__text">
                Set the scene, or simply say hello{botName ? ` to ${botName}` : ""}. Type <span className="mono">/commands</span> for the command list.
              </p>
            </div>
          )}

          {displayMessages.map((msg, i) => {
            const forks = forkMap.get(i);
            const isEditing = editingMsg?.visibleIndex === i;
            const showSpeaker = msg.role === "assistant" && displayMessages[i - 1]?.role !== "assistant";
            return (
              <React.Fragment key={i}>
                {isEditing ? (
                  <EditPanel
                    msg={msg}
                    fontSize={fontSz}
                    editText={editText}
                    saving={busy === "edit"}
                    onEditChange={setEditText}
                    onEditConfirm={() => {
                      if (msg.role === "assistant") runBusy("edit", () => doEditLuna(i, editText));
                      else doEditUser(i, editText);
                    }}
                    onEditCancel={() => setEditingMsg(null)}
                  />
                ) : (
                  <Turn
                    role={msg.role}
                    speaker={botName}
                    showSpeaker={showSpeaker}
                    text={msg.content}
                    onActivate={() => { setEditingMsg({ visibleIndex: i, role: msg.role }); setEditText(msg.content); }}
                  />
                )}
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
            <Turn role="assistant" speaker={botName}
              showSpeaker={displayMessages[displayMessages.length - 1]?.role !== "assistant"}
              text={streamText} caret />
          )}
          {streaming && !streamText && <Thinking speaker={botName} />}
        </div>
      </div>

      {/* ── DOCK: TOOLBAR + COMPOSER ── */}
      <div className="dock">
        <div className="chat-col">
          <div className="toolbar" role="toolbar" aria-label="Story tools">
            {memChip}
            {tools.map(({ label, Icon, onClick, busy: toolBusy }) => (
              <button key={label} className="chip" onClick={onClick} disabled={streaming || !!busy || toolBusy} aria-busy={toolBusy || undefined}>
                <BusyIcon busy={toolBusy} Icon={Icon} size={15} /> {label}
              </button>
            ))}
          </div>
          <Composer
            inputRef={inputRef}
            value={input}
            onChange={setInput}
            onSend={sendMessage}
            placeholder={streaming ? "Writing…" : "Continue the story…"}
            canSend={!!input.trim() && !streaming}
            busy={streaming}
            fontSize={fontSz}
          />
        </div>
      </div>

      {/* ── SHEETS ── */}
      {sheet === "retry" && (
        <BottomSheet title="Retry" onClose={() => setSheet(null)}>
          <p className="sheet-note">Writes a new version of the last reply. The current one stays as a version you can flip back to.</p>
          <input className="input" placeholder="Direction (optional), e.g. be more shy…"
            value={retryHint} onChange={e => setRetryHint(e.target.value)}
            onKeyDown={e => e.key === "Enter" && doRetry()} autoFocus />
          <button className="btn btn-primary btn-block" onClick={doRetry}>
            <RotateCcw size={16} /> Retry
          </button>
        </BottomSheet>
      )}

      {sheet === "style" && (
        <BottomSheet title="Reply style" onClose={() => setSheet(null)}>
          <div className="option-grid">
            {[
              { cmd: "short",    label: "Short",    sub: "2-3 sentences" },
              { cmd: "long",     label: "Long",     sub: "Full scene" },
              { cmd: "continue", label: "Continue", sub: "Bot advances" },
              { cmd: "narrator", label: "Narrator", sub: "3rd person" },
            ].map(({ cmd, label, sub }) => (
              <button key={cmd} className="option" onClick={() => injectStyle(cmd)}>
                <span className="option__title">{label}</span>
                <span className="option__sub">{sub}</span>
              </button>
            ))}
          </div>
          <div className="field">
            <label className="field-label" htmlFor="as-input">Custom tone</label>
            <div className="input-row">
              <input className="input" placeholder="e.g. drunk, cold and distant…" id="as-input" />
              <button className="btn btn-ghost" onClick={() => {
                const val = document.getElementById("as-input").value.trim();
                if (val) injectStyle(`as ${val}`);
              }}>Apply</button>
            </div>
          </div>
        </BottomSheet>
      )}

      {sheet === "bookmark" && (
        <BottomSheet title="Save bookmark" onClose={() => setSheet(null)}>
          <input className="input" placeholder="Label, e.g. before the argument…"
            value={bookmarkLabel} onChange={e => setBookmarkLabel(e.target.value)}
            onKeyDown={e => e.key === "Enter" && runBusy("bm-save", saveBookmark)} autoFocus />
          <button className="btn btn-primary btn-block" onClick={() => runBusy("bm-save", saveBookmark)}
            disabled={!bookmarkLabel.trim() || busy === "bm-save"}>
            <BusyIcon busy={busy === "bm-save"} Icon={Bookmark} /> {busy === "bm-save" ? "Saving…" : "Save bookmark"}
          </button>
        </BottomSheet>
      )}

      {sheet === "bookmarks" && (
        <BottomSheet title="Bookmarks" onClose={() => setSheet(null)}>
          {bookmarks.length === 0 && (
            <p className="sheet-note">No bookmarks saved yet. Use <b>Save</b> above the composer to keep a moment you may want to return to.</p>
          )}
          <div>
            {bookmarks.map(bm => (
              <div key={bm.id} className="bm-item">
                <div className="bm-item__body">
                  <div className="bm-item__label">{bm.label}</div>
                  <div className="bm-item__date">{parseServerDate(bm.created_at)?.toLocaleDateString()}</div>
                </div>
                <button className="btn btn-ghost btn-sm" disabled={!!busy}
                  onClick={() => runBusy(`restore-${bm.id}`, () => restoreBookmark(bm.id))}>
                  {busy === `restore-${bm.id}` && <Spinner size={13} />} Restore
                </button>
                <button className="icon-btn icon-btn--danger" aria-label={`Delete bookmark ${bm.label}`} disabled={!!busy}
                  onClick={() => runBusy(`del-${bm.id}`, async () => {
                    await api.deleteBookmark(bm.id);
                    setBookmarks(bs => bs.filter(b => b.id !== bm.id));
                  })}>
                  <BusyIcon busy={busy === `del-${bm.id}`} Icon={X} />
                </button>
              </div>
            ))}
          </div>
        </BottomSheet>
      )}

      {sheet === "search" && (
        <BottomSheet title="Search this chat" onClose={() => { setSheet(null); setSearchQuery(""); }}>
          <input className="input" placeholder="Search messages…" value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)} autoFocus />
          <p className="sheet-note mono">
            {searchQuery
              ? `${filteredMessages.length} result${filteredMessages.length !== 1 ? "s" : ""}, shown in the transcript`
              : "Matching messages are shown in the transcript behind this panel."}
          </p>
        </BottomSheet>
      )}

      {sheet === "commands" && (
        <BottomSheet title="/commands" onClose={() => setSheet(null)}>
          <pre className="ref">{COMMANDS_REF}</pre>
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
    <div className="versions">
      <button
        className="icon-btn"
        disabled={idx <= 0}
        onClick={() => onSwitch(forks[idx - 1])}
        aria-label="Previous version"
      >
        <ArrowL size={15} />
      </button>
      <span className="versions__count"><b>{idx + 1}</b> / {forks.length}</span>
      <button
        className="icon-btn"
        disabled={idx >= forks.length - 1}
        onClick={() => onSwitch(forks[idx + 1])}
        aria-label="Next version"
      >
        <ArrowR size={15} />
      </button>
      <span className="versions__label">versions</span>
    </div>
  );
}

// ── EDIT PANEL ────────────────────────────────────────────────────────────────
function EditPanel({ msg, fontSize, editText, saving, onEditChange, onEditConfirm, onEditCancel }) {
  const isUser = msg.role === "user";
  const ref = useRef(null);
  useAutoGrow(ref, editText);

  return (
    <div className="edit-panel">
      <div className="edit-panel__head">
        <span>{isUser ? "Editing your line" : "Editing reply"}</span>
        {msg.model && <span className="edit-panel__model">{msg.model}</span>}
      </div>
      <textarea
        ref={ref}
        autoFocus
        aria-label={isUser ? "Edit your line" : "Edit reply"}
        value={editText}
        onChange={e => onEditChange(e.target.value)}
        onKeyDown={e => {
          if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); onEditConfirm(); }
          if (e.key === "Escape") onEditCancel();
        }}
        style={{ fontSize }}
      />
      <div className="edit-panel__foot">
        <span className="edit-panel__hint">
          {isUser ? "Sending writes a new reply as another version." : "Saves this reply in place."}
        </span>
        <button className="btn btn-quiet btn-sm" onClick={onEditCancel}>Cancel</button>
        <button className="btn btn-primary btn-sm" onClick={onEditConfirm} disabled={saving}>
          {saving && <Spinner size={13} />} {isUser ? "Send edited" : saving ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}
