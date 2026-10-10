"""Account settings sync: the model order list must round-trip through PUT/GET /settings (encrypted at rest)."""
import json

from harness import Api, FakeLLM, load_backend

CHAIN = [{"id": "a", "provider": "puter", "model": "deepseek/deepseek-v4.1-flash:free", "name": ""},
         {"id": "b", "provider": "gemini", "model": "gemini-3.8-flash", "name": "G"}]


def setup():
    return Api(load_backend("new"), FakeLLM())


def test_model_chain_round_trips():
    api = setup()
    r = api.c.put("/settings", headers=api.h(), json={"settings": {"model_chain": json.dumps(CHAIN), "use_fallbacks": "true"}})
    assert r.status_code == 200
    got = api.c.get("/settings", headers=api.h()).json()["settings"]
    assert json.loads(got["model_chain"]) == CHAIN
    assert got["use_fallbacks"] == "true"


def test_unknown_settings_are_still_dropped_and_chain_is_stored_encrypted():
    api = setup()
    api.c.put("/settings", headers=api.h(), json={"settings": {"model_chain": json.dumps(CHAIN), "evil": "x", "groq_token": "gsk_secret"}})
    got = api.c.get("/settings", headers=api.h()).json()["settings"]
    assert "evil" not in got and got["groq_token"] == "gsk_secret"
    conn = api.mod.get_db()
    raw = conn.execute("SELECT data FROM user_settings").fetchone()[0]
    conn.close()
    assert "gemini-3.8-flash" not in raw and "gsk_secret" not in raw, "stored encrypted, not as plain text"


def test_each_account_has_its_own_chain():
    a = setup()
    b = Api(a.mod, a.llm, email="other@test.com")
    a.c.put("/settings", headers=a.h(), json={"settings": {"model_chain": json.dumps(CHAIN)}})
    assert b.c.get("/settings", headers=b.h()).json()["settings"] == {}
