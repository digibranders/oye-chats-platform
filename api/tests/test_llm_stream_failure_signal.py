"""``generate_response_stream`` must report failure STRUCTURALLY, not as text.

Every failure branch in the streaming helper yields a human-readable error
*string* so the visitor sees something. A caller that only counts yielded
chunks therefore cannot tell a provider outage from a real answer, and
``rag_service`` used exactly that count to decide whether to cache the turn
for an hour and whether to report ``generation_failed`` (which drives the
credit refund). The ``status`` dict added here mirrors the ``(text, failed)``
tuple the non-streaming ``_generate_response`` already returns:

* ``error``  — any failure branch ran, so the caller must not cache the text.
* ``failed`` — no real answer tokens were produced, so the caller may refund.
  Deliberately False on a mid-stream failure that already delivered content.
"""

import pytest

from app.services import llm_service
from app.services.llm_service import generate_response_stream

PRIMARY = "openai/gpt-5.4-mini"
FALLBACK = "gemini/gemini-2.5-flash"


async def _drain(agen):
    return [chunk async for chunk in agen]


@pytest.fixture()
def _models(monkeypatch):
    monkeypatch.setattr(llm_service, "PRIMARY_MODEL_KEY_SET", True)
    monkeypatch.setattr(llm_service, "FALLBACK_MODEL_KEY_SET", True)
    monkeypatch.setattr(llm_service, "_primary_model", lambda: PRIMARY)
    monkeypatch.setattr(llm_service, "_fallback_model", lambda: FALLBACK)


def _install(monkeypatch, behaviour):
    async def stream_side_effect(model, prompt, max_tokens, metadata, temperature, system_prompt=None):
        async for chunk in behaviour(model):
            yield chunk

    monkeypatch.setattr(llm_service, "_stream_from_model", stream_side_effect)


class TestStreamStatusSignal:
    @pytest.mark.asyncio
    async def test_clean_stream_leaves_status_untouched(self, monkeypatch, _models):
        async def ok(_model):
            yield "a real answer"

        _install(monkeypatch, ok)
        status: dict = {}
        assert await _drain(generate_response_stream("hi", status=status)) == ["a real answer"]
        assert status == {}

    @pytest.mark.asyncio
    async def test_missing_primary_key_marks_failed(self, monkeypatch):
        monkeypatch.setattr(llm_service, "PRIMARY_MODEL_KEY_SET", False)
        status: dict = {}
        chunks = await _drain(generate_response_stream("hi", status=status))
        assert chunks and "Configuration error" in chunks[0]
        assert status == {"error": True, "failed": True}

    @pytest.mark.asyncio
    async def test_both_models_failing_marks_failed(self, monkeypatch, _models):
        async def boom(_model):
            raise RuntimeError("provider down")
            yield  # pragma: no cover - makes this an async generator

        _install(monkeypatch, boom)
        status: dict = {}
        chunks = await _drain(generate_response_stream("hi", status=status))
        # The visitor-facing text is indistinguishable from a real answer...
        assert chunks == [" [I encountered an error. Please try again.]"]
        # ...so only the structural flag can tell the caller not to bill it.
        assert status == {"error": True, "failed": True}

    @pytest.mark.asyncio
    async def test_missing_fallback_key_marks_failed(self, monkeypatch, _models):
        monkeypatch.setattr(llm_service, "FALLBACK_MODEL_KEY_SET", False)

        async def boom(_model):
            raise RuntimeError("provider down")
            yield  # pragma: no cover

        _install(monkeypatch, boom)
        status: dict = {}
        await _drain(generate_response_stream("hi", status=status))
        assert status == {"error": True, "failed": True}

    @pytest.mark.asyncio
    async def test_primary_timeout_before_any_chunk_marks_failed(self, monkeypatch, _models):
        async def slow(_model):
            raise TimeoutError("stalled upstream")
            yield  # pragma: no cover

        _install(monkeypatch, slow)
        status: dict = {}
        await _drain(generate_response_stream("hi", status=status))
        assert status == {"error": True, "failed": True}

    @pytest.mark.asyncio
    async def test_mid_stream_failure_is_error_but_not_failed(self, monkeypatch, _models):
        """Partial content already reached the visitor: don't cache it (error),
        but don't refund a partially delivered answer either (not failed)."""

        async def half(_model):
            yield "here is the first half"
            raise RuntimeError("connection reset")

        _install(monkeypatch, half)
        status: dict = {}
        chunks = await _drain(generate_response_stream("hi", status=status))
        assert chunks == ["here is the first half", " [Response interrupted. Please try again.]"]
        assert status == {"error": True, "failed": False}

    @pytest.mark.asyncio
    async def test_fallback_failure_after_fallback_chunks_is_not_failed(self, monkeypatch, _models):
        async def behaviour(model):
            if model == PRIMARY:
                raise RuntimeError("primary down")
            yield "fallback got this far"
            raise RuntimeError("fallback died too")

        _install(monkeypatch, behaviour)
        status: dict = {}
        chunks = await _drain(generate_response_stream("hi", status=status))
        assert chunks[0] == "fallback got this far"
        assert status == {"error": True, "failed": False}

    @pytest.mark.asyncio
    async def test_status_is_optional(self, monkeypatch, _models):
        """Existing callers pass no ``status`` and must be unaffected."""

        async def boom(_model):
            raise RuntimeError("provider down")
            yield  # pragma: no cover

        _install(monkeypatch, boom)
        assert await _drain(generate_response_stream("hi")) == [" [I encountered an error. Please try again.]"]
