import React from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { MessageSquare, Bot, Settings } from "lucide-react";

const tabs = [
  { path: "/chats",    label: "Chats",    Icon: MessageSquare },
  { path: "/bots",     label: "Bots",     Icon: Bot },
  { path: "/settings", label: "Settings", Icon: Settings },
];

export default function BottomNav() {
  const loc = useLocation();
  const nav = useNavigate();
  // Hide on individual chat page
  if (loc.pathname.match(/^\/chats\/.+/)) return null;

  return (
    <nav style={{
      position: "fixed", bottom: 0, left: "50%", transform: "translateX(-50%)",
      width: "100%", maxWidth: 480,
      display: "flex", background: "var(--bg2)",
      borderTop: "1px solid var(--border)",
      paddingBottom: "env(safe-area-inset-bottom, 0px)",
      zIndex: 50,
    }}>
      {tabs.map(({ path, label, Icon }) => {
        const active = loc.pathname.startsWith(path);
        return (
          <button key={path} onClick={() => nav(path)} style={{
            flex: 1, display: "flex", flexDirection: "column", alignItems: "center",
            justifyContent: "center", padding: "10px 0", background: "none", border: "none",
            cursor: "pointer", color: active ? "var(--accent)" : "var(--text3)",
            transition: "color 0.15s", WebkitTapHighlightColor: "transparent",
            gap: 3,
          }}>
            <Icon size={20} strokeWidth={active ? 2.2 : 1.8} />
            <span style={{ fontSize: 11, fontFamily: "var(--mono)", letterSpacing: "0.3px" }}>{label}</span>
          </button>
        );
      })}
    </nav>
  );
}
