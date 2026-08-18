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


# ── extract_company_context: strict= and the per-caller bounds ───────────────
#
# company_profile_service writes to a CROSS-TENANT cache. Without strict= it
# cannot tell "this page describes no company" from "the model was
# unreachable", and would record a provider outage as a permanent fact about
# someone's domain. These test the real function, not a mock of it, the
# resolver's own tests patch it wholesale, so nothing there would notice if
# strict= stopped raising.


def test_extract_company_context_swallows_errors_by_default(monkeypatch):
    """The existing contract, relied on by crawl_orchestrator."""

    def boom(**kwargs):
        raise RuntimeError("provider down")

    monkeypatch.setattr(llm_service.litellm, "completion", boom)
    assert llm_service.extract_company_context("Acme Corp is a logistics firm.") is None


def test_extract_company_context_strict_reraises(monkeypatch):
    import pytest

    def boom(**kwargs):
        raise RuntimeError("provider down")

    monkeypatch.setattr(llm_service.litellm, "completion", boom)
    with pytest.raises(RuntimeError, match="provider down"):
        llm_service.extract_company_context("Acme Corp is a logistics firm.", strict=True)


def test_extract_company_context_defaults_are_unchanged_for_existing_callers(monkeypatch):
    """crawl_orchestrator calls this bare; the new params must not move it."""
    captured: dict = {}

    def fake_completion(**kwargs):
        captured.update(kwargs)
        return _fake_response("NAME: Acme Corp\nDESCRIPTION: Logistics.")

    monkeypatch.setattr(llm_service.litellm, "completion", fake_completion)
    llm_service.extract_company_context("Acme Corp is a logistics firm.")
    assert captured["timeout"] == llm_service._LLM_TIMEOUT_S
    assert captured["num_retries"] == llm_service._LLM_NUM_RETRIES


def test_extract_company_context_honours_a_caller_supplied_bound(monkeypatch):
    captured: dict = {}

    def fake_completion(**kwargs):
        captured.update(kwargs)
        return _fake_response("NAME: Acme Corp\nDESCRIPTION: Logistics.")

    monkeypatch.setattr(llm_service.litellm, "completion", fake_completion)
    llm_service.extract_company_context("Acme Corp is a logistics firm.", timeout=20.0, num_retries=1)
    assert captured["timeout"] == 20.0
    assert captured["num_retries"] == 1
