"""Builds REAL chat data (via the real backend routes) for the JS tests of frontend/src/lib/branches.js.
Output: tests/js/fixtures.json  {scenario: {"chat": <GET /chats/{id} json>, "ids": {name: branch_id}}}
"""
import json
from pathlib import Path

from harness import Api, FakeLLM, load_backend, done_event

OUT = Path(__file__).parent / "js" / "fixtures.json"


def new_chat(api):
    chat = api.chat(api.bot()["id"])
    return chat["id"], api.root(chat["id"])


def finish(api, chat_id, ids):
    return {"chat": api.get_chat(chat_id), "ids": ids}


def retry_twice(api):
    chat, root = new_chat(api)
    api.send(chat, root, "q1", first=True)
    b2 = done_event(api.retry(chat, root))["branch_id"]
    b3 = done_event(api.retry(chat, b2))["branch_id"]
    return finish(api, chat, {"root": root, "b2": b2, "b3": b3})


def two_futures(api):
    chat, root = new_chat(api)
    api.send(chat, root, "q1", first=True)
    b2 = done_event(api.retry(chat, root))["branch_id"]
    api.send(chat, root, "root future q2")
    api.send(chat, b2, "retry future q3")
    api.send(chat, b2, "retry future q4")
    b4 = done_event(api.retry(chat, root))["branch_id"]          # later retry on root's last reply
    return finish(api, chat, {"root": root, "b2": b2, "b4": b4})


def edit_after_retries(api):
    chat, root = new_chat(api)
    api.send(chat, root, "q1", first=True)
    b2 = done_event(api.retry(chat, root))["branch_id"]
    b3 = done_event(api.retry(chat, b2))["branch_id"]
    b4 = done_event(api.edit_user(chat, b3, 0, "q1 (edited)"))["branch_id"]
    return finish(api, chat, {"root": root, "b2": b2, "b3": b3, "b4": b4})


def retry_after_edit(api):
    s = edit_after_retries(api)
    chat = s["chat"]["id"]
    b5 = done_event(api.retry(chat, s["ids"]["b4"]))["branch_id"]
    ids = dict(s["ids"], b5=b5)
    return finish(api, chat, ids)


def multi_fork(api):
    chat, root = new_chat(api)
    for i in range(1, 5):
        api.send(chat, root, f"turn {i}", first=(i == 1))
    b2 = done_event(api.edit_user(chat, root, 2, "turn 2 (edited)"))["branch_id"]   # edit at turn 2
    api.send(chat, b2, "turn 3 on edited path")
    b3 = done_event(api.retry(chat, root))["branch_id"]                               # retry the last reply of root
    b4 = done_event(api.edit_user(chat, b2, 4, "turn 3 on edited path (edited again)"))["branch_id"]
    return finish(api, chat, {"root": root, "b2": b2, "b3": b3, "b4": b4})


def undo_and_edit_message(api):
    chat, root = new_chat(api)
    api.send(chat, root, "q1", first=True)
    b2 = done_event(api.retry(chat, root))["branch_id"]
    api.undo(b2)                                          # b2 loses its only turn
    api.send(chat, root, "q2")
    api.edit_message(root, 1, "reply edited in place")
    return finish(api, chat, {"root": root, "b2": b2})


def undo_prefix(api):
    chat, root = new_chat(api)
    for i in range(1, 4):
        api.send(chat, root, f"q{i}", first=(i == 1))
    b2 = done_event(api.retry(chat, root))["branch_id"]      # another version of q3's reply
    api.undo(b2)                                              # b2 is now only q1,q2 (a prefix of root)
    return finish(api, chat, {"root": root, "b2": b2})


def duplicates_from_bookmark(api):
    chat, root = new_chat(api)
    api.send(chat, root, "q1", first=True)
    api.send(chat, root, "q2")
    bm = api.bookmark(chat, root, "mark")
    restored = api.restore_bookmark(bm["id"])["branch_id"]    # identical copy of root
    return finish(api, chat, {"root": root, "restored": restored})


def many_branches(api):
    chat, root = new_chat(api)
    for i in range(1, 41):
        api.send(chat, root, f"turn {i}", first=(i == 1))
    ids = {"root": root}
    prev = root
    for i in range(12):
        prev = done_event(api.retry(chat, prev))["branch_id"]
        ids[f"r{i}"] = prev
    return finish(api, chat, ids)


SCENARIOS = [retry_twice, two_futures, edit_after_retries, retry_after_edit, multi_fork,
             undo_and_edit_message, undo_prefix, duplicates_from_bookmark, many_branches]

if __name__ == "__main__":
    out = {}
    for fn in SCENARIOS:
        api = Api(load_backend("new"), FakeLLM())
        out[fn.__name__] = fn(api)
        print(f"{fn.__name__:26} branches={len(out[fn.__name__]['chat']['branches'])}")
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(json.dumps(out), encoding="utf-8")
    print("wrote", OUT, OUT.stat().st_size, "bytes")
