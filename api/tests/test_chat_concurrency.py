"""ChatConcurrencyGate: the process-wide ceiling on in-flight chat generations.

The gate sits below the DB pool so chat traffic can never exhaust it. These
tests pin that its two acquisition paths agree: ``slot()`` (the streaming
endpoint) and ``run_sync`` (the synchronous ``POST /chat``, whose pipeline is
blocking code on a worker thread). ``run_sync`` has one property ``slot()``
does not need: a cancelled caller must NOT release the slot while its thread is
still running, because that thread still holds a DB connection and counting
exactly that is the gate's job.
"""

import asyncio
import threading
from collections.abc import Callable

import pytest
from fastapi import HTTPException

from app.core.chat_concurrency import ChatConcurrencyGate


async def _eventually(predicate: Callable[[], bool], timeout_s: float = 5.0) -> bool:
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout_s
    while loop.time() < deadline:
        if predicate():
            return True
        await asyncio.sleep(0.01)
    return predicate()


class TestSlot:
    @pytest.mark.asyncio
    async def test_holds_and_releases_one_slot(self):
        gate = ChatConcurrencyGate(limit=2, acquire_timeout_s=1.0)
        async with gate.slot():
            assert gate.stats()["in_flight"] == 1
            assert gate.stats()["available"] == 1
        assert gate.stats()["in_flight"] == 0

    @pytest.mark.asyncio
    async def test_full_gate_sheds_with_503_and_retry_after(self):
        gate = ChatConcurrencyGate(limit=1, acquire_timeout_s=0.05)
        async with gate.slot():
            with pytest.raises(HTTPException) as excinfo:
                async with gate.slot():
                    pass
        exc = excinfo.value
        assert exc.status_code == 503
        assert exc.detail["error"] == "server_busy"
        assert exc.headers["Retry-After"] == "1"  # never advertised below one second
        stats = gate.stats()
        assert stats["rejected_total"] == 1
        assert stats["queued_total"] == 1
        assert stats["in_flight"] == 0


class TestRunSync:
    @pytest.mark.asyncio
    async def test_runs_the_function_on_a_worker_thread_under_a_slot(self):
        gate = ChatConcurrencyGate(limit=2, acquire_timeout_s=1.0)
        seen: dict[str, object] = {}

        def work(a: int, *, b: int) -> int:
            seen["thread"] = threading.current_thread().name
            seen["in_flight"] = gate.stats()["in_flight"]
            return a + b

        assert await gate.run_sync(work, 1, b=2) == 3
        assert seen["thread"] != threading.current_thread().name
        assert seen["in_flight"] == 1
        assert gate.stats()["in_flight"] == 0

    @pytest.mark.asyncio
    async def test_releases_the_slot_when_the_function_raises(self):
        gate = ChatConcurrencyGate(limit=1, acquire_timeout_s=1.0)

        def boom() -> None:
            raise RuntimeError("pipeline exploded")

        with pytest.raises(RuntimeError, match="pipeline exploded"):
            await gate.run_sync(boom)
        assert gate.stats()["in_flight"] == 0
        # The slot really came back: with limit=1 this would otherwise shed.
        assert await gate.run_sync(lambda: "ok") == "ok"

    @pytest.mark.asyncio
    async def test_sheds_exactly_like_slot_when_full(self):
        gate = ChatConcurrencyGate(limit=1, acquire_timeout_s=0.05)
        ran = threading.Event()
        async with gate.slot():
            with pytest.raises(HTTPException) as excinfo:
                await gate.run_sync(ran.set)
        assert excinfo.value.status_code == 503
        assert excinfo.value.headers["Retry-After"] == "1"
        assert not ran.is_set()  # a shed request never reaches the pipeline
        assert gate.stats()["rejected_total"] == 1
        assert gate.stats()["in_flight"] == 0

    @pytest.mark.asyncio
    async def test_cancelled_caller_keeps_the_slot_until_the_thread_finishes(self):
        """The property that makes ``run_sync`` more than ``to_thread`` inside
        ``slot()``. ``TimeoutMiddleware`` cancels the endpoint coroutine at 60s;
        the worker thread it started cannot be cancelled and keeps its DB
        connection until the pipeline returns. Releasing at cancellation would
        let the gate admit another generation on top of it, once per timed-out
        request, which is the pool exhaustion the gate exists to prevent."""
        gate = ChatConcurrencyGate(limit=1, acquire_timeout_s=1.0)
        started = threading.Event()
        release = threading.Event()

        def work() -> str:
            started.set()
            release.wait(5.0)
            return "late"

        task = asyncio.create_task(gate.run_sync(work))
        assert await asyncio.to_thread(started.wait, 5.0)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        # The thread is still running, so the slot must still be held.
        assert gate.stats()["in_flight"] == 1
        release.set()
        assert await _eventually(lambda: gate.stats()["in_flight"] == 0)
