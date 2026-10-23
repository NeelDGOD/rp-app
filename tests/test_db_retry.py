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
