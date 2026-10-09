"""Test harness: loads backend/main.py (any revision) against a throwaway sqlite DB with a
deterministic fake LLM, drives it through the real HTTP API (FastAPI TestClient) and
normalizes ids/timestamps so two implementations can be compared exactly.

OLD = the production backend at BASE_REV (git show); NEW = the working tree.
Not deployed: lives outside backend/.
"""
import importlib.util
import json
import os
import re
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
from types import SimpleNamespace as NS

from fastapi.testclient import TestClient

REPO = Path(__file__).resolve().parents[1]
BASE_REV = "8dd4c9c"
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
DROP_KEYS = {"created_at", "updated_at", "active_branch_id"}
_counter = [0]


def _fresh_dir():
    return Path(tempfile.mkdtemp(prefix="rp_harness_"))


def load_backend(kind: str):
    """kind: 'old' (git BASE_REV) or 'new' (working tree). Returns an isolated module + its db path."""
    _counter[0] += 1
    work = _fresh_dir()
    if kind == "old":
        src = work / "main_old.py"
        src.write_bytes(subprocess.check_output(["git", "show", f"{BASE_REV}:backend/main.py"], cwd=REPO))
    else:
        src = REPO / "backend" / "main.py"
    db = work / "test.db"
    os.environ["TURSO_URL"] = f"file:{db}"
    os.environ["TURSO_TOKEN"] = ""
    os.environ["KEYS_SECRET"] = "harness-secret"
    name = f"backend_{kind}_{_counter[0]}"
    spec = importlib.util.spec_from_file_location(name, str(src))
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


class FakeLLM:
    """Deterministic stand-in for every provider. Replies are numbered so retries differ."""

    def __init__(self, stream_delay=0.0, memory_delay=0.0):
        self.calls = 0
        self.lock = threading.Lock()
        self.stream_delay = stream_delay
        self.memory_delay = memory_delay
        self.fail_stream = False      # raise before any text (provider outage)
        self.drop_note = False        # memory update decides to DROP the director note
        self.log = []                 # (kind, n_messages)

    def get_client(self, provider, token, model):
        return FakeClient(self), model


class FakeClient:
    def __init__(self, llm):
        self.llm = llm
        self.chat = NS(completions=self)

    def create(self, model, messages, stream=False):
        llm = self.llm
        with llm.lock:
            llm.calls += 1
            n = llm.calls
        first = messages[0]["content"] if messages else ""
        is_memory = first.startswith("Maintain a persistent memory document")
        if is_memory:
            llm.log.append(("memory", len(messages)))
            if llm.memory_delay:
                time.sleep(llm.memory_delay)
            user = messages[-1]["content"]
            convo = user.split("NEW CONVERSATION:\n", 1)[-1].split("\n\nReturn the fully")[0]
            lines = [ln for ln in convo.splitlines() if ln.strip()]
            doc = (f"CHARACTERS: Mira\nRELATIONSHIP: friends\nKEY EVENTS: saw {len(lines)} lines; last={lines[-1][:40] if lines else ''}\n"
                   f"PROMISES & SECRETS: none\nCURRENT SCENE: cafe\nEMOTIONAL STATE: calm")
            if "ACTIVE DIRECTOR NOTE" in first:
                doc += "\nDIRECTOR_NOTE: " + ("DROP" if llm.drop_note else "KEEP")
            return NS(choices=[NS(message=NS(content=doc))])
        llm.log.append(("chat", len(messages)))
        if llm.fail_stream:
            raise RuntimeError("provider down")
        last_user = ""
        for m in reversed(messages):
            if m["role"] == "user":
                last_user = m["content"]
                break
        text = f"*reply {n}* to: {last_user[:40]}"
        if not stream:
            return NS(choices=[NS(message=NS(content=text))])
        parts = [text[i:i + 12] for i in range(0, len(text), 12)]

        def gen():
            for p in parts:
                if llm.stream_delay:
                    time.sleep(llm.stream_delay)
                yield NS(choices=[NS(delta=NS(content=p))])
        return gen()


def sse(text):
    return [json.loads(l[6:]) for l in text.splitlines() if l.startswith("data: ")]


class Api:
    """Thin client over one backend module. Every call goes through real HTTP routes."""

    def __init__(self, mod, llm=None, email="u@test.com"):
        self.mod = mod
        self.llm = llm or FakeLLM()
        mod.get_client = self.llm.get_client
        mod.embed_text = lambda text, token, task: [float(len(text) % 7), 1.0, 0.5]
        self.c = TestClient(mod.app)
        self.idmap = {}
        self.token = self.c.post("/auth/register", json={"email": email, "password": "pass1234"}).json()["token"]

    # -- plumbing
    def h(self, **extra):
        base = {"x-auth-token": self.token, "x-hf-token": "KEY", "x-model": "m1", "x-provider": "groq",
                "x-fallbacks": "[]", "x-use-rag": "false", "x-embed-token": "", "Content-Type": "application/json"}
        base.update(extra)
        return base

    def norm(self, obj):
        if isinstance(obj, dict):
            return {k: self.norm(v) for k, v in obj.items() if k not in DROP_KEYS}
        if isinstance(obj, list):
            return [self.norm(v) for v in obj]
        if isinstance(obj, str) and UUID_RE.match(obj):
            return self.idmap.setdefault(obj, f"<id{len(self.idmap) + 1}>")
        return obj

    # -- API calls
    def bot(self, name="Mira", content="You are Mira, a sarcastic barista."):
        return self.c.post("/bots", headers=self.h(), json={"name": name, "content": content}).json()

    def chat(self, bot_id, name="Cafe"):
        return self.c.post("/chats", headers=self.h(), json={"name": name, "bot_id": bot_id}).json()

    def get_chat(self, chat_id):
        return self.c.get(f"/chats/{chat_id}", headers=self.h()).json()

    def root(self, chat_id):
        return self.get_chat(chat_id)["branches"][0]["id"]

    def branch(self, chat_id, branch_id):
        return next(b for b in self.get_chat(chat_id)["branches"] if b["id"] == branch_id)

    def send(self, chat_id, branch_id, text, first=False, **hdr):
        r = self.c.post(f"/chats/{chat_id}/send", headers=self.h(**hdr),
                        json={"content": text, "branch_id": branch_id, "is_first_turn": first})
        return sse(r.text)

    def retry(self, chat_id, branch_id, hint=""):
        r = self.c.post(f"/chats/{chat_id}/retry", headers=self.h(), json={"branch_id": branch_id, "hint": hint})
        return sse(r.text)

    def edit_user(self, chat_id, branch_id, visible_index, text):
        r = self.c.post(f"/chats/{chat_id}/edit-user", headers=self.h(),
                        json={"branch_id": branch_id, "visible_index": visible_index, "new_content": text})
        return sse(r.text)

    def undo(self, branch_id):
        return self.c.post(f"/branches/{branch_id}/undo", headers=self.h()).json()

    def memory(self, branch_id, **hdr):
        r = self.c.post(f"/branches/{branch_id}/memory", headers=self.h(**hdr))
        return r.status_code, r.json()

    def edit_message(self, branch_id, visible_index, text):
        r = self.c.post(f"/branches/{branch_id}/edit-message", headers=self.h(),
                        json={"visible_index": visible_index, "new_content": text})
        return r.status_code, r.json()

    def bookmark(self, chat_id, branch_id, label):
        return self.c.post(f"/chats/{chat_id}/bookmarks", headers=self.h(),
                           json={"branch_id": branch_id, "label": label}).json()

    def bookmarks(self, chat_id):
        return self.c.get(f"/chats/{chat_id}/bookmarks", headers=self.h()).json()

    def restore_bookmark(self, bookmark_id):
        return self.c.post(f"/bookmarks/{bookmark_id}/restore", headers=self.h()).json()

    def rename(self, chat_id, name):
        return self.c.put(f"/chats/{chat_id}/rename", headers=self.h(), json={"name": name}).json()

    def clone(self, chat_id, name):
        return self.c.post(f"/chats/{chat_id}/clone", headers=self.h(), json={"name": name}).json()

    def delete_chat(self, chat_id):
        return self.c.delete(f"/chats/{chat_id}", headers=self.h()).json()

    def chats(self):
        return self.c.get("/chats", headers=self.h()).json()

    def visible(self, chat_id, branch_id):
        """[(role, content)] of user/assistant messages of one branch (what the user reads)."""
        h = self.branch(chat_id, branch_id)["history"]
        return [(m["role"], m["content"]) for m in h if m["role"] in ("user", "assistant")]


def done_event(events):
    return next((e for e in events if e.get("type") == "done"), None)
