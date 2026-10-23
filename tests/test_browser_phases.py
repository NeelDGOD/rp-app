"""Sources the server cannot reach are called from the user's browser. For those, every model-calling endpoint has a
"prepare" step (returns the messages, saves nothing) and a "commit" step (saves a reply the browser fetched).
The result of prepare + commit must be identical to a normal server-side turn."""
import json

from harness import Api, FakeLLM, load_backend

PREP = {"x-phase": "prepare"}
COMMIT = {"x-phase": "commit"}


class Spy(FakeLLM):
    """Fake model that remembers the messages of every call and the text it answered with."""

    def __init__(self):
        super().__init__()
        self.sent = []
        self.answers = []

    def get_client(self, provider, token, model):
        client, model_id = super().get_client(provider, token, model)
        real = client.create

        def create(model, messages, stream=False):
            self.sent.append(messages)
            out = real(model=model, messages=messages, stream=stream)
            if not stream:
                self.answers.append(out.choices[0].message.content)
                return out
            chunks = list(out)
            self.answers.append("".join(c.choices[0].delta.content for c in chunks))
            return iter(chunks)
        client.create = create
        return client, model_id


def pair():
    """Two independent backends: A runs the normal server-side flow, B runs the browser flow."""
    a, b = Api(load_backend("new"), Spy()), Api(load_backend("new"), Spy())
    for api in (a, b):
        api.bot_id = api.bot()["id"]
        api.chat_id = api.chat(api.bot_id)["id"]
        api.root_id = api.root(api.chat_id)
    return a, b


def state(api):
    return api.norm(api.get_chat(api.chat_id))


def post(api, path, headers, body=None):
    return api.c.post(path, headers=api.h(**headers), json=body)


def browser_send(api, text, first=False, served_by="groq / m1"):
    prep = post(api, f"/chats/{api.chat_id}/send", PREP, {"content": text, "branch_id": api.root_id, "is_first_turn": first})
    assert prep.status_code == 200
    reply = api.llm.answers[-1] if api.llm.answers else "*reply* to"
    return prep.json()["messages"], post(api, f"/chats/{api.chat_id}/send", COMMIT,
                                         {"content": text, "branch_id": api.root_id, "is_first_turn": first, "reply": reply, "served_by": served_by})


def test_send_prepare_gives_the_exact_messages_and_saves_nothing():
    a, b = pair()
    a.send(a.chat_id, a.root_id, "Hello there {short}", first=True)
    before = state(b)
    prep = post(b, f"/chats/{b.chat_id}/send", PREP, {"content": "Hello there {short}", "branch_id": b.root_id, "is_first_turn": True})
    assert prep.status_code == 200 and prep.json()["messages"] == a.llm.sent[-1]
    assert state(b) == before, "prepare must not save anything"


def test_send_commit_matches_a_normal_turn():
    a, b = pair()
    a.send(a.chat_id, a.root_id, "Hello there")
    reply = a.llm.answers[-1]
    r = post(b, f"/chats/{b.chat_id}/send", COMMIT, {"content": "Hello there", "branch_id": b.root_id, "reply": reply, "served_by": "groq / m1"})
    assert r.status_code == 200 and r.json()["type"] == "done"
    assert state(b) == state(a)
    assert r.json()["turn_counter"] == 1


def test_a_director_note_in_the_message_is_applied_by_commit_too():
    a, b = pair()
    a.send(a.chat_id, a.root_id, "{direct: be cold} Hi")
    reply = a.llm.answers[-1]
    post(b, f"/chats/{b.chat_id}/send", COMMIT, {"content": "{direct: be cold} Hi", "branch_id": b.root_id, "reply": reply, "served_by": "groq / m1"})
    assert state(b) == state(a)
    assert state(b)["branches"][0]["director_note"] == "be cold"


def test_retry_prepare_and_commit_match_a_normal_retry():
    a, b = pair()
    a.send(a.chat_id, a.root_id, "Hi")
    post(b, f"/chats/{b.chat_id}/send", COMMIT, {"content": "Hi", "branch_id": b.root_id, "reply": a.llm.answers[-1], "served_by": "groq / m1"})
    a.retry(a.chat_id, a.root_id, "be shy")
    prep = post(b, f"/chats/{b.chat_id}/retry", PREP, {"branch_id": b.root_id, "hint": "be shy"})
    assert prep.json()["messages"] == a.llm.sent[-1]
    r = post(b, f"/chats/{b.chat_id}/retry", COMMIT, {"branch_id": b.root_id, "hint": "be shy", "reply": a.llm.answers[-1], "served_by": "groq / m1"})
    assert r.json()["type"] == "done" and "branch_id" in r.json()
    assert state(b) == state(a)


def test_edit_user_prepare_and_commit_match_a_normal_edit():
    a, b = pair()
    a.send(a.chat_id, a.root_id, "Hi")
    post(b, f"/chats/{b.chat_id}/send", COMMIT, {"content": "Hi", "branch_id": b.root_id, "reply": a.llm.answers[-1], "served_by": "groq / m1"})
    a.edit_user(a.chat_id, a.root_id, 0, "Hello, edited")
    body = {"branch_id": b.root_id, "visible_index": 0, "new_content": "Hello, edited"}
    prep = post(b, f"/chats/{b.chat_id}/edit-user", PREP, body)
    assert prep.json()["messages"] == a.llm.sent[-1]
    r = post(b, f"/chats/{b.chat_id}/edit-user", COMMIT, {**body, "reply": a.llm.answers[-1], "served_by": "groq / m1"})
    assert r.json()["type"] == "done"
    assert state(b) == state(a)


def test_memory_prepare_and_commit_match_a_normal_update():
    a, b = pair()
    for api in (a, b):
        for text in ("one", "two"):
            api.send(api.chat_id, api.root_id, text)
    code, normal = a.memory(a.root_id)
    assert code == 200
    prep = b.c.post(f"/branches/{b.root_id}/memory", headers=b.h(**PREP))
    assert prep.status_code == 200
    assert prep.json()["messages"] == a.llm.sent[-1]
    r = b.c.post(f"/branches/{b.root_id}/memory", headers=b.h(**COMMIT), json={"reply": a.llm.answers[-1]})
    assert r.status_code == 200 and r.json()["ok"]
    assert state(b) == state(a)


def test_memory_commit_applies_the_director_note_decision_like_the_normal_path():
    a, b = pair()
    for api in (a, b):
        api.llm.drop_note = True
        api.send(api.chat_id, api.root_id, "{direct: stay cold} one")
    a.memory(a.root_id)
    b.c.post(f"/branches/{b.root_id}/memory", headers=b.h(**PREP))
    b.c.post(f"/branches/{b.root_id}/memory", headers=b.h(**COMMIT), json={"reply": a.llm.answers[-1]})
    assert state(b) == state(a)
    assert state(b)["branches"][0]["director_note"] == ""


def test_ai_chat_prepare_and_commit_match_a_normal_turn():
    a, b = Api(load_backend("new"), Spy()), Api(load_backend("new"), Spy())
    ids = []
    for api in (a, b):
        ids.append(api.c.post("/ai-chats", headers=api.h(), json={"name": "AI"}).json()["id"])
    a.c.post(f"/ai-chats/{ids[0]}/send", headers=a.h(), json={"content": "What is 2+2?"})
    prep = b.c.post(f"/ai-chats/{ids[1]}/send", headers=b.h(**PREP), json={"content": "What is 2+2?"})
    assert prep.json()["messages"] == a.llm.sent[-1]
    r = b.c.post(f"/ai-chats/{ids[1]}/send", headers=b.h(**COMMIT), json={"content": "What is 2+2?", "reply": a.llm.answers[-1]})
    assert r.json() == {"type": "done"}
    got = [b.c.get(f"/ai-chats/{ids[1]}", headers=b.h()).json()["history"], a.c.get(f"/ai-chats/{ids[0]}", headers=a.h()).json()["history"]]
    assert got[0] == got[1]


def test_commit_rejects_an_empty_reply_and_saves_nothing():
    a, b = pair()
    before = state(b)
    for reply in ("", "   ", None):
        r = post(b, f"/chats/{b.chat_id}/send", COMMIT, {"content": "Hi", "branch_id": b.root_id, "reply": reply})
        assert r.status_code == 400
    assert state(b) == before


def test_another_account_cannot_commit_into_my_chat():
    a, _ = pair()
    other = Api(a.mod, a.llm, email="other@test.com")
    r = other.c.post(f"/chats/{a.chat_id}/send", headers=other.h(**COMMIT),
                     json={"content": "x", "branch_id": a.root_id, "reply": "stolen", "served_by": "x"})
    assert r.status_code == 404
    assert "stolen" not in json.dumps(state(a))
