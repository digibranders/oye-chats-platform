"""The RAG turn closes the LLM token stream wherever its stream loop stops.

``rag_pipeline_stream`` leaves ``generate_response_stream`` before the model is
done on three paths: the price guard trips on a figure, the prompt-leak guard
fires, or the visitor leaves mid-answer. On each, the token stream must close
right there, in the task running the turn. Left to the async generator
finalizer, it closed later in a task of its own, where ``langfuse_generation``
could not detach its span (production, 2026-09-11: ``Failed to detach context``
on every price guard trip). ``test_llm_stream_close`` covers the layer below.
"""

import asyncio
import contextlib

import pytest

from app.core.langfuse_client import langfuse_generation
from app.services import rag_service as rs
from tests.otel_langfuse import detach_failures, install_otel_langfuse
from tests.test_price_guard_pipeline import CHUNKS, TYPO, _guarded
from tests.test_rag_pipeline_defects import _answer_text, _drive_stream

QUESTION = "what do you do?"
ANSWER = ("We monitor your network ", "around the clock ", "from two regions.")


@pytest.fixture()
def langfuse(monkeypatch, caplog):
    return install_otel_langfuse(monkeypatch, caplog)


def _traced_stream(chunks, closes: list, *, stall: bool = False):
    """``generate_response_stream`` in the shape that failed: text yielded from
    inside ``langfuse_generation``. ``closes`` records the task that closed it."""

    async def stream(prompt, **kwargs):
        with langfuse_generation("rag-stream-generation", model="test-model", prompt=prompt):
            try:
                for chunk in chunks:
                    yield chunk
                if stall:
                    await asyncio.sleep(3600)  # the model is still writing when the visitor leaves
            finally:
                closes.append(asyncio.current_task())

    return stream


@pytest.mark.parametrize(
    ("guard", "question", "chunks", "never_streamed"),
    [
        ("price", TYPO, (*CHUNKS, " Volume discounts apply."), "Volume discounts"),
        ("leak", QUESTION, ("We monitor networks. ", "REFERENCE INFORMATION", " The rest of the prompt."), "rest of"),
    ],
    ids=["price_guard", "prompt_leak"],
)
@pytest.mark.asyncio
async def test_a_guard_that_stops_the_stream_closes_it_in_the_turns_task(
    db, monkeypatch, langfuse, caplog, guard, question, chunks, never_streamed
):
    session_id = f"close-{guard}"
    bot, _ = _guarded(db, monkeypatch, session_id, live_chat_enabled=True)
    closes: list[asyncio.Task] = []
    monkeypatch.setattr(rs, "generate_response_stream", _traced_stream(chunks, closes))

    frames = await _drive_stream(bot, question, session_id)

    assert never_streamed not in _answer_text(frames), "the loop must stop before the model's last chunk"
    assert closes == [asyncio.current_task()], "closed by the async generator finalizer, in a task of its own"
    assert detach_failures(caplog) == []
    assert langfuse.spans
    assert langfuse.unended() == []


@pytest.mark.parametrize("leave", ["closed", "cancelled"])
@pytest.mark.asyncio
async def test_a_visitor_who_leaves_mid_answer_closes_the_stream_in_the_turns_task(
    db, monkeypatch, langfuse, caplog, leave
):
    """``closed``: the turn is closed while it waits on a frame it has just
    yielded, which throws ``GeneratorExit`` into the stream loop. ``cancelled``:
    the task is cancelled while the model is still writing, which unwinds the
    token stream from the inside."""
    session_id = f"close-leave-{leave}"
    bot, _ = _guarded(db, monkeypatch, session_id)
    closes: list[asyncio.Task] = []
    monkeypatch.setattr(rs, "generate_response_stream", _traced_stream(ANSWER, closes, stall=True))
    seen = asyncio.Event()

    async def turn():
        frames = rs.rag_pipeline_stream(bot, QUESTION, session_id, bot_id=bot.id)
        try:
            async for frame in frames:
                if "We monitor" in frame:
                    seen.set()
                    if leave == "closed":
                        return
        finally:
            await frames.aclose()

    task = asyncio.create_task(turn())
    await asyncio.wait_for(seen.wait(), timeout=10)
    if leave == "cancelled":
        task.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await task

    assert closes == [task], "closed by the async generator finalizer, in a task of its own"
    assert detach_failures(caplog) == []
    assert langfuse.spans
    assert langfuse.unended() == []
