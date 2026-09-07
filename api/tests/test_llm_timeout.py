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


# ── _generate_response / generate_response / generate_response_checked:
#    per-call timeout and num_retries overrides ─────────────────────────────
#
# The handoff-intent classifier runs on every turn and is awaited before
# retrieval can proceed, so it needs a bound of a few seconds and a single
# attempt; the module defaults (60s × 3 attempts) are for callers nobody is
# waiting on. Every caller that does not pass the new parameters must see the
# defaults exactly as before.


def _install_fake_completion(monkeypatch, captured: dict) -> None:
    def fake_completion(**kwargs):
        captured.update(kwargs)
        return _fake_response("ok")

    monkeypatch.setattr(llm_service.litellm, "completion", fake_completion)
    monkeypatch.setattr(llm_service, "PRIMARY_MODEL_KEY_SET", True)


def test_generate_response_defaults_to_the_module_budget(monkeypatch):
    captured: dict = {}
    _install_fake_completion(monkeypatch, captured)

    llm_service._generate_response("hello")

    assert captured["timeout"] == llm_service._LLM_TIMEOUT_S
    assert captured["num_retries"] == llm_service._LLM_NUM_RETRIES


def test_generate_response_honours_a_caller_supplied_budget(monkeypatch):
    captured: dict = {}
    _install_fake_completion(monkeypatch, captured)

    llm_service._generate_response("hello", timeout=3.0, num_retries=0)

    assert captured["timeout"] == 3.0
    # ``0`` is a real choice ("one attempt, no retries") and must not be read
    # as "unset" by a truthiness check.
    assert captured["num_retries"] == 0


def test_generate_response_override_applies_with_a_model_override_too(monkeypatch):
    """The gate-tier callers (AR-10) are the ones that pass ``model=``; the
    budget must reach the call on that path as well."""
    captured: dict = {}
    _install_fake_completion(monkeypatch, captured)

    llm_service._generate_response("hello", model="gemini/gemini-2.5-flash", timeout=2.5, num_retries=1)

    assert captured["model"] == "gemini/gemini-2.5-flash"
    assert captured["timeout"] == 2.5
    assert captured["num_retries"] == 1


def test_public_wrappers_forward_the_budget(monkeypatch):
    captured: dict = {}
    _install_fake_completion(monkeypatch, captured)

    text = llm_service.generate_response("hello", timeout=4.0, num_retries=0)
    assert text == "ok"
    assert (captured["timeout"], captured["num_retries"]) == (4.0, 0)

    captured.clear()
    text, failed = llm_service.generate_response_checked("hello", timeout=5.0, num_retries=1)
    assert (text, failed) == ("ok", False)
    assert (captured["timeout"], captured["num_retries"]) == (5.0, 1)


def test_public_wrappers_keep_the_defaults_when_the_budget_is_omitted(monkeypatch):
    """Backward compatibility for every existing caller."""
    captured: dict = {}
    _install_fake_completion(monkeypatch, captured)

    llm_service.generate_response("hello")
    assert captured["timeout"] == llm_service._LLM_TIMEOUT_S
    assert captured["num_retries"] == llm_service._LLM_NUM_RETRIES

    captured.clear()
    llm_service.generate_response_checked("hello")
    assert captured["timeout"] == llm_service._LLM_TIMEOUT_S
    assert captured["num_retries"] == llm_service._LLM_NUM_RETRIES


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
