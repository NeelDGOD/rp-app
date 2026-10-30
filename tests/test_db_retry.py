"""Startup and requests must ride out libsql's transient 'stream not found' errors instead of crashing."""
import pytest

from harness import load_backend


def flaky(failures, message="Hrana: `api error: stream not found: abc`"):
    calls = {"n": 0}

    def fn():
        calls["n"] += 1
        if calls["n"] <= failures:
            raise ValueError(message)
        return "ok"
    return fn, calls


def test_default_retry_gives_up_after_three_tries():
    mod = load_backend("new")
    fn, calls = flaky(5)
    with pytest.raises(ValueError):
        mod.with_db_retry(fn, delay=0)
    assert calls["n"] == 3


def test_startup_style_retry_outlasts_a_longer_outage():
    mod = load_backend("new")
    fn, calls = flaky(6)
    assert mod.with_db_retry(fn, attempts=8, delay=0) == "ok"
    assert calls["n"] == 7


def test_other_errors_are_not_retried():
    mod = load_backend("new")
    fn, calls = flaky(5, "no such table: users")
    with pytest.raises(ValueError):
        mod.with_db_retry(fn, attempts=8, delay=0)
    assert calls["n"] == 1


def test_a_database_that_stays_unavailable_does_not_stop_the_server_starting(capsys):
    mod = load_backend("new")
    fn, calls = flaky(100)
    assert mod.ensure_schema(fn, attempts=4, delay=0) is False
    assert calls["n"] == 4
    assert "starting anyway" in capsys.readouterr().out


def test_the_schema_is_created_once_the_database_answers():
    mod = load_backend("new")
    fn, calls = flaky(2)
    assert mod.ensure_schema(fn, attempts=8, delay=0) is True
    assert calls["n"] == 3


def test_creating_a_chat_rides_out_a_dropped_stream():
    from harness import Api, FakeLLM
    api = Api(load_backend("new"), FakeLLM())
    bot_id = api.bot()["id"]
    real, drops = api.mod.get_bot, {"left": 2}

    def flaky_get_bot(*args, **kwargs):
        if drops["left"]:
            drops["left"] -= 1
            raise ValueError("Hrana: `api error: stream not found: abc`")
        return real(*args, **kwargs)
    api.mod.get_bot = flaky_get_bot
    chat = api.chat(bot_id)
    assert drops["left"] == 0 and chat["root_branch_id"]
    assert [c["id"] for c in api.c.get("/chats", headers=api.h()).json()] == [chat["id"]], "exactly one chat was created"


def test_every_table_is_created_by_the_split_schema():
    mod = load_backend("new")
    conn = mod.get_db()
    names = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
    conn.close()
    assert {"users", "sessions", "bots", "chats", "branches", "bookmarks", "memory_chunks", "ai_chats",
            "user_settings", "api_errors", "chat_active_branch"} <= names
