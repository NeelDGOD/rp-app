import React, { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { BookOpenText, Brain, ChevronDown, KeyRound, LogOut, RefreshCw, Trash2, UserRound, Wrench } from "lucide-react";
import { api, clearSession, pushSettingsSoon } from "../lib/api";
import ModelSettings from "../components/ModelSettings";
import { BusyIcon, PageHeader } from "../components/States";
import { Composer, Thinking, Turn } from "../components/Transcript";
import { Prose } from "../lib/format";
import { useBusy } from "../lib/ui";

const PREVIEW_TEXT = `*She looks away, biting her lip as if weighing whether to say it.* "You came back," she says at last. "I wasn't sure you would."`;

function Section({ id, title, sub, Icon, open, onToggle, children }) {
  return (
    <section className={`acc${open ? " is-open" : ""}`}>
      <button className="acc-head" aria-expanded={open} aria-controls={`acc-${id}`} onClick={onToggle}>
        <span className="acc-icon"><Icon size={17} strokeWidth={1.8} /></span>
        <span className="acc-titles">
          <span className="acc-title">{title}</span>
          <span className="acc-sub">{sub}</span>
        </span>
        <ChevronDown size={18} className="acc-chev" />
      </button>
      <div className="acc-panel" id={`acc-${id}`}>
        <div className="acc-inner"><div className="acc-body">{children}</div></div>
      </div>
    </section>
  );
}

function ToggleSetting({ label, sub, checked, onChange }) {
  return (
    <div className="setting">
      <div>
        <div className="setting__label">{label}</div>
        <div className="setting__sub">{sub}</div>
      </div>
      <label className="toggle">
        <input type="checkbox" checked={checked} aria-label={label} onChange={e => onChange(e.target.checked)} />
        <div className="toggle-track" />
        <div className="toggle-thumb" />
      </label>
    </div>
  );
}

export default function SettingsPage() {
  const nav = useNavigate();
  const [autoMem, setAutoMem]   = useState(true);
  const [useRag, setUseRag]     = useState(false);
  const [useFallbacks, setUseFallbacks] = useState(false);
  const [errorLog, setErrorLog] = useState(null);
  const [fontSize, setFontSize] = useState(17);
  const [openSections, setOpenSections] = useState(["model"]);
  const [busy, runBusy] = useBusy();

  // Test chat
  const [testMessages, setTestMessages] = useState([]);
  const [testInput, setTestInput]       = useState("");
  const [testStreaming, setTestStreaming] = useState(false);
  const [testStreamText, setTestStreamText] = useState("");
  const testScrollRef = useRef(null);

  useEffect(() => {
    setAutoMem(localStorage.getItem("auto_memory") !== "false");
    setUseRag(localStorage.getItem("use_rag") === "true");
    setUseFallbacks(localStorage.getItem("use_fallbacks") === "true");
    setFontSize(parseInt(localStorage.getItem("font_size") || "17"));
  }, []);

  // Scrolls only the test box itself, never the page.
  useEffect(() => {
    const el = testScrollRef.current;
    if (!el || (testMessages.length === 0 && !testStreamText)) return;
    el.scrollTop = el.scrollHeight;
  }, [testMessages, testStreamText]);

  async function loadErrorLog() {
    try { setErrorLog(await api.getLogs()); } catch { setErrorLog([]); }
  }

  async function clearErrorLog() {
    await api.clearLogs();
    setErrorLog([]);
  }

  function save(key, val) { localStorage.setItem(key, String(val)); pushSettingsSoon(); }

  async function sendTestMessage() {
    if (!testInput.trim() || testStreaming) return;
    const text = testInput.trim();
    setTestInput("");
    const newMessages = [...testMessages, { role: "user", content: text }];
    setTestMessages(newMessages);
    setTestStreaming(true);
    let accumulated = "";
    setTestStreamText("");

    api.testChatStream(
      newMessages,
      (delta) => {
        accumulated += delta;
        setTestStreamText(accumulated);
      },
      () => {
        setTestMessages(msgs => [...msgs, { role: "assistant", content: accumulated }]);
        setTestStreaming(false);
        setTestStreamText("");
      },
      (err) => {
        setTestStreaming(false);
        setTestStreamText("");
        setTestInput(text);
        setTestMessages(prev => prev.slice(0, -1));
        alert(`Error: ${err.message}`);
      }
    );
  }

  const section = id => ({
    id,
    open: openSections.includes(id),
    onToggle: () => setOpenSections(s => (s.includes(id) ? s.filter(x => x !== id) : [...s, id])),
  });

  return (
    <div className="page">
      <PageHeader title="Settings" />

      <div className="col">
        <Section {...section("model")} title="Model & API key" sub="Provider, key and the model that writes replies" Icon={KeyRound}>
          <ModelSettings />
        </Section>

        <Section {...section("memory")} title="Memory & behavior" sub="How the story remembers and recovers" Icon={Brain}>
          <ToggleSetting
            label="Auto memory update"
            sub="Updates memory every 6 turns automatically"
            checked={autoMem}
            onChange={v => { setAutoMem(v); save("auto_memory", v); }}
          />
          <ToggleSetting
            label="Embed memory for retrieval"
            sub="Saves each memory update so old details can be recalled in very long chats (uses your Gemini key)"
            checked={useRag}
            onChange={v => { setUseRag(v); save("use_rag", v); }}
          />
          <ToggleSetting
            label="Fall back to saved models"
            sub="If the current model fails before replying, try your other saved models in list order"
            checked={useFallbacks}
            onChange={v => { setUseFallbacks(v); save("use_fallbacks", v); }}
          />
        </Section>

        <Section {...section("reading")} title="Reading" sub={`Chat text size · ${fontSize}px`} Icon={BookOpenText}>
          <div className="field">
            <div className="subhead">
              <label className="field-label" htmlFor="font-size">Chat font size</label>
              <span className="mono field-hint">{fontSize}px</span>
            </div>
            <input id="font-size" className="range" type="range" min={14} max={22} value={fontSize}
              style={{ "--fill": `${((fontSize - 14) / 8) * 100}%` }}
              onChange={e => { const v = parseInt(e.target.value); setFontSize(v); save("font_size", v); }} />
            <div className="subhead field-hint"><span>Smaller</span><span>Larger</span></div>
          </div>
          <div className="preview-prose" style={{ "--prose-size": `${fontSize}px` }}>
            <div className="speaker">Preview</div>
            <Prose text={PREVIEW_TEXT} />
          </div>
        </Section>

        <Section {...section("tools")} title="Tools" sub="Test the model, read recent errors" Icon={Wrench}>
          <div className="field">
            <div className="subhead">
              <div>
                <div className="subhead__title">Model test chat</div>
                <div className="subhead__sub">Raw model, no character context</div>
              </div>
              {testMessages.length > 0 && (
                <button className="icon-btn" aria-label="Clear test chat"
                  onClick={() => { setTestMessages([]); setTestStreamText(""); }}>
                  <Trash2 size={16} />
                </button>
              )}
            </div>
            <div className="mini-transcript" ref={testScrollRef}>
              {testMessages.length === 0 && !testStreaming && (
                <div className="field-hint" style={{ margin: "auto" }}>Send a message to test the model</div>
              )}
              {testMessages.map((m, i) => (
                <Turn key={i} role={m.role} mode="plain" text={m.content} speaker="Model"
                  showSpeaker={testMessages[i - 1]?.role !== "assistant"} />
              ))}
              {testStreaming && testStreamText && (
                <Turn role="assistant" mode="plain" text={testStreamText} speaker="Model" showSpeaker caret />
              )}
              {testStreaming && !testStreamText && <Thinking speaker="Model" />}
            </div>
            <Composer
              value={testInput}
              onChange={setTestInput}
              onSend={sendTestMessage}
              placeholder="Type to test the model…"
              canSend={!!testInput.trim() && !testStreaming}
              busy={testStreaming}
              fontSize={16}
            />
          </div>

          <div className="divider" />

          <div className="field">
            <div className="subhead">
              <div>
                <div className="subhead__title">Error log</div>
                <div className="subhead__sub">Failed model calls from the last 14 days</div>
              </div>
              <div className="btn-row">
                <button className="icon-btn" aria-label="Refresh error log" disabled={!!busy} onClick={() => runBusy("logs", loadErrorLog)}>
                  <BusyIcon busy={busy === "logs"} Icon={RefreshCw} />
                </button>
                {errorLog?.length > 0 && (
                  <button className="icon-btn" aria-label="Clear error log" disabled={!!busy} onClick={() => runBusy("clear-logs", clearErrorLog)}>
                    <BusyIcon busy={busy === "clear-logs"} Icon={Trash2} />
                  </button>
                )}
              </div>
            </div>

            {errorLog === null ? (
              <div>
                <button className="btn btn-ghost btn-sm" disabled={!!busy} onClick={() => runBusy("logs", loadErrorLog)}>
                  {busy === "logs" ? "Loading…" : "Show errors"}
                </button>
              </div>
            ) : errorLog.length === 0 ? (
              <div className="saved-empty">No errors logged.</div>
            ) : (
              <div className="log-list">
                {errorLog.map(e => (
                  <div key={e.id} className="log-item">
                    <div className="log-item__head">
                      {e.kind} · {e.provider} / {e.model}
                      {e.fell_back ? <span className="tag">tried again</span> : null}
                    </div>
                    <div className="log-item__time">{new Date(e.created_at + "Z").toLocaleString()}</div>
                    <div className="log-item__msg">{e.message}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </Section>

        <Section {...section("account")} title="Account" sub={localStorage.getItem("auth_email") || "Signed in"} Icon={UserRound}>
          <div className="setting">
            <div>
              <div className="setting__label">Signed in</div>
              <div className="setting__sub">{localStorage.getItem("auth_email") || ""}</div>
            </div>
            <button className="btn btn-ghost btn-sm" disabled={busy === "logout"} onClick={() => runBusy("logout", async () => {
              try { await api.logout(); } catch {}
              clearSession();
              nav("/login", { replace: true });
            })}>
              <BusyIcon busy={busy === "logout"} Icon={LogOut} size={15} /> {busy === "logout" ? "Signing out…" : "Log out"}
            </button>
          </div>
        </Section>
      </div>
    </div>
  );
}
