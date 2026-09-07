"""A primary-model stall before the first token must try the fallback (audit R9).

``_stream_from_model`` raises ``TimeoutError`` when a chunk read exceeds
``_STREAM_CHUNK_TIMEOUT_S``. Before this fix that branch always yielded
"[Response timed out. Please try again.]" and returned, so a stalled primary
model was the one pre-first-token failure mode that never reached the
fallback, even though nothing had been streamed to the visitor yet. Every
other pre-first-token failure did.

The second half of the fix is the deadline itself. The per-chunk timeout only
ever started once ``litellm.acompletion`` had returned a stream, and that call
carried no ``timeout`` of its own, so a primary that accepted the request and
then produced nothing was bounded by LiteLLM's default request timeout
(6000s), not by anything here. ``_LLM_FIRST_TOKEN_TIMEOUT_S`` is ONE deadline
that covers the request and the first read together; the tests below drive the
real ``_stream_from_model`` against a stand-in stream to pin that contract.
"""

import asyncio
from types import SimpleNamespace

import pytest

from app.services import llm_service
from app.services.llm_service import generate_response_stream

PRIMARY = "openai/gpt-5.4-mini"
FALLBACK = "gemini/gemini-2.5-flash"


async def _drain(agen):
    return [chunk async for chunk in agen]


def _wire(monkeypatch, stream_side_effect, *, fallback_key=True):
    monkeypatch.setattr(llm_service, "PRIMARY_MODEL_KEY_SET", True)
    monkeypatch.setattr(llm_service, "FALLBACK_MODEL_KEY_SET", fallback_key)
    monkeypatch.setattr(llm_service, "_primary_model", lambda: PRIMARY)
    monkeypatch.setattr(llm_service, "_fallback_model", lambda: FALLBACK)
    monkeypatch.setattr(llm_service, "_stream_from_model", stream_side_effect)


# ── generate_response_stream: the TimeoutError branch ────────────────────────


@pytest.mark.asyncio
async def test_primary_timeout_before_any_chunk_invokes_fallback(monkeypatch):
    calls = []

    async def stream_side_effect(model, prompt, max_tokens, metadata, temperature, system_prompt=None):
        calls.append(model)
        if model == PRIMARY:
            raise TimeoutError("primary stalled before first token")
            yield  # pragma: no cover - unreachable, makes this a generator
        yield "fallback answer"

    _wire(monkeypatch, stream_side_effect)
    status: dict = {}

    chunks = await _drain(generate_response_stream("hi", status=status))

    assert chunks == ["fallback answer"]
    assert calls == [PRIMARY, FALLBACK]
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
    assert calls == [PRIMARY]
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


# ── _stream_from_model: the first-token deadline itself ──────────────────────


class _FakeStream:
    """Stand-in for LiteLLM's ``CustomStreamWrapper``: async-iterable and closable.

    ``first_chunk_delay`` / ``later_chunk_delay`` simulate a provider that has
    accepted the request but is slow to produce the first, or a later, chunk.
    """

    def __init__(self, chunks, *, first_chunk_delay: float = 0.0, later_chunk_delay: float = 0.0):
        self._chunks = list(chunks)
        self._first_delay = first_chunk_delay
        self._later_delay = later_chunk_delay
        self._served = 0
        self.closed = False

    def __aiter__(self):
        return self

    async def __anext__(self):
        if not self._chunks:
            raise StopAsyncIteration
        delay = self._first_delay if self._served == 0 else self._later_delay
        if delay:
            await asyncio.sleep(delay)
        self._served += 1
        return self._chunks.pop(0)

    async def aclose(self):
        self.closed = True


def _chunk(text: str):
    return SimpleNamespace(usage=None, choices=[SimpleNamespace(delta=SimpleNamespace(content=text))])


def _install_acompletion(monkeypatch, acompletion) -> None:
    monkeypatch.setattr(llm_service.litellm, "acompletion", acompletion)


@pytest.mark.asyncio
async def test_first_chunk_past_the_deadline_raises_before_any_chunk_and_closes_the_stream(monkeypatch):
    """The production shape: the request returns promptly (connection accepted)
    and then nothing arrives. Must raise a first-token ``TimeoutError`` with
    nothing yielded, and still release the provider stream."""
    monkeypatch.setattr(llm_service, "_LLM_FIRST_TOKEN_TIMEOUT_S", 0.05)
    stream = _FakeStream([_chunk("too late")], first_chunk_delay=5.0)

    async def acompletion(**kwargs):
        return stream

    _install_acompletion(monkeypatch, acompletion)
    received = []

    with pytest.raises(TimeoutError, match=r"first token timeout after 0\.05s"):
        async for chunk in llm_service._stream_from_model(PRIMARY, "hi", None, None):
            received.append(chunk)

    assert received == []
    assert stream.closed is True, "aclose() must run on the deadline path too"


@pytest.mark.asyncio
async def test_a_request_that_never_returns_hits_the_same_deadline(monkeypatch):
    """The deadline starts at the request, not at the first read. Here no
    stream object ever exists, so there is nothing to close and the cleanup
    path must cope with ``response`` being None."""
    monkeypatch.setattr(llm_service, "_LLM_FIRST_TOKEN_TIMEOUT_S", 0.05)

    async def slow_acompletion(**kwargs):
        await asyncio.sleep(5.0)
        return _FakeStream([_chunk("never")])  # pragma: no cover - cancelled before this

    _install_acompletion(monkeypatch, slow_acompletion)
    received = []

    with pytest.raises(TimeoutError, match=r"first token timeout after 0\.05s"):
        async for chunk in llm_service._stream_from_model(PRIMARY, "hi", None, None):
            received.append(chunk)

    assert received == []


@pytest.mark.asyncio
async def test_request_time_is_charged_against_the_first_chunk_deadline(monkeypatch):
    """One deadline, not two consecutive ones: a request that uses most of the
    budget leaves only the remainder for the first read. Each delay alone fits
    inside the deadline; together they do not."""
    monkeypatch.setattr(llm_service, "_LLM_FIRST_TOKEN_TIMEOUT_S", 0.4)
    stream = _FakeStream([_chunk("x")], first_chunk_delay=0.3)

    async def acompletion(**kwargs):
        await asyncio.sleep(0.3)
        return stream

    _install_acompletion(monkeypatch, acompletion)

    with pytest.raises(TimeoutError, match="first token timeout"):
        async for _ in llm_service._stream_from_model(PRIMARY, "hi", None, None):
            pass  # pragma: no cover - nothing arrives in time

    assert stream.closed is True


@pytest.mark.asyncio
async def test_a_stall_after_the_first_chunk_is_a_chunk_timeout(monkeypatch):
    """Once text is flowing the first-token deadline is spent; later reads get
    the per-chunk window, and the error names it so the two are
    distinguishable in logs (the caller treats them differently too: partial
    text suppresses the fallback)."""
    monkeypatch.setattr(llm_service, "_LLM_FIRST_TOKEN_TIMEOUT_S", 5.0)
    monkeypatch.setattr(llm_service, "_STREAM_CHUNK_TIMEOUT_S", 0.05)
    stream = _FakeStream([_chunk("first"), _chunk("second")], later_chunk_delay=5.0)

    async def acompletion(**kwargs):
        return stream

    _install_acompletion(monkeypatch, acompletion)
    received = []

    with pytest.raises(TimeoutError, match=r"chunk timeout after 0\.05s"):
        async for chunk in llm_service._stream_from_model(PRIMARY, "hi", None, None):
            received.append(chunk)

    assert received == ["first"]
    assert stream.closed is True


@pytest.mark.asyncio
async def test_a_first_chunk_inside_the_deadline_streams_normally(monkeypatch):
    monkeypatch.setattr(llm_service, "_LLM_FIRST_TOKEN_TIMEOUT_S", 5.0)
    stream = _FakeStream([_chunk("a"), _chunk("b")], first_chunk_delay=0.01)

    async def acompletion(**kwargs):
        return stream

    _install_acompletion(monkeypatch, acompletion)

    chunks = await _drain(llm_service._stream_from_model(PRIMARY, "hi", None, None))

    assert chunks == ["a", "b"]
    assert stream.closed is True


@pytest.mark.asyncio
async def test_the_litellm_request_carries_the_client_timeout(monkeypatch):
    """The stream call previously passed ``num_retries`` but no ``timeout``, so
    the provider client's connect/read bounds were LiteLLM's defaults."""
    captured: dict = {}

    async def acompletion(**kwargs):
        captured.update(kwargs)
        return _FakeStream([])

    _install_acompletion(monkeypatch, acompletion)

    await _drain(llm_service._stream_from_model(PRIMARY, "hi", None, None))

    assert captured["timeout"] == llm_service._LLM_TIMEOUT_S
    assert captured["num_retries"] == llm_service._LLM_NUM_RETRIES


@pytest.mark.asyncio
async def test_generate_response_stream_falls_back_when_the_primary_never_produces_a_first_token(monkeypatch):
    """End to end through the REAL ``_stream_from_model``: a primary that
    accepts the request and stalls hands the turn to the fallback before the
    visitor sees anything, and its stream is released."""
    monkeypatch.setattr(llm_service, "PRIMARY_MODEL_KEY_SET", True)
    monkeypatch.setattr(llm_service, "FALLBACK_MODEL_KEY_SET", True)
    monkeypatch.setattr(llm_service, "_primary_model", lambda: PRIMARY)
    monkeypatch.setattr(llm_service, "_fallback_model", lambda: FALLBACK)
    monkeypatch.setattr(llm_service, "_LLM_FIRST_TOKEN_TIMEOUT_S", 0.05)
    stalled = _FakeStream([_chunk("too late")], first_chunk_delay=5.0)
    models = []

    async def acompletion(**kwargs):
        models.append(kwargs["model"])
        if kwargs["model"] == PRIMARY:
            return stalled
        return _FakeStream([_chunk("fallback answer")])

    _install_acompletion(monkeypatch, acompletion)
    status: dict = {}

    chunks = await _drain(generate_response_stream("hi", status=status))

    assert chunks == ["fallback answer"]
    assert models == [PRIMARY, FALLBACK]
    assert stalled.closed is True
    assert status == {}, "a clean fallback answer is not a failure the caller must refund"
