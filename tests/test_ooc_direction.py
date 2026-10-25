"""Text in (parentheses) is a direction to the writer: the model is told to carry it out as narration in asterisks,
not to answer it as the character. Messages without parentheses are not touched."""
from harness import Api, FakeLLM, load_backend

PREP = {"x-phase": "prepare"}


def setup():
    api = Api(load_backend("new"), FakeLLM())
    api.bot_id = api.bot()["id"]
    api.chat_id = api.chat(api.bot_id)["id"]
    api.root_id = api.root(api.chat_id)
    return api


def prepare(api, text, path="send", **body):
    payload = {"content": text, "branch_id": api.root_id, **body} if path == "send" else body
    r = api.c.post(f"/chats/{api.chat_id}/{path}", headers=api.h(**PREP), json=payload)
    assert r.status_code == 200, r.text
    return r.json()["messages"]


def notes(messages):
    return [m for m in messages if m["role"] == "system" and m["content"].startswith("OUT-OF-CHARACTER DIRECTION")]


def test_a_message_in_parentheses_becomes_a_direction_to_narrate_in_asterisks():
    api = setup()
    messages = prepare(api, "(explain what she is doing)")
    [note] = notes(messages)
    assert '"explain what she is doing"' in note["content"]
    assert "*asterisks*" in note["content"] and "third-person" in note["content"]
    assert "first person" in note["content"]
    assert messages[-2] is not None and messages[-2]["content"] == note["content"], "the note sits right before the user's message"
    assert messages[-1] == {"role": "user", "content": "(explain what she is doing)"}, "what the user typed is kept as typed"


def test_every_parenthetical_is_listed_and_normal_text_is_still_answered():
    api = setup()
    [note] = notes(prepare(api, "*I sit down.* Hello there. (describe the room) (and her mood)"))
    assert '"describe the room" | "and her mood"' in note["content"]
    assert "outside the parentheses" in note["content"]


def test_messages_without_parentheses_are_untouched():
    api = setup()
    for text in ("Hello there", "*I wave.* Hi!", "Great :) see you", "Bad :( day", "Hello {short}", "()", "( )", "(a)", "( unclosed", "closed only )"):
        assert notes(prepare(api, text)) == [], text


def test_the_model_really_receives_the_direction():
    api = setup()
    sent = []
    real = api.llm.get_client

    def spy(provider, token, model):
        client, model_id = real(provider, token, model)
        create = client.create
        client.create = lambda model, messages, stream=False: (sent.append(messages), create(model=model, messages=messages, stream=stream))[1]
        return client, model_id
    api.mod.get_client = spy
    api.send(api.chat_id, api.root_id, "(narrate her walking in)")
    assert len(notes(sent[-1])) == 1
    assert sent[-1][-1]["content"] == "(narrate her walking in)"
    api.send(api.chat_id, api.root_id, "plain message")
    assert notes(sent[-1]) == [], "the direction applies only to the message that has it"


def test_a_retry_keeps_the_direction_of_the_message_it_answers():
    api = setup()
    api.send(api.chat_id, api.root_id, "(describe the room)")
    [note] = notes(prepare(api, "", path="retry", branch_id=api.root_id, hint="shorter"))
    assert '"describe the room"' in note["content"]
    api.send(api.chat_id, api.root_id, "an ordinary message")
    assert notes(prepare(api, "", path="retry", branch_id=api.root_id)) == []


def test_an_edited_message_gets_its_direction_too():
    api = setup()
    api.send(api.chat_id, api.root_id, "first message")
    messages = prepare(api, "", path="edit-user", branch_id=api.root_id, visible_index=0, new_content="(what is she thinking)")
    [note] = notes(messages)
    assert '"what is she thinking"' in note["content"]
    assert notes(prepare(api, "", path="edit-user", branch_id=api.root_id, visible_index=0, new_content="edited normally")) == []


def test_the_saved_chat_keeps_the_parentheses_and_no_note_is_stored():
    api = setup()
    api.send(api.chat_id, api.root_id, "(explain what she is doing)")
    history = api.branch(api.chat_id, api.root_id)["history"]
    assert [m["content"] for m in history if m["role"] == "user"] == ["(explain what she is doing)"]
    assert not any("OUT-OF-CHARACTER" in m["content"] for m in history)
