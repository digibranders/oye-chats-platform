"""An LLM token stream that its consumer stops early is closed in the consumer's task.

Production, 2026-09-11 (API on 0ad95d9d): every time the streaming price guard
tripped, OpenTelemetry logged ``Failed to detach context``. The guard breaks out
of ``generate_response_stream`` after a few chunks, and nothing closed the
stream, so CPython's async generator finalizer closed it later in a task of its
own. ``langfuse_generation`` inside ``_stream_from_model`` then exited in that
task's copy of the context, and a ContextVar token cannot be reset in a Context
other than the one that set it.

The fix closes the stream where each consumer stops, at every layer: the RAG
turn closes ``generate_response_stream``, and that closes ``_stream_from_model``.
These tests drive the real ``generate_response_stream``, ``_stream_from_model``
and ``langfuse_generation`` over real OpenTelemetry context handling, so the
detach under test is the one that failed. ``test_rag_stream_close`` covers the
RAG turn's side.
"""

import ast
import asyncio
import contextlib
from pathlib import Path
from types import SimpleNamespace

import pytest
from opentelemetry import trace

from app.services import llm_service
from tests.otel_langfuse import detach_failures, install_otel_langfuse

PRIMARY = "openai/gpt-5.4-mini"
FALLBACK = "gemini/gemini-2.5-flash"
ANSWER = ("SOC as a Service ", "starts at ", "₹2,66,250", " per month.")


@pytest.fixture()
def langfuse(monkeypatch, caplog):
    return install_otel_langfuse(monkeypatch, caplog)


class _ProviderStream:
    """Stand-in for LiteLLM's stream wrapper that records the task that closed it."""

    def __init__(self, texts, *, fail_after: int | None = None):
        self._texts = list(texts)
        self._fail_after = fail_after
        self._served = 0
        self.closed = asyncio.Event()
        self.closed_in: asyncio.Task | None = None

    def __aiter__(self):
        return self

    async def __anext__(self):
        if self._served == self._fail_after:
            raise RuntimeError("provider dropped the connection")
        if not self._texts:
            raise StopAsyncIteration
        self._served += 1
        return SimpleNamespace(usage=None, choices=[SimpleNamespace(delta=SimpleNamespace(content=self._texts.pop(0)))])

    async def aclose(self):
        self.closed_in = asyncio.current_task()
        self.closed.set()


def _wire(monkeypatch, *, primary_fails: bool = False, fail_after: int | None = None) -> list[_ProviderStream]:
    """Real ``generate_response_stream`` and ``_stream_from_model`` over stand-in provider streams."""
    streams: list[_ProviderStream] = []
    monkeypatch.setattr(llm_service, "PRIMARY_MODEL_KEY_SET", True)
    monkeypatch.setattr(llm_service, "FALLBACK_MODEL_KEY_SET", True)
    monkeypatch.setattr(llm_service, "_primary_model", lambda: PRIMARY)
    monkeypatch.setattr(llm_service, "_fallback_model", lambda: FALLBACK)

    async def acompletion(**kwargs):
        if primary_fails and kwargs["model"] == PRIMARY:
            raise RuntimeError("primary unavailable")
        stream = _ProviderStream(ANSWER, fail_after=fail_after)
        streams.append(stream)
        return stream

    monkeypatch.setattr(llm_service.litellm, "acompletion", acompletion)
    return streams


@pytest.mark.parametrize("primary_fails", [False, True], ids=["primary", "fallback"])
@pytest.mark.asyncio
async def test_a_stream_stopped_early_is_closed_in_the_consumers_task(monkeypatch, langfuse, caplog, primary_fails):
    """The price guard's exit: take a few chunks, then stop."""
    streams = _wire(monkeypatch, primary_fails=primary_fails)
    consumer = asyncio.current_task()
    received: list[str] = []

    with langfuse.tracer.start_as_current_span("rag-pipeline-stream") as turn:
        tokens = llm_service.generate_response_stream("q", metadata={"generation_name": "rag-stream-generation"})
        async with contextlib.aclosing(tokens):
            async for chunk in tokens:
                received.append(chunk)
                if len(received) == 2:
                    break
        current_after_stop = trace.get_current_span()

    (stream,) = streams
    # A stream left to the finalizer closes a loop iteration or two later.
    await asyncio.wait_for(stream.closed.wait(), timeout=5)
    assert received == list(ANSWER[:2])
    assert stream.closed_in is consumer, "closed by the async generator finalizer, in a task of its own"
    assert detach_failures(caplog) == []
    assert current_after_stop is turn, "the stopped generation must not stay the current span of the turn"
    assert langfuse.spans
    assert langfuse.unended() == []


@pytest.mark.parametrize("fail_after", [None, 2], ids=["drained", "provider_error"])
@pytest.mark.asyncio
async def test_a_stream_that_ends_on_its_own_still_detaches_and_ends_its_span(
    monkeypatch, langfuse, caplog, fail_after
):
    streams = _wire(monkeypatch, fail_after=fail_after)
    consumer = asyncio.current_task()

    with langfuse.tracer.start_as_current_span("rag-pipeline-stream") as turn:
        tokens = llm_service.generate_response_stream("q")
        async with contextlib.aclosing(tokens):
            received = [chunk async for chunk in tokens]
        current_after = trace.get_current_span()

    (stream,) = streams
    if fail_after is None:
        assert received == list(ANSWER)
    else:
        assert received == [*ANSWER[:fail_after], " [Response interrupted. Please try again.]"]
    assert stream.closed_in is consumer
    assert detach_failures(caplog) == []
    assert current_after is turn
    assert langfuse.spans
    assert langfuse.unended() == []


_TOKEN_STREAMS = frozenset({"generate_response_stream", "_stream_from_model"})
_APP = Path(__file__).resolve().parents[1] / "app"


def _called_name(node: ast.AST) -> str | None:
    if not isinstance(node, ast.Call):
        return None
    if isinstance(node.func, ast.Name):
        return node.func.id
    if isinstance(node.func, ast.Attribute):
        return node.func.attr
    return None


def test_every_token_stream_consumer_closes_the_stream():
    """``async for`` straight over one of these calls hands the generator to the
    finalizer whenever the loop stops early. Each consumer holds the stream in
    ``contextlib.aclosing`` instead."""
    unclosed: list[str] = []
    closed: set[str | None] = set()
    for path in sorted(_APP.rglob("*.py")):
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
            if isinstance(node, ast.AsyncFor) and _called_name(node.iter) in _TOKEN_STREAMS:
                unclosed.append(f"{path.relative_to(_APP.parent)}:{node.lineno}")
            if _called_name(node) == "aclosing" and node.args and _called_name(node.args[0]) in _TOKEN_STREAMS:
                closed.add(_called_name(node.args[0]))
    assert unclosed == []
    assert closed == _TOKEN_STREAMS, "each token stream has a consumer, and that consumer closes it"
