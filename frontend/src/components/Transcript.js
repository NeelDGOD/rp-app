import React, { useRef } from "react";
import { ArrowUp } from "lucide-react";
import { Prose } from "../lib/format";
import { useActivity, useAutoGrow, useElapsed } from "../lib/ui";

// One turn of the story: the character's prose under a small name label, or the user's line as an inset cue.
export function Turn({ role, speaker, showSpeaker, text, images, mode, caret, onActivate }) {
  const isUser = role === "user";
  const tap = onActivate && {
    role: "button",
    tabIndex: 0,
    "aria-roledescription": isUser ? "your line, tap to edit" : "reply, tap to edit",
    onClick: onActivate,
    onKeyDown: e => { if (e.key === "Enter" && e.target === e.currentTarget) { e.preventDefault(); onActivate(); } },
  };
  return (
    <article className={`turn ${isUser ? "turn--user" : "turn--char"}${onActivate ? " turn--tap" : ""}`} {...tap}>
      {!isUser && showSpeaker && <div className="speaker">{speaker}</div>}
      {isUser && images?.length > 0 && (
        <div className="cue-images">{images.map((src, i) => <img key={i} src={src} alt="Attached" />)}</div>
      )}
      {(text || !isUser) && <Prose text={text} mode={mode} caret={caret} />}
    </article>
  );
}

const SLOW_REPLY_SECS = 20;

// Shown from the moment a message is sent until the first token arrives.
export function Thinking({ speaker }) {
  const secs = useElapsed();
  const { pending } = useActivity();
  const label = pending > 0 ? "Sending" : "Waiting for the model";
  return (
    <div className="turn turn--char" role="status">
      <div className="speaker">{speaker}</div>
      <div className="waiting">
        <div className="thinking" aria-hidden="true"><i /><i /><i /></div>
        <span className="waiting__label">
          {label}…{secs > 0 && <span className="waiting__secs">{secs}s</span>}
        </span>
      </div>
      {secs >= SLOW_REPLY_SECS && (
        <div className="waiting__note">Still waiting. Slow models can take a while; the reply appears here as soon as it starts.</div>
      )}
    </div>
  );
}

export function Composer({ inputRef, value, onChange, onSend, onPaste, placeholder, canSend, busy, fontSize, before }) {
  const ownRef = useRef(null);
  const ref = inputRef || ownRef;
  useAutoGrow(ref, value);
  return (
    <div className="composer">
      {before}
      <textarea
        ref={ref}
        value={value}
        onChange={e => onChange(e.target.value)}
        onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); onSend(); } }}
        onPaste={onPaste}
        placeholder={placeholder}
        aria-label={placeholder}
        rows={1}
        style={{ fontSize }}
      />
      <button
        className={`send-btn${busy ? " is-busy" : ""}`}
        onClick={onSend}
        disabled={!canSend}
        aria-label={busy ? "Writing…" : "Send"}
      >
        <ArrowUp size={19} strokeWidth={2.2} />
      </button>
    </div>
  );
}
