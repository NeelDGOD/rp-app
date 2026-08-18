import os, re, json, uuid, secrets
from datetime import datetime
from typing import Optional
from fastapi import FastAPI, HTTPException, Header, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from huggingface_hub import InferenceClient
import bcrypt

# ── CONFIG ────────────────────────────────────────────────────────────────────
TURSO_URL   = os.environ.get("TURSO_URL", "file:rp.db")
TURSO_TOKEN = os.environ.get("TURSO_TOKEN", "")
DEFAULT_MODEL = "deepseek-ai/DeepSeek-V3"
MAX_CONTEXT   = 20
MEM_INTERVAL  = 6
EMBED_MODEL   = "sentence-transformers/all-MiniLM-L6-v2"
RAG_TOP_K     = 3
ADMIN_EMAIL   = "admin@chat.com"
ADMIN_PASSWORD = "admin"

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
}

def rows(conn, sql, params=(), cols=None):
    cur = conn.execute(sql, params)
    if cols is None:
        cols = [d[0] for d in cur.description]
    return [dict(zip(cols, r)) for r in cur.fetchall()]

def row(conn, sql, params=(), cols=None):
    r = rows(conn, sql, params, cols)
    return r[0] if r else None

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
    """)
    conn.commit()
    conn.close()

init_db()

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

run_migrations()

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
    send = [history[0]] + history[-MAX_CONTEXT:]
    i = 1
    if memory:
        send.insert(i, {"role": "system", "content": f"RP MEMORY:\n{memory}"}); i += 1
    if resume:
        send.insert(i, resume)
    return send

def hf_client(token: str, model: str):
    """Split a "repo_id:provider" model string (as copied from HF's model page)
    into a client configured for that provider and the bare repo_id."""
    if ":" in model:
        repo_id, provider = model.split(":", 1)
    else:
        repo_id, provider = model, "auto"
    return InferenceClient(provider=provider, api_key=token), repo_id

def do_memory_update(history: list, current_memory: str, token: str, model: str, director_note: str = "") -> tuple:
    client, model = hf_client(token, model)
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
    raw = client.chat.completions.create(model=model, messages=prompt).choices[0].message.content

    new_note = director_note
    m = re.search(r"DIRECTOR_NOTE:\s*(KEEP|DROP)", raw, re.IGNORECASE)
    if m:
        raw = raw[:m.start()].rstrip()
        if m.group(1).upper() == "DROP":
            new_note = ""
    return raw, new_note

# ── RAG (memory chunk embedding + retrieval) ─────────────────────────────────
_embedder = None

def get_embedder():
    global _embedder
    if _embedder is None:
        from sentence_transformers import SentenceTransformer
        _embedder = SentenceTransformer(EMBED_MODEL)
    return _embedder

def embed_text(text: str) -> list:
    return get_embedder().encode(text).tolist()

def cosine_similarity(a: list, b: list) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    norm_a = sum(x * x for x in a) ** 0.5
    norm_b = sum(y * y for y in b) ** 0.5
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return dot / (norm_a * norm_b)

def store_memory_chunk(branch_id: str, content: str):
    conn = get_db()
    q(conn, "INSERT INTO memory_chunks VALUES (?,?,?,?,?)",
      (str(uuid.uuid4()), branch_id, content, json.dumps(embed_text(content)), ts()))
    conn.commit(); conn.close()

def retrieve_relevant_chunks(branch_id: str, query: str, k: int = RAG_TOP_K) -> list:
    conn = get_db()
    chunks = rows(conn, "SELECT content, embedding FROM memory_chunks WHERE branch_id=?", (branch_id,), cols=["content", "embedding"])
    conn.close()
    if not chunks:
        return []
    query_vec = embed_text(query)
    scored = [(cosine_similarity(query_vec, json.loads(c["embedding"])), c["content"]) for c in chunks]
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

def save_branch(branch_id: str, history: list, memory: str, turns: int, director_note: str):
    conn = get_db()
    q(conn, "UPDATE branches SET history=?,memory=?,turn_counter=?,director_note=?,updated_at=? WHERE id=?",
      (json.dumps(history), memory, turns, director_note, ts(), branch_id))
    conn.commit(); conn.close()

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
                       x_hf_token: str = Header(...), x_model: str = Header(default=DEFAULT_MODEL),
                       x_use_rag: str = Header(default="false"),
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

    if x_use_rag.lower() == "true":
        relevant = retrieve_relevant_chunks(data.branch_id, cleaned)
        if relevant:
            send_hist.append({"role": "system", "content": "RELEVANT PAST MEMORY:\n" + "\n---\n".join(relevant)})

    if b["director_note"]:
        send_hist.append({"role": "system", "content": f"ONGOING DIRECTOR NOTE (stays in effect until the user changes or clears it): {b['director_note']}"})

    # One-shot commands injected into send_hist only — never saved to permanent history
    if oneshot_cmds:
        override = {"role": "system", "content": f"COMMAND OVERRIDE\nCommands: {' | '.join(oneshot_cmds)}"}
        send_hist.append(override)

    send_hist.append({"role": "user", "content": cleaned})
    b["history"].append({"role": "user", "content": cleaned})

    client, model = hf_client(x_hf_token, x_model)

    async def stream():
        full = ""
        try:
            for chunk in client.chat.completions.create(model=model, messages=send_hist, stream=True):
                if not chunk.choices:
                    continue
                delta = chunk.choices[0].delta.content
                if delta:
                    full += delta
                    yield f"data: {json.dumps({'type':'delta','content':delta})}\n\n"
            b["history"].append({"role": "assistant", "content": full})
            b["turn_counter"] += 1
            needs_mem = b["turn_counter"] % MEM_INTERVAL == 0
            save_branch(data.branch_id, b["history"], b["memory"], b["turn_counter"], b["director_note"])
            conn2 = get_db(); q(conn2, "UPDATE chats SET updated_at=? WHERE id=?", (ts(), chat_id)); conn2.commit(); conn2.close()
            yield f"data: {json.dumps({'type':'done','needs_memory':needs_mem,'turn_counter':b['turn_counter']})}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'type':'error','message':str(e)})}\n\n"

    return StreamingResponse(stream(), media_type="text/event-stream")

# ── RETRY (NEW BRANCH) ────────────────────────────────────────────────────────
@app.post("/chats/{chat_id}/retry")
async def retry_message(chat_id: str, data: RetryMsg,
                        x_hf_token: str = Header(...), x_model: str = Header(default=DEFAULT_MODEL),
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
    client, model = hf_client(x_hf_token, x_model)

    async def stream():
        full = ""
        try:
            for chunk in client.chat.completions.create(model=model, messages=send_hist, stream=True):
                if not chunk.choices:
                    continue
                delta = chunk.choices[0].delta.content
                if delta:
                    full += delta
                    yield f"data: {json.dumps({'type':'delta','content':delta})}\n\n"
            new_hist = hist_base + [{"role": "assistant", "content": full}]
            needs_mem = parent["turn_counter"] % MEM_INTERVAL == 0
            conn = get_db()
            q(conn, "INSERT INTO branches VALUES (?,?,?,?,?,?,?,?,?,?)",
              (new_bid, chat_id, data.branch_id, len(hist_base), json.dumps(new_hist), parent["memory"], parent["turn_counter"], n, n, parent["director_note"]))
            q(conn, "UPDATE chats SET updated_at=? WHERE id=?", (ts(), chat_id))
            conn.commit(); conn.close()
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
def update_memory(branch_id: str, x_hf_token: str = Header(...), x_model: str = Header(default=DEFAULT_MODEL),
                  x_use_rag: str = Header(default="false"), user_id: str = Depends(require_user)):
    branch_owned(branch_id, user_id)
    b = get_branch_data(branch_id)
    try:
        new_mem, new_note = do_memory_update(b["history"], b["memory"], x_hf_token, x_model, b["director_note"])
        save_branch(branch_id, b["history"], new_mem, b["turn_counter"], new_note)
        if x_use_rag.lower() == "true":
            store_memory_chunk(branch_id, new_mem)
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
                            x_hf_token: str = Header(...), x_model: str = Header(default=DEFAULT_MODEL),
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
    client, model = hf_client(x_hf_token, x_model)

    async def stream():
        full = ""
        try:
            for chunk in client.chat.completions.create(model=model, messages=send_hist, stream=True):
                if not chunk.choices:
                    continue
                delta = chunk.choices[0].delta.content
                if delta:
                    full += delta
                    yield f"data: {json.dumps({'type':'delta','content':delta})}\n\n"
            new_hist = hist_base + [{"role": "assistant", "content": full}]
            needs_mem = parent["turn_counter"] % MEM_INTERVAL == 0
            conn = get_db()
            q(conn, "INSERT INTO branches VALUES (?,?,?,?,?,?,?,?,?,?)",
              (new_bid, chat_id, data.branch_id, actual_idx, json.dumps(new_hist), parent["memory"], parent["turn_counter"], n, n, parent["director_note"]))
            q(conn, "UPDATE chats SET updated_at=? WHERE id=?", (ts(), chat_id))
            conn.commit(); conn.close()
            yield f"data: {json.dumps({'type':'done','branch_id':new_bid,'needs_memory':needs_mem})}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'type':'error','message':str(e)})}\n\n"

    return StreamingResponse(stream(), media_type="text/event-stream")


# ── TEST CHAT (bare, no bot/memory/system prompt) ─────────────────────────────
class TestMsg(BaseModel):
    messages: list  # full conversation history [{role, content}]

@app.post("/test-chat")
async def test_chat(data: TestMsg,
                    x_hf_token: str = Header(...),
                    x_model: str = Header(default=DEFAULT_MODEL),
                    user_id: str = Depends(require_user)):
    client, model = hf_client(x_hf_token, x_model)

    async def stream():
        try:
            for chunk in client.chat.completions.create(
                model=model, messages=data.messages, stream=True
            ):
                if not chunk.choices:
                    continue
                delta = chunk.choices[0].delta.content
                if delta:
                    yield f"data: {json.dumps({'type':'delta','content':delta})}\n\n"
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
