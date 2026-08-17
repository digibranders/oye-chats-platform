"""Cross-process delivery for live-chat WebSocket frames.

WHY
---
``ConnectionManager`` keeps visitor and operator sockets in per-process
dictionaries, so a frame produced by one process can only reach a socket that
same process happens to hold. With ``WEB_CONCURRENCY=1`` that is always true and
the problem is invisible. The moment the API runs more than one process — or the
WebSocket endpoints move to their own process, which is the plan this belongs to
— a frame produced anywhere else is dropped silently: no exception, no log, no
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

from app.config import REDIS_URL, WS_BACKPLANE_ENABLED

logger = logging.getLogger(__name__)

_OPERATOR_CHANNEL = "ws:operator:{}"
_SESSION_CHANNEL = "ws:session:{}"

# One async client for publishing, one connection for the subscriber. The
# subscriber holds a blocking read, so it must not share a connection with
# publishers.
_pub_client = None
_subscriber_task: asyncio.Task | None = None


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

    A False return is informational only — it means no process currently holds
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


async def deliver_to_operator(manager, operator_id: int, payload: dict) -> bool:
    """Deliver ``payload`` to an operator, wherever their socket lives.

    Local socket first (no Redis on the common path); otherwise publish so the
    process holding it can write the frame.
    """
    if manager.operator_connections.get(operator_id) is not None:
        await manager._send_to_operator(operator_id, payload)
        return True
    return await _publish(_OPERATOR_CHANNEL.format(operator_id), payload)


async def deliver_to_session(manager, session_id: str, payload: dict) -> bool:
    """Deliver ``payload`` to a visitor session, wherever its socket lives."""
    if manager.visitor_connections.get(session_id) is not None:
        await manager._send_to_visitor(session_id, payload)
        return True
    return await _publish(_SESSION_CHANNEL.format(session_id), payload)


async def _listen(manager) -> None:
    """Subscribe to this process's sockets and write inbound frames locally.

    Subscriptions follow the sockets: the pattern subscription is cheap and
    keeps this simple, while the local-socket check below means a process
    ignores traffic for sockets it does not hold.
    """
    import redis.asyncio as aioredis

    client = aioredis.from_url(REDIS_URL, decode_responses=True)
    pubsub = client.pubsub(ignore_subscribe_messages=True)
    await pubsub.psubscribe("ws:operator:*", "ws:session:*")
    logger.info("ws_backplane subscriber listening")

    try:
        async for message in pubsub.listen():
            if not message or message.get("type") not in ("pmessage", "message"):
                continue
            channel = message.get("channel") or ""
            try:
                payload = json.loads(message.get("data") or "{}")
            except (ValueError, TypeError):
                continue

            try:
                if channel.startswith("ws:operator:"):
                    operator_id = int(channel.rsplit(":", 1)[1])
                    if manager.operator_connections.get(operator_id) is not None:
                        await manager._send_to_operator(operator_id, payload)
                elif channel.startswith("ws:session:"):
                    session_id = channel.rsplit(":", 1)[1]
                    if manager.visitor_connections.get(session_id) is not None:
                        await manager._send_to_visitor(session_id, payload)
            except Exception:
                # One bad frame must not kill the subscriber for every socket.
                logger.warning("ws_backplane failed to deliver on %s", channel, exc_info=True)
    except asyncio.CancelledError:
        raise
    except Exception:
        logger.exception("ws_backplane subscriber stopped unexpectedly")
    finally:
        with_close = getattr(pubsub, "aclose", None) or getattr(pubsub, "close", None)
        if with_close:
            try:
                result = with_close()
                if asyncio.iscoroutine(result):
                    await result
            except Exception:
                logger.debug("ws_backplane pubsub close failed", exc_info=True)


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
        with contextlib.suppress(Exception):
            await _subscriber_task
    _subscriber_task = None
