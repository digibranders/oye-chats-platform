"""A streamed response closes its body in the task that streamed it, even when the client leaves mid-send.

Starlette 0.52 stops iterating a ``StreamingResponse`` body when the client
disconnects while a frame is being sent, and never closes it. The async
generator finalizer closed the body later, in a task of its own: the chat
turn's spans could not be detached there (``Failed to detach context``, the
error the price guard trips logged in production on 2026-09-11), and the turn's
cleanup waited on garbage collection. ``ClosingStreamingResponse`` closes the
body where Starlette stops.
"""

import ast
import asyncio
from pathlib import Path

import pytest
from starlette.requests import ClientDisconnect

from app.core.langfuse_client import langfuse_generation
from app.core.streaming import ClosingStreamingResponse
from tests.otel_langfuse import detach_failures, install_otel_langfuse

FRAMES = ("first", "second", "third")


@pytest.fixture()
def langfuse(monkeypatch, caplog):
    return install_otel_langfuse(monkeypatch, caplog)


def _body(tasks: dict[str, list]):
    """A body that streams from inside a Langfuse generation, like a chat turn."""

    async def frames():
        tasks["iterated"].append(asyncio.current_task())
        with langfuse_generation("rag-stream-generation", model="test-model", prompt="q"):
            try:
                for frame in FRAMES:
                    yield frame
            finally:
                tasks["closed"].append(asyncio.current_task())

    return frames()


def _client_that_leaves_mid_send(spec_version: str):
    """ASGI scope, receive and send for a client that leaves while the second frame is being sent."""
    first_frame_sent = asyncio.Event()

    async def send(message):
        if message["type"] != "http.response.body" or not message.get("more_body"):
            return
        if first_frame_sent.is_set():
            if spec_version == "2.4":
                raise OSError("connection reset by peer")
            await asyncio.sleep(3600)  # the socket buffer is full, so this send never completes
        first_frame_sent.set()

    async def receive():
        await first_frame_sent.wait()
        return {"type": "http.disconnect"}

    scope = {"type": "http", "asgi": {"version": "3.0", "spec_version": spec_version}}
    return scope, receive, send


@pytest.mark.parametrize("spec_version", ["2.3", "2.4"])
@pytest.mark.asyncio
async def test_a_client_that_leaves_mid_send_has_the_body_closed_in_the_streaming_task(langfuse, caplog, spec_version):
    tasks: dict[str, list] = {"iterated": [], "closed": []}
    scope, receive, send = _client_that_leaves_mid_send(spec_version)
    response = ClosingStreamingResponse(_body(tasks), media_type="text/event-stream")

    if spec_version == "2.4":
        with pytest.raises(ClientDisconnect):
            await asyncio.wait_for(response(scope, receive, send), timeout=5)
    else:
        await asyncio.wait_for(response(scope, receive, send), timeout=5)

    assert tasks["iterated"]
    assert tasks["closed"] == tasks["iterated"], "closed by the async generator finalizer, in a task of its own"
    assert detach_failures(caplog) == []
    assert langfuse.spans
    assert langfuse.unended() == []


@pytest.mark.asyncio
async def test_a_body_that_runs_to_its_end_streams_every_frame(langfuse, caplog):
    tasks: dict[str, list] = {"iterated": [], "closed": []}
    sent: list[bytes] = []

    async def send(message):
        if message["type"] == "http.response.body":
            sent.append(message["body"])

    async def receive():
        await asyncio.sleep(3600)  # the client stays

    scope = {"type": "http", "asgi": {"version": "3.0", "spec_version": "2.3"}}
    response = ClosingStreamingResponse(_body(tasks), media_type="text/event-stream")

    await asyncio.wait_for(response(scope, receive, send), timeout=5)

    assert sent == [frame.encode() for frame in FRAMES] + [b""]
    assert tasks["closed"] == tasks["iterated"]
    assert detach_failures(caplog) == []
    assert langfuse.unended() == []


def test_the_chat_routes_stream_through_the_closing_response():
    """A bare ``StreamingResponse`` here would leave an abandoned chat turn to the finalizer again."""
    path = Path(__file__).resolve().parents[1] / "app" / "api" / "chat_routes.py"
    bare = [
        node.lineno
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8")))
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "StreamingResponse"
    ]
    assert bare == []
