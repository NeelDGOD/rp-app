"""The app's own log: what the browser saw (settings changes, model calls, retries, errors), stored per account, readable
with a revocable debug key that shows the log and a summary of the settings, and never keys or chat text."""
import json

from harness import Api, FakeLLM, load_backend


def setup():
    return Api(load_backend("new"), FakeLLM())


def post(api, events, device="phone"):
    return api.c.post("/client-log", headers=api.h(), json={"device": device, "events": events})


def event(kind="model-call", message="", **data):
    return {"t": "2026-10-24T12:00:00Z", "kind": kind, "message": message, "data": data}


def test_events_are_stored_and_listed_newest_first():
    api = setup()
    first = dict(event("settings", "chain changed"), t="2026-10-24T12:00:00Z")
    second = dict(event("model-call", "budsai glm-5-3-flash 429", provider="budsai", status=429), t="2026-10-24T12:00:05Z")
    assert post(api, [first, second]).json() == {"stored": 2}
    got = api.c.get("/client-log", headers=api.h()).json()["events"]
    assert [e["kind"] for e in got] == ["model-call", "settings"]
    assert got[0]["data"] == {"provider": "budsai", "status": 429}
    assert got[0]["device"] == "phone"


def test_secrets_and_chat_text_are_dropped_even_if_the_app_sent_them():
    api = setup()
    post(api, [event("x", "m", provider="budsai", token="sk-secret", api_key="k", error="boom",
                     nested={"authorization": "Bearer z", "ok": 1}, content="a private reply", prompt="p", text="t", messages=[1])])
    stored = api.c.get("/client-log", headers=api.h()).json()["events"][0]["data"]
    assert stored == {"provider": "budsai", "error": "boom", "nested": {"ok": 1}}
    assert "sk-secret" not in json.dumps(api.c.get("/client-log", headers=api.h()).json())


def test_long_text_is_cut_and_oversized_data_is_replaced():
    api = setup()
    post(api, [event("x", "m" * 1000, big="y" * 5000), event("x", "ok", a=["z" * 10] * 100), event("x", "huge", a=["z" * 300] * 30)])
    got = {e["message"][:1] if e["message"][0] == "m" else e["message"]: e for e in api.c.get("/client-log", headers=api.h()).json()["events"]}
    assert len(got["m"]["message"]) == 300
    assert len(got["m"]["data"]["big"]) == 300
    assert len(got["ok"]["data"]["a"]) == 30, "long lists are cut to 30 items"
    assert got["huge"]["data"] == {"truncated": True}, "data that is still too big is replaced"


def test_a_batch_is_capped():
    api = setup()
    assert post(api, [event("x", str(i)) for i in range(250)]).json() == {"stored": 200}


def test_only_the_newest_rows_are_kept():
    api = setup()
    api.mod.CLIENT_LOG_MAX_ROWS = 5
    for i in range(8):
        post(api, [dict(event("x", f"e{i}"), t=f"2026-10-24T12:00:{i:02d}Z")])
    messages = [e["message"] for e in api.c.get("/client-log", headers=api.h()).json()["events"]]
    assert messages == ["e7", "e6", "e5", "e4", "e3"]


def test_each_account_only_sees_its_own_log_and_can_clear_it():
    a = setup()
    b = Api(a.mod, a.llm, email="other@test.com")
    post(a, [event("x", "mine")])
    assert b.c.get("/client-log", headers=b.h()).json()["events"] == []
    assert a.c.delete("/client-log", headers=a.h()).json() == {"ok": True}
    assert a.c.get("/client-log", headers=a.h()).json()["events"] == []


def test_the_log_needs_a_login():
    api = setup()
    assert api.c.post("/client-log", json={"events": []}).status_code in (401, 422)
    assert api.c.get("/client-log").status_code in (401, 422)


def test_a_debug_key_reads_the_log_and_a_settings_summary_without_secrets():
    api = setup()
    chain = [{"id": "a", "provider": "budsai", "model": "glm-5-3-flash", "name": "", "retries": 4}]
    api.c.put("/settings", headers=api.h(), json={"settings": {"budsai_token": "sk-VERY-SECRET", "groq_token": "gsk-OTHER-SECRET",
                                                               "model_chain": json.dumps(chain), "use_fallbacks": "true", "budsai_model": "glm-5-3-flash"}})
    post(api, [event("model-call", "budsai 429", provider="budsai", status=429)])
    key = api.c.post("/debug-key", headers=api.h()).json()["key"]
    r = api.c.get(f"/debug/{key}")
    assert r.status_code == 200
    body = r.json()
    assert body["keys_set"] == ["budsai", "groq"], "which sources have a key, not the keys"
    assert body["settings"]["model_chain"] == chain
    assert body["settings"]["use_fallbacks"] == "true"
    assert body["events"][0]["message"] == "budsai 429"
    assert "SECRET" not in r.text


def test_the_debug_key_also_shows_the_servers_own_errors():
    api = setup()
    api.mod.log_api_error(api.c.get("/auth/me", headers=api.h()).json()["id"] if "id" in api.c.get("/auth/me", headers=api.h()).json() else "u",
                          "chat", "gemini", "m", RuntimeError("quota"), "")
    key = api.c.post("/debug-key", headers=api.h()).json()["key"]
    assert "server_errors" in api.c.get(f"/debug/{key}").json()


def test_a_debug_key_can_be_revoked_replaced_and_unknown_keys_are_refused():
    api = setup()
    first = api.c.post("/debug-key", headers=api.h()).json()["key"]
    assert api.c.get("/debug-key", headers=api.h()).json()["active"] is True
    second = api.c.post("/debug-key", headers=api.h()).json()["key"]
    assert first != second
    assert api.c.get(f"/debug/{first}").status_code == 404, "a new key replaces the old one"
    assert api.c.get(f"/debug/{second}").status_code == 200
    api.c.delete("/debug-key", headers=api.h())
    assert api.c.get(f"/debug/{second}").status_code == 404
    assert api.c.get("/debug-key", headers=api.h()).json()["active"] is False
    assert api.c.get("/debug/not-a-key").status_code == 404


def test_the_debug_key_is_stored_hashed():
    api = setup()
    key = api.c.post("/debug-key", headers=api.h()).json()["key"]
    conn = api.mod.get_db()
    stored = [r[0] for r in conn.execute("SELECT key_hash FROM debug_keys").fetchall()]
    conn.close()
    assert stored and key not in stored
