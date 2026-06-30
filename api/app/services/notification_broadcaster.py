"""Lightweight WebSocket fan-out for in-app notifications.

A dedicated channel (``/ws/notifications``) so that *every* dashboard tab —
regardless of which page it's on — receives notification events in real
time. This is deliberately separate from the heavy ``/ws/operator`` channel
used by the live-chat console: notifications are broadcast everywhere
(Knowledge Base, Settings, Insights, …) and shouldn't share fate with the
operator presence machinery.

Each workspace (``client_id``) keeps its own set of connections. A handful
of tabs per operator is typical; the broadcaster fan-outs sequentially with
``asyncio.gather`` and prunes dead sockets eagerly. No back-pressure or
buffering — if a tab disconnects, the next poll/refetch through REST closes
the gap.
"""

from __future__ import annotations

import asyncio
import logging
from collections import defaultdict
from typing import Any

from fastapi import WebSocket

logger = logging.getLogger(__name__)


class NotificationBroadcaster:
    """Per-workspace WebSocket registry with best-effort fan-out."""

    def __init__(self) -> None:
        # client_id -> set of open WebSocket connections
        self._conns: dict[int, set[WebSocket]] = defaultdict(set)
        self._lock = asyncio.Lock()
        # Captured at FastAPI startup so sync routes running on the
        # threadpool can still hand off a coroutine onto the main loop.
        # ``None`` until ``bind_loop`` is called (or when the broadcaster
        # is used from a context that genuinely has no main loop, like
        # the ARQ worker — in that case the row is still persisted; only
        # the real-time WS push is skipped).
        self._main_loop: asyncio.AbstractEventLoop | None = None

    def bind_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        """Remember the FastAPI main loop so we can fan-out from threads."""
        self._main_loop = loop

    def schedule_broadcast(self, client_id: int, payload: dict[str, Any]) -> bool:
        """Schedule a broadcast from any thread / sync context.

        Returns True if the coroutine was actually handed off, False if
        no main loop is available (e.g. ARQ worker boot). In the False
        case the notification has already been persisted, so the next
        REST hydrate covers the gap.
        """
        loop = self._main_loop
        if loop is None or loop.is_closed():
            return False
        try:
            if loop.is_running():
                # Called from a worker thread — use the thread-safe API.
                asyncio.run_coroutine_threadsafe(self.broadcast(client_id, payload), loop)
                return True
            return False
        except RuntimeError:
            return False
        except Exception:
            logger.exception("schedule_broadcast failed")
            return False

    async def connect(self, client_id: int, ws: WebSocket) -> None:
        async with self._lock:
            self._conns[client_id].add(ws)
        logger.info(
            "notification ws connected client_id=%s total=%d",
            client_id,
            len(self._conns[client_id]),
        )

    async def disconnect(self, client_id: int, ws: WebSocket) -> None:
        async with self._lock:
            conns = self._conns.get(client_id)
            if conns:
                conns.discard(ws)
                if not conns:
                    self._conns.pop(client_id, None)
        logger.info(
            "notification ws disconnected client_id=%s",
            client_id,
        )

    async def broadcast(self, client_id: int, payload: dict[str, Any]) -> int:
        """Send ``payload`` to every connection in the workspace.

        Returns the number of deliveries that succeeded. Dead sockets are
        evicted as a side-effect.
        """
        conns = list(self._conns.get(client_id, ()))
        if not conns:
            return 0
        delivered = 0
        for ws in conns:
            try:
                await ws.send_json(payload)
                delivered += 1
            except Exception:
                async with self._lock:
                    self._conns.get(client_id, set()).discard(ws)
        logger.info(
            "Broadcasted notification to %d clients for client_id=%s event=%s",
            delivered,
            client_id,
            payload.get("event"),
        )
        return delivered

    def connection_count(self, client_id: int) -> int:
        return len(self._conns.get(client_id, ()))


# Module-level singleton — imported by routes + service for fan-out.
broadcaster = NotificationBroadcaster()
