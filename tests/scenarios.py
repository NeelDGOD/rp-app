"""Scripted conversations replayed against OLD and NEW backends; each returns a normalized
transcript (list) so the two can be compared exactly. Every step goes through the real HTTP API."""
from harness import Api, FakeLLM, done_event


def _snap(api, chat_id):
    """Normalized full state of one chat (all branches, ordered by creation)."""
    chat = api.get_chat(chat_id)
    return api.norm(chat)


def basic_flow(api: Api):
    """send xN across the memory interval, memory update, retry (+hint), edit-user, undo, edit-message."""
    t = []
    bot = api.bot()
    chat = api.chat(bot["id"])
    root = api.root(chat["id"])
    t.append(("created", api.norm({"bot": bot, "chat": chat})))
    for i in range(1, 8):
        ev = api.send(chat["id"], root, f"message {i}", first=(i == 1))
        t.append((f"send {i}", api.norm(ev)))
    t.append(("memory", api.norm(api.memory(root))))
    t.append(("state after memory", _snap(api, chat["id"])))
    t.append(("send after memory", api.norm(api.send(chat["id"], root, "after memory", first=False))))
    r1 = api.retry(chat["id"], root)
    t.append(("retry", api.norm(r1)))
    r2 = api.retry(chat["id"], done_event(r1)["branch_id"], hint="make it shorter")
    t.append(("retry with hint", api.norm(r2)))
    e1 = api.edit_user(chat["id"], root, 4, "message 3 (edited)")
    t.append(("edit-user", api.norm(e1)))
    t.append(("undo", api.norm(api.undo(root))))
    t.append(("undo again", api.norm(api.undo(root))))
    t.append(("edit-message", api.norm(api.edit_message(root, 0, "edited first message"))))
    t.append(("edit-message out of range", api.norm(api.edit_message(root, 999, "x"))))
    t.append(("final state", _snap(api, chat["id"])))
    t.append(("chat list", api.norm(api.chats())))
    return t


def director_and_commands(api: Api):
    t = []
    chat = api.chat(api.bot()["id"])
    root = api.root(chat["id"])
    t.append(("direct", api.norm(api.send(chat["id"], root, "{direct: be mysterious} hello there", first=True))))
    t.append(("oneshot", api.norm(api.send(chat["id"], root, "{as villain} what now?"))))
    t.append(("memory with note keep", api.norm(api.memory(root))))
    api.llm.drop_note = True
    t.append(("memory with note drop", api.norm(api.memory(root))))
    api.llm.drop_note = False
    t.append(("direct again", api.norm(api.send(chat["id"], root, "{direct: be cheerful} next"))))
    t.append(("normal", api.norm(api.send(chat["id"], root, "{normal} back to normal"))))
    t.append(("state", _snap(api, chat["id"])))
    return t


def bookmarks_and_chat_ops(api: Api):
    t = []
    chat = api.chat(api.bot()["id"], name="Original")
    root = api.root(chat["id"])
    for i in range(1, 4):
        api.send(chat["id"], root, f"line {i}", first=(i == 1))
    bm = api.bookmark(chat["id"], root, "checkpoint")
    t.append(("bookmark", api.norm(bm)))
    api.send(chat["id"], root, "line 4")
    t.append(("bookmarks", api.norm(api.bookmarks(chat["id"]))))
    restored = api.restore_bookmark(bm["id"])
    t.append(("restore", api.norm(restored)))
    t.append(("state after restore", _snap(api, chat["id"])))
    t.append(("rename", api.norm(api.rename(chat["id"], "Renamed"))))
    clone = api.clone(chat["id"], "Copy")
    t.append(("clone", api.norm(clone)))
    t.append(("clone state", _snap(api, clone["id"])))
    t.append(("delete", api.norm(api.delete_chat(chat["id"]))))
    t.append(("chat list", api.norm(api.chats())))
    return t


def failure_flow(api: Api):
    """Provider outage before any text: nothing must be saved; later sends work normally."""
    t = []
    chat = api.chat(api.bot()["id"])
    root = api.root(chat["id"])
    api.send(chat["id"], root, "hello", first=True)
    before = _snap(api, chat["id"])
    api.llm.fail_stream = True
    t.append(("send during outage", api.norm(api.send(chat["id"], root, "this fails"))))
    t.append(("retry during outage", api.norm(api.retry(chat["id"], root))))
    t.append(("edit during outage", api.norm(api.edit_user(chat["id"], root, 0, "edited"))))
    api.llm.fail_stream = False
    t.append(("unchanged by failures", before == _snap(api, chat["id"])))
    t.append(("send after outage", api.norm(api.send(chat["id"], root, "works again"))))
    t.append(("final", _snap(api, chat["id"])))
    return t


def rag_flow(api: Api):
    t = []
    chat = api.chat(api.bot()["id"])
    root = api.root(chat["id"])
    for i in range(1, 4):
        api.send(chat["id"], root, f"fact {i}", first=(i == 1))
    t.append(("memory with rag", api.norm(api.memory(root, **{"x-use-rag": "true", "x-embed-token": "EMB"}))))
    t.append(("send with rag", api.norm(api.send(chat["id"], root, "recall please", **{"x-use-rag": "true", "x-embed-token": "EMB"}))))
    t.append(("state", _snap(api, chat["id"])))
    return t


SCENARIOS = {
    "basic_flow": basic_flow,
    "director_and_commands": director_and_commands,
    "bookmarks_and_chat_ops": bookmarks_and_chat_ops,
    "failure_flow": failure_flow,
    "rag_flow": rag_flow,
}
