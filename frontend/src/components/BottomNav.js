import React from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { BookOpen, Feather, Settings2, Sparkles } from "lucide-react";

const tabs = [
  { path: "/chats",    label: "Chats",    Icon: BookOpen },
  { path: "/ai-chats", label: "AI",       Icon: Sparkles },
  { path: "/bots",     label: "Bots",     Icon: Feather },
  { path: "/settings", label: "Settings", Icon: Settings2 },
];

export default function BottomNav() {
  const loc = useLocation();
  const nav = useNavigate();
  if (loc.pathname === "/login") return null;
  // Individual chat screens need the full phone height for the composer; the desktop rail costs no height, so it stays.
  const inChat = /^\/(chats|ai-chats)\/.+/.test(loc.pathname);

  return (
    <nav className={`nav${inChat ? " nav--hide-mobile" : ""}`} aria-label="Main">
      <div className="nav-mark" aria-hidden="true">r<span>·</span>p</div>
      {tabs.map(({ path, label, Icon }) => {
        const active = loc.pathname.startsWith(path);
        return (
          <button
            key={path}
            className={`nav-tab${active ? " is-active" : ""}`}
            aria-current={active ? "page" : undefined}
            onClick={() => nav(path)}
          >
            <Icon size={20} strokeWidth={active ? 2 : 1.7} />
            <span>{label}</span>
          </button>
        );
      })}
    </nav>
  );
}
