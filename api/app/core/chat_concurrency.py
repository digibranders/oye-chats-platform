"""Application-level backpressure for the expensive chat/RAG path.

WHY THIS EXISTS
---------------
A load test (see ``load-tests/``) measured the failure mode: past ~15 concurrent
``/chat/stream`` requests the SQLAlchemy pool (size 5 + overflow 10 = 15) is
exhausted, requests wait ``pool_timeout`` (30s) and then raise
``QueuePool limit ... connection timed out`` — 261 such errors at saturation —
and the exhaustion even starved unrelated background jobs (a shared-pool
cascading failure). The only limiters before this were per-key SlowAPI token
buckets; there was no GLOBAL ceiling on concurrent expensive work, so a spike
from many distinct callers collapsed the single worker instead of degrading.

WHAT THIS DOES
--------------
A process-global async gate caps the number of chat generations in flight. It is
sized *below* the DB pool so the pool can never be driven to exhaustion by chat
traffic (leaving headroom for auth lookups and background jobs). Excess requests
wait briefly for a slot (graceful queueing) and, if none frees up in time, are
rejected with HTTP 503 + ``Retry-After`` — a fast, cheap, non-hanging signal that
does not trigger retry storms or hold a DB connection.

This is per-process. With the single worker that ships today that is the whole
service; when the WebSocket backplane lands and the app runs multiple
workers/instances, this bound is per-instance (a distributed limiter would live
in Redis — noted for that phase).

CONFIG
------
  CHAT_MAX_CONCURRENCY    max in-flight chat generations (default 10, < pool 15)
  CHAT_ACQUIRE_TIMEOUT_S  seconds a request waits for a slot before 503 (default 8)
"""

from __future__ import annotations

import asyncio
import logging
import os

from fastapi import HTTPException

logger = logging.getLogger(__name__)

# Default 10: below the 15-connection pool so chat can never exhaust it, with
# headroom for the ~1 auth/background connection each request also touches.
MAX_CONCURRENCY = max(1, int(os.getenv("CHAT_MAX_CONCURRENCY", "10")))
# Wait this long for a slot before shedding load. Short: a visitor should get a
# fast "busy, retry" rather than a 30s hang that ties up resources.
ACQUIRE_TIMEOUT_S = float(os.getenv("CHAT_ACQUIRE_TIMEOUT_S", "8"))


class ChatConcurrencyGate:
    """A counting gate around the expensive chat path. Not reentrant; each
    acquired slot must be released exactly once (use ``slot()``)."""

    def __init__(self, limit: int, acquire_timeout_s: float) -> None:
        self._limit = limit
        self._timeout = acquire_timeout_s
        # Created here but only bound to the running loop on first await — safe
        # to construct at import time under uvicorn.
        self._sem = asyncio.Semaphore(limit)
        self._in_flight = 0
        self._rejected = 0
        self._waited = 0

    @property
    def limit(self) -> int:
        return self._limit

    def stats(self) -> dict[str, int]:
        """Snapshot for health/observability (surfaced in /health/full)."""
        return {
            "limit": self._limit,
            "in_flight": self._in_flight,
            "available": max(0, self._limit - self._in_flight),
            "rejected_total": self._rejected,
            "queued_total": self._waited,
        }

    async def _acquire(self) -> None:
        # Fast path: a slot is free right now.
        if self._sem.locked() or self._in_flight >= self._limit:
            self._waited += 1
            logger.info(
                "chat gate full (%d/%d in flight) — request waiting up to %.0fs",
                self._in_flight,
                self._limit,
                self._timeout,
            )
        try:
            await asyncio.wait_for(self._sem.acquire(), timeout=self._timeout)
        except TimeoutError as exc:
            self._rejected += 1
            logger.warning(
                "chat gate rejected a request after %.0fs wait (%d/%d in flight, %d rejected total)",
                self._timeout,
                self._in_flight,
                self._limit,
                self._rejected,
            )
            raise HTTPException(
                status_code=503,
                detail={
                    "error": "server_busy",
                    "message": "The assistant is handling a lot of chats right now. Please retry in a few seconds.",
                },
                headers={"Retry-After": str(max(1, int(self._timeout)))},
            ) from exc
        self._in_flight += 1

    def _release(self) -> None:
        self._in_flight = max(0, self._in_flight - 1)
        self._sem.release()

    def slot(self) -> _Slot:
        """Async context manager: ``async with gate.slot():`` holds one slot for
        the block and releases it on any exit (success, error, client cancel)."""
        return _Slot(self)


class _Slot:
    def __init__(self, gate: ChatConcurrencyGate) -> None:
        self._gate = gate
        self._held = False

    async def __aenter__(self) -> _Slot:
        await self._gate._acquire()
        self._held = True
        return self

    async def __aexit__(self, *exc) -> None:
        if self._held:
            self._held = False
            self._gate._release()


# Process-global singleton.
chat_gate = ChatConcurrencyGate(MAX_CONCURRENCY, ACQUIRE_TIMEOUT_S)
