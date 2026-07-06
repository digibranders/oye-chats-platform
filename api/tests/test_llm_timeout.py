"""Non-streaming LLM calls must carry a client-side timeout (audit F09).

Without ``timeout=``, a hung upstream (a stalled OpenAI/Gemini socket, distinct
from a clean error) blocks the /chat threadpool worker indefinitely and never
triggers the LiteLLM fallback. Every non-streaming ``litellm.completion`` must
pass a positive timeout.
"""

from types import SimpleNamespace

from app.services import llm_service


def _fake_response(text: str):
    return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=text))])


def test_generate_response_passes_a_positive_timeout(monkeypatch):
    captured: dict = {}

    def fake_completion(**kwargs):
        captured.update(kwargs)
        return _fake_response("hello there")

    monkeypatch.setattr(llm_service.litellm, "completion", fake_completion)
    monkeypatch.setattr(llm_service, "PRIMARY_MODEL_KEY_SET", True)
    # Isolate from langfuse wiring so the assertion is purely about the call.
    import contextlib

    @contextlib.contextmanager
    def _noop_gen(*args, **kwargs):
        yield SimpleNamespace(record_litellm=lambda *a, **k: None)

    monkeypatch.setattr(llm_service, "langfuse_generation", _noop_gen)

    text, failed = llm_service._generate_response("hello")

    assert failed is False
    assert "timeout" in captured, "litellm.completion must be called with a timeout"
    assert captured["timeout"] > 0
