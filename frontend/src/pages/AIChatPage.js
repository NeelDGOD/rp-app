import React, { useEffect, useState, useRef, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { ChevronLeft, Send, Paperclip, X } from "lucide-react";
import { api } from "../lib/api";
import { useSlowLoad } from "../lib/useSlowLoad";
import { useToast } from "../components/Toast";

const MAX_IMAGE_DIM = 1280;
const IMAGE_QUALITY = 0.85;

function resizeImageToDataUrl(file, maxDim = MAX_IMAGE_DIM, quality = IMAGE_QUALITY) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new window.Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          const scale = maxDim / Math.max(width, height);
          width = Math.round(width * scale);
          height = Math.round(height * scale);
        }
        const canvas = document.createElement("canvas");
        canvas.width = width; canvas.height = height;
        canvas.getContext("2d").drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.onerror = reject;
      img.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// Message content from the server is either a plain string, or (when images
// were attached) an OpenAI-style multimodal parts array. Locally-optimistic
// messages (before the server round-trip) instead carry a separate `images`
// field alongside plain string `content`. This normalizes both shapes.
function extractParts(msg) {
  if (Array.isArray(msg.content)) {
    const text = msg.content.filter(p => p.type === "text").map(p => p.text).join("\n");
    const images = msg.content.filter(p => p.type === "image_url").map(p => p.image_url.url);
    return { text, images };
  }
  return { text: msg.content || "", images: msg.images || [] };
}

export default function AIChatPage() {
  const { chatId } = useParams();
  const nav = useNavigate();
  const toast = useToast();

  const [chat, setChat]           = useState(null);
  const [streaming, setStreaming] = useState(false);
  const [streamText, setStreamText] = useState("");
  const [input, setInput]         = useState("");
  const [images, setImages]       = useState([]); // staged data URLs, not yet sent

  const bottomRef = useRef(null);
  const fileInputRef = useRef(null);
  const fontSz = parseInt(localStorage.getItem("font_size") || "17");
  const slowLoad = useSlowLoad(!chat);

  const loadChat = useCallback(async () => {
    try {
      const data = await api.getAIChat(chatId);
      setChat(data);
      const saved = sessionStorage.getItem(`ai_draft_${chatId}`);
      if (saved) setInput(saved);
    } catch (e) { toast(e.message, "error"); }
  }, [chatId]);

  useEffect(() => { loadChat(); }, [loadChat]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chat?.history, streamText]);

  useEffect(() => {
    sessionStorage.setItem(`ai_draft_${chatId}`, input);
  }, [input, chatId]);

  async function handleFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    try {
      const dataUrls = await Promise.all(files.map(f => resizeImageToDataUrl(f)));
      setImages(prev => [...prev, ...dataUrls]);
    } catch {
      toast("Couldn't read that image", "error");
    }
  }

  function removeImage(idx) {
    setImages(prev => prev.filter((_, i) => i !== idx));
  }

  function handlePaste(e) {
    const files = Array.from(e.clipboardData?.items || [])
      .filter(it => it.type.startsWith("image/"))
      .map(it => it.getAsFile())
      .filter(Boolean);
    if (!files.length) return;
    e.preventDefault();
    handleFiles(files);
  }

  async function sendMessage() {
    if ((!input.trim() && images.length === 0) || streaming || !chat) return;
    const text = input.trim();
    const imgs = images;
    setInput(""); setImages([]);
    sessionStorage.removeItem(`ai_draft_${chatId}`);

    setStreaming(true); setStreamText("");

    const optimisticHistory = [
      ...chat.history,
      { role: "user", content: text, images: imgs },
    ];
    setChat(c => ({ ...c, history: optimisticHistory }));

    const historyAtSend = chat.history;

    api.sendAIChatStream(
      chatId,
      { content: text, images: imgs },
      (delta) => setStreamText(t => t + delta),
      async () => {
        setStreaming(false); setStreamText("");
        await loadChat();
      },
      (err) => {
        setStreaming(false); setStreamText("");
        setChat(c => ({ ...c, history: historyAtSend }));
        setInput(text); setImages(imgs);
        sessionStorage.setItem(`ai_draft_${chatId}`, text);
        toast(`API error: ${err.message}`, "error", 6000);
      }
    );
  }

  if (!chat) {
    return (
      <div style={{ padding: 32, textAlign: "center", color: "var(--text3)" }}>
        Loading…
        {slowLoad && (
          <div style={{ marginTop: 8, fontSize: 13 }}>
            ⚡ Waking up the server — this can take up to a minute on the free tier.
          </div>
        )}
      </div>
    );
  }

  const messages = chat.history.filter(m => m.role === "user" || m.role === "assistant");

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100dvh", background: "var(--bg)" }}>
      {/* ── HEADER ── */}
      <div style={{
        display: "flex", alignItems: "center", gap: 10, padding: "12px 12px 10px",
        borderBottom: "1px solid var(--border)", background: "var(--bg)",
        position: "sticky", top: 0, zIndex: 20,
      }}>
        <button className="btn-icon" onClick={() => nav("/ai-chats")}><ChevronLeft size={22} /></button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 17, fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {chat.name}
          </div>
        </div>
      </div>

      {/* ── MESSAGES ── */}
      <div style={{ flex: 1, overflowY: "auto", padding: "12px 12px 4px" }}>
        {messages.length === 0 && !streaming && (
          <div style={{ padding: 48, textAlign: "center", color: "var(--text3)" }}>
            <div style={{ fontSize: 32, marginBottom: 12 }}>✦</div>
            <div>Ask me anything</div>
            <div style={{ fontSize: 14, marginTop: 6 }}>Plain assistant — no character, no roleplay</div>
          </div>
        )}

        {messages.map((msg, i) => <MessageBubble key={i} msg={msg} fontSize={fontSz} />)}

        {streaming && streamText && (
          <MessageBubble msg={{ role: "assistant", content: streamText }} fontSize={fontSz} isStreaming />
        )}
        {streaming && !streamText && (
          <div style={{ display: "flex", gap: 6, padding: "10px 4px", alignItems: "center" }}>
            {[0, 1, 2].map(i => (
              <div key={i} style={{
                width: 6, height: 6, borderRadius: "50%", background: "var(--accent)",
                animation: "pulse 1.2s infinite", animationDelay: `${i * 0.2}s`
              }} />
            ))}
          </div>
        )}

        <div ref={bottomRef} style={{ height: 8 }} />
      </div>

      {/* ── STAGED IMAGES ── */}
      {images.length > 0 && (
        <div style={{ display: "flex", gap: 8, padding: "8px 12px 0", overflowX: "auto" }}>
          {images.map((src, i) => (
            <div key={i} style={{ position: "relative", flexShrink: 0 }}>
              <img src={src} alt="" style={{
                width: 56, height: 56, objectFit: "cover",
                borderRadius: "var(--radius-sm)", border: "1px solid var(--border)",
              }} />
              <button onClick={() => removeImage(i)} style={{
                position: "absolute", top: -6, right: -6, width: 20, height: 20,
                borderRadius: "50%", border: "none", background: "var(--bg4)",
                color: "var(--text)", display: "flex", alignItems: "center", justifyContent: "center",
                cursor: "pointer",
              }}>
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* ── INPUT ── */}
      <div style={{
        display: "flex", gap: 8, padding: "8px 12px",
        paddingBottom: "calc(8px + env(safe-area-inset-bottom, 0px))",
        background: "var(--bg)",
      }}>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          style={{ display: "none" }}
          onChange={e => { handleFiles(e.target.files); e.target.value = ""; }}
        />
        <button className="btn-icon" onClick={() => fileInputRef.current?.click()} style={{ alignSelf: "flex-end" }}>
          <Paperclip size={20} />
        </button>
        <textarea
          className="input"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
          onPaste={handlePaste}
          placeholder="Message the assistant… (paste an image with Ctrl+V)"
          rows={1}
          style={{ flex: 1, resize: "none", fontSize: fontSz, maxHeight: 120, overflowY: "auto" }}
        />
        <button onClick={sendMessage} disabled={(!input.trim() && images.length === 0) || streaming} style={{
          width: 42, height: 42, borderRadius: "50%", border: "none",
          background: (input.trim() || images.length) && !streaming ? "var(--accent)" : "var(--bg4)",
          color: (input.trim() || images.length) && !streaming ? "#1a1208" : "var(--text3)",
          display: "flex", alignItems: "center", justifyContent: "center",
          cursor: (input.trim() || images.length) && !streaming ? "pointer" : "default",
          transition: "all 0.15s", flexShrink: 0, alignSelf: "flex-end",
        }}>
          <Send size={18} />
        </button>
      </div>
    </div>
  );
}

// ── MESSAGE BUBBLE ────────────────────────────────────────────────────────────
function MessageBubble({ msg, fontSize, isStreaming }) {
  const isUser = msg.role === "user";
  const { text, images } = extractParts(msg);

  return (
    <div style={{ display: "flex", justifyContent: isUser ? "flex-end" : "flex-start", marginBottom: 4 }}>
      <div style={{
        maxWidth: "85%",
        padding: isUser ? "10px 14px" : "12px 16px",
        borderRadius: isUser
          ? "var(--radius-lg) var(--radius-lg) 4px var(--radius-lg)"
          : "var(--radius-lg) var(--radius-lg) var(--radius-lg) 4px",
        background: isUser ? "var(--bg4)" : "var(--bg2)",
        border: isUser ? "1px solid var(--border)" : "1px solid var(--border2)",
        fontSize, lineHeight: 1.65,
        color: isUser ? "var(--text2)" : "var(--text)",
        whiteSpace: "pre-wrap", wordBreak: "break-word",
      }} className={isStreaming ? "streaming-cursor" : ""}>
        {images.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: text ? 8 : 0 }}>
            {images.map((src, i) => (
              <img key={i} src={src} alt="" style={{
                maxWidth: 200, maxHeight: 200, borderRadius: "var(--radius-sm)",
                border: "1px solid var(--border)",
              }} />
            ))}
          </div>
        )}
        {text}
      </div>
    </div>
  );
}
