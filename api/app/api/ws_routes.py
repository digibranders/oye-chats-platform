"""WebSocket endpoints for live chat between visitors and operators."""

import asyncio
import ipaddress
import logging
from urllib.parse import urlparse

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from sqlalchemy import select

from app.db.models import Bot, ChatSession, Client, Operator
from app.db.repository import add_chat_message, get_lead_info_by_session
from app.db.session import get_session
from app.services.live_chat_service import manager

logger = logging.getLogger(__name__)


def _is_safe_file_url(url: str) -> bool:
    """Validate that a file URL is safe (HTTPS only, no private IPs)."""
    try:
        parsed = urlparse(url)
    except Exception:
        return False

    if parsed.scheme != "https":
        return False

    hostname = parsed.hostname
    if not hostname:
        return False

    # Block private/reserved IP ranges (SSRF protection)
    try:
        ip = ipaddress.ip_address(hostname)
        if ip.is_private or ip.is_loopback or ip.is_reserved or ip.is_link_local:
            return False
    except ValueError:
        # Not an IP — it's a hostname, which is fine
        pass

    # Block known internal hostnames
    return hostname not in ("localhost", "0.0.0.0", "127.0.0.1", "[::]", "[::1]")


router = APIRouter(tags=["websocket"])

_HEARTBEAT_INTERVAL = 30  # seconds

# ── Per-connection rate limiting ──
_VISITOR_MSG_LIMIT = 30  # max messages per window
_OPERATOR_MSG_LIMIT = 60  # operators type faster / manage multiple chats
_RATE_WINDOW_SECONDS = 60.0


class _RateLimiter:
    """Simple sliding-window rate limiter for WebSocket messages."""

    __slots__ = ("_timestamps", "_limit", "_window")

    def __init__(self, limit: int, window: float = _RATE_WINDOW_SECONDS):
        self._timestamps: list[float] = []
        self._limit = limit
        self._window = window

    def allow(self) -> bool:
        """Return True if the message is allowed, False if rate-limited."""
        import time

        now = time.monotonic()
        # Prune expired timestamps
        cutoff = now - self._window
        while self._timestamps and self._timestamps[0] < cutoff:
            self._timestamps.pop(0)
        if len(self._timestamps) >= self._limit:
            return False
        self._timestamps.append(now)
        return True


async def _heartbeat(ws: WebSocket) -> None:
    """Send periodic pings to keep the WebSocket connection alive."""
    while True:
        await asyncio.sleep(_HEARTBEAT_INTERVAL)
        await ws.send_json({"type": "ping"})


async def _send_initial_waiting_queue(
    ws: WebSocket,
    client_id: int,
    operator_department_id: int | None = None,
):
    """Send DB-backed waiting queue snapshot on connect."""
    waiting_items: list[dict] = []

    with get_session() as session:
        waiting_sessions = session.execute(
            select(ChatSession, Bot)
            .join(Bot, ChatSession.bot_id == Bot.id)
            .where(Bot.client_id == client_id, ChatSession.status == "waiting")
            .order_by(ChatSession.created_at.asc())
        ).all()

        for chat_session, _ in waiting_sessions:
            if (
                operator_department_id
                and chat_session.department_id
                and chat_session.department_id != operator_department_id
            ):
                continue

            lead_info = get_lead_info_by_session(session, chat_session.id)
            waiting_items.append(
                {
                    "session_id": chat_session.id,
                    "name": lead_info.name if lead_info else "Anonymous",
                    "reason": chat_session.handoff_reason,
                }
            )

    await ws.send_json(
        {
            "type": "queue_update",
            "waiting": waiting_items,
            "count": len(waiting_items),
        }
    )


@router.websocket("/ws/chat/{session_id}")
async def visitor_websocket(ws: WebSocket, session_id: str, bot_key: str | None = None):
    """WebSocket for visitor (widget) side of live chat.

    Auth resolution order (most→least preferred):
    1. ``X-Bot-Key`` request header (non-browser / native clients)
    2. ``Sec-WebSocket-Protocol`` header encoded as ``bot-key.<value>``
    3. ``bot_key`` query parameter (browser Widget — browsers cannot set WS headers)

    Note: the query-parameter fallback is intentional.  Browser clients cannot
    set arbitrary headers on WebSocket connections.  The value is encrypted
    in transit over TLS/WSS.  Production nginx should be configured to omit
    WebSocket query strings from access logs to avoid log exposure.
    """
    # Prefer header-based auth when available (non-browser clients)
    resolved_key = ws.headers.get("x-bot-key") or bot_key
    # Subprotocol trick: allow "bot-key.<value>" in Sec-WebSocket-Protocol
    if not resolved_key:
        for proto in ws.headers.get("sec-websocket-protocol", "").split(","):
            proto = proto.strip()
            if proto.startswith("bot-key."):
                resolved_key = proto[len("bot-key.") :]
                break

    if not resolved_key:
        await ws.close(code=4001, reason="Missing bot_key")
        return
    bot_key = resolved_key

    # Determine the subprotocol to echo back so browsers don't reject the WS.
    # When the client sends Sec-WebSocket-Protocol, the server MUST respond with
    # one of the offered values or browsers may close the connection immediately.
    accepted_subprotocol: str | None = None
    for proto in ws.headers.get("sec-websocket-protocol", "").split(","):
        proto = proto.strip()
        if proto.startswith("bot-key."):
            accepted_subprotocol = proto
            break

    with get_session() as session:
        bot = session.execute(select(Bot).where(Bot.bot_key == bot_key, Bot.is_active.is_(True))).scalar_one_or_none()
        if not bot:
            await ws.close(code=4003, reason="Invalid bot key")
            return
        bot_id = bot.id

        # Validate session belongs to this bot (prevent cross-session messaging)
        chat_session = session.execute(select(ChatSession).where(ChatSession.id == session_id)).scalar_one_or_none()
        if chat_session and chat_session.bot_id != bot_id:
            await ws.close(code=4003, reason="Session does not belong to this bot")
            return

    await manager.connect_visitor(session_id, ws, subprotocol=accepted_subprotocol)
    heartbeat_task = asyncio.create_task(_heartbeat(ws))
    rate_limiter = _RateLimiter(_VISITOR_MSG_LIMIT)

    try:
        while True:
            data = await ws.receive_json()
            msg_type = data.get("type")

            if msg_type == "ping":
                await ws.send_json({"type": "pong"})

            elif msg_type == "message":
                if not rate_limiter.allow():
                    await ws.send_json({"type": "error", "message": "Rate limit exceeded. Please slow down."})
                    continue
                content = data.get("content", "").strip()
                if not content or len(content) > 10000:
                    continue

                with get_session() as session:
                    add_chat_message(session, session_id, role="user", content=content, bot_id=bot_id)
                    session.commit()

                await manager.route_visitor_message(session_id, content)

            elif msg_type == "file":
                file_url = data.get("file_url", "").strip()
                filename = data.get("filename", "file").replace("/", "").replace("\\", "")[:100]
                content_type = data.get("content_type", "")
                if not file_url or not _is_safe_file_url(file_url):
                    continue

                # Save as a message with file metadata
                file_content = f"[File: {filename}]({file_url})"
                with get_session() as session:
                    add_chat_message(session, session_id, role="user", content=file_content, bot_id=bot_id)
                    session.commit()

                await manager.route_visitor_file(session_id, file_url, filename, content_type)

            elif msg_type == "typing":
                await manager.send_typing_to_operator(session_id)

            elif msg_type == "stopped_typing":
                # Explicit stopped-typing event
                await manager.send_stopped_typing_to_operator(session_id)

            elif msg_type == "read_receipt":
                # Visitor confirms they've read messages up to this ID
                last_read_id = data.get("last_read_id")
                if last_read_id is not None:
                    await manager.send_read_receipt_to_operator(session_id, last_read_id)

            elif msg_type == "status_check":
                # Widget polls for current status — recovers from lost WS messages
                await manager._restore_visitor_state(session_id)

            elif msg_type == "visitor_end_chat":
                # Visitor deliberately ended the chat (clicked "End chat and return to AI").
                # Close the session immediately in DB and notify the operator — do NOT
                # start the 120s grace period, as this is an intentional user action.
                with get_session() as session:
                    chat_session = session.execute(
                        select(ChatSession).where(ChatSession.id == session_id)
                    ).scalar_one_or_none()
                    if chat_session and chat_session.status == "live":
                        bot = session.execute(select(Bot).where(Bot.id == chat_session.bot_id)).scalar_one_or_none()
                        bot_name = bot.name if bot else "AI Assistant"
                        add_chat_message(
                            session, session_id, role="system", content="Visitor ended the live chat.", bot_id=bot_id
                        )
                        chat_session.status = "bot"
                        chat_session.assigned_operator_id = None
                        session.commit()
                        await manager.close_chat(session_id, bot_name)

            elif msg_type and msg_type != "pong":
                logger.warning(f"Unknown visitor WS message type: {msg_type} from {session_id}")

    except WebSocketDisconnect:
        heartbeat_task.cancel()
        manager.disconnect_visitor(session_id)
    except Exception as e:
        heartbeat_task.cancel()
        logger.error(f"Visitor WS error for {session_id}: {type(e).__name__}: {e}")
        manager.disconnect_visitor(session_id)


def _resolve_operator_from_key(key: str, key_type: str) -> tuple[int, str, int, int | None, bool] | None:
    """Resolve operator_id, operator_name, client_id, department_id, is_online from an api_key or operator_key.

    Returns (operator_id, operator_name, client_id, department_id, is_online) or None if auth fails.
    """
    with get_session() as session:
        if key_type == "operator_key":
            operator = session.execute(select(Operator).where(Operator.operator_api_key == key)).scalar_one_or_none()
            if not operator:
                return None
            operator.is_online = True
            session.commit()
            return operator.id, operator.name, operator.client_id, operator.department_id, True

        # Client api_key auth — find or create the owner's operator record.
        # Use role='owner' to avoid matching sub-operators created for the same client.
        client = session.execute(select(Client).where(Client.api_key == key)).scalar_one_or_none()
        if not client:
            return None

        operator = session.execute(
            select(Operator).where(Operator.client_id == client.id, Operator.role == "owner").limit(1)
        ).scalar_one_or_none()

        if not operator:
            import uuid as _uuid

            operator = Operator(
                client_id=client.id,
                name=client.name,
                email=client.email,
                is_online=True,
                role="owner",
                operator_api_key=_uuid.uuid4().hex,
            )
            session.add(operator)
            session.commit()
            session.refresh(operator)
        else:
            operator.is_online = True
            session.commit()

        return operator.id, operator.name, client.id, operator.department_id, operator.is_online


@router.websocket("/ws/operator")
async def operator_websocket(
    ws: WebSocket,
    api_key: str | None = None,
    operator_key: str | None = None,
    agent_key: str | None = None,
):
    """WebSocket for operator (admin dashboard) side of live chat.

    Supports dual auth:
    - api_key: Client API key (owner/backward compat, resolves to first operator)
    - operator_key: Operator's own API key (for multi-operator)
    - agent_key: Legacy alias for operator_key (backward compat during transition)
    """
    effective_key = operator_key or agent_key
    if effective_key:
        result = _resolve_operator_from_key(effective_key, "operator_key")
    elif api_key:
        result = _resolve_operator_from_key(api_key, "api_key")
    else:
        await ws.close(code=4001, reason="Missing api_key or operator_key query param")
        return

    if not result:
        await ws.close(code=4003, reason="Invalid authentication key")
        return

    operator_id, operator_name, client_id, department_id, is_online = result

    await manager.connect_operator(
        operator_id,
        ws,
        department_id=department_id,
        operator_name=operator_name,
        is_online=is_online,
    )

    heartbeat_task = asyncio.create_task(_heartbeat(ws))
    rate_limiter = _RateLimiter(_OPERATOR_MSG_LIMIT)

    try:
        # Queue snapshot is already sent by connect_operator() via _notify_operator_queue.
        # No additional send needed here — the manager is the single source of truth.
        while True:
            data = await ws.receive_json()
            msg_type = data.get("type")

            if msg_type == "ping":
                await ws.send_json({"type": "pong"})

            elif msg_type == "message":
                if not rate_limiter.allow():
                    await ws.send_json({"type": "error", "message": "Rate limit exceeded."})
                    continue
                target_session = data.get("session_id")
                content = data.get("content", "").strip()
                if not target_session or not content:
                    continue

                # Validate session ownership — operator can only message sessions
                # belonging to their client's bots and in "live" status
                with get_session() as session:
                    chat_session = session.execute(
                        select(ChatSession).where(ChatSession.id == target_session)
                    ).scalar_one_or_none()
                    if not chat_session or chat_session.status != "live":
                        continue
                    bot = session.execute(select(Bot).where(Bot.id == chat_session.bot_id)).scalar_one_or_none()
                    if not bot or bot.client_id != client_id:
                        logger.warning(
                            f"Operator {operator_id} attempted to message session {target_session} "
                            f"belonging to a different client — rejected"
                        )
                        continue

                    add_chat_message(session, target_session, role="operator", content=content, bot_id=None)
                    session.commit()

                await manager.route_operator_message(target_session, content, operator_name)

            elif msg_type == "file":
                # File sharing — operator sends a file URL
                target_session = data.get("session_id")
                file_url = data.get("file_url", "").strip()
                filename = data.get("filename", "file").replace("/", "").replace("\\", "")[:100]
                content_type_val = data.get("content_type", "")
                if not target_session or not file_url or not _is_safe_file_url(file_url):
                    continue

                with get_session() as session:
                    chat_session = session.execute(
                        select(ChatSession).where(ChatSession.id == target_session)
                    ).scalar_one_or_none()
                    if not chat_session or chat_session.status != "live":
                        continue
                    bot = session.execute(select(Bot).where(Bot.id == chat_session.bot_id)).scalar_one_or_none()
                    if not bot or bot.client_id != client_id:
                        continue

                    file_content = f"[File: {filename}]({file_url})"
                    add_chat_message(session, target_session, role="operator", content=file_content, bot_id=None)
                    session.commit()

                await manager.route_operator_file(target_session, file_url, filename, content_type_val, operator_name)

            elif msg_type == "typing":
                target_session = data.get("session_id")
                if target_session:
                    await manager.send_typing_to_visitor(target_session)

            elif msg_type == "read_receipt":
                # Operator confirms they've read messages up to this ID
                target_session = data.get("session_id")
                last_read_id = data.get("last_read_id")
                if target_session and last_read_id is not None:
                    await manager.send_read_receipt_to_visitor(target_session, last_read_id)

            elif msg_type == "close_chat":
                target_session = data.get("session_id")
                if target_session:
                    with get_session() as session:
                        chat_session = session.execute(
                            select(ChatSession).where(ChatSession.id == target_session)
                        ).scalar_one_or_none()
                        if chat_session:
                            bot = session.execute(select(Bot).where(Bot.id == chat_session.bot_id)).scalar_one_or_none()
                            # Ownership check: only allow the operator's own client to close
                            if not bot or bot.client_id != client_id:
                                logger.warning(
                                    f"Operator {operator_id} attempted to close session {target_session} "
                                    f"belonging to a different client — rejected"
                                )
                                continue
                            # Capture bot_name before session closes (avoid DetachedInstanceError)
                            bot_name = bot.name
                            # Persist system message for operator-initiated closure
                            add_chat_message(
                                session,
                                target_session,
                                role="system",
                                content=f"Operator {operator_name} ended the live chat.",
                                bot_id=None,
                            )
                            chat_session.status = "bot"
                            chat_session.assigned_operator_id = None
                            session.commit()
                            await manager.close_chat(target_session, bot_name)

    except WebSocketDisconnect:
        heartbeat_task.cancel()
        await manager.disconnect_operator_and_broadcast(operator_id)
    except Exception as e:
        heartbeat_task.cancel()
        logger.error(f"Operator WS error for operator {operator_id}: {type(e).__name__}: {e}")
        await manager.disconnect_operator_and_broadcast(operator_id)


# ── Backward compat: keep /ws/agent as alias during transition ──
@router.websocket("/ws/agent")
async def legacy_agent_websocket(
    ws: WebSocket,
    api_key: str | None = None,
    agent_key: str | None = None,
    operator_key: str | None = None,
):
    """Legacy WebSocket endpoint — delegates to operator_websocket."""
    await operator_websocket(ws, api_key=api_key, operator_key=operator_key, agent_key=agent_key)
