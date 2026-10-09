"""The server remembers which version (branch) of a chat the user was last on."""
from harness import Api, FakeLLM, load_backend, done_event


def setup():
    api = Api(load_backend("new"), FakeLLM())
    chat = api.chat(api.bot()["id"])
    return api, chat["id"], api.root(chat["id"])


def active(api, chat_id):
    return api.get_chat(chat_id)["active_branch_id"]


def put(api, chat_id, branch_id, a=None):
    a = a or api
    return a.c.put(f"/chats/{chat_id}/active-branch", headers=a.h(), json={"branch_id": branch_id})


def test_new_chat_has_no_remembered_branch_yet():
    api, chat, root = setup()
    assert active(api, chat) is None


def test_send_remembers_the_branch():
    api, chat, root = setup()
    api.send(chat, root, "hi", first=True)
    assert active(api, chat) == root


def test_retry_moves_to_the_new_branch_and_put_switches_back():
    api, chat, root = setup()
    api.send(chat, root, "hi", first=True)
    new = done_event(api.retry(chat, root))["branch_id"]
    assert active(api, chat) == new
    assert put(api, chat, root).json() == {"ok": True}
    assert active(api, chat) == root


def test_edit_user_moves_to_the_new_branch():
    api, chat, root = setup()
    api.send(chat, root, "hi", first=True)
    api.send(chat, root, "second")
    new = done_event(api.edit_user(chat, root, 2, "second (edited)"))["branch_id"]
    assert active(api, chat) == new


def test_restore_bookmark_moves_to_the_restored_branch():
    api, chat, root = setup()
    api.send(chat, root, "hi", first=True)
    bm = api.bookmark(chat, root, "mark")
    restored = api.restore_bookmark(bm["id"])["branch_id"]
    assert active(api, chat) == restored


def test_put_validates_ownership_and_branch():
    api, chat, root = setup()
    other = Api(api.mod, api.llm, email="other@test.com")
    assert put(api, chat, "00000000-0000-0000-0000-000000000000").status_code == 404
    assert put(other, chat, root, a=other).status_code == 404, "another user's chat must be invisible"
    assert api.c.put(f"/chats/{chat}/active-branch", json={"branch_id": root}).status_code == 422, "needs auth"
    other_chat = other.chat(other.bot()["id"])
    foreign_root = other.root(other_chat["id"])
    assert put(api, chat, foreign_root).status_code == 404, "a branch of a different chat is rejected"


def test_clone_maps_the_remembered_branch_and_delete_forgets_it():
    api, chat, root = setup()
    api.send(chat, root, "hi", first=True)
    new = done_event(api.retry(chat, root))["branch_id"]
    clone = api.clone(chat, "copy")
    cloned = api.get_chat(clone["id"])
    assert cloned["active_branch_id"] in [b["id"] for b in cloned["branches"]]
    chosen = next(b for b in cloned["branches"] if b["id"] == cloned["active_branch_id"])
    original = next(b for b in api.get_chat(chat)["branches"] if b["id"] == new)
    assert chosen["history"] == original["history"], "the clone must open on the equivalent version"
    api.delete_chat(chat)
    conn = api.mod.get_db()
    left = conn.execute("SELECT COUNT(*) FROM chat_active_branch WHERE chat_id=?", (chat,)).fetchone()[0]
    conn.close()
    assert left == 0


def test_stale_remembered_branch_is_reported_as_none():
    api, chat, root = setup()
    api.send(chat, root, "hi", first=True)
    conn = api.mod.get_db()
    conn.execute("INSERT OR REPLACE INTO chat_active_branch VALUES (?,?)", (chat, "11111111-1111-1111-1111-111111111111"))
    conn.commit(); conn.close()
    assert active(api, chat) is None
