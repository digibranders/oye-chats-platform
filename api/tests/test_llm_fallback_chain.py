"""Tests for the LLM fallback chain itself (AR-31).

Before this file, the only LLM-path test (test_llm_timeout.py) verified a
positive ``timeout`` kwarg is passed — nothing asserted that a primary-model
failure actually invokes the fallback, or that the mid-stream-failure
suppression (the fix for the historical "two stitched-together responses"
bug) actually fires. A future refactor of generate_response_stream could
silently break either property with CI staying green.
"""

from types import SimpleNamespace

import pytest

from app.services import llm_service
from app.services.llm_service import generate_response_stream


def _fake_response(text: str):
    return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=text))])


async def _drain(agen):
    return [chunk async for chunk in agen]


class TestNonStreamingFallbackChain:
    def test_fallbacks_kwarg_is_set_when_both_keys_configured(self, monkeypatch):
        """litellm's own fallback mechanism only engages when we actually pass
        the `fallbacks` kwarg — pin that it's set whenever both primary and
        fallback API keys are configured (and model= isn't overridden)."""
        captured: dict = {}

        def fake_completion(**kwargs):
            captured.update(kwargs)
            return _fake_response("hi")

        monkeypatch.setattr(llm_service.litellm, "completion", fake_completion)
        monkeypatch.setattr(llm_service, "PRIMARY_MODEL_KEY_SET", True)
        monkeypatch.setattr(llm_service, "FALLBACK_MODEL_KEY_SET", True)
        monkeypatch.setattr(llm_service, "_primary_model", lambda: "openai/gpt-5.4-mini")
        monkeypatch.setattr(llm_service, "_fallback_model", lambda: "gemini/gemini-2.5-flash")

        llm_service._generate_response("hi")

        assert captured["fallbacks"] == [{"openai/gpt-5.4-mini": ["gemini/gemini-2.5-flash"]}]

    def test_fallbacks_kwarg_absent_when_fallback_key_not_configured(self, monkeypatch):
        captured: dict = {}

        def fake_completion(**kwargs):
            captured.update(kwargs)
            return _fake_response("hi")

        monkeypatch.setattr(llm_service.litellm, "completion", fake_completion)
        monkeypatch.setattr(llm_service, "PRIMARY_MODEL_KEY_SET", True)
        monkeypatch.setattr(llm_service, "FALLBACK_MODEL_KEY_SET", False)

        llm_service._generate_response("hi")

        assert "fallbacks" not in captured

    def test_fallbacks_kwarg_absent_when_model_override_set(self, monkeypatch):
        """AR-10 override callers (gate-tier tasks) get no cross-provider
        fallback — matching the gate's own single-model contract."""
        captured: dict = {}

        def fake_completion(**kwargs):
            captured.update(kwargs)
            return _fake_response("hi")

        monkeypatch.setattr(llm_service.litellm, "completion", fake_completion)
        monkeypatch.setattr(llm_service, "PRIMARY_MODEL_KEY_SET", True)
        monkeypatch.setattr(llm_service, "FALLBACK_MODEL_KEY_SET", True)

        llm_service._generate_response("hi", model="gemini/gemini-2.5-flash")

        assert "fallbacks" not in captured


class TestStreamingFallbackChain:
    @pytest.mark.asyncio
    async def test_primary_failure_before_any_chunk_invokes_fallback(self, monkeypatch):
        async def failing_primary(model, prompt, max_tokens, metadata, temperature, system_prompt=None):
            raise RuntimeError("primary exploded")
            yield  # pragma: no cover - unreachable, makes this a generator

        async def working_fallback(model, prompt, max_tokens, metadata, temperature, system_prompt=None):
            yield "fallback answer"

        calls = []

        async def stream_side_effect(model, prompt, max_tokens, metadata, temperature, system_prompt=None):
            calls.append(model)
            gen = failing_primary if model == "openai/gpt-5.4-mini" else working_fallback
            async for chunk in gen(model, prompt, max_tokens, metadata, temperature, system_prompt):
                yield chunk

        monkeypatch.setattr(llm_service, "PRIMARY_MODEL_KEY_SET", True)
        monkeypatch.setattr(llm_service, "FALLBACK_MODEL_KEY_SET", True)
        monkeypatch.setattr(llm_service, "_primary_model", lambda: "openai/gpt-5.4-mini")
        monkeypatch.setattr(llm_service, "_fallback_model", lambda: "gemini/gemini-2.5-flash")
        monkeypatch.setattr(llm_service, "_stream_from_model", stream_side_effect)

        chunks = await _drain(generate_response_stream("hi"))

        assert chunks == ["fallback answer"]
        assert calls == ["openai/gpt-5.4-mini", "gemini/gemini-2.5-flash"], "fallback must actually be invoked"

    @pytest.mark.asyncio
    async def test_mid_stream_failure_after_chunks_yielded_suppresses_fallback(self, monkeypatch):
        """The historical "two stitched-together responses" bug: once the
        visitor has already received partial primary text, falling back would
        concatenate a brand-new complete answer onto the half-finished one on
        the same SSE stream (which can't rewind). Must end gracefully instead,
        and the fallback model must NEVER be invoked in this case."""
        calls = []

        async def stream_side_effect(model, prompt, max_tokens, metadata, temperature, system_prompt=None):
            calls.append(model)
            yield "partial "
            yield "answer "
            raise RuntimeError("primary dropped mid-stream")

        monkeypatch.setattr(llm_service, "PRIMARY_MODEL_KEY_SET", True)
        monkeypatch.setattr(llm_service, "FALLBACK_MODEL_KEY_SET", True)
        monkeypatch.setattr(llm_service, "_primary_model", lambda: "openai/gpt-5.4-mini")
        monkeypatch.setattr(llm_service, "_fallback_model", lambda: "gemini/gemini-2.5-flash")
        monkeypatch.setattr(llm_service, "_stream_from_model", stream_side_effect)

        chunks = await _drain(generate_response_stream("hi"))

        assert chunks == ["partial ", "answer ", " [Response interrupted. Please try again.]"]
        assert calls == ["openai/gpt-5.4-mini"], "fallback must NOT be invoked once primary chunks were yielded"

    @pytest.mark.asyncio
    async def test_primary_success_never_invokes_fallback(self, monkeypatch):
        calls = []

        async def stream_side_effect(model, prompt, max_tokens, metadata, temperature, system_prompt=None):
            calls.append(model)
            yield "full answer"

        monkeypatch.setattr(llm_service, "PRIMARY_MODEL_KEY_SET", True)
        monkeypatch.setattr(llm_service, "_primary_model", lambda: "openai/gpt-5.4-mini")
        monkeypatch.setattr(llm_service, "_stream_from_model", stream_side_effect)

        chunks = await _drain(generate_response_stream("hi"))

        assert chunks == ["full answer"]
        assert calls == ["openai/gpt-5.4-mini"]

    @pytest.mark.asyncio
    async def test_both_primary_and_fallback_fail_before_any_chunk(self, monkeypatch):
        async def always_fails(model, prompt, max_tokens, metadata, temperature, system_prompt=None):
            raise RuntimeError(f"{model} exploded")
            yield  # pragma: no cover - unreachable, makes this a generator

        monkeypatch.setattr(llm_service, "PRIMARY_MODEL_KEY_SET", True)
        monkeypatch.setattr(llm_service, "FALLBACK_MODEL_KEY_SET", True)
        monkeypatch.setattr(llm_service, "_primary_model", lambda: "openai/gpt-5.4-mini")
        monkeypatch.setattr(llm_service, "_fallback_model", lambda: "gemini/gemini-2.5-flash")
        monkeypatch.setattr(llm_service, "_stream_from_model", always_fails)

        chunks = await _drain(generate_response_stream("hi"))

        assert chunks == [" [I encountered an error. Please try again.]"]
