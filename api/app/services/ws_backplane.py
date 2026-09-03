"""Cross-process delivery for live-chat WebSocket frames.

WHY
---
``ConnectionManager`` keeps visitor and operator sockets in per-process
dictionaries, so a frame produced by one process can only reach a socket that
same process happens to hold. With ``WEB_CONCURRENCY=1`` that is always true and
the problem is invisible. The moment the API runs more than one process (or the
WebSocket endpoints move to their own process, which is the plan this belongs to) a frame produced anywhere else is dropped silently: no exception, no log, no
delivery.

This module is the delivery path for that case. A producer that cannot find the
socket locally publishes to a Redis channel named for the *target*; the process
holding that socket is subscribed and writes the frame to its own connection.

DESIGN NOTES
------------
* **Local-first.** Producers call the ``deliver_*`` helpers, which try the local
  socket and only publish when it is absent. Single-process deployments
  therefore behave exactly as before, with no Redis round-trip on the hot path.
* **At-most-once, deliberately.** Redis pub/sub drops messages for subscribers
  that are momentarily disconnected. That is acceptable here because
  ``ChatMessage`` rows are the source of truth and the widget re-hydrates over
  REST on reconnect. Redis Streams would buy durability we already have from
  Postgres, at the cost of consumer groups and trimming.
* **Fail open, never fail the request.** Every publish is best-effort. A Redis
  outage degrades live chat to today's behaviour (local-only delivery); it must
  never turn a visitor's message into a 500.
* **Off by default.** ``WS_BACKPLANE_ENABLED`` gates both the publisher and the
  subscriber, so this ships dark and is enabled per-environment.

Channels are per-target rather than one firehose, so each process only receives
traffic for sockets it actually holds:

    ws:operator:{operator_id}
    ws:session:{session_id}
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import time

from app.config import REDIS_URL, WS_BACKPLANE_ENABLED

logger = logging.getLogger(__name__)

_OPERATOR_CHANNEL = "ws:operator:{}"
_SESSION_CHANNEL = "ws:session:{}"

# One async client for publishing, one connection for the subscriber. The
# subscriber holds a blocking read, so it must not share a connection with
# publishers.
_pub_client = None
_subscriber_task: asyncio.Task | None = None

# Reconnect backoff for the subscriber. Small enough that a Redis blip costs at
# most a couple of seconds of cross-process delivery, capped so a long outage
# does not hammer the server.
_RECONNECT_MIN_DELAY_S = 1.0
_RECONNECT_MAX_DELAY_S = 30.0


def _enabled() -> bool:
    return bool(WS_BACKPLANE_ENABLED and REDIS_URL)


async def _publisher():
    """Lazily build the async Redis client used for publishing."""
    global _pub_client
    if _pub_client is None:
        import redis.asyncio as aioredis

        _pub_client = aioredis.from_url(REDIS_URL, decode_responses=True)
    return _pub_client


async def _publish(channel: str, payload: dict) -> bool:
    """Publish one frame. Returns True if at least one subscriber received it.

    A False return is informational only, it means no process currently holds
    that socket, which is a normal state (the operator may simply be offline).
    """
    if not _enabled():
        return False
    try:
        client = await _publisher()
        receivers = await client.publish(channel, json.dumps(payload, default=str))
        return bool(receivers)
    except Exception:
        # Best-effort by design: a Redis problem degrades delivery, it does not
        # fail the caller's request.
        logger.warning("ws_backplane publish failed on %s", channel, exc_info=True)
        return False


async def publish_to_operator(operator_id: int, payload: dict) -> bool:
    """Publish a frame for an operator socket held by another process.

    Called by ``ConnectionManager._send_to_operator`` once it has established the
    socket is not local, so it does NOT re-check locality here.
    """
    return await _publish(_OPERATOR_CHANNEL.format(operator_id), payload)


async def publish_to_session(session_id: str, payload: dict) -> bool:
    """Publish a frame for a visitor socket held by another process."""
    return await _publish(_SESSION_CHANNEL.format(session_id), payload)


async def deliver_to_operator(manager, operator_id: int, payload: dict) -> bool:
    """Deliver ``payload`` to an operator, wherever their socket lives.

    Local socket first (no Redis on the common path); otherwise publish so the
    process holding it can write the frame.
    """
    if manager.operator_connections.get(operator_id) is not None:
        await manager._send_to_operator_local(operator_id, payload)
        return True
    return await _publish(_OPERATOR_CHANNEL.format(operator_id), payload)


async def deliver_to_session(manager, session_id: str, payload: dict) -> bool:
    """Deliver ``payload`` to a visitor session, wherever its socket lives."""
    if manager.visitor_connections.get(session_id) is not None:
        await manager._send_to_visitor_local(session_id, payload)
        return True
    return await _publish(_SESSION_CHANNEL.format(session_id), payload)


async def _listen_once(manager) -> None:
    """One subscription lifetime: subscribe, then read until the link breaks.

    Subscriptions follow the sockets: the pattern subscription is cheap and
    keeps this simple, while the local-socket check below means a process
    ignores traffic for sockets it does not hold.
    """
    import redis.asyncio as aioredis

    client = aioredis.from_url(REDIS_URL, decode_responses=True)
    pubsub = client.pubsub(ignore_subscribe_messages=True)
    try:
        await pubsub.psubscribe("ws:operator:*", "ws:session:*")
        logger.info("ws_backplane subscriber listening")
        async for message in pubsub.listen():
            if not message or message.get("type") not in ("pmessage", "message"):
                continue
            channel = message.get("channel") or ""
            try:
                payload = json.loads(message.get("data") or "{}")
            except (ValueError, TypeError):
                continue

            try:
                # LOCAL write only. Routing here would re-publish a frame that
                # just arrived over Redis, and it would never stop.
                if channel.startswith("ws:operator:"):
                    operator_id = int(channel.rsplit(":", 1)[1])
                    if manager.operator_connections.get(operator_id) is not None:
                        await manager._send_to_operator_local(operator_id, payload)
                elif channel.startswith("ws:session:"):
                    session_id = channel.rsplit(":", 1)[1]
                    if manager.visitor_connections.get(session_id) is not None:
                        await manager._send_to_visitor_local(session_id, payload)
            except Exception:
                # One bad frame must not kill the subscriber for every socket.
                logger.warning("ws_backplane failed to deliver on %s", channel, exc_info=True)
    finally:
        for closable in (pubsub, client):
            with_close = getattr(closable, "aclose", None) or getattr(closable, "close", None)
            if not with_close:
                continue
            try:
                result = with_close()
                if asyncio.iscoroutine(result):
                    await result
            except Exception:
                logger.debug("ws_backplane close failed", exc_info=True)


async def _listen(manager) -> None:
    """Keep a subscription alive for the life of the process.

    A single Redis error used to end the subscriber permanently: cross-process
    delivery then stayed dark until the next restart, silently. Reconnect with
    bounded exponential backoff instead, and stop cleanly on cancellation.
    """
    delay = _RECONNECT_MIN_DELAY_S
    while True:
        started_at = time.monotonic()
        try:
            await _listen_once(manager)
            # A clean return means the pubsub stream ended without an error
            # (server-side close). Reconnect, but treat it like any other drop.
            logger.warning("ws_backplane subscriber stream ended; reconnecting in %.1fs", delay)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.warning(
                "ws_backplane subscriber failed; reconnecting in %.1fs",
                delay,
                exc_info=True,
            )
        if time.monotonic() - started_at >= _RECONNECT_MAX_DELAY_S:
            # The last subscription was healthy for a while, so this is a fresh
            # incident rather than a failing retry: start the backoff over.
            delay = _RECONNECT_MIN_DELAY_S
        await asyncio.sleep(delay)
        delay = min(delay * 2, _RECONNECT_MAX_DELAY_S)


async def start(manager) -> None:
    """Start the subscriber for this process. No-op when disabled."""
    global _subscriber_task
    if not _enabled():
        logger.info("ws_backplane disabled (WS_BACKPLANE_ENABLED off or no REDIS_URL)")
        return
    if _subscriber_task and not _subscriber_task.done():
        return
    _subscriber_task = asyncio.create_task(_listen(manager))


async def stop() -> None:
    """Cancel the subscriber on shutdown."""
    global _subscriber_task
    if _subscriber_task and not _subscriber_task.done():
        _subscriber_task.cancel()
        # ``CancelledError`` is a BaseException, so ``suppress(Exception)`` let
        # the expected cancellation escape into the shutdown handler.
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await _subscriber_task
    _subscriber_task = None
