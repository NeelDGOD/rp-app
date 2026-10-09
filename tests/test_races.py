"""Concurrency tests for the lost-update bug: a slow background write (memory update / long stream) must
never overwrite newer chat state.

Each scenario is run on OLD (production) and NEW. OLD is expected to LOSE data (control: proves the
test actually detects the bug); NEW must keep everything.
"""
import random
import threading
import time

import pytest

from harness import Api, FakeLLM, load_backend, done_event


def setup(kind, **llm_kw):
    llm = FakeLLM(**llm_kw)
    api = Api(load_backend(kind), llm)
    chat = api.chat(api.bot()["id"])
    return api, chat["id"], api.root(chat["id"]), llm


def in_thread(fn, *a, **kw):
    out = {}
    def run():
        out["result"] = fn(*a, **kw)
    t = threading.Thread(target=run)
    t.start()
    return t, out


def users(api, chat_id, root):
    return [c for r, c in api.visible(chat_id, root) if r == "user"]


# ---- R1: memory update running while new messages are sent -------------------------------------
def scenario_messages_during_memory(kind):
    api, chat, root, _ = setup(kind, memory_delay=1.5)
    api.send(chat, root, "m1", first=True)
    t, _ = in_thread(api.memory, root)
    time.sleep(0.4)
    api.send(chat, root, "m2")
    api.send(chat, root, "m3")
    during = users(api, chat, root)
    t.join()
    return during, users(api, chat, root), api.branch(chat, root)


def test_old_loses_messages_written_during_memory_update():
    during, after, _ = scenario_messages_during_memory("old")
    assert during == ["m1", "m2", "m3"]
    assert after == ["m1"], "control: the old code is expected to lose m2 and m3"


def test_new_keeps_messages_written_during_memory_update():
    during, after, branch = scenario_messages_during_memory("new")
    assert during == ["m1", "m2", "m3"]
    assert after == ["m1", "m2", "m3"]
    assert "saw" in branch["memory"], "the memory update must still be saved"
    assert branch["turn_counter"] == 3


# ---- R2: a long send finishing after a memory update must not wipe the new memory -----------------
def scenario_memory_during_send(kind):
    api, chat, root, _ = setup(kind, stream_delay=0.5)
    api.send(chat, root, "m1", first=True)
    t, out = in_thread(api.send, chat, root, "m2")
    time.sleep(0.6)
    api.llm.stream_delay = 0
    status, _ = api.memory(root)
    t.join()
    return status, api.branch(chat, root), out["result"]


def test_old_send_wipes_memory_saved_while_it_streamed():
    status, branch, _ = scenario_memory_during_send("old")
    assert status == 200 and branch["memory"] == "", "control: old code overwrites the fresh memory with the stale one"


def test_new_send_keeps_memory_saved_while_it_streamed():
    status, branch, events = scenario_memory_during_send("new")
    assert status == 200
    assert "saw" in branch["memory"]
    assert [c for r, c in [(m["role"], m["content"]) for m in branch["history"] if m["role"] in ("user", "assistant")] if r == "user"] == ["m1", "m2"]
    assert done_event(events)["turn_counter"] == 2


# ---- R3: undo while a memory update runs must stay undone -----------------------------------------------------
def scenario_undo_during_memory(kind):
    api, chat, root, _ = setup(kind, memory_delay=1.2)
    api.send(chat, root, "m1", first=True)
    api.send(chat, root, "m2")
    t, _ = in_thread(api.memory, root)
    time.sleep(0.4)
    api.undo(root)
    t.join()
    return users(api, chat, root), api.branch(chat, root)


def test_old_undo_is_reverted_by_memory_update():
    after, _ = scenario_undo_during_memory("old")
    assert after == ["m1", "m2"], "control: old code resurrects the undone turn"


def test_new_undo_survives_memory_update():
    after, branch = scenario_undo_during_memory("new")
    assert after == ["m1"]
    assert branch["turn_counter"] == 1 and "saw" in branch["memory"]


# ---- R4: manual edit while a memory update runs ------------------------------------------------------------------
def scenario_edit_during_memory(kind):
    api, chat, root, _ = setup(kind, memory_delay=1.2)
    api.send(chat, root, "m1", first=True)
    t, _ = in_thread(api.memory, root)
    time.sleep(0.4)
    api.edit_message(root, 1, "EDITED REPLY")
    t.join()
    return api.visible(chat, root)


def test_old_edit_is_reverted_by_memory_update():
    assert all(c != "EDITED REPLY" for _, c in scenario_edit_during_memory("old"))


def test_new_edit_survives_memory_update():
    assert ("assistant", "EDITED REPLY") in scenario_edit_during_memory("new")


# ---- R5: director note changed while a memory update runs -------------------------------------------------------------
def scenario_director_note_during_memory(kind):
    api, chat, root, _ = setup(kind, memory_delay=1.2)
    api.send(chat, root, "{direct: note A} m1", first=True)
    t, _ = in_thread(api.memory, root)
    time.sleep(0.4)
    api.send(chat, root, "{direct: note B} m2")
    t.join()
    return api.branch(chat, root)["director_note"]


def test_old_director_note_reverted():
    assert scenario_director_note_during_memory("old") == "note A"


def test_new_director_note_kept():
    assert scenario_director_note_during_memory("new") == "note B"


# ---- R6: memory update decides DROP for the note it saw, but the user set a newer note meanwhile ------------------
def test_new_drop_applies_when_note_unchanged():
    api, chat, root, llm = setup("new")
    api.send(chat, root, "{direct: note A} m1", first=True)
    llm.drop_note = True
    api.memory(root)
    assert api.branch(chat, root)["director_note"] == ""


# ---- R7: randomized stress ----------------------------------------------------------------------------------------------
@pytest.mark.parametrize("seed", range(6))
def test_new_stress_no_lost_messages(seed):
    rnd = random.Random(seed)
    api, chat, root, _ = setup("new", memory_delay=0.25, stream_delay=0.02)
    api.send(chat, root, "start", first=True)
    sent = ["start"]
    memory_threads = []
    for i in range(10):
        if rnd.random() < 0.5:
            t, _ = in_thread(api.memory, root)
            memory_threads.append(t)
        text = f"msg {i}"
        api.send(chat, root, text)
        sent.append(text)
        time.sleep(rnd.random() * 0.1)
    for t in memory_threads:
        t.join()
    branch = api.branch(chat, root)
    assert users(api, chat, root) == sent
    assert branch["turn_counter"] == len(sent)
    assert "saw" in branch["memory"]
    roles = [m["role"] for m in branch["history"] if m["role"] in ("user", "assistant")]
    assert roles == ["user", "assistant"] * len(sent)


def test_new_concurrent_sends_on_two_branches_do_not_interfere():
    api, chat, root, _ = setup("new", stream_delay=0.1)
    api.send(chat, root, "base", first=True)
    other = done_event(api.retry(chat, root))["branch_id"]
    t1, _ = in_thread(api.send, chat, root, "on original")
    t2, _ = in_thread(api.send, chat, other, "on retry")
    t1.join(); t2.join()
    assert users(api, chat, root) == ["base", "on original"]
    assert users(api, chat, other) == ["base", "on retry"]
