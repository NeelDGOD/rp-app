import React, { useEffect } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import ChatsPage from "./pages/ChatsPage";
import ChatPage from "./pages/ChatPage";
import BotsPage from "./pages/BotsPage";
import SettingsPage from "./pages/SettingsPage";
import LoginPage from "./pages/LoginPage";
import AIChatsPage from "./pages/AIChatsPage";
import AIChatPage from "./pages/AIChatPage";
import BottomNav from "./components/BottomNav";
import { pullSettingsPersistently } from "./lib/api";
import "./index.css";

function RequireAuth({ children }) {
  const authed = !!localStorage.getItem("auth_token");
  return authed ? children : <Navigate to="/login" replace />;
}

export default function App() {
  useEffect(() => {
    const pull = () => {
      if (localStorage.getItem("auth_token")) pullSettingsPersistently().catch(() => {});
    };
    const onVisible = () => { if (document.visibilityState === "visible") pull(); };
    pull();
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  return (
    <BrowserRouter>
      <div className="app-shell">
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/" element={<Navigate to="/chats" replace />} />
          <Route path="/chats" element={<RequireAuth><ChatsPage /></RequireAuth>} />
          <Route path="/chats/:chatId" element={<RequireAuth><ChatPage /></RequireAuth>} />
          <Route path="/ai-chats" element={<RequireAuth><AIChatsPage /></RequireAuth>} />
          <Route path="/ai-chats/:chatId" element={<RequireAuth><AIChatPage /></RequireAuth>} />
          <Route path="/bots" element={<RequireAuth><BotsPage /></RequireAuth>} />
          <Route path="/settings" element={<RequireAuth><SettingsPage /></RequireAuth>} />
        </Routes>
        <BottomNav />
      </div>
    </BrowserRouter>
  );
}
