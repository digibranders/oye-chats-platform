"""A primary-model stall before the first token must try the fallback (audit R9).

``_stream_from_model`` raises ``TimeoutError`` when a chunk read exceeds
``_STREAM_CHUNK_TIMEOUT_S``. Before this fix that branch always yielded
"[Response timed out. Please try again.]" and returned, so a stalled primary
model was the one pre-first-token failure mode that never reached the
fallback, even though nothing had been streamed to the visitor yet. Every
other pre-first-token failure did.
"""

import pytest

from app.services import llm_service
from app.services.llm_service import generate_response_stream


async def _drain(agen):
    return [chunk async for chunk in agen]


def _wire(monkeypatch, stream_side_effect, *, fallback_key=True):
    monkeypatch.setattr(llm_service, "PRIMARY_MODEL_KEY_SET", True)
    monkeypatch.setattr(llm_service, "FALLBACK_MODEL_KEY_SET", fallback_key)
    monkeypatch.setattr(llm_service, "_primary_model", lambda: "openai/gpt-5.4-mini")
    monkeypatch.setattr(llm_service, "_fallback_model", lambda: "gemini/gemini-2.5-flash")
    monkeypatch.setattr(llm_service, "_stream_from_model", stream_side_effect)


@pytest.mark.asyncio
async def test_primary_timeout_before_any_chunk_invokes_fallback(monkeypatch):
    calls = []

    async def stream_side_effect(model, prompt, max_tokens, metadata, temperature, system_prompt=None):
        calls.append(model)
        if model == "openai/gpt-5.4-mini":
            raise TimeoutError("primary stalled before first token")
            yield  # pragma: no cover - unreachable, makes this a generator
        yield "fallback answer"

    _wire(monkeypatch, stream_side_effect)
    status: dict = {}

    chunks = await _drain(generate_response_stream("hi", status=status))

    assert chunks == ["fallback answer"]
    assert calls == ["openai/gpt-5.4-mini", "gemini/gemini-2.5-flash"]
    assert status == {}, "a clean fallback answer is not a failure the caller must refund"


@pytest.mark.asyncio
async def test_primary_timeout_after_chunks_still_suppresses_fallback(monkeypatch):
    """Partial primary text already reached the visitor: a fallback answer
    would be stitched onto it on an SSE stream that cannot rewind."""
    calls = []

    async def stream_side_effect(model, prompt, max_tokens, metadata, temperature, system_prompt=None):
        calls.append(model)
        yield "partial "
        raise TimeoutError("primary stalled mid-stream")

    _wire(monkeypatch, stream_side_effect)
    status: dict = {}

    chunks = await _drain(generate_response_stream("hi", status=status))

    assert chunks == ["partial ", " [Response timed out. Please try again.]"]
    assert calls == ["openai/gpt-5.4-mini"]
    assert status == {"error": True, "failed": False}


@pytest.mark.asyncio
async def test_primary_timeout_without_a_fallback_key_still_reports_the_failure(monkeypatch):
    async def stream_side_effect(model, prompt, max_tokens, metadata, temperature, system_prompt=None):
        raise TimeoutError("primary stalled before first token")
        yield  # pragma: no cover - unreachable, makes this a generator

    _wire(monkeypatch, stream_side_effect, fallback_key=False)
    status: dict = {}

    chunks = await _drain(generate_response_stream("hi", status=status))

    assert chunks == [" [I encountered an error. Please try again.]"]
    assert status == {"error": True, "failed": True}
