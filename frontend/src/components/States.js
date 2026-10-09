import React from "react";
import { CloudOff } from "lucide-react";
import { friendlyError } from "../lib/ui";

export function PageHeader({ title, kicker, children }) {
  return (
    <header className="page-head">
      <div className="col page-head__inner">
        <div className="page-head__text">
          <h1 className="page-title">{title}</h1>
          {kicker && <div className="page-kicker">{kicker}</div>}
        </div>
        {children && <div className="page-head__actions">{children}</div>}
      </div>
    </header>
  );
}

export function Spinner({ size = 15 }) {
  return <span className="spinner" style={{ width: size, height: size }} aria-hidden="true" />;
}

// An icon that turns into a spinner while its action runs.
export function BusyIcon({ busy, Icon, size = 16 }) {
  return busy ? <Spinner size={size - 1} /> : <Icon size={size} />;
}

export function EmptyState({ icon: Icon, title, text, action, tone }) {
  return (
    <div className={`empty${tone === "error" ? " empty--error" : ""}`}>
      <div className="empty__glyph"><Icon size={22} strokeWidth={1.6} /></div>
      <div className="empty__title">{title}</div>
      {text && <div className="empty__text">{text}</div>}
      {action}
    </div>
  );
}

export function ErrorState({ message, onRetry, busy }) {
  return (
    <EmptyState
      icon={CloudOff}
      tone="error"
      title="Couldn't load this"
      text={friendlyError(message)}
      action={onRetry && (
        <button className="btn btn-ghost" onClick={onRetry} disabled={busy}>
          {busy && <Spinner />} Try again
        </button>
      )}
    />
  );
}

export function ListSkeleton({ rows = 5 }) {
  return (
    <div className="skeleton-list" aria-busy="true" aria-label="Loading">
      <span className="skel skel--label" />
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton-row" style={{ opacity: 1 - i * 0.15 }}>
          <span className="skel skel--title" />
          <span className="skel skel--meta" />
        </div>
      ))}
    </div>
  );
}

const SKELETON_TURNS = [[92, 100, 96, 54], [70, 38], [100, 94, 98, 88, 41]];

export function TranscriptSkeleton() {
  return (
    <div className="transcript-skeleton" aria-busy="true" aria-label="Loading the story">
      {SKELETON_TURNS.map((lines, t) => (
        <div key={t} className={t % 2 ? "skel-turn skel-turn--cue" : "skel-turn"}>
          {t % 2 === 0 && <span className="skel skel--speaker" />}
          {lines.map((w, i) => <span key={i} className="skel skel--line" style={{ width: `${w}%` }} />)}
        </div>
      ))}
    </div>
  );
}
