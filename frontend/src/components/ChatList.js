import React from "react";
import { MoreHorizontal } from "lucide-react";
import { groupByRecency, relativeTime } from "../lib/time";

export default function ChatList({ chats, metaFor, onOpen, onMore }) {
  let i = 0;
  return (
    <div>
      {groupByRecency(chats).map(group => (
        <section key={group.label} className="stagger" aria-label={group.label}>
          <h2 className="section-label" style={{ "--i": i++ }}>{group.label}</h2>
          {group.items.map(c => (
            <div
              key={c.id}
              className="row"
              role="link"
              tabIndex={0}
              style={{ "--i": i++ }}
              onClick={() => onOpen(c)}
              onKeyDown={e => { if (e.key === "Enter") onOpen(c); }}
            >
              <div className="row__body">
                <div className="row__title">{c.name}</div>
                <div className="row__meta">
                  <span className="row__meta-main">{metaFor(c)}</span>
                  <span className="row__sep" />
                  <span className="row__time">{relativeTime(c.updated_at)}</span>
                </div>
              </div>
              <button
                className="icon-btn"
                aria-label={`Options for ${c.name}`}
                onClick={e => { e.stopPropagation(); onMore(c); }}
                onKeyDown={e => e.stopPropagation()}
              >
                <MoreHorizontal size={18} />
              </button>
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}
