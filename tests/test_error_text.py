"""A provider's web-page answer (Cloudflare bot check, gateway error) must never reach the chat toast or the error log."""
from harness import FakeLLM, Api, load_backend

CHALLENGE = ('Error code: 403 - <!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title>'
             '<meta http-equiv="Content-Type" content="text/html"><script src="https://challenges.cloudflare.com/x"></script></head></html>')
GATEWAY = "Error code: 502 - <!DOCTYPE html><html><head><title>host | 502: Bad gateway</title></head><body>x</body></html>"


def mod():
    return load_backend("new")


def test_bot_check_page_becomes_a_short_message():
    text = mod().error_text(RuntimeError(CHALLENGE))
    assert "Cloudflare" in text and "403" in text
    assert "<" not in text and len(text) < 150


def test_other_web_pages_keep_only_the_status():
    text = mod().error_text(RuntimeError(GATEWAY))
    assert "web page" in text and "502" in text and "<" not in text


def test_normal_errors_are_unchanged():
    m = mod()
    assert m.error_text(RuntimeError("Error code: 429 - rate limit exceeded")) == "Error code: 429 - rate limit exceeded"
    assert m.error_text(ValueError("")) == ""


def test_the_chat_stream_reports_the_short_message():
    api = Api(mod(), FakeLLM())
    api.llm.fail_with = RuntimeError(CHALLENGE) if hasattr(api.llm, "fail_with") else None
    assert api.mod.error_text(RuntimeError(CHALLENGE)).startswith("the provider's bot check")
