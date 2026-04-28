import os, re, json, uuid, asyncio
from datetime import datetime
from typing import Optional, AsyncGenerator
from fastapi import FastAPI, HTTPException, Header
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from huggingface_hub import InferenceClient

# ── CONFIG ────────────────────────────────────────────────────────────────────
TURSO_URL   = os.environ.get("TURSO_URL", "file:rp.db")
TURSO_TOKEN = os.environ.get("TURSO_TOKEN", "")
DEFAULT_MODEL = "deepseek-ai/DeepSeek-V3"
MAX_CONTEXT   = 20
MEM_INTERVAL  = 6

app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

# ── DATABASE ──────────────────────────────────────────────────────────────────
def get_db():
    try:
        import libsql_experimental as libsql
        if TURSO_TOKEN:
            return libsql.connect(TURSO_URL, auth_token=TURSO_TOKEN)
        return libsql.connect(TURSO_URL)
    except ImportError:
        import sqlite3
        conn = sqlite3.connect(TURSO_URL.replace("file:", ""))
        conn.row_factory = sqlite3.Row
        return conn

def q(conn, sql, params=()):
    cur = conn.execute(sql, params)
    return cur

def rows(conn, sql, params=()):
    cur = conn.execute(sql, params)
    cols = [d[0] for d in cur.description]
    return [dict(zip(cols, r)) for r in cur.fetchall()]

def row(conn, sql, params=()):
    r = rows(conn, sql, params)
    return r[0] if r else None

def init_db():
    conn = get_db()
    conn.executescript("""
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
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS bookmarks (
            id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, branch_id TEXT NOT NULL,
            label TEXT NOT NULL, history TEXT NOT NULL, memory TEXT NOT NULL DEFAULT '',
            turn_counter INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
        );
    """)
    conn.commit()
    conn.close()

init_db()

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

def do_memory_update(history: list, current_memory: str, token: str, model: str) -> str:
    client = InferenceClient(api_key=token)
    text = "\n".join(
        f"{'User' if m['role']=='user' else 'Bot'}: {m['content']}"
        for m in history[-20:] if m["role"] in ("user", "assistant")
    )
    prompt = [
        {"role": "system", "content": """Maintain a persistent memory document for an ongoing roleplay.
Given EXISTING memory + NEW conversation, return a fully UPDATED memory document.
NEVER remove old info. Only add or update. Output ONLY the memory document in this structure:

CHARACTERS:
RELATIONSHIP:
KEY EVENTS:
PROMISES & SECRETS:
CURRENT SCENE:
EMOTIONAL STATE:"""},
        {"role": "user", "content": f"EXISTING MEMORY:\n{current_memory or '(none yet)'}\n\nNEW CONVERSATION:\n{text}\n\nReturn the fully updated memory document."}
    ]
    return client.chat.completions.create(model=model, messages=prompt).choices[0].message.content

# ── HELPERS ───────────────────────────────────────────────────────────────────
def ts(): return datetime.utcnow().isoformat()

def get_branch_data(branch_id: str) -> dict:
    conn = get_db()
    b = row(conn, "SELECT * FROM branches WHERE id=?", (branch_id,))
    conn.close()
    if not b: raise HTTPException(404, "Branch not found")
    b["history"] = json.loads(b["history"])
    return b

def save_branch(branch_id: str, history: list, memory: str, turns: int):
    conn = get_db()
    q(conn, "UPDATE branches SET history=?,memory=?,turn_counter=?,updated_at=? WHERE id=?",
      (json.dumps(history), memory, turns, ts(), branch_id))
    conn.commit(); conn.close()

def get_bot(bot_id: str, conn=None) -> dict:
    close = conn is None
    if close: conn = get_db()
    b = row(conn, "SELECT * FROM bots WHERE id=?", (bot_id,))
    if close: conn.close()
    if not b: raise HTTPException(404, "Bot not found")
    return b

# ── BOTS ──────────────────────────────────────────────────────────────────────
@app.get("/bots")
def list_bots():
    conn = get_db(); r = rows(conn, "SELECT * FROM bots ORDER BY name"); conn.close(); return r

@app.post("/bots")
def create_bot(data: BotCreate):
    conn = get_db(); bid = str(uuid.uuid4()); n = ts()
    q(conn, "INSERT INTO bots VALUES (?,?,?,?,?)", (bid, data.name, data.content, n, n))
    conn.commit(); conn.close()
    return {"id": bid, "name": data.name, "content": data.content, "created_at": n, "updated_at": n}

@app.put("/bots/{bot_id}")
def update_bot(bot_id: str, data: BotUpdate):
    conn = get_db(); b = get_bot(bot_id, conn)
    name = data.name or b["name"]; content = data.content or b["content"]
    q(conn, "UPDATE bots SET name=?,content=?,updated_at=? WHERE id=?", (name, content, ts(), bot_id))
    conn.commit(); conn.close()
    return {"id": bot_id, "name": name, "content": content}

@app.delete("/bots/{bot_id}")
def delete_bot(bot_id: str):
    conn = get_db(); q(conn, "DELETE FROM bots WHERE id=?", (bot_id,)); conn.commit(); conn.close(); return {"ok": True}

# ── CHATS ─────────────────────────────────────────────────────────────────────
@app.get("/chats")
def list_chats():
    conn = get_db(); r = rows(conn, "SELECT * FROM chats ORDER BY updated_at DESC"); conn.close(); return r

@app.post("/chats")
def create_chat(data: ChatCreate):
    conn = get_db(); cid = str(uuid.uuid4()); bid = str(uuid.uuid4()); n = ts()
    bot = get_bot(data.bot_id, conn)
    init_hist = json.dumps([sys_msg(bot["content"])])
    q(conn, "INSERT INTO chats VALUES (?,?,?,?,?)", (cid, data.name, data.bot_id, n, n))
    q(conn, "INSERT INTO branches VALUES (?,?,?,?,?,?,?,?,?)", (bid, cid, None, 0, init_hist, "", 0, n, n))
    conn.commit(); conn.close()
    return {"id": cid, "name": data.name, "bot_id": data.bot_id, "root_branch_id": bid, "created_at": n}

@app.get("/chats/{chat_id}")
def get_chat(chat_id: str):
    conn = get_db()
    c = row(conn, "SELECT * FROM chats WHERE id=?", (chat_id,))
    if not c: raise HTTPException(404, "Chat not found")
    bs = rows(conn, "SELECT * FROM branches WHERE chat_id=? ORDER BY created_at", (chat_id,))
    conn.close()
    for b in bs: b["history"] = json.loads(b["history"])
    c["branches"] = bs
    return c

@app.put("/chats/{chat_id}/rename")
def rename_chat(chat_id: str, data: Rename):
    conn = get_db(); q(conn, "UPDATE chats SET name=?,updated_at=? WHERE id=?", (data.name, ts(), chat_id))
    conn.commit(); conn.close(); return {"ok": True}

@app.delete("/chats/{chat_id}")
def delete_chat(chat_id: str):
    conn = get_db()
    for tbl in ("bookmarks", "branches", "chats"):
        q(conn, f"DELETE FROM {tbl} WHERE {'chat_id' if tbl!='chats' else 'id'}=?", (chat_id,))
    conn.commit(); conn.close(); return {"ok": True}

@app.post("/chats/{chat_id}/clone")
def clone_chat(chat_id: str, data: Rename):
    conn = get_db()
    c = row(conn, "SELECT * FROM chats WHERE id=?", (chat_id,))
    if not c: raise HTTPException(404)
    bs = rows(conn, "SELECT * FROM branches WHERE chat_id=?", (chat_id,))
    new_cid = str(uuid.uuid4()); n = ts()
    id_map = {b["id"]: str(uuid.uuid4()) for b in bs}
    q(conn, "INSERT INTO chats VALUES (?,?,?,?,?)", (new_cid, data.name, c["bot_id"], n, n))
    for b in bs:
        np = id_map.get(b["parent_branch_id"]) if b["parent_branch_id"] else None
        q(conn, "INSERT INTO branches VALUES (?,?,?,?,?,?,?,?,?)",
          (id_map[b["id"]], new_cid, np, b["fork_message_index"], b["history"], b["memory"], b["turn_counter"], n, n))
    conn.commit(); conn.close()
    return {"id": new_cid, "name": data.name}

# ── SEND (STREAMING) ──────────────────────────────────────────────────────────
@app.post("/chats/{chat_id}/send")
async def send_message(chat_id: str, data: SendMsg,
                       x_hf_token: str = Header(...), x_model: str = Header(default=DEFAULT_MODEL)):
    conn = get_db()
    c = row(conn, "SELECT * FROM chats WHERE id=?", (chat_id,))
    if not c: raise HTTPException(404)
    bot = get_bot(c["bot_id"], conn); conn.close()

    b = get_branch_data(data.branch_id)
    b["history"][0] = sys_msg(bot["content"])

    cmds = re.findall(r"{([^}]+)}", data.content)
    cleaned = re.sub(r"{[^}]+}", "", data.content).strip()
    if cmds:
        b["history"].append({"role": "system", "content": f"COMMAND OVERRIDE\nCommands: {' | '.join(cmds)}"})
    b["history"].append({"role": "user", "content": cleaned})

    resume = resume_injection(b["memory"]) if data.is_first_turn else None
    send_hist = build_send_history(b["history"], b["memory"], resume)
    client = InferenceClient(api_key=x_hf_token)

    async def stream():
        full = ""
        try:
            for chunk in client.chat.completions.create(model=x_model, messages=send_hist, stream=True):
                delta = chunk.choices[0].delta.content
                if delta:
                    full += delta
                    yield f"data: {json.dumps({'type':'delta','content':delta})}\n\n"
            b["history"].append({"role": "assistant", "content": full})
            b["turn_counter"] += 1
            needs_mem = b["turn_counter"] % MEM_INTERVAL == 0
            save_branch(data.branch_id, b["history"], b["memory"], b["turn_counter"])
            conn2 = get_db(); q(conn2, "UPDATE chats SET updated_at=? WHERE id=?", (ts(), chat_id)); conn2.commit(); conn2.close()
            yield f"data: {json.dumps({'type':'done','needs_memory':needs_mem,'turn_counter':b['turn_counter']})}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'type':'error','message':str(e)})}\n\n"

    return StreamingResponse(stream(), media_type="text/event-stream")

# ── RETRY (NEW BRANCH) ────────────────────────────────────────────────────────
@app.post("/chats/{chat_id}/retry")
async def retry_message(chat_id: str, data: RetryMsg,
                        x_hf_token: str = Header(...), x_model: str = Header(default=DEFAULT_MODEL)):
    parent = get_branch_data(data.branch_id)
    hist_base = parent["history"][:-1] if parent["history"] and parent["history"][-1]["role"] == "assistant" else parent["history"]
    send_hist = build_send_history(hist_base, parent["memory"])
    if data.hint:
        send_hist.append({"role": "system", "content": f"RETRY DIRECTION: {data.hint}"})

    new_bid = str(uuid.uuid4()); n = ts()
    client = InferenceClient(api_key=x_hf_token)

    async def stream():
        full = ""
        try:
            for chunk in client.chat.completions.create(model=x_model, messages=send_hist, stream=True):
                delta = chunk.choices[0].delta.content
                if delta:
                    full += delta
                    yield f"data: {json.dumps({'type':'delta','content':delta})}\n\n"
            new_hist = hist_base + [{"role": "assistant", "content": full}]
            needs_mem = parent["turn_counter"] % MEM_INTERVAL == 0
            conn = get_db()
            q(conn, "INSERT INTO branches VALUES (?,?,?,?,?,?,?,?,?)",
              (new_bid, chat_id, data.branch_id, len(hist_base), json.dumps(new_hist), parent["memory"], parent["turn_counter"], n, n))
            q(conn, "UPDATE chats SET updated_at=? WHERE id=?", (ts(), chat_id))
            conn.commit(); conn.close()
            yield f"data: {json.dumps({'type':'done','branch_id':new_bid,'needs_memory':needs_mem})}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'type':'error','message':str(e)})}\n\n"

    return StreamingResponse(stream(), media_type="text/event-stream")

# ── UNDO ──────────────────────────────────────────────────────────────────────
@app.post("/branches/{branch_id}/undo")
def undo(branch_id: str):
    b = get_branch_data(branch_id)
    h = b["history"]
    if len(h) > 2:
        if h[-1]["role"] == "assistant": h.pop()
        if h and h[-1]["role"] in ("user",): h.pop()
        if h and h[-1]["role"] == "system" and "COMMAND OVERRIDE" in h[-1].get("content",""):  h.pop()
    turns = max(0, b["turn_counter"] - 1)
    save_branch(branch_id, h, b["memory"], turns)
    return {"ok": True, "history": h}

# ── MEMORY ────────────────────────────────────────────────────────────────────
@app.post("/branches/{branch_id}/memory")
def update_memory(branch_id: str, x_hf_token: str = Header(...), x_model: str = Header(default=DEFAULT_MODEL)):
    b = get_branch_data(branch_id)
    try:
        new_mem = do_memory_update(b["history"], b["memory"], x_hf_token, x_model)
        save_branch(branch_id, b["history"], new_mem, b["turn_counter"])
        return {"ok": True, "memory": new_mem}
    except Exception as e:
        raise HTTPException(500, str(e))

# ── BOOKMARKS ─────────────────────────────────────────────────────────────────
@app.get("/chats/{chat_id}/bookmarks")
def list_bookmarks(chat_id: str):
    conn = get_db(); r = rows(conn, "SELECT * FROM bookmarks WHERE chat_id=? ORDER BY created_at DESC", (chat_id,)); conn.close()
    for bm in r: bm["history"] = json.loads(bm["history"])
    return r

@app.post("/chats/{chat_id}/bookmarks")
def create_bookmark(chat_id: str, data: BookmarkCreate):
    b = get_branch_data(data.branch_id)
    conn = get_db(); bm_id = str(uuid.uuid4()); n = ts()
    q(conn, "INSERT INTO bookmarks VALUES (?,?,?,?,?,?,?,?)",
      (bm_id, chat_id, data.branch_id, data.label, json.dumps(b["history"]), b["memory"], b["turn_counter"], n))
    conn.commit(); conn.close()
    return {"id": bm_id, "label": data.label, "created_at": n}

@app.post("/bookmarks/{bookmark_id}/restore")
def restore_bookmark(bookmark_id: str):
    conn = get_db()
    bm = row(conn, "SELECT * FROM bookmarks WHERE id=?", (bookmark_id,))
    if not bm: raise HTTPException(404)
    new_bid = str(uuid.uuid4()); n = ts()
    q(conn, "INSERT INTO branches VALUES (?,?,?,?,?,?,?,?,?)",
      (new_bid, bm["chat_id"], None, 0, bm["history"], bm["memory"], bm["turn_counter"], n, n))
    conn.commit(); conn.close()
    return {"branch_id": new_bid}

@app.delete("/bookmarks/{bookmark_id}")
def delete_bookmark(bookmark_id: str):
    conn = get_db(); q(conn, "DELETE FROM bookmarks WHERE id=?", (bookmark_id,)); conn.commit(); conn.close(); return {"ok": True}
