import os, re, json, uuid, secrets, asyncio, threading, time, base64, hashlib
from datetime import datetime
from typing import Optional
from fastapi import FastAPI, HTTPException, Header, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
# from huggingface_hub import InferenceClient
from openai import OpenAI
import bcrypt
import httpx
from cryptography.fernet import Fernet

# ── CONFIG ────────────────────────────────────────────────────────────────────
TURSO_URL   = os.environ.get("TURSO_URL", "file:rp.db")
TURSO_TOKEN = os.environ.get("TURSO_TOKEN", "")
DEFAULT_MODEL = "gemini-3.8-flash"
OPENAI_COMPAT_BASE_URLS = {
    "openrouter": "https://openrouter.ai/api/v1",
    "nvidia": "https://integrate.api.nvidia.com/v1",
    "gemini": "https://generativelanguage.googleapis.com/v1beta/openai/",
    "mistral": "https://api.mistral.ai/v1",
    "groq": "https://api.groq.com/openai/v1",
    "navy": "https://api.navy/v1",
    "puter": "https://api.puter.com/puterai/openai/v1/",
}
# A stalled provider (Puter can hang instead of erroring once its allowance is
# spent) must fail fast so the fallback chain can take over.
LLM_TIMEOUT = 60
LLM_MAX_RETRIES = 1
MAX_CONTEXT   = 20
MEM_INTERVAL  = 6
EMBED_MODEL   = "gemini-embedding-001"
EMBED_DIMS    = 768
RAG_TOP_K     = 3
ADMIN_EMAIL   = "admin@chat.com"
ADMIN_PASSWORD = "admin"
KEYS_SECRET   = os.environ.get("KEYS_SECRET", "")
SYNCED_SETTINGS = (
    # "hf_token", "hf_model",
    "openrouter_token", "nvidia_token", "gemini_token", "mistral_token", "groq_token", "navy_token", "puter_token",
    "openrouter_model", "nvidia_model", "gemini_model", "mistral_model", "groq_model", "navy_model", "puter_model",
    "llm_provider", "saved_models", "use_fallbacks",
)

app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

def ts(): return datetime.utcnow().isoformat()

# ── DATABASE ──────────────────────────────────────────────────────────────────
class _DBConnWrapper:
    def __init__(self, inner):
        self._inner = inner
    def __getattr__(self, name):
        return getattr(self._inner, name)
    def close(self):
        close = getattr(self._inner, "close", None)
        if close:
            close()

def get_db():
    try:
        import libsql_experimental as libsql
        if TURSO_TOKEN:
            conn = libsql.connect(TURSO_URL, auth_token=TURSO_TOKEN)
        else:
            conn = libsql.connect(TURSO_URL)
        return _DBConnWrapper(conn)
    except ImportError:
        import sqlite3
        conn = sqlite3.connect(TURSO_URL.replace("file:", ""))
        conn.row_factory = sqlite3.Row
        return conn

def q(conn, sql, params=()):
    cur = conn.execute(sql, params)
    return cur

# cursor.description is unreliable across libsql_experimental versions (some
# builds return it empty even for successful SELECT *), so column names are
# passed explicitly per table instead of introspected from the cursor.
TABLE_COLS = {
    "users": ["id", "email", "password_hash", "created_at"],
    "sessions": ["token", "user_id", "created_at"],
    "bots": ["id", "name", "content", "created_at", "updated_at", "user_id"],
    "chats": ["id", "name", "bot_id", "created_at", "updated_at", "user_id"],
    "branches": ["id", "chat_id", "parent_branch_id", "fork_message_index",
                 "history", "memory", "turn_counter", "created_at", "updated_at", "director_note"],
    "bookmarks": ["id", "chat_id", "branch_id", "label", "history", "memory",
                  "turn_counter", "created_at"],
    "memory_chunks": ["id", "branch_id", "content", "embedding", "created_at"],
    "ai_chats": ["id", "name", "history", "created_at", "updated_at", "user_id"],
    "user_settings": ["user_id", "data"],
}

def rows(conn, sql, params=(), cols=None):
    cur = conn.execute(sql, params)
    if cols is None:
        cols = [d[0] for d in cur.description]
    return [dict(zip(cols, r)) for r in cur.fetchall()]

def row(conn, sql, params=(), cols=None):
    r = rows(conn, sql, params, cols)
    return r[0] if r else None

TRANSIENT_DB_ERRORS = ("Stream already in use", "stream not found")

def with_db_retry(fn):
    """Run a block of database work, retrying on libsql's transient Hrana stream
    errors — 'stream already in use' (concurrent requests racing on the same
    underlying stream) and 'stream not found' (the server dropped it) — instead
    of surfacing them to the user or crashing startup."""
    for attempt in range(3):
        try:
            return fn()
        except Exception as e:
            if any(msg in str(e) for msg in TRANSIENT_DB_ERRORS) and attempt < 2:
                time.sleep(0.3 * (attempt + 1))
                continue
            raise

def init_db():
    conn = get_db()
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL, created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sessions (
            token TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS bots (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, content TEXT NOT NULL,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS chats (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, bot_id TEXT NOT NULL,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS branches (
            id TEXT PRIMARY KEY, chat_id TEXT NOT NULL,
            parent_branch_id TEXT, fork_message_index INTEGER NOT NULL DEFAULT 0,
            history TEXT NOT NULL DEFAULT '[]', memory TEXT NOT NULL DEFAULT '',
            turn_counter INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
            director_note TEXT NOT NULL DEFAULT ''
        );
        CREATE TABLE IF NOT EXISTS bookmarks (
            id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, branch_id TEXT NOT NULL,
            label TEXT NOT NULL, history TEXT NOT NULL, memory TEXT NOT NULL DEFAULT '',
            turn_counter INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS memory_chunks (
            id TEXT PRIMARY KEY, branch_id TEXT NOT NULL,
            content TEXT NOT NULL, embedding TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS ai_chats (
            id TEXT PRIMARY KEY, name TEXT NOT NULL,
            history TEXT NOT NULL DEFAULT '[]',
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
            user_id TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS user_settings (
            user_id TEXT PRIMARY KEY, data TEXT NOT NULL
        );
    """)
    conn.commit()
    conn.close()

with_db_retry(init_db)

# ── AUTH ──────────────────────────────────────────────────────────────────────
def hash_password(pw: str) -> str:
    return bcrypt.hashpw(pw.encode(), bcrypt.gensalt()).decode()

def verify_password(pw: str, hashed: str) -> bool:
    return bcrypt.checkpw(pw.encode(), hashed.encode())

def run_migrations():
    conn = get_db()
    # bots/chats predate per-user ownership — add the column for older deployments.
    # CREATE TABLE IF NOT EXISTS above won't add columns to an already-existing table.
    for stmt in ("ALTER TABLE bots ADD COLUMN user_id TEXT",
                 "ALTER TABLE chats ADD COLUMN user_id TEXT",
                 "ALTER TABLE branches ADD COLUMN director_note TEXT NOT NULL DEFAULT ''"):
        try:
            conn.execute(stmt)
        except Exception:
            pass
    conn.commit()

    admin = row(conn, "SELECT * FROM users WHERE email=?", (ADMIN_EMAIL,), cols=TABLE_COLS["users"])
    if admin:
        admin_id = admin["id"]
    else:
        admin_id = str(uuid.uuid4())
        q(conn, "INSERT INTO users VALUES (?,?,?,?)",
          (admin_id, ADMIN_EMAIL, hash_password(ADMIN_PASSWORD), ts()))
        conn.commit()

    # Any bot/chat created before accounts existed belongs to admin.
    q(conn, "UPDATE bots SET user_id=? WHERE user_id IS NULL OR user_id=''", (admin_id,))
    q(conn, "UPDATE chats SET user_id=? WHERE user_id IS NULL OR user_id=''", (admin_id,))
    conn.commit()
    conn.close()

with_db_retry(run_migrations)

def require_user(x_auth_token: str = Header(...)) -> str:
    conn = get_db()
    s = row(conn, "SELECT * FROM sessions WHERE token=?", (x_auth_token,), cols=TABLE_COLS["sessions"])
    conn.close()
    if not s:
        raise HTTPException(401, "Invalid or expired session")
    return s["user_id"]

class LoginReq(BaseModel):
    email: str
    password: str

@app.post("/auth/register")
def register(data: LoginReq):
    email = data.email.strip().lower()
    if "@" not in email:
        raise HTTPException(400, "Invalid email")
    if len(data.password) < 4:
        raise HTTPException(400, "Password must be at least 4 characters")
    conn = get_db()
    existing = row(conn, "SELECT * FROM users WHERE email=?", (email,), cols=TABLE_COLS["users"])
    if existing:
        conn.close()
        raise HTTPException(400, "An account with that email already exists")
    uid = str(uuid.uuid4())
    q(conn, "INSERT INTO users VALUES (?,?,?,?)", (uid, email, hash_password(data.password), ts()))
    token = secrets.token_hex(32)
    q(conn, "INSERT INTO sessions VALUES (?,?,?)", (token, uid, ts()))
    conn.commit(); conn.close()
    return {"token": token, "email": email}

@app.post("/auth/login")
def login(data: LoginReq):
    conn = get_db()
    u = row(conn, "SELECT * FROM users WHERE email=?", (data.email.strip().lower(),), cols=TABLE_COLS["users"])
    if not u or not verify_password(data.password, u["password_hash"]):
        conn.close()
        raise HTTPException(401, "Invalid email or password")
    token = secrets.token_hex(32)
    q(conn, "INSERT INTO sessions VALUES (?,?,?)", (token, u["id"], ts()))
    conn.commit(); conn.close()
    return {"token": token, "email": u["email"]}

@app.post("/auth/logout")
def logout(x_auth_token: str = Header(...)):
    conn = get_db()
    q(conn, "DELETE FROM sessions WHERE token=?", (x_auth_token,))
    conn.commit(); conn.close()
    return {"ok": True}

@app.get("/auth/me")
def me(user_id: str = Depends(require_user)):
    conn = get_db()
    u = row(conn, "SELECT * FROM users WHERE id=?", (user_id,), cols=TABLE_COLS["users"])
    conn.close()
    if not u: raise HTTPException(404)
    return {"email": u["email"]}

# ── SETTINGS (API keys + model choices, stored per account, encrypted at rest) ─
def settings_cipher() -> Fernet:
    if not KEYS_SECRET:
        raise HTTPException(503, "KEYS_SECRET is not configured on the server")
    return Fernet(base64.urlsafe_b64encode(hashlib.sha256(KEYS_SECRET.encode()).digest()))

class SettingsPayload(BaseModel):
    settings: dict

@app.get("/settings")
def get_settings(user_id: str = Depends(require_user)):
    cipher = settings_cipher()
    conn = get_db()
    r = row(conn, "SELECT * FROM user_settings WHERE user_id=?", (user_id,), cols=TABLE_COLS["user_settings"])
    conn.close()
    return {"settings": json.loads(cipher.decrypt(r["data"].encode())) if r else {}}

@app.put("/settings")
def put_settings(data: SettingsPayload, user_id: str = Depends(require_user)):
    cipher = settings_cipher()
    settings = {k: v for k, v in data.settings.items() if k in SYNCED_SETTINGS and isinstance(v, str) and v}
    conn = get_db()
    q(conn, "INSERT OR REPLACE INTO user_settings VALUES (?,?)", (user_id, cipher.encrypt(json.dumps(settings).encode()).decode()))
    conn.commit(); conn.close()
    return {"ok": True}

# ── MODELS ────────────────────────────────────────────────────────────────────
class BotCreate(BaseModel):
    name: str; content: str

class BotUpdate(BaseModel):
    name: Optional[str] = None; content: Optional[str] = None

class ChatCreate(BaseModel):
    name: str; bot_id: str

class Rename(BaseModel):
    name: str

class SendMsg(BaseModel):
    content: str; branch_id: str; is_first_turn: bool = False

class RetryMsg(BaseModel):
    branch_id: str; hint: str = ""

class BookmarkCreate(BaseModel):
    branch_id: str; label: str

class RestoreHistory(BaseModel):
    history: list; memory: str = ""; turn_counter: int = 0

class AIChatCreate(BaseModel):
    name: str = "New Chat"

class AIChatSendMsg(BaseModel):
    content: str
    images: list = []  # data URLs (base64), optional

# ── SYSTEM PROMPT ─────────────────────────────────────────────────────────────
CMD_RULES = """
COMMAND OVERRIDE RULE:
Anything inside {curly brackets} is a DIRECT COMMAND. You MUST follow it exactly.
- {short}            = 2-3 sentences only, reactive and punchy
- {long}             = full immersive scene, 3-5 paragraphs
- {continue}         = continue scene forward without waiting for user
- {narrator} [text]  = one third-person narrative transition paragraph only
- {as [description]} = adopt described tone/persona for this reply only

Always write detailed immersive roleplay.
Describe body language, tone, emotional shifts.
Use inner italic thoughts naturally.
Only output immersive roleplay text.
"""

def sys_msg(bot_content: str) -> dict:
    return {"role": "system", "content": f"{bot_content}\n\n{CMD_RULES}"}

AI_CHAT_SYSTEM_PROMPT = "You are a helpful, knowledgeable assistant. Answer directly and naturally, with no persona or roleplay."

def ai_msg_content(text: str, images: list):
    if not images:
        return text
    parts = []
    if text:
        parts.append({"type": "text", "text": text})
    for img in images:
        parts.append({"type": "image_url", "image_url": {"url": img}})
    return parts

# ── MEMORY ────────────────────────────────────────────────────────────────────
def mem_field(memory: str, field: str) -> str:
    if not memory: return ""
    m = re.search(rf"{field}:\s*\n(.*?)(?=\n[A-Z &]+:|$)", memory, re.DOTALL | re.IGNORECASE)
    return m.group(1).strip() if m else ""

def resume_injection(memory: str) -> Optional[dict]:
    scene = mem_field(memory, "CURRENT SCENE")
    mood  = mem_field(memory, "EMOTIONAL STATE")
    if not scene and not mood: return None
    parts = ["You are resuming this roleplay session."]
    if scene: parts.append(f"Last scene: {scene}")
    if mood:  parts.append(f"Your current emotional state: {mood}")
    parts.append("Pick up naturally from where things left off.")
    return {"role": "system", "content": "\n".join(parts)}

def build_send_history(history: list, memory: str, resume: Optional[dict] = None) -> list:
    # Stored messages carry extra fields (e.g. "model") that strict providers reject.
    send = [{"role": m["role"], "content": m["content"]} for m in [history[0]] + history[-MAX_CONTEXT:]]
    i = 1
    if memory:
        send.insert(i, {"role": "system", "content": f"RP MEMORY:\n{memory}"}); i += 1
    if resume:
        send.insert(i, resume)
    return send

def get_client(provider: str, token: str, model: str):
    """Return (chat client, model id) for the requested provider. Every provider
    in OPENAI_COMPAT_BASE_URLS takes the model id as-is via its OpenAI-compatible API."""
    # A pasted key often carries a trailing space/newline, which the HTTP layer
    # rejects and the OpenAI client reports only as a bare "Connection error.".
    return OpenAI(api_key=token.strip(), base_url=OPENAI_COMPAT_BASE_URLS[provider],
                  timeout=LLM_TIMEOUT, max_retries=LLM_MAX_RETRIES), model
    # Hugging Face (disabled: free accounts no longer get Inference Providers credits).
    # "huggingface" expects a "repo_id:provider" model string as copied from HF's model page.
    # if ":" in model:
    #     repo_id, hf_provider = model.split(":", 1)
    # else:
    #     repo_id, hf_provider = model, "auto"
    # return InferenceClient(provider=hf_provider, api_key=token), repo_id

def llm_candidates(x_hf_token: str = Header(...), x_model: str = Header(default=DEFAULT_MODEL),
                   x_provider: str = Header(default="gemini"), x_fallbacks: str = Header(default="[]")) -> list:
    """The selected (provider, token, model) followed by the user's fallbacks, in order."""
    return [(x_provider, x_hf_token, x_model)] + [(f["provider"], f["token"], f["model"]) for f in json.loads(x_fallbacks)]

def complete(llm: list, messages: list) -> str:
    for i, (provider, token, model) in enumerate(llm):
        client, model_id = get_client(provider, token, model)
        try:
            return client.chat.completions.create(model=model_id, messages=messages).choices[0].message.content
        except Exception:
            if i == len(llm) - 1:
                raise

# Provider SDKs iterate the stream synchronously (blocking network I/O per chunk).
# Running that directly inside an `async def` route blocks the whole event loop,
# freezing every other request until the provider responds. Running the iteration
# on a worker thread and relaying chunks through a queue keeps a slow/stuck
# provider from stalling anything but its own request.
class _KeepAlive:
    pass

KEEPALIVE = _KeepAlive()
KEEPALIVE_INTERVAL = 15  # seconds of silence tolerated before emitting a heartbeat

class LLMStream:
    """Async-iterable chunk stream; `model` names the candidate that served it."""
    model = ""

    def __init__(self):
        self.gen = None

    def __aiter__(self):
        return self.gen

def stream_chat(llm: list, messages: list):
    result = LLMStream()
    queue: asyncio.Queue = asyncio.Queue()
    loop = asyncio.get_event_loop()
    done = object()

    def worker():
        try:
            for i, (provider, token, model) in enumerate(llm):
                client, model_id = get_client(provider, token, model)
                started = False
                try:
                    for chunk in client.chat.completions.create(model=model_id, messages=messages, stream=True):
                        if chunk.choices and chunk.choices[0].delta.content:
                            started = True
                            result.model = f"{provider} / {model}"
                        loop.call_soon_threadsafe(queue.put_nowait, chunk)
                    return
                except Exception:
                    # Once text has reached the user, switching models would splice
                    # two different replies together, so only fall back before that.
                    if started or i == len(llm) - 1:
                        raise
        except Exception as e:
            loop.call_soon_threadsafe(queue.put_nowait, e)
        finally:
            loop.call_soon_threadsafe(queue.put_nowait, done)

    threading.Thread(target=worker, daemon=True).start()

    # Render sits behind a proxy that drops connections that go quiet for too
    # long. A slow-to-start provider (cold model, etc.) could otherwise leave
    # the response with zero bytes sent for minutes, so a heartbeat is emitted
    # on the queue timeout to keep the connection alive until real data shows up.
    async def gen():
        while True:
            try:
                item = await asyncio.wait_for(queue.get(), timeout=KEEPALIVE_INTERVAL)
            except asyncio.TimeoutError:
                yield KEEPALIVE
                continue
            if item is done:
                return
            if isinstance(item, Exception):
                raise item
            yield item

    result.gen = gen()
    return result

def do_memory_update(history: list, current_memory: str, llm: list, director_note: str = "") -> tuple:
    text = "\n".join(
        f"{'User' if m['role']=='user' else 'Bot'}: {m['content']}"
        for m in history[-20:] if m["role"] in ("user", "assistant")
    )
    directive_block = ""
    if director_note:
        directive_block = f"""

ACTIVE DIRECTOR NOTE (an out-of-character instruction currently overriding the character's default behavior): "{director_note}"
Judge from the NEW CONVERSATION whether this note still applies to the current scene, or whether the moment it
was about has clearly passed. After the memory document, add exactly one final line, nothing after it:
DIRECTOR_NOTE: KEEP
or
DIRECTOR_NOTE: DROP"""

    prompt = [
        {"role": "system", "content": f"""Maintain a persistent memory document for an ongoing roleplay.
Given EXISTING memory + NEW conversation, return a fully UPDATED memory document.
NEVER remove old info. Only add or update. Output ONLY the memory document in this structure:

CHARACTERS:
RELATIONSHIP:
KEY EVENTS:
PROMISES & SECRETS:
CURRENT SCENE:
EMOTIONAL STATE:{directive_block}"""},
        {"role": "user", "content": f"EXISTING MEMORY:\n{current_memory or '(none yet)'}\n\nNEW CONVERSATION:\n{text}\n\nReturn the fully updated memory document."}
    ]
    raw = complete(llm, prompt)

    new_note = director_note
    m = re.search(r"DIRECTOR_NOTE:\s*(KEEP|DROP)", raw, re.IGNORECASE)
    if m:
        raw = raw[:m.start()].rstrip()
        if m.group(1).upper() == "DROP":
            new_note = ""
    return raw, new_note

# ── RAG (memory chunk embedding + retrieval) ─────────────────────────────────
# Embeddings are computed remotely via Gemini's API rather than loading
# sentence-transformers/torch in-process — that combo's memory footprint was
# what kept OOM-killing the server on free-tier hosts.
def embed_text(text: str, token: str, task: str) -> list:
    r = httpx.post(
        f"https://generativelanguage.googleapis.com/v1beta/models/{EMBED_MODEL}:embedContent",
        headers={"x-goog-api-key": token.strip()},
        json={"content": {"parts": [{"text": text}]}, "taskType": task, "outputDimensionality": EMBED_DIMS},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["embedding"]["values"]

def cosine_similarity(a: list, b: list) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    norm_a = sum(x * x for x in a) ** 0.5
    norm_b = sum(y * y for y in b) ** 0.5
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return dot / (norm_a * norm_b)

def store_memory_chunk(branch_id: str, content: str, token: str):
    conn = get_db()
    q(conn, "INSERT INTO memory_chunks VALUES (?,?,?,?,?)",
      (str(uuid.uuid4()), branch_id, content, json.dumps(embed_text(content, token, "RETRIEVAL_DOCUMENT")), ts()))
    conn.commit(); conn.close()

def retrieve_relevant_chunks(branch_id: str, query: str, token: str, k: int = RAG_TOP_K) -> list:
    conn = get_db()
    chunks = rows(conn, "SELECT content, embedding FROM memory_chunks WHERE branch_id=?", (branch_id,), cols=["content", "embedding"])
    conn.close()
    if not chunks:
        return []
    query_vec = embed_text(query, token, "RETRIEVAL_QUERY")
    # Chunks stored by the earlier HF bge-small model have a different vector
    # length and can't be compared against Gemini vectors, so they're skipped.
    scored = [(cosine_similarity(query_vec, vec), c["content"])
              for c in chunks if len(vec := json.loads(c["embedding"])) == len(query_vec)]
    scored.sort(key=lambda x: x[0], reverse=True)
    return [content for _, content in scored[:k]]

# ── HELPERS ───────────────────────────────────────────────────────────────────
def get_branch_data(branch_id: str) -> dict:
    conn = get_db()
    b = row(conn, "SELECT * FROM branches WHERE id=?", (branch_id,), cols=TABLE_COLS["branches"])
    conn.close()
    if not b: raise HTTPException(404, "Branch not found")
    b["history"] = json.loads(b["history"])
    if not b["history"]:
        b["history"] = []
    return b

def db_write(sql: str, params: tuple = ()):
    def _do():
        conn = get_db()
        q(conn, sql, params)
        conn.commit(); conn.close()
    with_db_retry(_do)

def touch_chat(chat_id: str):
    db_write("UPDATE chats SET updated_at=? WHERE id=?", (ts(), chat_id))

def save_branch(branch_id: str, history: list, memory: str, turns: int, director_note: str):
    db_write("UPDATE branches SET history=?,memory=?,turn_counter=?,director_note=?,updated_at=? WHERE id=?",
             (json.dumps(history), memory, turns, director_note, ts(), branch_id))

def get_bot(bot_id: str, conn=None, user_id: str = None) -> dict:
    close = conn is None
    if close: conn = get_db()
    b = row(conn, "SELECT * FROM bots WHERE id=?", (bot_id,), cols=TABLE_COLS["bots"])
    if close: conn.close()
    if not b or (user_id is not None and b["user_id"] != user_id):
        raise HTTPException(404, "Bot not found")
    return b

def chat_owned(chat_id: str, user_id: str, conn=None) -> dict:
    close = conn is None
    if close: conn = get_db()
    c = row(conn, "SELECT * FROM chats WHERE id=?", (chat_id,), cols=TABLE_COLS["chats"])
    if close: conn.close()
    if not c or c["user_id"] != user_id:
        raise HTTPException(404, "Chat not found")
    return c

def branch_owned(branch_id: str, user_id: str) -> dict:
    conn = get_db()
    b = row(conn, "SELECT * FROM branches WHERE id=?", (branch_id,), cols=TABLE_COLS["branches"])
    conn.close()
    if not b: raise HTTPException(404, "Branch not found")
    chat_owned(b["chat_id"], user_id)
    return b

def bookmark_owned(bookmark_id: str, user_id: str) -> dict:
    conn = get_db()
    bm = row(conn, "SELECT * FROM bookmarks WHERE id=?", (bookmark_id,), cols=TABLE_COLS["bookmarks"])
    conn.close()
    if not bm: raise HTTPException(404, "Bookmark not found")
    chat_owned(bm["chat_id"], user_id)
    return bm

def ai_chat_owned(chat_id: str, user_id: str, conn=None) -> dict:
    close = conn is None
    if close: conn = get_db()
    c = row(conn, "SELECT * FROM ai_chats WHERE id=?", (chat_id,), cols=TABLE_COLS["ai_chats"])
    if close: conn.close()
    if not c or c["user_id"] != user_id:
        raise HTTPException(404, "Chat not found")
    return c

# ── BOTS ──────────────────────────────────────────────────────────────────────
@app.get("/bots")
def list_bots(user_id: str = Depends(require_user)):
    conn = get_db()
    r = rows(conn, "SELECT * FROM bots WHERE user_id=? ORDER BY name", (user_id,), cols=TABLE_COLS["bots"])
    conn.close(); return r

@app.post("/bots")
def create_bot(data: BotCreate, user_id: str = Depends(require_user)):
    conn = get_db(); bid = str(uuid.uuid4()); n = ts()
    q(conn, "INSERT INTO bots VALUES (?,?,?,?,?,?)", (bid, data.name, data.content, n, n, user_id))
    conn.commit(); conn.close()
    return {"id": bid, "name": data.name, "content": data.content, "created_at": n, "updated_at": n}

@app.put("/bots/{bot_id}")
def update_bot(bot_id: str, data: BotUpdate, user_id: str = Depends(require_user)):
    conn = get_db(); b = get_bot(bot_id, conn, user_id)
    name = data.name or b["name"]; content = data.content or b["content"]
    q(conn, "UPDATE bots SET name=?,content=?,updated_at=? WHERE id=?", (name, content, ts(), bot_id))
    conn.commit(); conn.close()
    return {"id": bot_id, "name": name, "content": content}

@app.delete("/bots/{bot_id}")
def delete_bot(bot_id: str, user_id: str = Depends(require_user)):
    conn = get_db(); get_bot(bot_id, conn, user_id)
    q(conn, "DELETE FROM bots WHERE id=?", (bot_id,)); conn.commit(); conn.close(); return {"ok": True}

# ── CHATS ─────────────────────────────────────────────────────────────────────
@app.get("/chats")
def list_chats(user_id: str = Depends(require_user)):
    conn = get_db()
    r = rows(conn, "SELECT * FROM chats WHERE user_id=? ORDER BY updated_at DESC", (user_id,), cols=TABLE_COLS["chats"])
    conn.close(); return r

@app.post("/chats")
def create_chat(data: ChatCreate, user_id: str = Depends(require_user)):
    conn = get_db(); cid = str(uuid.uuid4()); bid = str(uuid.uuid4()); n = ts()
    bot = get_bot(data.bot_id, conn, user_id)
    init_hist = json.dumps([sys_msg(bot["content"])])
    q(conn, "INSERT INTO chats VALUES (?,?,?,?,?,?)", (cid, data.name, data.bot_id, n, n, user_id))
    q(conn, "INSERT INTO branches VALUES (?,?,?,?,?,?,?,?,?,?)", (bid, cid, "", 0, init_hist, "", 0, n, n, ""))
    conn.commit(); conn.close()
    return {"id": cid, "name": data.name, "bot_id": data.bot_id, "root_branch_id": bid, "created_at": n}

@app.get("/chats/{chat_id}")
def get_chat(chat_id: str, user_id: str = Depends(require_user)):
    conn = get_db()
    c = chat_owned(chat_id, user_id, conn)
    bs = rows(conn, "SELECT * FROM branches WHERE chat_id=? ORDER BY created_at", (chat_id,), cols=TABLE_COLS["branches"])
    conn.close()
    for b in bs: b["history"] = json.loads(b["history"])
    c["branches"] = bs
    return c

@app.put("/chats/{chat_id}/rename")
def rename_chat(chat_id: str, data: Rename, user_id: str = Depends(require_user)):
    conn = get_db(); chat_owned(chat_id, user_id, conn)
    q(conn, "UPDATE chats SET name=?,updated_at=? WHERE id=?", (data.name, ts(), chat_id))
    conn.commit(); conn.close(); return {"ok": True}

@app.delete("/chats/{chat_id}")
def delete_chat(chat_id: str, user_id: str = Depends(require_user)):
    conn = get_db(); chat_owned(chat_id, user_id, conn)
    for tbl in ("bookmarks", "branches", "chats"):
        q(conn, f"DELETE FROM {tbl} WHERE {'chat_id' if tbl!='chats' else 'id'}=?", (chat_id,))
    conn.commit(); conn.close(); return {"ok": True}

@app.post("/chats/{chat_id}/clone")
def clone_chat(chat_id: str, data: Rename, user_id: str = Depends(require_user)):
    conn = get_db()
    c = chat_owned(chat_id, user_id, conn)
    bs = rows(conn, "SELECT * FROM branches WHERE chat_id=?", (chat_id,), cols=TABLE_COLS["branches"])
    new_cid = str(uuid.uuid4()); n = ts()
    id_map = {b["id"]: str(uuid.uuid4()) for b in bs}
    q(conn, "INSERT INTO chats VALUES (?,?,?,?,?,?)", (new_cid, data.name, c["bot_id"], n, n, user_id))
    for b in bs:
        np = id_map.get(b["parent_branch_id"]) if b["parent_branch_id"] else ""
        q(conn, "INSERT INTO branches VALUES (?,?,?,?,?,?,?,?,?,?)",
          (id_map[b["id"]], new_cid, np, b["fork_message_index"], b["history"], b["memory"], b["turn_counter"], n, n, b["director_note"]))
    conn.commit(); conn.close()
    return {"id": new_cid, "name": data.name}

# ── SEND (STREAMING) ──────────────────────────────────────────────────────────
@app.post("/chats/{chat_id}/send")
async def send_message(chat_id: str, data: SendMsg,
                       llm: list = Depends(llm_candidates),
                       x_use_rag: str = Header(default="false"),
                       x_embed_token: str = Header(default=""),
                       user_id: str = Depends(require_user)):
    conn = get_db()
    c = chat_owned(chat_id, user_id, conn)
    bot = get_bot(c["bot_id"], conn); conn.close()

    b = get_branch_data(data.branch_id)

    # Guard against empty history
    if not b["history"]:
        b["history"] = [sys_msg(bot["content"])]
    else:
        b["history"][0] = sys_msg(bot["content"])

    cmds = re.findall(r"{([^}]+)}", data.content)
    cleaned = re.sub(r"{[^}]+}", "", data.content).strip()

    # {direct: ...} sets a sticky director note that stays in effect (re-injected every
    # turn) until replaced or cleared with {normal}/{reset} — unlike the other one-shot
    # commands below, which only apply to this single message.
    oneshot_cmds = []
    for c in cmds:
        stripped = c.strip()
        m = re.match(r"direct:\s*(.+)", stripped, re.IGNORECASE)
        if m:
            b["director_note"] = m.group(1).strip()
        elif stripped.lower() in ("normal", "reset"):
            b["director_note"] = ""
        else:
            oneshot_cmds.append(stripped)

    resume = resume_injection(b["memory"]) if data.is_first_turn else None
    send_hist = build_send_history(b["history"], b["memory"], resume)

    if x_use_rag.lower() == "true" and x_embed_token:
        # RAG context is a best-effort enhancement — a broken/unauthorized
        # embed token must never block sending the actual chat message.
        try:
            relevant = retrieve_relevant_chunks(data.branch_id, cleaned, x_embed_token)
            if relevant:
                send_hist.append({"role": "system", "content": "RELEVANT PAST MEMORY:\n" + "\n---\n".join(relevant)})
        except Exception:
            pass

    if b["director_note"]:
        send_hist.append({"role": "system", "content": f"ONGOING DIRECTOR NOTE (stays in effect until the user changes or clears it): {b['director_note']}"})

    # One-shot commands injected into send_hist only — never saved to permanent history
    if oneshot_cmds:
        override = {"role": "system", "content": f"COMMAND OVERRIDE\nCommands: {' | '.join(oneshot_cmds)}"}
        send_hist.append(override)

    send_hist.append({"role": "user", "content": cleaned})
    b["history"].append({"role": "user", "content": cleaned})

    async def stream():
        full = ""
        try:
            reply = stream_chat(llm, send_hist)
            async for chunk in reply:
                if chunk is KEEPALIVE:
                    yield ": keepalive\n\n"
                    continue
                if not chunk.choices:
                    continue
                delta = chunk.choices[0].delta.content
                if delta:
                    full += delta
                    yield f"data: {json.dumps({'type':'delta','content':delta})}\n\n"
            b["history"].append({"role": "assistant", "content": full, "model": reply.model})
            b["turn_counter"] += 1
            needs_mem = b["turn_counter"] % MEM_INTERVAL == 0
            save_branch(data.branch_id, b["history"], b["memory"], b["turn_counter"], b["director_note"])
            touch_chat(chat_id)
            yield f"data: {json.dumps({'type':'done','needs_memory':needs_mem,'turn_counter':b['turn_counter']})}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'type':'error','message':str(e)})}\n\n"

    return StreamingResponse(stream(), media_type="text/event-stream")

# ── RETRY (NEW BRANCH) ────────────────────────────────────────────────────────
@app.post("/chats/{chat_id}/retry")
async def retry_message(chat_id: str, data: RetryMsg,
                        llm: list = Depends(llm_candidates),
                        user_id: str = Depends(require_user)):
    chat_owned(chat_id, user_id)
    parent = get_branch_data(data.branch_id)
    hist_base = parent["history"][:-1] if parent["history"] and parent["history"][-1]["role"] == "assistant" else parent["history"]
    send_hist = build_send_history(hist_base, parent["memory"])
    if parent["director_note"]:
        send_hist.append({"role": "system", "content": f"ONGOING DIRECTOR NOTE (stays in effect until the user changes or clears it): {parent['director_note']}"})
    if data.hint:
        send_hist.append({"role": "system", "content": f"RETRY DIRECTION: {data.hint}"})

    new_bid = str(uuid.uuid4()); n = ts()

    async def stream():
        full = ""
        try:
            reply = stream_chat(llm, send_hist)
            async for chunk in reply:
                if chunk is KEEPALIVE:
                    yield ": keepalive\n\n"
                    continue
                if not chunk.choices:
                    continue
                delta = chunk.choices[0].delta.content
                if delta:
                    full += delta
                    yield f"data: {json.dumps({'type':'delta','content':delta})}\n\n"
            new_hist = hist_base + [{"role": "assistant", "content": full, "model": reply.model}]
            needs_mem = parent["turn_counter"] % MEM_INTERVAL == 0
            def _persist():
                conn = get_db()
                q(conn, "INSERT INTO branches VALUES (?,?,?,?,?,?,?,?,?,?)",
                  (new_bid, chat_id, data.branch_id, len(hist_base), json.dumps(new_hist), parent["memory"], parent["turn_counter"], n, n, parent["director_note"]))
                q(conn, "UPDATE chats SET updated_at=? WHERE id=?", (ts(), chat_id))
                conn.commit(); conn.close()
            with_db_retry(_persist)
            yield f"data: {json.dumps({'type':'done','branch_id':new_bid,'needs_memory':needs_mem})}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'type':'error','message':str(e)})}\n\n"

    return StreamingResponse(stream(), media_type="text/event-stream")

# ── UNDO ──────────────────────────────────────────────────────────────────────
@app.post("/branches/{branch_id}/undo")
def undo(branch_id: str, user_id: str = Depends(require_user)):
    branch_owned(branch_id, user_id)
    b = get_branch_data(branch_id)
    h = b["history"]
    if len(h) > 2:
        if h[-1]["role"] == "assistant": h.pop()
        if h and h[-1]["role"] == "user": h.pop()
        if h and h[-1]["role"] == "system" and "COMMAND OVERRIDE" in h[-1].get("content", ""): h.pop()
    turns = max(0, b["turn_counter"] - 1)
    save_branch(branch_id, h, b["memory"], turns, b["director_note"])
    return {"ok": True, "history": h}

# ── MEMORY ────────────────────────────────────────────────────────────────────
@app.post("/branches/{branch_id}/memory")
def update_memory(branch_id: str, llm: list = Depends(llm_candidates),
                  x_use_rag: str = Header(default="false"), x_embed_token: str = Header(default=""),
                  user_id: str = Depends(require_user)):
    branch_owned(branch_id, user_id)
    b = get_branch_data(branch_id)
    try:
        new_mem, new_note = do_memory_update(b["history"], b["memory"], llm, b["director_note"])
        save_branch(branch_id, b["history"], new_mem, b["turn_counter"], new_note)
        if x_use_rag.lower() == "true" and x_embed_token:
            # The memory document above is already saved — a broken/unauthorized
            # embed token must not turn this into a reported failure.
            try:
                store_memory_chunk(branch_id, new_mem, x_embed_token)
            except Exception:
                pass
        return {"ok": True, "memory": new_mem, "director_note": new_note}
    except Exception as e:
        raise HTTPException(500, str(e))

# ── BOOKMARKS ─────────────────────────────────────────────────────────────────
@app.get("/chats/{chat_id}/bookmarks")
def list_bookmarks(chat_id: str, user_id: str = Depends(require_user)):
    chat_owned(chat_id, user_id)
    conn = get_db()
    r = rows(conn, "SELECT * FROM bookmarks WHERE chat_id=? ORDER BY created_at DESC", (chat_id,), cols=TABLE_COLS["bookmarks"])
    conn.close()
    for bm in r: bm["history"] = json.loads(bm["history"])
    return r

@app.post("/chats/{chat_id}/bookmarks")
def create_bookmark(chat_id: str, data: BookmarkCreate, user_id: str = Depends(require_user)):
    chat_owned(chat_id, user_id)
    b = get_branch_data(data.branch_id)
    conn = get_db(); bm_id = str(uuid.uuid4()); n = ts()
    q(conn, "INSERT INTO bookmarks VALUES (?,?,?,?,?,?,?,?)",
      (bm_id, chat_id, data.branch_id, data.label, json.dumps(b["history"]), b["memory"], b["turn_counter"], n))
    conn.commit(); conn.close()
    return {"id": bm_id, "label": data.label, "created_at": n}

@app.post("/bookmarks/{bookmark_id}/restore")
def restore_bookmark(bookmark_id: str, user_id: str = Depends(require_user)):
    bm = bookmark_owned(bookmark_id, user_id)
    conn = get_db()
    new_bid = str(uuid.uuid4()); n = ts()
    q(conn, "INSERT INTO branches VALUES (?,?,?,?,?,?,?,?,?,?)",
      (new_bid, bm["chat_id"], "", 0, bm["history"], bm["memory"], bm["turn_counter"], n, n, ""))
    conn.commit(); conn.close()
    return {"branch_id": new_bid}

@app.delete("/bookmarks/{bookmark_id}")
def delete_bookmark(bookmark_id: str, user_id: str = Depends(require_user)):
    bookmark_owned(bookmark_id, user_id)
    conn = get_db(); q(conn, "DELETE FROM bookmarks WHERE id=?", (bookmark_id,)); conn.commit(); conn.close(); return {"ok": True}


# ── EDIT MESSAGE IN BRANCH ────────────────────────────────────────────────────
class EditMessage(BaseModel):
    visible_index: int  # index in visible (user+assistant only) messages
    new_content: str

@app.post("/branches/{branch_id}/edit-message")
def edit_message(branch_id: str, data: EditMessage, user_id: str = Depends(require_user)):
    branch_owned(branch_id, user_id)
    b = get_branch_data(branch_id)
    h = b["history"]
    # Get visible messages with their actual history indices
    visible_indices = [i for i, m in enumerate(h) if m["role"] in ("user", "assistant")]
    if data.visible_index >= len(visible_indices):
        raise HTTPException(400, "Message index out of range")
    actual_index = visible_indices[data.visible_index]
    h[actual_index]["content"] = data.new_content
    save_branch(branch_id, h, b["memory"], b["turn_counter"], b["director_note"])
    return {"ok": True, "history": h}


# ── EDIT USER MESSAGE (streaming, creates new branch) ────────────────────────
class EditUserMsg(BaseModel):
    branch_id: str
    visible_index: int  # index of the user message being edited
    new_content: str

@app.post("/chats/{chat_id}/edit-user")
async def edit_user_message(chat_id: str, data: EditUserMsg,
                            llm: list = Depends(llm_candidates),
                            user_id: str = Depends(require_user)):
    chat_owned(chat_id, user_id)
    parent = get_branch_data(data.branch_id)
    h = parent["history"]

    # Find actual history index for the visible user message
    visible_indices = [i for i, m in enumerate(h) if m["role"] in ("user", "assistant")]
    if data.visible_index >= len(visible_indices):
        raise HTTPException(400, "Message index out of range")
    actual_idx = visible_indices[data.visible_index]

    # New history = everything before that user message + edited user message
    hist_base = h[:actual_idx] + [{"role": "user", "content": data.new_content}]
    send_hist = build_send_history(hist_base, parent["memory"])
    if parent["director_note"]:
        send_hist.append({"role": "system", "content": f"ONGOING DIRECTOR NOTE (stays in effect until the user changes or clears it): {parent['director_note']}"})

    new_bid = str(uuid.uuid4()); n = ts()

    async def stream():
        full = ""
        try:
            reply = stream_chat(llm, send_hist)
            async for chunk in reply:
                if chunk is KEEPALIVE:
                    yield ": keepalive\n\n"
                    continue
                if not chunk.choices:
                    continue
                delta = chunk.choices[0].delta.content
                if delta:
                    full += delta
                    yield f"data: {json.dumps({'type':'delta','content':delta})}\n\n"
            new_hist = hist_base + [{"role": "assistant", "content": full, "model": reply.model}]
            needs_mem = parent["turn_counter"] % MEM_INTERVAL == 0
            def _persist():
                conn = get_db()
                q(conn, "INSERT INTO branches VALUES (?,?,?,?,?,?,?,?,?,?)",
                  (new_bid, chat_id, data.branch_id, actual_idx, json.dumps(new_hist), parent["memory"], parent["turn_counter"], n, n, parent["director_note"]))
                q(conn, "UPDATE chats SET updated_at=? WHERE id=?", (ts(), chat_id))
                conn.commit(); conn.close()
            with_db_retry(_persist)
            yield f"data: {json.dumps({'type':'done','branch_id':new_bid,'needs_memory':needs_mem})}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'type':'error','message':str(e)})}\n\n"

    return StreamingResponse(stream(), media_type="text/event-stream")


# ── TEST CHAT (bare, no bot/memory/system prompt) ─────────────────────────────
class TestMsg(BaseModel):
    messages: list  # full conversation history [{role, content}]

@app.post("/test-chat")
async def test_chat(data: TestMsg,
                    llm: list = Depends(llm_candidates),
                    user_id: str = Depends(require_user)):
    async def stream():
        try:
            async for chunk in stream_chat(llm, data.messages):
                if chunk is KEEPALIVE:
                    yield ": keepalive\n\n"
                    continue
                if not chunk.choices:
                    continue
                delta = chunk.choices[0].delta.content
                if delta:
                    yield f"data: {json.dumps({'type':'delta','content':delta})}\n\n"
            yield f"data: {json.dumps({'type':'done'})}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'type':'error','message':str(e)})}\n\n"

    return StreamingResponse(stream(), media_type="text/event-stream")

# ── AI CHAT (plain assistant, no bot/persona) ─────────────────────────────────
@app.get("/ai-chats")
def list_ai_chats(user_id: str = Depends(require_user)):
    conn = get_db()
    r = rows(conn, "SELECT id,name,created_at,updated_at FROM ai_chats WHERE user_id=? ORDER BY updated_at DESC",
             (user_id,), cols=["id", "name", "created_at", "updated_at"])
    conn.close()
    return r

@app.post("/ai-chats")
def create_ai_chat(data: AIChatCreate, user_id: str = Depends(require_user)):
    conn = get_db(); cid = str(uuid.uuid4()); n = ts()
    q(conn, "INSERT INTO ai_chats VALUES (?,?,?,?,?,?)", (cid, data.name, "[]", n, n, user_id))
    conn.commit(); conn.close()
    return {"id": cid, "name": data.name, "created_at": n, "updated_at": n}

@app.get("/ai-chats/{chat_id}")
def get_ai_chat(chat_id: str, user_id: str = Depends(require_user)):
    c = ai_chat_owned(chat_id, user_id)
    c["history"] = json.loads(c["history"])
    return c

@app.put("/ai-chats/{chat_id}/rename")
def rename_ai_chat(chat_id: str, data: Rename, user_id: str = Depends(require_user)):
    conn = get_db(); ai_chat_owned(chat_id, user_id, conn)
    q(conn, "UPDATE ai_chats SET name=?,updated_at=? WHERE id=?", (data.name, ts(), chat_id))
    conn.commit(); conn.close()
    return {"ok": True}

@app.delete("/ai-chats/{chat_id}")
def delete_ai_chat(chat_id: str, user_id: str = Depends(require_user)):
    conn = get_db(); ai_chat_owned(chat_id, user_id, conn)
    q(conn, "DELETE FROM ai_chats WHERE id=?", (chat_id,))
    conn.commit(); conn.close()
    return {"ok": True}

@app.post("/ai-chats/{chat_id}/send")
async def send_ai_message(chat_id: str, data: AIChatSendMsg,
                          llm: list = Depends(llm_candidates),
                          user_id: str = Depends(require_user)):
    c = ai_chat_owned(chat_id, user_id)
    history = json.loads(c["history"])
    if not history:
        history.append({"role": "system", "content": AI_CHAT_SYSTEM_PROMPT})

    history.append({"role": "user", "content": ai_msg_content(data.content, data.images)})
    send_hist = build_send_history(history, "")

    async def stream():
        full = ""
        try:
            async for chunk in stream_chat(llm, send_hist):
                if chunk is KEEPALIVE:
                    yield ": keepalive\n\n"
                    continue
                if not chunk.choices:
                    continue
                delta = chunk.choices[0].delta.content
                if delta:
                    full += delta
                    yield f"data: {json.dumps({'type':'delta','content':delta})}\n\n"
            history.append({"role": "assistant", "content": full})
            conn = get_db()
            q(conn, "UPDATE ai_chats SET history=?,updated_at=? WHERE id=?", (json.dumps(history), ts(), chat_id))
            conn.commit(); conn.close()
            yield f"data: {json.dumps({'type':'done'})}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'type':'error','message':str(e)})}\n\n"

    return StreamingResponse(stream(), media_type="text/event-stream")

# ── MIGRATION ENDPOINT ────────────────────────────────────────────────────────
@app.post("/branches/{branch_id}/restore-history")
def restore_history(branch_id: str, data: RestoreHistory, user_id: str = Depends(require_user)):
    branch_owned(branch_id, user_id)
    conn = get_db()
    q(conn, "UPDATE branches SET history=?,memory=?,turn_counter=?,updated_at=? WHERE id=?",
      (json.dumps(data.history), data.memory, data.turn_counter, ts(), branch_id))
    conn.commit(); conn.close()
    return {"ok": True}
