import React from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import ChatsPage from "./pages/ChatsPage";
import ChatPage from "./pages/ChatPage";
import BotsPage from "./pages/BotsPage";
import SettingsPage from "./pages/SettingsPage";
import BottomNav from "./components/BottomNav";
import "./index.css";

export default function App() {
  return (
    <BrowserRouter>
      <div className="app-shell">
        <Routes>
          <Route path="/" element={<Navigate to="/chats" replace />} />
          <Route path="/chats" element={<ChatsPage />} />
          <Route path="/chats/:chatId" element={<ChatPage />} />
          <Route path="/bots" element={<BotsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
        <BottomNav />
      </div>
    </BrowserRouter>
  );
}
