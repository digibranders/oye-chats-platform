"""WebSocket endpoints for live chat between visitors and operators."""

import asyncio
import ipaddress
import logging
from datetime import UTC, datetime
from urllib.parse import urlparse

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from sqlalchemy import func, select

from app.config import PUSH_VISITOR_MSG_EMAIL_DEBOUNCE_SECONDS
from app.core.origin_check import extract_hostname, is_origin_allowed
from app.db.models import Bot, ChatSession, Client, Operator
from app.db.repository import add_chat_message, get_lead_info_by_session
from app.db.session import get_session
from app.schemas.ws import OPERATOR_FRAMES, VISITOR_FRAMES, parse_frame
from app.services.live_chat_service import is_client_gone, manager
from app.services.plan_service import get_client_subscription
from app.services.session_state_machine import InvalidTransitionError, transition_session
from app.services.translation_service import is_translation_enabled, translate_outgoing

logger = logging.getLogger(__name__)

# Per-process debounce for "visitor sent a message in a waiting session" emails.
# Maps ``session_id`` → last-sent timestamp. The window is short (default 60s)
# so a chatty visitor doesn't flood the operator inbox while still ensuring a
# follow-up message *does* re-ping if the operator never picked up the first.
# In a multi-worker deployment each worker has its own dict. Worst case is N
# emails per window where N = uvicorn worker count, which is acceptable for
# this signal class. Bounded at 1000 entries; oldest are evicted FIFO.
_visitor_msg_email_dedup: dict[str, datetime] = {}
_VISITOR_MSG_EMAIL_DEDUP_MAX = 1000

# Fallback queue-timeout when an unattended waiting session needs a push but
# no per-bot setting is in scope (e.g. the visitor messaged after the WS
# became the only context). Matches the same default as
# ``Bot.live_chat_queue_timeout_seconds``.
DEFAULT_QUEUE_TIMEOUT_SECONDS = 20


def _should_email_visitor_message(session_id: str) -> bool:
    """Returns True if a visitor-message email may fire for this session now.

    Updates the debounce marker as a side-effect when it returns True.
    """
    now = datetime.now(UTC)
    last = _visitor_msg_email_dedup.get(session_id)
    if last is not None and (now - last).total_seconds() < PUSH_VISITOR_MSG_EMAIL_DEBOUNCE_SECONDS:
        return False
    _visitor_msg_email_dedup[session_id] = now
    # Bounded eviction. Drop oldest half when we hit the cap. This is cheap
    # compared to maintaining a true LRU and the cap is hit only under unusual
    # traffic patterns.
    if len(_visitor_msg_email_dedup) > _VISITOR_MSG_EMAIL_DEDUP_MAX:
        cutoff = sorted(_visitor_msg_email_dedup.values())[len(_visitor_msg_email_dedup) // 2]
        for sid, ts in list(_visitor_msg_email_dedup.items()):
            if ts < cutoff:
                _visitor_msg_email_dedup.pop(sid, None)
    return True


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
        # Not an IP, it's a hostname, which is fine
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


# One DB write per this many server heartbeats. `touch_last_seen` exists to keep
# `Operator.last_seen_at` fresh enough for the Redis-outage fallback (120s
# window) without hammering Postgres, at a 30s heartbeat, every other tick is
# a write every 60s, inside that window with room to spare.
_LAST_SEEN_EVERY_N_BEATS = 2


async def _operator_presence_heartbeat(ws: WebSocket, operator_id: int, client_id: int) -> None:
    """Ping the operator AND re-stamp their presence, server-side.

    Presence used to be refreshed ONLY when the operator's client sent a
    ``{"type": "heartbeat"}`` message. The Redis key lives 60s, so any client
    that does not send it (the mobile app, or a web client on a tab the browser
    has throttled) went invisible one minute after connecting while its socket
    stayed open and its own UI still showed "connected". Every handoff after
    that minute resolved to ``all_offline`` and the visitor got the offline
    form, with an operator sitting right there. Observed in production on
    2026-08-11: operator connected 13:03:35, key expired ~13:04:35, visitor
    asked for a human 13:08:43 → ``reason=all_offline``.

    An OPEN SOCKET is the presence signal. Asserting it from the server removes
    the dependency on client behaviour entirely; the client-sent ``heartbeat``
    message still works and is now belt-and-braces rather than load-bearing.

    Also drives ``touch_last_seen``, which had no callers at all, so
    ``last_seen_at`` was NULL for every operator and ``is_online``'s documented
    "if Redis is down, fall back to the DB" path could never return True.
    """
    from app.db.session import get_session
    from app.services import operator_presence_service as presence

    beat = 0
    while True:
        await asyncio.sleep(_HEARTBEAT_INTERVAL)
        await ws.send_json({"type": "ping"})

        beat += 1
        # Never let a presence write break the socket: this coroutine dying
        # would stop the pings too, and the connection with it.
        try:
            presence.mark_online(operator_id, client_id)
            if beat % _LAST_SEEN_EVERY_N_BEATS == 0:
                with get_session() as session:
                    presence.touch_last_seen(operator_id, session)
        except Exception:
            logger.debug("presence heartbeat failed for operator=%s", operator_id, exc_info=True)


# ── CAS session transitions for the WS close paths (audit F31) ────────────────
#
# These used to be plain read-then-write status mutations inside the handlers,
# which raced the operator-accept guarded UPDATE (waiting→live): an accept
# committing between the read and the write was silently clobbered back to
# "bot", the operator kept chatting into a dead session. Each helper routes
# through the row-locked state machine with an expected_current CAS; False
# means the CAS lost (or the session is terminal) and the caller must skip its
# side effects (system message, close broadcast).


def _leave_queue_transition(session_id: str) -> bool:
    """Visitor left the queue: waiting → bot, only if still waiting."""
    try:
        transition_session(session_id, "bot", expected_current="waiting", audit_action="visitor_left_queue")
        return True
    except (InvalidTransitionError, ValueError):
        return False


def _visitor_end_transition(session_id: str) -> bool:
    """Visitor ended the live chat: live → bot, only if still live."""
    try:
        transition_session(session_id, "bot", expected_current="live", audit_action="visitor_ended_chat")
        return True
    except (InvalidTransitionError, ValueError):
        return False


def _operator_close_transition(session_id: str, operator_id: int) -> bool:
    """Operator closed the chat: live → bot, only if still live.

    The live-only CAS also stops the old resurrection bug: closing an
    already-closed session used to flip the terminal state back to "bot".
    """
    try:
        transition_session(session_id, "bot", operator_id=operator_id, expected_current="live", audit_action="closed")
        return True
    except (InvalidTransitionError, ValueError):
        return False


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
    3. ``bot_key`` query parameter (browser Widget. Browsers cannot set WS headers)

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

        # Origin whitelist (parity with HTTP get_current_bot). Enforced only when
        # the customer has opted in; otherwise we keep the previous behaviour so
        # existing widgets continue to work.
        if bot.domain_check_enabled:
            origin_header = ws.headers.get("origin") or ws.headers.get("referer")
            hostname = extract_hostname(origin_header)
            if not is_origin_allowed(hostname, list(bot.allowed_domains or [])):
                logger.info(
                    "Widget WS rejected by origin check: bot_id=%s origin=%r hostname=%r",
                    bot_id,
                    origin_header,
                    hostname,
                )
                await ws.close(code=4403, reason="origin_not_allowed")
                return

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
            raw = await ws.receive_json()
            # One schema check for the whole frame, before any branch reaches
            # into it. A rejected frame costs the sender that frame, not the
            # conversation, so we answer and keep the socket open.
            frame, reject_reason = parse_frame(raw, VISITOR_FRAMES)
            if frame is None:
                await ws.send_json({"type": "error", "message": reject_reason})
                continue
            msg_type = frame.type

            if msg_type == "ping":
                await ws.send_json({"type": "pong"})

            elif msg_type == "message":
                if not rate_limiter.allow():
                    await ws.send_json({"type": "error", "message": "Rate limit exceeded. Please slow down."})
                    continue
                content = frame.content.strip()
                if not content:
                    continue

                # Echoed back to the visitor in ``message_ack`` so the widget
                # can map its optimistic UI entry to the persisted ``db_id``
                # and drive the per-message tick state (sending → sent →
                # delivered → read).
                client_msg_id = frame.client_msg_id

                cs_status: str | None = None
                cs_bot_id: int | None = None
                source_language: str | None = None
                with get_session() as session:
                    # Read the session's resolved language BEFORE the insert so
                    # it can be stamped on the row. This is Phase 2 state, read
                    # from the server's own record: the widget is never asked
                    # what language it thinks it is writing in.
                    cs = session.execute(
                        select(ChatSession.status, ChatSession.bot_id, ChatSession.language_code).where(
                            ChatSession.id == session_id
                        )
                    ).one_or_none()
                    if cs is not None:
                        cs_status, cs_bot_id, source_language = cs

                    persisted = add_chat_message(
                        session,
                        session_id,
                        role="user",
                        content=content,
                        bot_id=bot_id,
                        source_language=source_language,
                    )
                    session.commit()
                    db_id = persisted.id

                delivered = await manager.route_visitor_message(
                    session_id, content, db_id=db_id, source_language=source_language
                )

                # Operator alert ladder for the "visitor sent a message in an
                # unattended waiting session" case. We deliberately removed the
                # email that fired on initial handoff; this is the *real* signal
                # an operator needs to see: the visitor is actively typing into
                # an empty queue slot. Push fans out immediately to every
                # eligible operator who is off-WS; email follows as the
                # debounced fallback so a chatty visitor doesn't flood the
                # inbox but a long-waiting one still pings repeatedly.
                if not delivered and cs_status == "waiting" and cs_bot_id is not None:
                    from app.worker.enqueue import enqueue_sync

                    enqueue_sync(
                        "task_dispatch_handoff_push",
                        session_id,
                        cs_bot_id,
                        None,  # department resolved at dispatch time from session
                        None,  # visitor name irrelevant here. Preview already in content
                        content[:140],
                        DEFAULT_QUEUE_TIMEOUT_SECONDS,
                    )
                    if _should_email_visitor_message(session_id):
                        enqueue_sync(
                            "task_send_visitor_message_email",
                            session_id,
                            cs_bot_id,
                            content[:500],
                        )

                await ws.send_json(
                    {
                        "type": "message_ack",
                        "client_msg_id": client_msg_id,
                        "message_id": db_id,
                        "status": "delivered" if delivered else "sent",
                        "timestamp": datetime.now(UTC).isoformat(),
                    }
                )

                # ── Translation, strictly AFTER the ack (Phase 4) ──
                # Detached on purpose. This loop is a sequential
                # ``await ws.receive_json()``, so a provider call placed
                # anywhere above would both stall the visitor's
                # sending → sent → delivered tick and head-of-line block their
                # next message behind their own translation. The original is
                # already persisted and delivered by this point; the operator
                # gets the translation as a follow-up ``message_translation``
                # frame, or never, and live chat is unaffected either way.
                # Gated ONLY on the session having a resolved language, never on
                # ``delivered``. That flag reflects whether the operator's
                # socket is held by THIS worker: with WS_BACKPLANE_ENABLED it is
                # False for a perfectly healthy cross-process pair, and it is
                # also False while the operator is inside their reconnect grace
                # period, when the translation still needs persisting so it is
                # there when they come back. Who to translate for is decided
                # from the database in ``resolve_incoming_target``, which
                # returns no target when there is genuinely nobody to translate
                # for and makes this a cheap no-op.
                if source_language:
                    from app.services.translation_service import spawn_incoming_translation

                    spawn_incoming_translation(session_id, db_id, content)

            elif msg_type == "file":
                # File shares consume the same per-connection rate budget as
                # messages. Otherwise a single connection could flood the DB
                # with unlimited file inserts (audit F32).
                if not rate_limiter.allow():
                    await ws.send_json({"type": "error", "message": "Rate limit exceeded. Please slow down."})
                    continue
                file_url = frame.file_url.strip()
                filename = frame.filename.replace("/", "").replace("\\", "")[:100]
                content_type = frame.content_type
                if not file_url or not _is_safe_file_url(file_url):
                    continue

                client_msg_id = frame.client_msg_id

                # Save as a message with file metadata
                file_content = f"[File: {filename}]({file_url})"
                with get_session() as session:
                    persisted = add_chat_message(session, session_id, role="user", content=file_content, bot_id=bot_id)
                    session.commit()
                    db_id = persisted.id

                delivered = await manager.route_visitor_file(session_id, file_url, filename, content_type, db_id=db_id)

                await ws.send_json(
                    {
                        "type": "message_ack",
                        "client_msg_id": client_msg_id,
                        "message_id": db_id,
                        "status": "delivered" if delivered else "sent",
                        "timestamp": datetime.now(UTC).isoformat(),
                    }
                )

            elif msg_type == "typing":
                await manager.send_typing_to_operator(session_id)

            elif msg_type == "stopped_typing":
                # Explicit stopped-typing event
                await manager.send_stopped_typing_to_operator(session_id)

            elif msg_type == "read_receipt":
                # Visitor confirms they've read messages up to this ID. The
                # schema guarantees a positive int, so the peer can no longer
                # be handed an arbitrary JSON value here.
                await manager.send_read_receipt_to_operator(session_id, frame.last_read_id)

            elif msg_type == "status_check":
                # Widget polls for current status. Recovers from lost WS messages
                await manager._restore_visitor_state(session_id)

            elif msg_type == "submit_offline_form":
                # Visitor fell back to the offline form mid-flow (queue timed
                # out, operators went offline while waiting, etc.). Persist
                # an OfflineMessage with the chat transcript so the responding
                # operator has the conversation context that led to the form.
                #
                # The widget sends:
                #   { type, name, email, phone, message, reason, transcript }
                # Field validation matches the existing /operator/offline-message
                # HTTP endpoint contract.
                # Required fields, the email syntax check, the per-field
                # ceilings and the transcript shape are all enforced by
                # ``SubmitOfflineFormFrame``, the same contract as
                # ``POST /offline-messages``, which this path claimed to match
                # but previously only truncated.
                name = frame.name
                email = frame.email
                phone = frame.phone or None
                message = frame.message
                reason = frame.reason
                transcript = [turn.model_dump() for turn in frame.transcript] if frame.transcript else None

                with get_session() as session:
                    from app.db.models import OfflineMessage

                    offline_msg = OfflineMessage(
                        bot_id=bot_id,
                        session_id=session_id,
                        visitor_name=name,
                        visitor_email=email,
                        visitor_phone=phone,
                        message_body=message,
                        transcript=transcript,
                        fallback_reason=reason,
                    )
                    session.add(offline_msg)
                    session.commit()

                    # Send team notification. Mirrors offline_message_routes.py
                    # so the team is alerted regardless of whether the visitor
                    # arrived here via the REST form or the mid-flow WS fallback.
                    ws_bot = session.execute(select(Bot).where(Bot.id == bot_id)).scalar_one_or_none()
                    if ws_bot and getattr(ws_bot, "email_on_offline", True):
                        from app.services.email_service import (
                            get_notification_recipients,
                            send_offline_message_email,
                            send_unavailable_callback_email,
                        )

                        recipients = get_notification_recipients(ws_bot, "offline_message")
                        reply_to = getattr(ws_bot, "reply_to_email", None)
                        for recipient in recipients:
                            if phone:
                                send_unavailable_callback_email(
                                    notification_email=recipient,
                                    bot_name=ws_bot.name,
                                    contact={"name": name, "email": email, "phone": phone},
                                    reply_to=reply_to,
                                )
                            else:
                                send_offline_message_email(
                                    notification_email=recipient,
                                    bot_name=ws_bot.name,
                                    visitor_name=name,
                                    visitor_email=email,
                                    message_preview=message[:200],
                                    reply_to=reply_to,
                                )

                    # Drop a workspace-scoped notification into the bell so it survives a
                    # reload + reaches operators on any page in the admin dashboard.
                    try:
                        from app.services.notification_service import notify_offline_message

                        if ws_bot is not None:
                            notify_offline_message(
                                session,
                                client_id=ws_bot.client_id,
                                visitor_name=name,
                                visitor_email=email,
                                message_preview=message,
                                offline_message_id=offline_msg.id,
                                bot_name=ws_bot.name,
                            )
                    except Exception:
                        logger.exception("Failed to record offline_message notification via WS")

                await ws.send_json({"type": "offline_form_submitted"})
                logger.info(
                    "Offline form submitted via WS: session=%s bot=%s reason=%s transcript_len=%s",
                    session_id,
                    bot_id,
                    reason,
                    len(transcript) if transcript else 0,
                )

            elif msg_type == "leave_queue":
                # Visitor decided not to wait. Drop them from the queue and
                # let the bot conversation resume. Cleaner than them just
                # closing the widget (which would also clear queue state but
                # leaves the audit trail unclear). CAS from "waiting": if an
                # operator accept won the race, the live chat stands (F31).
                with get_session() as session:
                    from app.services import live_chat_queue_service as queue_svc

                    queue_svc.abandon(session_id, session)
                _leave_queue_transition(session_id)
                await ws.send_json({"type": "queue_left"})

            # Visitor deliberately ended the chat (clicked "End chat and return
            # to AI"). Close the session immediately in DB and notify the
            # operator. Do NOT start the 120s grace period, as this is an
            # intentional user action. CAS from "live" (F31): the side effects
            # below only fire when this write actually won; a concurrent
            # transfer/close skips them.
            elif msg_type == "visitor_end_chat" and _visitor_end_transition(session_id):
                with get_session() as session:
                    bot = session.execute(select(Bot).where(Bot.id == bot_id)).scalar_one_or_none()
                    bot_name = bot.name if bot else "AI Assistant"
                    add_chat_message(
                        session, session_id, role="system", content="Visitor ended the live chat.", bot_id=bot_id
                    )
                    session.commit()
                await manager.close_chat(session_id, bot_name)

            # No trailing unknown-type branch: ``parse_frame`` rejects any
            # type not in ``VISITOR_FRAMES`` before the chain is entered, so
            # everything reaching here is a declared type.

    except WebSocketDisconnect:
        heartbeat_task.cancel()
        manager.disconnect_visitor(session_id)
    except Exception as e:
        heartbeat_task.cancel()
        # A visitor closing their tab reaches here as a bare RuntimeError from
        # Starlette ("WebSocket is not connected...") rather than
        # WebSocketDisconnect, because the socket died mid-operation. That is
        # routine, not an incident. Logging it at ERROR buried genuine
        # failures and inflated Sentry. Real protocol errors still log at
        # ERROR; nothing is swallowed either way.
        detail = f"{type(e).__name__}: {e}" if str(e) else type(e).__name__
        if is_client_gone(e):
            logger.debug(f"Visitor WS closed by client for {session_id} ({detail})")
        else:
            logger.error(f"Visitor WS error for {session_id}: {detail}")
        manager.disconnect_visitor(session_id)


def _resolve_operator_from_key(key: str, key_type: str) -> tuple[int, str, int, int | None, bool, str | None] | None:
    """Resolve operator identity + workspace scope from an api_key or operator_key.

    Returns ``(operator_id, operator_name, client_id, department_id, is_online,
    preferred_locale)`` or None if auth fails.

    ``preferred_locale`` (Phase 4) is carried here so ``connect_operator`` can
    cache it for the console's own language badge without a second query. It is
    NOT what drives translation targeting: that reads the DB per message, see
    ``translation_service.resolve_incoming_target``.
    """
    with get_session() as session:
        if key_type == "operator_key":
            operator = session.execute(select(Operator).where(Operator.operator_api_key == key)).scalar_one_or_none()
            if not operator or not operator.is_active:
                return None
            operator.is_online = True
            session.commit()
            return (
                operator.id,
                operator.name,
                operator.client_id,
                operator.department_id,
                True,
                operator.preferred_locale,
            )

        # Client api_key auth. Find or create the owner's operator record.
        # Use role='owner' to avoid matching sub-operators created for the same client.
        client = session.execute(select(Client).where(Client.api_key == key)).scalar_one_or_none()
        if not client:
            return None

        operator = session.execute(
            select(Operator).where(Operator.client_id == client.id, Operator.role == "owner").limit(1)
        ).scalar_one_or_none()

        if not operator:
            # bot_id is NOT NULL on operators (one operator, one bot. See
            # b1c7e9d3f2a5_operator_bot_one_to_one.py). Bind the auto-provisioned
            # owner to the client's oldest bot, matching that migration's backfill
            # rule. Clients with no bots yet can't use the operator dashboard.
            # Fail auth cleanly rather than crashing on a NOT NULL violation.
            first_bot_id = session.execute(
                select(Bot.id).where(Bot.client_id == client.id).order_by(Bot.created_at.asc()).limit(1)
            ).scalar_one_or_none()
            if first_bot_id is None:
                return None

            import uuid as _uuid

            operator = Operator(
                client_id=client.id,
                bot_id=first_bot_id,
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

        return (
            operator.id,
            operator.name,
            client.id,
            operator.department_id,
            operator.is_online,
            operator.preferred_locale,
        )


@router.websocket("/ws/operator")
async def operator_websocket(
    ws: WebSocket,
    api_key: str | None = None,
    operator_key: str | None = None,
    agent_key: str | None = None,
):
    """WebSocket for operator (admin dashboard) side of live chat.

    Supports dual auth via query params (legacy) **or** Sec-WebSocket-Protocol
    header (preferred. Avoids leaking credentials in URL/logs):

    Query params (legacy, kept for backward compat):
    - api_key: Client API key (owner/backward compat, resolves to first operator)
    - operator_key: Operator's own API key (for multi-operator)
    - agent_key: Legacy alias for operator_key

    Subprotocol header (preferred):
    - ``operator-key.<value>`` . Operator's own key
    - ``api-key.<value>``      . Client/owner key
    """
    # --- Resolve auth: prefer subprotocol header over query params ---
    accepted_subprotocol: str | None = None
    for proto in ws.headers.get("sec-websocket-protocol", "").split(","):
        proto = proto.strip()
        if proto.startswith("operator-key."):
            operator_key = operator_key or proto[len("operator-key.") :]
            accepted_subprotocol = proto
        elif proto.startswith("api-key."):
            api_key = api_key or proto[len("api-key.") :]
            accepted_subprotocol = proto

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

    operator_id, operator_name, client_id, department_id, is_online, operator_locale = result

    # ── Seat-limit enforcement: cap concurrent online operators per subscription ──
    # ``operator_quantity`` on Subscription is the customer's purchased seat count
    # (= included_operator_seats from the plan + extras paid via the seat add-on).
    # Best-effort check: counts operators flagged is_online in the DB. The auth
    # path above already set this operator's flag to True, so the count includes
    # self. If the total exceeds the seat allowance, roll back and reject.
    # A negative mirror is the codebase-wide UNLIMITED (-1) sentinel, carried
    # over from a plan with ``included_operator_seats = -1``, no cap to apply.
    with get_session() as db:
        sub = get_client_subscription(db, client_id)
        if sub is not None and (seat_quantity := int(sub.operator_quantity or 1)) >= 0:
            seat_limit = max(seat_quantity, 1)
            online_count = (
                db.scalar(
                    select(func.count(Operator.id)).where(
                        Operator.client_id == client_id,
                        Operator.is_online.is_(True),
                    )
                )
                or 0
            )
            if online_count > seat_limit:
                operator_row = db.get(Operator, operator_id)
                if operator_row is not None:
                    operator_row.is_online = False
                    db.commit()
                await ws.close(
                    code=4003,
                    reason=f"seat_limit:{seat_limit} operators online; upgrade or buy a seat to add more",
                )
                return

    await manager.connect_operator(
        operator_id,
        ws,
        department_id=department_id,
        operator_name=operator_name,
        is_online=is_online,
        client_id=client_id,
        subprotocol=accepted_subprotocol,
        preferred_locale=operator_locale,
    )

    heartbeat_task = asyncio.create_task(_operator_presence_heartbeat(ws, operator_id, client_id))
    rate_limiter = _RateLimiter(_OPERATOR_MSG_LIMIT)

    try:
        # Queue snapshot is already sent by connect_operator() via _notify_operator_queue.
        # No additional send needed here, the manager is the single source of truth.
        while True:
            raw = await ws.receive_json()
            frame, reject_reason = parse_frame(raw, OPERATOR_FRAMES)
            if frame is None:
                await ws.send_json({"type": "error", "message": reject_reason})
                continue
            msg_type = frame.type

            if msg_type == "ping":
                await ws.send_json({"type": "pong"})

            elif msg_type == "heartbeat":
                # Operator presence refresh. Extends Redis TTL so the state
                # resolver keeps this operator in the "online" candidate set.
                # The widget heartbeat ("ping") is separate; this one is for
                # cross-process presence and only operators send it.
                from app.services import operator_presence_service as presence

                presence.mark_online(operator_id, client_id)

            elif msg_type == "set_availability":
                # Manual DND toggle. accepting=False means "stay online but
                # stop receiving new chat assignments". Active chats keep
                # running. accepting=True puts the operator back in the pool.
                accepting = frame.accepting
                with get_session() as session:
                    from app.services import operator_presence_service as presence

                    presence.set_accepting_chats(operator_id, accepting, session)
                # Invalidate state caches so the resolver picks up the new
                # availability immediately (visitors don't see stale "wait" UI).
                manager._invalidate_workspace_state_caches(client_id)
                await ws.send_json({"type": "availability_updated", "accepting": accepting})

            elif msg_type == "message":
                if not rate_limiter.allow():
                    await ws.send_json({"type": "error", "message": "Rate limit exceeded."})
                    continue
                target_session = frame.session_id
                content = frame.content.strip()
                if not target_session or not content:
                    continue

                # Validate session ownership. Operator can only message sessions
                # belonging to their client's bots and in "live" status
                translation_bot = None
                target_language: str | None = None
                op_db_id: int | None = None
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
                            f"belonging to a different client. Rejected"
                        )
                        continue

                    # The operator writes in THEIR language; the visitor reads
                    # in the session's. Both come from server state.
                    target_language = chat_session.language_code
                    persisted_op = add_chat_message(
                        session,
                        target_session,
                        role="operator",
                        content=content,
                        bot_id=None,
                        source_language=operator_locale,
                    )
                    session.commit()
                    op_db_id = persisted_op.id

                    if is_translation_enabled(bot) and operator_locale and target_language:
                        translation_bot = bot
                        session.expunge(bot)

                # The original is committed above, so translation can only ever
                # change WHICH string the visitor is shown, never whether a
                # message exists. Awaiting is safe here (no delivery tick is
                # pending) and necessary: the translated text must be persisted
                # before delivery so a reconnect re-renders the same string.
                delivered_content, translated_from = content, None
                if translation_bot is not None:
                    delivered_content, translated_from = await translate_outgoing(
                        target_session,
                        op_db_id,
                        content,
                        translation_bot,
                        operator_locale,
                        target_language,
                    )

                await manager.route_operator_message(
                    target_session,
                    content,
                    operator_name,
                    delivered_content=delivered_content,
                    translated_from=translated_from,
                    message_id=op_db_id,
                )

            elif msg_type == "file":
                # File sharing. Operator sends a file URL. Rate-limited on the
                # same per-connection budget as messages (audit F32).
                if not rate_limiter.allow():
                    await ws.send_json({"type": "error", "message": "Rate limit exceeded. Please slow down."})
                    continue
                target_session = frame.session_id
                file_url = frame.file_url.strip()
                filename = frame.filename.replace("/", "").replace("\\", "")[:100]
                content_type_val = frame.content_type
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
                target_session = frame.session_id
                if target_session:
                    await manager.send_typing_to_visitor(target_session)

            elif msg_type == "read_receipt":
                # Operator confirms they've read messages up to this ID
                target_session = frame.session_id
                if target_session:
                    await manager.send_read_receipt_to_visitor(target_session, frame.last_read_id)

            elif msg_type == "close_chat":
                target_session = frame.session_id
                if target_session:
                    bot_name = None
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
                                    f"belonging to a different client. Rejected"
                                )
                                continue
                            # Capture bot_name before session closes (avoid DetachedInstanceError)
                            bot_name = bot.name
                    # CAS from "live" (F31): the row-locked state machine wins or
                    # loses atomically against a concurrent accept/transfer, and
                    # a terminal (closed) session is never resurrected to "bot".
                    if bot_name is not None and _operator_close_transition(target_session, operator_id):
                        with get_session() as session:
                            # Persist system message for operator-initiated closure
                            add_chat_message(
                                session,
                                target_session,
                                role="system",
                                content=f"Operator {operator_name} ended the live chat.",
                                bot_id=None,
                            )
                            session.commit()
                        await manager.close_chat(target_session, bot_name)

    except WebSocketDisconnect:
        heartbeat_task.cancel()
        await manager.disconnect_operator_and_broadcast(operator_id)
    except Exception as e:
        heartbeat_task.cancel()
        # Same reasoning as the visitor handler above: an operator closing
        # their console tab is routine, not an incident.
        detail = f"{type(e).__name__}: {e}" if str(e) else type(e).__name__
        if is_client_gone(e):
            logger.debug(f"Operator WS closed by client for operator {operator_id} ({detail})")
        else:
            logger.error(f"Operator WS error for operator {operator_id}: {detail}")
        await manager.disconnect_operator_and_broadcast(operator_id)


# ── Backward compat: keep /ws/agent as alias during transition ──
@router.websocket("/ws/agent")
async def legacy_agent_websocket(
    ws: WebSocket,
    api_key: str | None = None,
    agent_key: str | None = None,
    operator_key: str | None = None,
):
    """Legacy WebSocket endpoint. Delegates to operator_websocket."""
    await operator_websocket(ws, api_key=api_key, operator_key=operator_key, agent_key=agent_key)
