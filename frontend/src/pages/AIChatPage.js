import React, { useEffect, useState, useRef, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { ChevronLeft, Paperclip, Sparkles, X } from "lucide-react";
import { api } from "../lib/api";
import { useBusy, useScrollToEnd } from "../lib/ui";
import { useToast } from "../components/Toast";
import ModelPickerButton from "../components/ModelPickerButton";
import { EmptyState, ErrorState, TranscriptSkeleton } from "../components/States";
import { Composer, Thinking, Turn } from "../components/Transcript";

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
  const [loadError, setLoadError] = useState("");

  const scrollerRef = useRef(null);
  const fileInputRef = useRef(null);
  const fontSz = parseInt(localStorage.getItem("font_size") || "17");
  const [busy, runBusy] = useBusy();

  const loadChat = useCallback(async () => {
    try {
      const data = await api.getAIChat(chatId);
      setChat(data);
      setLoadError("");
      const saved = sessionStorage.getItem(`ai_draft_${chatId}`);
      if (saved) setInput(saved);
    } catch (e) { setLoadError(e.message); toast(e.message, "error"); }
  }, [chatId]);

  useEffect(() => { loadChat(); }, [loadChat]);

  useScrollToEnd(scrollerRef, chat?.history, streamText);

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

  const proseVars = { "--prose-size": `${fontSz}px` };
  const backButton = (
    <button className="icon-btn bar__back" onClick={() => nav("/ai-chats")} aria-label="Back to AI chats"><ChevronLeft size={22} /></button>
  );

  if (!chat) {
    return (
      <div className="chat-screen" style={proseVars}>
        <header className="bar"><div className="chat-col bar__inner">{backButton}</div></header>
        {loadError ? (
          <div className="center-state">
            <ErrorState message={loadError} busy={busy === "reload"} onRetry={() => runBusy("reload", loadChat)} />
          </div>
        ) : (
          <div className="scroller"><div className="chat-col"><TranscriptSkeleton /></div></div>
        )}
      </div>
    );
  }

  const messages = chat.history.filter(m => m.role === "user" || m.role === "assistant");
  const canSend = (!!input.trim() || images.length > 0) && !streaming;

  return (
    <div className="chat-screen" style={proseVars}>
      {/* ── HEADER ── */}
      <header className="bar">
        <div className="chat-col bar__inner">
          {backButton}
          <div className="bar__title">
            <h1 className="bar__name">{chat.name}</h1>
            <div className="bar__sub"><ModelPickerButton /></div>
          </div>
        </div>
      </header>

      {/* ── TRANSCRIPT ── */}
      <div className="scroller" ref={scrollerRef}>
        <div className="chat-col transcript">
          {messages.length === 0 && !streaming && (
            <EmptyState icon={Sparkles} title="Ask anything"
              text="Plain assistant: no character, no roleplay. Paste or attach images if it helps." />
          )}

          {messages.map((msg, i) => {
            const { text, images: msgImages } = extractParts(msg);
            return (
              <Turn key={i} role={msg.role} speaker="Assistant" mode="plain" text={text} images={msgImages}
                showSpeaker={messages[i - 1]?.role !== "assistant"} />
            );
          })}

          {streaming && streamText && (
            <Turn role="assistant" speaker="Assistant" mode="plain" text={streamText} caret
              showSpeaker={messages[messages.length - 1]?.role !== "assistant"} />
          )}
          {streaming && !streamText && <Thinking speaker="Assistant" />}
        </div>
      </div>

      {/* ── DOCK ── */}
      <div className="dock">
        <div className="chat-col">
          {images.length > 0 && (
            <div className="staged">
              {images.map((src, i) => (
                <div key={i} className="staged__item">
                  <img src={src} alt={`Attachment ${i + 1}`} />
                  <button className="staged__remove" onClick={() => removeImage(i)} aria-label={`Remove attachment ${i + 1}`}>
                    <X size={13} />
                  </button>
                </div>
              ))}
            </div>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={e => { handleFiles(e.target.files); e.target.value = ""; }}
          />
          <div className="dock__gap" />
          <Composer
            value={input}
            onChange={setInput}
            onSend={sendMessage}
            onPaste={handlePaste}
            placeholder="Message the assistant…"
            canSend={canSend}
            busy={streaming}
            fontSize={fontSz}
            before={
              <button className="icon-btn" onClick={() => fileInputRef.current?.click()} aria-label="Attach images (or paste one)">
                <Paperclip size={19} />
              </button>
            }
          />
        </div>
      </div>
    </div>
  );
}
