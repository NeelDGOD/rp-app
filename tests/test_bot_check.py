"""A provider's Cloudflare bot check is retried briefly; if it persists, that source's other models are skipped and the
next source answers. Both the memory path (complete) and the chat path (stream_chat) behave the same."""
import asyncio
from types import SimpleNamespace

from harness import load_backend

CHALLENGE = ('Error code: 403 - <!DOCTYPE html><html><head><title>Just a moment...</title>'
             '<script src="https://challenges.cloudflare.com/x"></script></head></html>')

LLM = [("budsai", "k", "a"), ("budsai", "k", "b"), ("groq", "k", "c")]
MESSAGES = [{"role": "user", "content": "x"}]


def make(mod, behaviour):
    """behaviour(provider, model, call_number) returns text or raises. Returns the list of every attempt made."""
    attempts = []

    def get_client(provider, token, model):
        def create(model, messages, stream=False):
            attempts.append(f"{provider}/{model}")
            text = behaviour(provider, model, attempts.count(f"{provider}/{model}"))
            if not stream:
                return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=text))])
            return iter([SimpleNamespace(choices=[SimpleNamespace(delta=SimpleNamespace(content=text))])])
        return SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create))), model

    mod.get_client = get_client
    mod.time = SimpleNamespace(sleep=lambda seconds: None, time=mod.time.time)
    return attempts


def blocked_always(provider, model, n):
    if provider == "budsai":
        raise RuntimeError(CHALLENGE)
    return f"{provider} answered"


def raise_challenge():
    raise RuntimeError(CHALLENGE)


def test_memory_path_retries_then_skips_the_blocked_source():
    mod = load_backend("new")
    attempts = make(mod, blocked_always)
    assert mod.complete(LLM, MESSAGES, "u") == "groq answered"
    assert attempts == ["budsai/a", "budsai/a", "budsai/a", "groq/c"], "3 tries on the first id, the second id skipped"


def test_a_passing_bot_check_is_retried_on_the_same_model():
    mod = load_backend("new")

    def behaviour(provider, model, n):
        if n == 1:
            raise_challenge()
        return "budsai answered"
    attempts = make(mod, behaviour)
    assert mod.complete(LLM, MESSAGES, "u") == "budsai answered"
    assert attempts == ["budsai/a", "budsai/a"]


def test_everything_blocked_raises_the_last_error():
    mod = load_backend("new")
    make(mod, lambda p, m, n: raise_challenge())
    try:
        mod.complete(LLM, MESSAGES, "u")
        raise AssertionError("expected an error")
    except RuntimeError as e:
        assert mod.bot_check(e)


def test_chat_path_behaves_the_same():
    mod = load_backend("new")
    attempts = make(mod, blocked_always)

    async def go():
        reply = mod.stream_chat(LLM, MESSAGES, "u")
        text = ""
        async for chunk in reply:
            if chunk is not mod.KEEPALIVE and chunk.choices and chunk.choices[0].delta.content:
                text += chunk.choices[0].delta.content
        return text, reply.model

    text, served_by = asyncio.run(go())
    assert text == "groq answered" and served_by == "groq / c"
    assert attempts == ["budsai/a", "budsai/a", "budsai/a", "groq/c"]


def test_other_errors_still_fall_straight_through():
    mod = load_backend("new")

    def behaviour(provider, model, n):
        if provider == "budsai":
            raise RuntimeError("Error code: 429 - rate limit")
        return f"{provider} answered"
    attempts = make(mod, behaviour)
    assert mod.complete(LLM, MESSAGES, "u") == "groq answered"
    assert attempts == ["budsai/a", "budsai/b", "groq/c"], "no retry and no skipping for ordinary errors"
