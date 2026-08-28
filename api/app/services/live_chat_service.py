"""Live chat connection manager. Handles WebSocket routing between visitors and operators."""

import asyncio
import contextlib
import logging
from datetime import UTC, datetime

from fastapi import WebSocket
from sqlalchemy import select
from starlette.websockets import WebSocketDisconnect

from app.db.models import Bot, ChatSession, Operator
from app.db.repository import get_lead_info_by_session
from app.db.session import get_session
from app.services import operator_presence_service as presence
from app.services.session_state_machine import InvalidTransitionError, transition_session

logger = logging.getLogger(__name__)


# Starlette raises a bare ``RuntimeError`` (not a typed exception) when you
# touch a socket the client has already closed. Matching on its message is
# unpleasant but it is the only signal available, so keep the list EXACT,
# a broad substring here would silently demote real bugs to DEBUG.
_CLIENT_GONE_RUNTIME_MESSAGES = (
    'websocket is not connected. need to call "accept" first.',
    'cannot call "send" once a close message has been sent.',
)


def is_client_gone(exc: BaseException) -> bool:
    """True when ``exc`` means "the visitor's socket is already closed".

    A browser tab closing is the single most common thing that happens to a
    chat widget. It is not an error, and logging it as one buries genuine
    failures and inflates Sentry volume. Callers use this to pick a log level;
    NOTHING here swallows the exception.

    Deliberately narrow: only the disconnect exception itself, the two
    Starlette runtime messages for an already-closed socket, and the OS-level
    peer-hangup errors. Anything else (including other ``RuntimeError``s) is
    treated as a real problem and still logs loudly.
    """
    if isinstance(exc, WebSocketDisconnect | ConnectionResetError | BrokenPipeError):
        return True
    if isinstance(exc, RuntimeError):
        return str(exc).strip().lower() in _CLIENT_GONE_RUNTIME_MESSAGES
    return False


class _ConnectRequestStore:
    """Shared storage for pending operator-to-visitor connect requests.

    A connect request is coordination state, not a socket: an operator asks to
    join a visitor's chat, the widget polls REST until the visitor accepts or
    declines, and the record expires after ``CONNECT_REQUEST_TTL_SECONDS``.

    It lived in a per-process dict, which quietly breaks above one worker: the
    operator's request is registered on whichever process served that call, and
    the visitor's poll (a separate HTTP request that can land anywhere) asks a
    different process, sees nothing, and the popup never appears. Nothing errors;
    the request simply evaporates.

    Redis is the natural home. The record is small, has a natural TTL that Redis
    enforces without the lazy pruning the dict needed, and the widget's poll is
    already a round-trip. Writes go to both stores and reads prefer the shared
    one, so behaviour is unchanged when Redis is absent and no deployment has to
    flip anything to stay correct.

    Deliberately NOT gated on ``WS_BACKPLANE_ENABLED``: unlike socket delivery
    this needs no subscriber, degrades to exactly today's behaviour when Redis is
    down, and a single-worker deployment cannot tell the difference.
    """

    _PREFIX = "ws:connect_request:"

    def _key(self, session_id: str) -> str:
        return f"{self._PREFIX}{session_id}"

    def put(self, session_id: str, payload: dict, ttl: int) -> None:
        try:
            from app.core.cache import cache_set

            cache_set(self._key(session_id), payload, ttl)
        except Exception:
            # Best-effort: the caller has already written the in-process copy, so
            # a Redis problem degrades to single-process behaviour rather than
            # losing the request.
            logger.debug("connect-request shared write failed", exc_info=True)

    def get(self, session_id: str) -> dict | None:
        try:
            from app.core.cache import cache_get

            value = cache_get(self._key(session_id))
            return value if isinstance(value, dict) else None
        except Exception:
            logger.debug("connect-request shared read failed", exc_info=True)
            return None

    def drop(self, session_id: str) -> dict | None:
        """Remove and return the record, so callers keep pop() semantics."""
        try:
            from app.core.cache import cache_delete

            existing = self.get(session_id)
            cache_delete(self._key(session_id))
            return existing
        except Exception:
            logger.debug("connect-request shared delete failed", exc_info=True)
            return None


_connect_request_store = _ConnectRequestStore()


class ConnectionManager:
    """Manages WebSocket connections for live chat between visitors and operators."""

    # Default timeouts. Used when no bot-specific value is available.
    DEFAULT_VISITOR_DISCONNECT_TIMEOUT = 120  # seconds
    DEFAULT_OPERATOR_DISCONNECT_TIMEOUT = 60  # seconds

    # Terminal close code for an operator socket the server is revoking. The
    # console maps this to auth-failed and deliberately does NOT reconnect,
    # which is right for a deactivated operator: their key no longer
    # authenticates, so a reconnect loop would only hammer the WS endpoint.
    DEACTIVATED_CLOSE_CODE = 4003

    def __init__(self):
        # session_id → WebSocket
        self.visitor_connections: dict[str, WebSocket] = {}
        # operator_id → WebSocket
        self.operator_connections: dict[int, WebSocket] = {}
        # session_ids waiting for an operator
        self.waiting_queue: list[str] = []
        # session_id → operator_id assignment
        self.assignments: dict[str, int] = {}
        # session_id → timeout task
        self._timeout_tasks: dict[str, asyncio.Task] = {}
        # session_id → disconnect cleanup task (visitor left mid-chat)
        self._disconnect_tasks: dict[str, asyncio.Task] = {}
        # operator_id → grace-period task (operator WS dropped, waiting for reconnect)
        self._operator_disconnect_tasks: dict[int, asyncio.Task] = {}
        # session_id → owning client_id (tenant). Every session-scoped operator
        # notification (new-chat, queue, roster) is partitioned by this so one
        # workspace's visitor PII / roster never leaks to another (audit F03).
        self._session_client_ids: dict[str, int] = {}
        # session_id → department_id (for department-aware routing)
        self._session_departments: dict[str, int | None] = {}
        # operator_id → department_id (cached on connect)
        self._operator_departments: dict[int, int | None] = {}
        # operator_id → operator name (cached on connect for roster broadcasts)
        self._operator_names: dict[int, str] = {}
        # operator_id → preferred_locale (cached on connect, DISPLAY ONLY).
        # Never gates a translation decision: this dict is per-process, and
        # with WS_BACKPLANE_ENABLED the worker holding a visitor socket
        # routinely does not hold the operator's, so a translation that keyed
        # off it would silently not happen for cross-process pairs.
        # ``translation_service.resolve_incoming_target`` reads the DB instead.
        self._operator_locales: dict[int, str | None] = {}
        # operator_id → avatar URL (cached on connect so visitor-facing payloads
        # can show the operator's photo instead of falling back to initials).
        self._operator_avatars: dict[int, str | None] = {}
        # operator_id → client_id (cached on connect so disconnect cleanup
        # can address the right Redis presence bucket without a DB lookup
        # . Important because the cleanup runs after the operator row may
        # have been mutated).
        self._operator_client_ids: dict[int, int] = {}
        # session_id → { name, reason } (visitor metadata for queue display)
        self._session_metadata: dict[str, dict] = {}
        # operator_id → queued messages while WS is in grace period
        self._operator_message_queue: dict[int, list[dict]] = {}
        # Periodic cleanup task handle
        self._cleanup_task: asyncio.Task | None = None
        # Startup recovery flag
        self._recovered = False
        # Per-session locks for accept_chat to prevent TOCTOU races
        self._accept_locks: dict[str, asyncio.Lock] = {}
        # session_id → monotonic timestamp of the last bot-mode heartbeat from
        # the visitor's widget. Populated by the widget's connect-request poll
        # (fires every 5s while chatting with the AI). Used to drive the
        # "Chatting with AI" operator console. Sessions whose heartbeat
        # stops within a small window are treated as no longer present.
        self._bot_session_last_seen: dict[str, float] = {}
        # session_id → pending connect-request initiated by an operator
        # {
        #   "operator_id": int,
        #   "operator_name": str,
        #   "request_id": str,         # short uuid, embedded in widget poll
        #   "expires_at": float,        # monotonic deadline
        #   "created_at": iso str,
        # }
        # Visitor in bot mode polls /chat/connect-request/{session_id} and sees
        # this; on yes/no the entry is consumed.
        self._connect_requests: dict[str, dict] = {}

    def _ensure_background_tasks(self):
        """Start periodic background tasks (idempotent. Safe to call on every connection)."""
        if self._cleanup_task is None or self._cleanup_task.done():
            self._cleanup_task = asyncio.create_task(self._periodic_cleanup_loop())

        if not self._recovered:
            self._recovered = True
            self._recover_orphaned_sessions()

    def _recover_orphaned_sessions(self):
        """On startup, restore waiting queue from DB and clean orphaned live sessions."""
        try:
            with get_session() as db:
                # 1. Restore waiting sessions to in-memory queue
                stale_waiting = db.execute(select(ChatSession).where(ChatSession.status == "waiting")).scalars().all()
                for cs in stale_waiting:
                    # Always record the owning tenant, even if the session is
                    # already queued, the F03 queue/notify guard fails OPEN when
                    # _session_client_ids is missing, so a restored session
                    # without it leaks across tenants (code-review RV1).
                    if cs.client_id is not None:
                        self._session_client_ids[cs.id] = cs.client_id
                    if cs.id not in self.waiting_queue:
                        self.waiting_queue.append(cs.id)
                        logger.info(f"Restored waiting session from DB: {cs.id}")

                # 2. "Live" sessions assigned to offline operators → revert to bot
                live_sessions = (
                    db.execute(
                        select(ChatSession).where(
                            ChatSession.status == "live",
                            ChatSession.assigned_operator_id.isnot(None),
                        )
                    )
                    .scalars()
                    .all()
                )
                for cs in live_sessions:
                    if cs.assigned_operator_id not in self.operator_connections:
                        # Operator not connected. Check DB online status
                        op = db.execute(
                            select(Operator).where(Operator.id == cs.assigned_operator_id)
                        ).scalar_one_or_none()
                        if not op or not op.is_online:
                            cs.status = "bot"
                            cs.assigned_operator_id = None

                db.commit()
                logger.info("Startup recovery: cleaned orphaned sessions")
        except Exception as e:
            logger.warning(f"Startup recovery failed (non-fatal): {e}")

    async def _periodic_cleanup_loop(self):
        """Every 5 minutes, remove in-memory entries for sessions that are closed/bot in DB
        and fix stale is_online flags.
        """
        while True:
            try:
                await asyncio.sleep(300)
                self._cleanup_stale_entries()
                self._fix_stale_online_flags()
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.warning(f"Periodic cleanup error: {e}")

    def _cleanup_stale_entries(self):
        """Diff in-memory assignments against DB and remove stale entries."""
        session_ids = list(self.assignments.keys())
        if not session_ids:
            return
        try:
            with get_session() as db:
                live_sessions = db.execute(
                    select(ChatSession.id, ChatSession.status, ChatSession.assigned_operator_id).where(
                        ChatSession.id.in_(session_ids)
                    )
                ).all()
                active_ids = {row.id for row in live_sessions if row.status in ("live", "waiting")}

                # Correct a moved chat as well as dropping a dead one. The map
                # is now populated from the database on a cache miss, and a
                # transfer performed in another process updates only that
                # process's copy, so without this a session would keep
                # resolving to the operator who first accepted it.
                for row in live_sessions:
                    if row.id not in active_ids or not row.assigned_operator_id:
                        continue
                    if self.assignments.get(row.id) not in (None, row.assigned_operator_id):
                        logger.info(
                            f"Re-syncing assignment for {row.id}: "
                            f"{self.assignments.get(row.id)} -> {row.assigned_operator_id}"
                        )
                        self.assignments[row.id] = row.assigned_operator_id

                stale_ids = set(session_ids) - active_ids
                for sid in stale_ids:
                    self.assignments.pop(sid, None)
                    self._accept_locks.pop(sid, None)
                    self._session_client_ids.pop(sid, None)
                    self._session_departments.pop(sid, None)
                    self._session_metadata.pop(sid, None)
                    self._disconnect_tasks.pop(sid, None)
                if stale_ids:
                    logger.info(f"Cleaned {len(stale_ids)} stale in-memory session entries")
        except Exception as e:
            logger.warning(f"Stale entry cleanup failed: {e}")

    def _fix_stale_online_flags(self):
        """Mark operators as offline in DB if they have is_online=True but are not
        connected and not in a grace period. Handles server crash scenarios where
        the grace period timeout never fired.
        """
        try:
            with get_session() as db:
                online_operators = db.execute(select(Operator).where(Operator.is_online.is_(True))).scalars().all()
                fixed = 0
                for op in online_operators:
                    if op.id not in self.operator_connections and op.id not in self._operator_disconnect_tasks:
                        op.is_online = False
                        fixed += 1
                if fixed:
                    db.commit()
                    logger.info(f"Fixed {fixed} stale is_online flags")
        except Exception as e:
            logger.warning(f"Stale online flag cleanup failed: {e}")

    # ── Visitor connections ──

    async def connect_visitor(self, session_id: str, ws: WebSocket, subprotocol: str | None = None):
        await ws.accept(subprotocol=subprotocol)
        self._ensure_background_tasks()
        self.visitor_connections[session_id] = ws
        logger.info(f"Visitor connected: {session_id}")
        # Sync state to visitor: handles both the REST→WS race condition (visitor WS
        # opens after handoff REST call but before manager.request_handoff fires) and
        # server-restart scenarios where in-memory state was cleared.
        await self._restore_visitor_state(session_id)

    def disconnect_visitor(self, session_id: str):
        was_waiting = session_id in self.waiting_queue
        was_in_live_chat = session_id in self.assignments
        had_connection = self.visitor_connections.pop(session_id, None) is not None

        # Idempotency guard. One disconnect legitimately reaches this method
        # twice: ``_send_to_visitor`` cleans up when a send fails, and then the
        # same underlying exception bubbles to the WS route's handler, which
        # cleans up again. With nothing left to release, the second pass used
        # to re-emit "Visitor disconnected". Making a single tab-close look
        # like two events in the logs and in any metric derived from them.
        if not (had_connection or was_waiting or was_in_live_chat):
            return

        self._cancel_timeout(session_id)

        if was_waiting:
            with contextlib.suppress(ValueError):
                self.waiting_queue.remove(session_id)
            self._session_client_ids.pop(session_id, None)
            self._session_departments.pop(session_id, None)
            self._session_metadata.pop(session_id, None)
            self._mark_session_waiting_exit(session_id)
        elif was_in_live_chat:
            # Visitor left mid-chat. Notify operator but keep the assignment alive
            # so the visitor can reconnect.  Start a cleanup timer.
            operator_id = self.assignments.get(session_id)
            if operator_id is not None:
                asyncio.ensure_future(self._handle_visitor_disconnect(session_id, operator_id))
        else:
            self._session_client_ids.pop(session_id, None)
            self._session_departments.pop(session_id, None)
            self._session_metadata.pop(session_id, None)

        logger.info(f"Visitor disconnected: {session_id} (was_waiting={was_waiting}, was_live={was_in_live_chat})")

    async def _handle_visitor_disconnect(self, session_id: str, operator_id: int):
        """Notify operator that visitor disconnected and start auto-close timer."""
        await self._send_to_operator(
            operator_id,
            {
                "type": "visitor_disconnected",
                "session_id": session_id,
            },
        )
        # Look up bot-specific timeout, fall back to default
        timeout = self.DEFAULT_VISITOR_DISCONNECT_TIMEOUT
        try:
            with get_session() as db:
                from app.db.models import Bot

                cs = db.get(ChatSession, session_id)
                if cs and cs.bot_id:
                    bot = db.get(Bot, cs.bot_id)
                    if bot and bot.visitor_disconnect_timeout:
                        timeout = bot.visitor_disconnect_timeout
        except Exception:
            pass  # Use default on any error

        # Start auto-close timer. If visitor doesn't reconnect within the window,
        # close the chat automatically.
        self._cancel_disconnect_task(session_id)
        task = asyncio.create_task(self._visitor_disconnect_timeout(session_id, timeout))
        self._disconnect_tasks[session_id] = task

    async def _visitor_disconnect_timeout(self, session_id: str, timeout: int | None = None):
        """Auto-close a chat if the visitor doesn't reconnect within the timeout."""
        try:
            await asyncio.sleep(
                timeout if timeout is not None and timeout > 0 else self.DEFAULT_VISITOR_DISCONNECT_TIMEOUT
            )
            if session_id in self.assignments and session_id not in self.visitor_connections:
                logger.info(f"Visitor {session_id} did not reconnect. Auto-closing chat")
                # Persist to DB
                self._mark_session_closed(session_id)
                # Clean up in-memory state and notify operator
                operator_id = self.assignments.pop(session_id, None)
                self._session_client_ids.pop(session_id, None)
                self._session_departments.pop(session_id, None)
                self._session_metadata.pop(session_id, None)
                if operator_id:
                    await self._send_to_operator(
                        operator_id,
                        {"type": "chat_closed", "session_id": session_id},
                    )
                await self.broadcast_operators_update()
        except asyncio.CancelledError:
            pass
        finally:
            self._disconnect_tasks.pop(session_id, None)

    def _cancel_disconnect_task(self, session_id: str):
        task = self._disconnect_tasks.pop(session_id, None)
        if task and not task.done():
            task.cancel()

    def _mark_session_closed(self, session_id: str):
        """Persist session closure to DB via the state machine."""
        try:
            transition_session(
                session_id,
                "bot",
                audit_action="visitor_disconnected",
            )
        except (InvalidTransitionError, ValueError) as e:
            logger.warning(f"State machine rejected session closure for {session_id}: {e}")
        except Exception as e:
            logger.warning(f"Failed to persist session closure for {session_id}: {e}")

    # ── Operator connections ──

    async def connect_operator(
        self,
        operator_id: int,
        ws: WebSocket,
        department_id: int | None = None,
        operator_name: str = "",
        is_online: bool = True,
        client_id: int | None = None,
        subprotocol: str | None = None,
        preferred_locale: str | None = None,
        operator_avatar: str | None = None,
    ):
        self._ensure_background_tasks()
        # Cancel any pending grace-period timeout. Operator is back before it expired.
        # This is the key reconnection-recovery path: tab switch, network blip, etc.
        self._cancel_operator_disconnect_task(operator_id)

        # If operator already connected (multi-tab), close old connection with a
        # custom close code so the old tab can show a helpful message instead of
        # starting a reconnect loop.
        old_ws = self.operator_connections.get(operator_id)
        if old_ws and old_ws is not ws:
            with contextlib.suppress(Exception):
                await old_ws.close(code=4001, reason="Session opened in another tab")

        await ws.accept(subprotocol=subprotocol)
        # First-online detection: capture whether this workspace had ZERO online
        # operators BEFORE this connect. Used to broadcast the "operator_joined"
        # toast to visitors stuck in the offline-form UI. We only fire on the
        # zero-to-one transition, not on every reconnect (otherwise visitors
        # get spammed with toasts when an operator hits refresh).
        was_workspace_empty = False
        if client_id is not None:
            was_workspace_empty = not presence.get_online_operator_ids(client_id)
        self.operator_connections[operator_id] = ws
        self._operator_departments[operator_id] = department_id
        self._operator_names[operator_id] = operator_name
        self._operator_locales[operator_id] = preferred_locale
        self._operator_avatars[operator_id] = operator_avatar
        if client_id is not None:
            self._operator_client_ids[operator_id] = client_id
            # Mark in Redis presence, the state resolver and routing service
            # read from this set. Without this the live chat availability
            # service would say "all_offline" even with operators connected.
            presence.mark_online(operator_id, client_id)
            # Bust state cache for this workspace's bots so the next visitor
            # request_handoff sees the fresh "available" state immediately.
            self._invalidate_workspace_state_caches(client_id)
        logger.info(f"Operator connected: {operator_id} ({operator_name}, dept={department_id})")

        # Send init state to this operator
        await self._send_to_operator(
            operator_id,
            {
                "type": "init",
                "operator_id": operator_id,
                "operator_name": operator_name,
                "operator_avatar": operator_avatar,
                "is_online": is_online,
            },
        )

        # Send current queue
        await self._notify_operator_queue(operator_id)

        # Send active chats so operator can restore state after page refresh
        await self._send_active_chats(operator_id)

        # Flush any messages that arrived while operator was in grace period
        queued = self._operator_message_queue.pop(operator_id, [])
        for msg in queued:
            await self._send_to_operator(operator_id, msg)
        if queued:
            logger.info(f"Flushed {len(queued)} queued messages to operator {operator_id}")

        # Broadcast updated roster to all operators
        await self.broadcast_operators_update()

        # Visitor-facing "operator_joined" broadcast. Only when this operator
        # was the FIRST to come online for the workspace (i.e. the workspace
        # transitioned from "all offline" to "1 online"). Skipped on operator
        # reconnects to avoid spamming visitors with toasts.
        if client_id is not None and was_workspace_empty:
            await self._notify_visitors_operator_available(client_id, operator_name, operator_avatar)

    async def _notify_visitors_operator_available(
        self, client_id: int, operator_name: str, operator_avatar: str | None = None
    ) -> None:
        """Broadcast ``operator_joined`` to every visitor currently connected
        whose session belongs to a bot in this workspace.

        The widget filters on its end. Only renders the toast when the
        visitor is in the offline-form state. Backend sends broadly because
        the workspace lookup per visitor would add a DB query for every
        connected widget; the noise cost (visitors elsewhere ignoring the
        event) is trivial vs the simplicity gained.
        """
        if not self.visitor_connections:
            return
        try:
            from app.db.models import Bot, ChatSession

            with get_session() as db:
                # One query: which session_ids belong to this client's bots?
                # Filter the in-memory visitor set against that. Small (a
                # handful of visitors) so the post-filter is fast.
                session_ids = list(self.visitor_connections.keys())
                if not session_ids:
                    return
                matching = (
                    db.execute(
                        select(ChatSession.id)
                        .join(Bot, ChatSession.bot_id == Bot.id)
                        .where(
                            ChatSession.id.in_(session_ids),
                            Bot.client_id == client_id,
                        )
                    )
                    .scalars()
                    .all()
                )
            for sid in matching:
                await self._send_to_visitor(
                    sid,
                    {
                        "type": "operator_joined",
                        "operator_name": operator_name,
                        "operator_avatar": operator_avatar,
                    },
                )
            if matching:
                logger.info(
                    "Broadcast operator_joined to %d visitor(s) for client=%s",
                    len(matching),
                    client_id,
                )
        except Exception:
            # Non-fatal, the visitor's polling fallback will eventually pick
            # up the state change via the resolver's 5s cache TTL.
            logger.debug("operator_joined broadcast failed", exc_info=True)

    def disconnect_operator(self, operator_id: int):
        """Remove the WebSocket reference but preserve in-memory state.

        Department, name, and session assignments are kept alive for the duration
        of the grace period so the operator can reconnect seamlessly. Full cleanup
        only happens in _operator_disconnect_timeout if they don't return in time.
        """
        self.operator_connections.pop(operator_id, None)
        logger.info(f"Operator WebSocket dropped: {operator_id} (grace period started)")

    async def disconnect_operator_and_broadcast(self, operator_id: int):
        """Start the operator disconnect grace period.

        Does NOT immediately mark the operator offline or broadcast an offline
        roster. Instead it starts a OPERATOR_DISCONNECT_TIMEOUT countdown.
        If the operator reconnects (cancel task) nothing changes for anyone.
        If they don't, _operator_disconnect_timeout does the full cleanup.
        """
        self.disconnect_operator(operator_id)
        self._cancel_operator_disconnect_task(operator_id)
        task = asyncio.create_task(self._operator_disconnect_timeout(operator_id))
        self._operator_disconnect_tasks[operator_id] = task

    def _cancel_operator_disconnect_task(self, operator_id: int):
        task = self._operator_disconnect_tasks.pop(operator_id, None)
        if task and not task.done():
            task.cancel()

    def _invalidate_workspace_state_caches(self, client_id: int) -> None:
        """Bust the 5s LiveChatAvailability cache for every bot in this workspace.

        Called whenever operator presence changes (online → offline or vice
        versa). Without this, a freshly-online operator can take up to 5
        seconds before visitors see the state shift from ALL_OFFLINE to
        AVAILABLE. Disastrous for UX. Cheap operation (one Redis DELETE
        per bot), and bots-per-workspace is bounded by plan limits.
        """
        try:
            from app.db.models import Bot
            from app.services.live_chat_availability_service import invalidate as invalidate_state

            with get_session() as db:
                bot_ids = (
                    db.execute(
                        select(Bot.id).where(
                            Bot.client_id == client_id,
                            Bot.is_active.is_(True),
                        )
                    )
                    .scalars()
                    .all()
                )
                for bot_id in bot_ids:
                    invalidate_state(bot_id)
        except Exception:
            logger.debug("Workspace state cache invalidation failed", exc_info=True)

    async def _operator_disconnect_timeout(self, operator_id: int):
        """Full cleanup when an operator doesn't reconnect within the grace period."""
        try:
            await asyncio.sleep(self.DEFAULT_OPERATOR_DISCONNECT_TIMEOUT)
            # Still not reconnected. Do the full cleanup now.
            if operator_id not in self.operator_connections:
                logger.info(
                    f"Operator {operator_id} did not reconnect within "
                    f"{self.DEFAULT_OPERATOR_DISCONNECT_TIMEOUT}s. Marking offline"
                )
                # Pull cached client_id BEFORE we forget it so we can ask the
                # presence service to drop this operator from the workspace
                # online set + invalidate dependent state caches.
                client_id_for_presence = self._operator_client_ids.pop(operator_id, None)
                if client_id_for_presence is not None:
                    presence.mark_offline(operator_id, client_id_for_presence)
                    self._invalidate_workspace_state_caches(client_id_for_presence)

                self._operator_departments.pop(operator_id, None)
                self._operator_names.pop(operator_id, None)
                self._operator_locales.pop(operator_id, None)
                self._operator_avatars.pop(operator_id, None)
                self._operator_message_queue.pop(operator_id, None)  # Discard stale queue

                # Persist offline status and reassign this operator's live sessions
                orphaned_sessions: list[str] = []
                try:
                    with get_session() as db:
                        op_obj = db.execute(select(Operator).where(Operator.id == operator_id)).scalar_one_or_none()
                        if op_obj:
                            op_obj.is_online = False

                        # Find all live sessions assigned to this operator and re-queue them
                        live_sessions = (
                            db.execute(
                                select(ChatSession).where(
                                    ChatSession.assigned_operator_id == operator_id,
                                    ChatSession.status == "live",
                                )
                            )
                            .scalars()
                            .all()
                        )
                        for cs in live_sessions:
                            cs.status = "waiting"
                            cs.assigned_operator_id = None
                            if cs.client_id is not None:
                                self._session_client_ids[cs.id] = cs.client_id
                            orphaned_sessions.append(cs.id)

                        db.commit()
                except Exception as e:
                    logger.warning(f"Failed to persist offline status for operator {operator_id}: {e}")

                # Clean up in-memory assignments and re-queue
                for sid in orphaned_sessions:
                    self.assignments.pop(sid, None)
                    if sid not in self.waiting_queue:
                        self.waiting_queue.append(sid)
                    # Notify visitor they're back in queue
                    await self._send_to_visitor(
                        sid,
                        {
                            "type": "status",
                            "status": "waiting",
                            "message": "Your operator disconnected. Finding another one...",
                            "queue_position": (self.waiting_queue.index(sid) + 1 if sid in self.waiting_queue else 0),
                        },
                    )

                if orphaned_sessions:
                    logger.info(f"Re-queued {len(orphaned_sessions)} sessions from offline operator {operator_id}")
                    # Notify all connected operators about updated queue
                    for oid in list(self.operator_connections.keys()):
                        await self._notify_operator_queue(oid)

                # Broadcast updated roster to all remaining operators
                await self.broadcast_operators_update()
        except asyncio.CancelledError:
            pass
        finally:
            self._operator_disconnect_tasks.pop(operator_id, None)

    async def mark_operator_offline_now(
        self,
        operator_id: int,
        visitor_message: str = "Your operator went offline. Finding another one...",
    ) -> int:
        """Force an operator offline immediately (no grace period).

        Used when an operator explicitly toggles themselves offline while their
        WebSocket is still connected, the grace-period path in
        ``_operator_disconnect_timeout`` only fires on a WS drop, so without this
        the visitor stays glued to a "live" session with no one on the other end.

        Re-queues every ``status='live'`` session assigned to this operator,
        notifies each affected visitor over WS, updates presence + workspace
        caches, and broadcasts an operator roster refresh. Returns the number
        of sessions that were re-queued.
        """
        # Cancel any pending grace-period task so it doesn't double-fire.
        self._cancel_operator_disconnect_task(operator_id)

        # Update presence + caches. Use the cached client_id if available
        # (set when the operator's WS connected); otherwise fall back to the DB.
        client_id_for_presence = self._operator_client_ids.get(operator_id)
        if client_id_for_presence is None:
            try:
                with get_session() as db:
                    op_row = db.execute(
                        select(Operator.client_id).where(Operator.id == operator_id)
                    ).scalar_one_or_none()
                    if op_row is not None:
                        client_id_for_presence = op_row
            except Exception:
                logger.debug("Failed to look up client_id for operator %s", operator_id, exc_info=True)

        if client_id_for_presence is not None:
            try:
                presence.mark_offline(operator_id, client_id_for_presence)
            except Exception:
                logger.debug("presence.mark_offline failed for operator %s", operator_id, exc_info=True)
            self._invalidate_workspace_state_caches(client_id_for_presence)

        # Re-queue live sessions in the DB.
        orphaned_sessions: list[str] = []
        try:
            with get_session() as db:
                live_sessions = (
                    db.execute(
                        select(ChatSession).where(
                            ChatSession.assigned_operator_id == operator_id,
                            ChatSession.status == "live",
                        )
                    )
                    .scalars()
                    .all()
                )
                for cs in live_sessions:
                    cs.status = "waiting"
                    cs.assigned_operator_id = None
                    if cs.client_id is not None:
                        self._session_client_ids[cs.id] = cs.client_id
                    orphaned_sessions.append(cs.id)
                db.commit()
        except Exception as e:
            logger.warning(f"Failed to re-queue sessions for operator {operator_id}: {e}")

        # Update in-memory assignments + queue, notify each affected visitor.
        for sid in orphaned_sessions:
            self.assignments.pop(sid, None)
            if sid not in self.waiting_queue:
                self.waiting_queue.append(sid)
            await self._send_to_visitor(
                sid,
                {
                    "type": "status",
                    "status": "waiting",
                    "message": visitor_message,
                    "queue_position": (self.waiting_queue.index(sid) + 1 if sid in self.waiting_queue else 0),
                },
            )

        if orphaned_sessions:
            logger.info(f"Re-queued {len(orphaned_sessions)} session(s) after operator {operator_id} went offline")
            for oid in list(self.operator_connections.keys()):
                await self._notify_operator_queue(oid)

        # Drop in-memory roster state for this operator so the broadcast shows them offline.
        self._operator_departments.pop(operator_id, None)
        self._operator_names.pop(operator_id, None)
        self._operator_avatars.pop(operator_id, None)
        self._operator_client_ids.pop(operator_id, None)
        self._operator_message_queue.pop(operator_id, None)

        await self.broadcast_operators_update()
        return len(orphaned_sessions)

    async def handle_operator_deactivated(self, operator_id: int) -> int:
        """Tear down a deactivated operator's console session immediately.

        A soft deactivation is not a flaky network drop, so the grace period in
        ``_operator_disconnect_timeout`` is the wrong tool for it. Reconnection
        is impossible (``_resolve_operator_from_key`` refuses an inactive
        operator), so waiting the timeout out only strands every in-flight
        visitor for that long before doing exactly this work. Worse, the
        operator WS handlers never re-read ``is_active``: a socket left open
        after deactivation can still accept queued chats and send messages, so
        the connection has to be closed, not merely forgotten.

        Order matters. The socket is closed first, so the revoked console can do
        nothing further and the re-queue broadcast that follows reaches only the
        operators who are still entitled to the work. The DB re-queue then runs
        inside ``mark_operator_offline_now``, which finds the sessions by
        ``status == 'live'`` — callers must therefore leave those rows alone and
        let this method move them, not pre-clear them.

        Returns the number of sessions handed back to the queue.
        """
        ws = self.operator_connections.pop(operator_id, None)
        if ws is not None:
            with contextlib.suppress(Exception):
                await ws.close(code=self.DEACTIVATED_CLOSE_CODE, reason="Operator account deactivated")
        # ``mark_operator_offline_now`` cancels any grace-period task first, so a
        # disconnect handler that reacted to the close above is absorbed here.
        return await self.mark_operator_offline_now(
            operator_id,
            visitor_message="Your operator is no longer available. Finding another one...",
        )

    # ── Handoff flow ──

    # Maximum queue size to prevent unbounded growth
    MAX_QUEUE_SIZE = 50

    async def request_handoff(
        self,
        session_id: str,
        timeout_seconds: int = 120,
        department_id: int | None = None,
        visitor_name: str | None = None,
        reason: str | None = None,
        bot_id: int | None = None,
        bot_name: str | None = None,
        client_id: int | None = None,
    ):
        """Add visitor to the waiting queue and notify operators.

        ``bot_id`` / ``bot_name`` flow through to the operator's queue
        and active-chat payloads so the UI can label each conversation
        with which bot it belongs to. Without these the operator has no
        way to tell whether an incoming chat is from bot1 or bot2.
        """
        if session_id not in self.waiting_queue:
            # Reject if queue is full
            if len(self.waiting_queue) >= self.MAX_QUEUE_SIZE:
                logger.warning(f"Queue full ({self.MAX_QUEUE_SIZE}). Rejecting handoff for {session_id}")
                self._mark_session_waiting_exit(session_id)
                await self._send_to_visitor(session_id, {"type": "status", "status": "unavailable"})
                return
            self.waiting_queue.append(session_id)
        if client_id is not None:
            self._session_client_ids[session_id] = client_id
        self._session_departments[session_id] = department_id
        self._session_metadata[session_id] = {
            "name": visitor_name or "Anonymous",
            "reason": reason,
            "bot_id": bot_id,
            "bot_name": bot_name,
        }

        # Notify visitor they're in queue
        await self._send_to_visitor(
            session_id,
            {
                "type": "status",
                "status": "waiting",
                "queue_position": (self.waiting_queue.index(session_id) + 1 if session_id in self.waiting_queue else 0),
            },
        )

        # Notify relevant operators (tenant-scoped, then department-aware)
        for operator_id in list(self.operator_connections.keys()):
            if self._should_notify_operator(operator_id, department_id, session_client_id=client_id):
                await self._notify_operator_queue(operator_id)

        # Start timeout
        self._start_timeout(session_id, timeout_seconds)

    def _should_notify_operator(
        self, operator_id: int, department_id: int | None, session_client_id: int | None = None
    ) -> bool:
        """Check if an operator should be notified about a queue item.

        Tenant scoping is enforced first (audit F03): when the session's owning
        ``client_id`` is known, only operators of that same workspace are
        eligible. Fail closed if the operator's client is unknown. Department
        routing then applies within the workspace.
        """
        if session_client_id is not None and self._operator_client_ids.get(operator_id) != session_client_id:
            return False
        if department_id is None:
            return True
        operator_dept = self._operator_departments.get(operator_id)
        if operator_dept is None:
            return True
        return operator_dept == department_id

    async def accept_chat(
        self, session_id: str, operator_id: int, operator_name: str, operator_avatar: str | None = None
    ) -> bool:
        """Operator accepts a waiting chat. Returns False if already accepted by a *different* operator.

        Uses a per-session asyncio.Lock to prevent TOCTOU races between the
        existence check and the assignment.

        ``operator_avatar`` is the accepting operator's photo URL (resolved from
        the DB by the caller). It is forwarded to the visitor so the widget can
        show the real avatar in the "joined the chat" pill instead of initials.
        Callers that don't have it may omit it; the manager falls back to the
        avatar cached at ``connect_operator`` time, and the widget falls back to
        initials when neither is present.
        """
        if session_id not in self._accept_locks:
            self._accept_locks[session_id] = asyncio.Lock()

        async with self._accept_locks[session_id]:
            return await self._accept_chat_inner(session_id, operator_id, operator_name, operator_avatar)

    async def _accept_chat_inner(
        self, session_id: str, operator_id: int, operator_name: str, operator_avatar: str | None = None
    ) -> bool:
        existing_assignee = self.assignments.get(session_id)
        if existing_assignee is not None:
            if existing_assignee == operator_id:
                # Already assigned to this operator. Idempotent success
                return True
            logger.warning(
                f"Chat {session_id} already assigned to operator {existing_assignee}, ignoring accept from {operator_id}"
            )
            return False

        if session_id in self.waiting_queue:
            self.waiting_queue.remove(session_id)
        self.assignments[session_id] = operator_id
        self._cancel_timeout(session_id)

        # Notify visitor. Prefer the caller-supplied avatar (DB truth, correct
        # even across workers); fall back to the one cached when this operator
        # connected. ``None`` → widget shows initials.
        avatar = operator_avatar if operator_avatar is not None else self._operator_avatars.get(operator_id)
        await self._send_to_visitor(
            session_id,
            {
                "type": "status",
                "status": "connected",
                "operator_name": operator_name,
                "operator_avatar": avatar,
            },
        )

        # Notify accepting operator
        await self._send_to_operator(
            operator_id,
            {
                "type": "chat_accepted",
                "session_id": session_id,
                "visitor_name": self._session_metadata.get(session_id, {}).get("name", "Anonymous"),
                "reason": self._session_metadata.get(session_id, {}).get("reason"),
                "bot_id": self._session_metadata.get(session_id, {}).get("bot_id"),
                "bot_name": self._session_metadata.get(session_id, {}).get("bot_name"),
            },
        )

        # Notify all other operators: updated queue + roster
        for other_operator_id in list(self.operator_connections.keys()):
            if other_operator_id != operator_id:
                await self._notify_operator_queue(other_operator_id)

        await self.broadcast_operators_update()
        logger.info(f"Operator {operator_id} ({operator_name}) accepted chat {session_id}")
        return True

    async def close_chat(self, session_id: str, bot_name: str = "AI Assistant"):
        """Operator closes a live chat, returns to bot mode."""
        operator_id = self.assignments.pop(session_id, None)
        self._accept_locks.pop(session_id, None)
        self._cancel_timeout(session_id)
        self._cancel_disconnect_task(session_id)
        self._session_departments.pop(session_id, None)
        self._session_metadata.pop(session_id, None)

        await self._send_to_visitor(
            session_id,
            {
                "type": "status",
                "status": "closed",
                "bot_name": bot_name,
            },
        )

        if operator_id:
            await self._send_to_operator(
                operator_id,
                {
                    "type": "chat_closed",
                    "session_id": session_id,
                },
            )

        await self.broadcast_operators_update()
        logger.info(f"Chat {session_id} closed")

    async def transfer_chat(
        self, session_id: str, old_operator_id: int | None, new_operator_id: int, new_operator_name: str
    ):
        """Transfer a live chat from one operator to another."""
        self.assignments[session_id] = new_operator_id
        self._cancel_timeout(session_id)

        # Notify old operator
        if old_operator_id:
            await self._send_to_operator(
                old_operator_id,
                {
                    "type": "chat_transferred",
                    "session_id": session_id,
                    "transferred_to": new_operator_name,
                },
            )

        # Notify new operator over WS. If they're not reachable this way
        # (offline, or connected to a different gunicorn worker), the push
        # task below fills the gap.
        visitor_name = self._session_metadata.get(session_id, {}).get("name", "Anonymous")
        await self._send_to_operator(
            new_operator_id,
            {
                "type": "chat_accepted",
                "session_id": session_id,
                "visitor_name": visitor_name,
                "reason": self._session_metadata.get(session_id, {}).get("reason"),
            },
        )

        # Enqueue a Web Push fallback, the task consults Redis presence and
        # only fires if the target isn't currently on WS anywhere, so an
        # operator with an open tab gets exactly one alert.
        try:
            from app.worker.enqueue import enqueue_sync

            enqueue_sync(
                "task_dispatch_transfer_push",
                session_id,
                new_operator_id,
                new_operator_name,
                visitor_name,
            )
        except Exception:
            logger.exception(
                "Failed to enqueue transfer push for session=%s operator=%s",
                session_id,
                new_operator_id,
            )

        # Notify visitor
        await self._send_to_visitor(
            session_id,
            {
                "type": "status",
                "status": "connected",
                "operator_name": new_operator_name,
            },
        )

        # Update all operators: queue + roster
        for operator_id in list(self.operator_connections.keys()):
            await self._notify_operator_queue(operator_id)

        await self.broadcast_operators_update()
        logger.info(
            f"Chat {session_id} transferred from operator {old_operator_id} to {new_operator_id} ({new_operator_name})"
        )

    # ── Read receipts ──

    async def send_read_receipt_to_operator(self, session_id: str, last_read_id: int):
        """Notify operator that visitor has read messages up to last_read_id."""
        operator_id = self.assignments.get(session_id)
        if operator_id:
            await self._send_to_operator(
                operator_id,
                {"type": "read_receipt", "session_id": session_id, "last_read_id": last_read_id, "reader": "visitor"},
            )

    async def send_read_receipt_to_visitor(self, session_id: str, last_read_id: int):
        """Notify visitor that operator has read messages up to last_read_id."""
        await self._send_to_visitor(
            session_id,
            {"type": "read_receipt", "last_read_id": last_read_id, "reader": "operator"},
        )

    # ── Department update ──

    async def update_operator_department(self, operator_id: int, department_id: int | None):
        """Update an operator's department without requiring WS reconnect."""
        self._operator_departments[operator_id] = department_id
        if operator_id in self.operator_connections:
            await self._notify_operator_queue(operator_id)
            logger.info(f"Updated operator {operator_id} department to {department_id}")

    # ── Roster broadcast ──

    async def broadcast_operators_update(self):
        """Push current operator roster to all connected operators.

        Includes operators that are within their grace period (WS dropped but not
        yet timed out) so their active_chats count stays visible to the team.
        """
        # Build the roster tagged with each operator's owning client_id, then
        # fan out to each operator ONLY the entries for their own workspace,
        # an operator must never see another tenant's roster (audit F03).
        roster: list[dict] = []
        seen_ids: set[int] = set()

        # Currently connected operators. Fully online
        for oid in list(self.operator_connections.keys()):
            active_count = len([sid for sid, o_id in self.assignments.items() if o_id == oid])
            roster.append(
                {
                    "operator_id": oid,
                    "name": self._operator_names.get(oid, ""),
                    "active_chats": active_count,
                    "is_online": True,
                    "_client_id": self._operator_client_ids.get(oid),
                }
            )
            seen_ids.add(oid)

        # Operators in grace period. WS dropped but assignments still live
        for oid in list(self._operator_disconnect_tasks.keys()):
            if oid not in seen_ids:
                active_count = len([sid for sid, o_id in self.assignments.items() if o_id == oid])
                if active_count > 0:
                    roster.append(
                        {
                            "operator_id": oid,
                            "name": self._operator_names.get(oid, ""),
                            "active_chats": active_count,
                            "is_online": False,  # temporarily away
                            "_client_id": self._operator_client_ids.get(oid),
                        }
                    )

        for operator_id in list(self.operator_connections.keys()):
            recipient_client_id = self._operator_client_ids.get(operator_id)
            operators_payload = [
                {k: v for k, v in entry.items() if k != "_client_id"}
                for entry in roster
                if entry["_client_id"] == recipient_client_id
            ]
            await self._send_to_operator(
                operator_id,
                {"type": "operators_update", "operators": operators_payload},
            )

    # ── Bot-mode presence (real-time "currently chatting" signal) ────────────

    # How long after the last widget heartbeat we still consider the visitor
    # to be present. Polling cadence on the widget is 5s, so 20s = 4 missed
    # polls before we drop them. Tight enough to feel real-time, loose
    # enough to survive a single transient request failure.
    BOT_PRESENCE_TTL_SECONDS = 20

    def record_bot_session_activity(self, session_id: str) -> None:
        """Mark a bot-mode session as currently present.

        Called from the widget's connect-request poll. Any subsequent call
        within ``BOT_PRESENCE_TTL_SECONDS`` keeps the session marked as live;
        once the polling stops (tab closed, navigation away, browser killed)
        the entry naturally expires on the next read.
        """
        import time

        if not session_id:
            return
        self._bot_session_last_seen[session_id] = time.time()

    def is_bot_session_present(self, session_id: str) -> bool:
        """Return True iff the widget has heartbeated recently enough that we
        believe the visitor is still on the page chatting with the AI."""
        import time

        last_seen = self._bot_session_last_seen.get(session_id)
        if last_seen is None:
            return False
        if (time.time() - last_seen) > self.BOT_PRESENCE_TTL_SECONDS:
            # Lazy eviction. Keeps the dict from growing unbounded while
            # also giving the next read an authoritative "not present".
            self._bot_session_last_seen.pop(session_id, None)
            return False
        return True

    def get_present_bot_session_ids(self) -> set[str]:
        """Return all session_ids whose heartbeat is still inside the TTL.

        Cheaper than calling :py:meth:`is_bot_session_present` for every row
        when the qualified-bot endpoint is filtering a list of candidates.
        """
        import time

        now = time.time()
        present: set[str] = set()
        expired: list[str] = []
        for sid, last_seen in self._bot_session_last_seen.items():
            if (now - last_seen) <= self.BOT_PRESENCE_TTL_SECONDS:
                present.add(sid)
            else:
                expired.append(sid)
        for sid in expired:
            self._bot_session_last_seen.pop(sid, None)
        return present

    # ── Connect-request (operator-initiated consent flow) ────────────────────

    CONNECT_REQUEST_TTL_SECONDS = 90

    def create_connect_request(
        self,
        session_id: str,
        operator_id: int,
        operator_name: str,
    ) -> dict:
        """Register a pending connect-request from an operator to a visitor.

        Returns the public payload the widget will poll for. The visitor sees
        a popup with the operator name and accepts/declines via REST. Existing
        requests for the same session are overwritten. Only one operator may
        be courting a visitor at a time.
        """
        import time
        import uuid

        request_id = uuid.uuid4().hex[:12]
        now = time.time()
        payload = {
            "request_id": request_id,
            "operator_id": operator_id,
            "operator_name": operator_name or "An operator",
            "expires_at": now + self.CONNECT_REQUEST_TTL_SECONDS,
            "created_at": datetime.now(UTC).isoformat(),
        }
        self._connect_requests[session_id] = payload
        _connect_request_store.put(session_id, payload, self.CONNECT_REQUEST_TTL_SECONDS)
        return payload

    def get_connect_request(self, session_id: str) -> dict | None:
        """Return the active connect-request for ``session_id`` or ``None``.

        Expired requests are pruned lazily on read so the widget polls always
        see fresh state without us having to schedule a per-request timer. When
        the shared store is active, Redis's own TTL does that pruning for us and
        the lazy check below is belt-and-braces for the in-process fallback.
        """
        import time

        req = _connect_request_store.get(session_id)
        if req is None:
            req = self._connect_requests.get(session_id)
        if not req:
            return None
        if req["expires_at"] < time.time():
            self._connect_requests.pop(session_id, None)
            _connect_request_store.drop(session_id)
            return None
        return req

    def clear_connect_request(self, session_id: str) -> dict | None:
        """Remove the pending request (used on accept/decline/expire)."""
        shared = _connect_request_store.drop(session_id)
        local = self._connect_requests.pop(session_id, None)
        return shared or local

    async def notify_connect_request_resolved(
        self,
        operator_id: int,
        session_id: str,
        outcome: str,
        visitor_name: str | None = None,
    ):
        """Push the visitor's decision back to the initiating operator."""
        if operator_id not in self.operator_connections:
            return
        await self._send_to_operator(
            operator_id,
            {
                "type": "connect_request_resolved",
                "session_id": session_id,
                "outcome": outcome,  # accepted | declined | expired | cancelled
                "visitor_name": visitor_name,
            },
        )

    async def broadcast_qualified_bot_changed(
        self,
        client_id: int,
        session_id: str | None = None,
    ):
        """Notify every operator of the given client that the qualified-bot
        sessions list may have changed. Operators refetch ``/qualified-bot-sessions``
        on receipt. Keeps the payload tiny and the truth in one query."""
        msg = {
            "type": "qualified_bot_changed",
            "session_id": session_id,
        }
        for operator_id, owner_client_id in list(self._operator_client_ids.items()):
            if owner_client_id != client_id:
                continue
            if operator_id not in self.operator_connections:
                continue
            await self._send_to_operator(operator_id, msg)

    # ── Message routing ──

    def _assigned_operator(self, session_id: str, *, consult_db: bool = False) -> int | None:
        """The operator handling ``session_id``, from memory or from the database.

        ``self.assignments`` is per-process memory, written by whichever worker
        handled the accept. Once live chat moved onto its own service that
        worker is never the one holding the visitor's socket: nginx routes
        ``/ws/`` to oyechats-ws while every HTTP route, ``POST
        /operators/accept`` included, lands on oyechats-api. So the accept
        recorded the assignment in one process and the visitor's messages
        arrived in another, which found an empty map and dropped every one of
        them. Nothing logged it, because the caller only reports a failed route
        while the session is still ``waiting``.

        ``consult_db`` is opt-in and has to stay that way. A miss is the normal
        state for the overwhelming majority of sessions, which are bot-only and
        have no operator at all, so querying on every miss would put a database
        round trip behind every keystroke on the platform. Pass True only when
        the session is already known to be live, or when the frame is rare
        enough that one indexed primary-key read does not matter.
        """
        operator_id = self.assignments.get(session_id)
        if operator_id is not None or not consult_db:
            return operator_id

        try:
            with get_session() as db:
                row = db.execute(
                    select(ChatSession.assigned_operator_id, ChatSession.status).where(ChatSession.id == session_id)
                ).one_or_none()
        except Exception:
            # Delivery is best-effort. A database blip must not raise into a
            # WebSocket handler and take the socket down with it.
            logger.warning(f"Assignment lookup failed for session {session_id}", exc_info=True)
            return None

        if row is None or row.status != "live" or not row.assigned_operator_id:
            return None

        # Cache it. ``_cleanup_stale_entries`` re-syncs this map against the
        # database on its periodic tick, so a chat later transferred to someone
        # else does not keep resolving to the operator who first took it.
        self.assignments[session_id] = row.assigned_operator_id
        return row.assigned_operator_id

    async def route_visitor_message(
        self,
        session_id: str,
        content: str,
        db_id: int | None = None,
        source_language: str | None = None,
        session_status: str | None = None,
    ) -> bool:
        """Route a message from visitor to their assigned operator.

        If the operator is in the grace period (WS dropped, waiting for reconnect),
        the message is queued and will be flushed when the operator reconnects.
        Messages are always persisted to DB by the caller (ws_routes), so nothing
        is lost. This only affects real-time delivery.

        Returns ``True`` when the operator's socket received the payload live
        (i.e. WhatsApp "delivered" semantics); ``False`` when no operator is
        assigned or the operator is currently disconnected (queued for grace
        period). The caller uses this to drive the visitor-side ack tick state.
        """
        # ``session_status`` comes from the caller's own read of the row, so
        # the database is consulted only for a chat already known to be live.
        operator_id = self._assigned_operator(session_id, consult_db=session_status == "live")
        if not operator_id:
            return False

        msg = {
            "type": "message",
            "session_id": session_id,
            "role": "user",
            "content": content,
            "timestamp": datetime.now(UTC).isoformat(),
        }
        if source_language:
            # Lets the console label the bubble and decide whether to show a
            # translation toggle, without waiting for the separate
            # ``message_translation`` frame that follows out of band.
            msg["source_language"] = source_language
        if db_id is not None:
            # Keyed as "id" to match what the operator dashboard reads
            # (LiveChat.jsx: `dbId: data.id || null`). The operator uses
            # this id as `last_read_id` in the read_receipt it sends back,
            # which is what drives the visitor's green double-check.
            msg["id"] = db_id

        # Deliver wherever the socket lives. The previous
        # ``if operator_id in self.operator_connections`` guard here made the
        # Redis backplane unreachable: ``_send_to_operator`` already prefers a
        # local socket and falls back to publishing, so checking locality again
        # first meant a socket held by another process was treated as no socket
        # at all. ``deliver_to_operator`` is that same routing with the answer
        # returned, which this method needs for its delivered/queued contract.
        from app.services.ws_backplane import deliver_to_operator

        if await deliver_to_operator(self, operator_id, msg):
            return True
        if operator_id in self._operator_disconnect_tasks:
            # Operator is in grace period. Queue for delivery on reconnect
            queue = self._operator_message_queue.setdefault(operator_id, [])
            if len(queue) < 500:
                queue.append(msg)
            else:
                queue.pop(0)
                queue.append(msg)
                logger.warning(f"Message queue full for operator {operator_id}. Dropped oldest")
            logger.debug(f"Queued message for operator {operator_id} (in grace period)")
        return False

    async def route_operator_message(
        self,
        session_id: str,
        content: str,
        operator_name: str,
        operator_avatar: str | None = None,
        *,
        delivered_content: str | None = None,
        translated_from: str | None = None,
        message_id: int | None = None,
    ):
        """Route a message from operator to visitor.

        ``delivered_content`` is what the visitor SEES: the translation when
        one succeeded, otherwise ``content`` (the operator's own words). The
        caller has already persisted both, the original in
        ``ChatMessage.content`` and the translation in
        ``ChatMessage.translations``, so the widget's reconnect path renders
        the identical string from ``GET /chat/history``.

        ``translated_from`` is absent when nothing was translated, which is how
        the widget distinguishes "delivered in your language" from "delivered
        in the operator's language because translation was unavailable".

        ``message_id`` was previously never sent. The widget already reads it
        (``dbId: typeof data.message_id === 'number' ? ...``), so populating it
        also closes a pre-existing gap in the visitor's read-receipt chain.

        ``operator_avatar`` lets the visitor see the operator's photo instead
        of initials. The caller resolves it from the sending operator, so the
        fallback below is only reached if a future caller omits it.
        """
        avatar = operator_avatar
        if avatar is None:
            # NOT ``self.assignments.get``: that map is per-process, written by
            # whichever worker handled the accept, which is oyechats-api while
            # this code runs in oyechats-ws. Reading it directly here would
            # resolve to None for every cross-process pair and silently drop
            # back to initials. This path is rare (the caller passes the
            # avatar), so the opt-in database read is affordable.
            assignee = self._assigned_operator(session_id, consult_db=True)
            if assignee is not None:
                avatar = self._operator_avatars.get(assignee)
        payload = {
            "type": "message",
            "role": "operator",
            "content": delivered_content if delivered_content is not None else content,
            "operator_name": operator_name,
            "operator_avatar": avatar,
            "timestamp": datetime.now(UTC).isoformat(),
        }
        if translated_from:
            payload["translated_from"] = translated_from
        if message_id is not None:
            payload["message_id"] = message_id
        await self._send_to_visitor(session_id, payload)

    async def send_translation_to_operator(self, session_id: str, payload: dict) -> None:
        """Push a ``message_translation`` frame to the session's operator.

        Routed through ``_send_to_operator``, so the Redis backplane carries it
        to whichever worker holds the socket, exactly like every other operator
        frame. Best-effort by design: this frame is a convenience, the
        translation is already persisted and will be picked up from
        ``GET /chat/history`` if the socket missed it.
        """
        # One frame per translated visitor message, so the database fallback is
        # affordable here and load-bearing: this is the frame that carries a
        # Hindi visitor's words to an English-reading operator.
        operator_id = self._assigned_operator(session_id, consult_db=True)
        if not operator_id:
            return
        await self._send_to_operator(operator_id, payload)

    # ── File routing ──

    async def route_visitor_file(
        self,
        session_id: str,
        file_url: str,
        filename: str,
        content_type: str,
        db_id: int | None = None,
    ) -> bool:
        """Route a file message from visitor to their assigned operator.

        Returns ``True`` when the operator's socket received the payload live
        (delivered), ``False`` otherwise. Same semantics as
        :meth:`route_visitor_message`.
        """
        # A file upload is rare enough that one indexed read on a cache miss
        # costs nothing, and losing one is as bad as losing a message.
        operator_id = self._assigned_operator(session_id, consult_db=True)
        if not operator_id:
            return False

        msg = {
            "type": "file",
            "session_id": session_id,
            "role": "user",
            "file_url": file_url,
            "filename": filename,
            "content_type": content_type,
            "timestamp": datetime.now(UTC).isoformat(),
        }
        if db_id is not None:
            # Keyed as "id" to match what the operator dashboard reads
            # (LiveChat.jsx: `dbId: data.id || null`). The operator uses
            # this id as `last_read_id` in the read_receipt it sends back,
            # which is what drives the visitor's green double-check.
            msg["id"] = db_id

        # Deliver wherever the socket lives. The previous
        # ``if operator_id in self.operator_connections`` guard here made the
        # Redis backplane unreachable: ``_send_to_operator`` already prefers a
        # local socket and falls back to publishing, so checking locality again
        # first meant a socket held by another process was treated as no socket
        # at all. ``deliver_to_operator`` is that same routing with the answer
        # returned, which this method needs for its delivered/queued contract.
        from app.services.ws_backplane import deliver_to_operator

        if await deliver_to_operator(self, operator_id, msg):
            return True
        if operator_id in self._operator_disconnect_tasks:
            queue = self._operator_message_queue.setdefault(operator_id, [])
            if len(queue) < 500:
                queue.append(msg)
            else:
                queue.pop(0)
                queue.append(msg)
                logger.warning(f"Message queue full for operator {operator_id}. Dropped oldest")
        return False

    async def route_operator_file(
        self,
        session_id: str,
        file_url: str,
        filename: str,
        content_type: str,
        operator_name: str,
        operator_avatar: str | None = None,
    ):
        """Route a file message from operator to visitor."""
        avatar = operator_avatar
        if avatar is None:
            assignee = self.assignments.get(session_id)
            if assignee is not None:
                avatar = self._operator_avatars.get(assignee)
        await self._send_to_visitor(
            session_id,
            {
                "type": "file",
                "role": "operator",
                "file_url": file_url,
                "filename": filename,
                "content_type": content_type,
                "operator_name": operator_name,
                "operator_avatar": avatar,
                "timestamp": datetime.now(UTC).isoformat(),
            },
        )

    async def send_typing_to_visitor(self, session_id: str):
        """Notify visitor that operator is typing."""
        await self._send_to_visitor(session_id, {"type": "operator_typing"})

    async def send_typing_to_operator(self, session_id: str):
        """Notify operator that visitor is typing."""
        operator_id = self.assignments.get(session_id)
        if operator_id:
            await self._send_to_operator(
                operator_id,
                {
                    "type": "visitor_typing",
                    "session_id": session_id,
                },
            )

    async def send_stopped_typing_to_operator(self, session_id: str):
        """Notify operator that visitor stopped typing."""
        operator_id = self.assignments.get(session_id)
        if operator_id:
            await self._send_to_operator(
                operator_id,
                {
                    "type": "visitor_stopped_typing",
                    "session_id": session_id,
                },
            )

    # ── Timeout handling ──

    def _start_timeout(self, session_id: str, timeout_seconds: int):
        self._cancel_timeout(session_id)
        task = asyncio.create_task(self._timeout_handler(session_id, timeout_seconds))
        self._timeout_tasks[session_id] = task

    def _cancel_timeout(self, session_id: str):
        task = self._timeout_tasks.pop(session_id, None)
        if task and not task.done():
            task.cancel()

    async def _timeout_handler(self, session_id: str, timeout_seconds: int):
        """If no operator accepts within timeout, mark as unavailable."""
        try:
            await asyncio.sleep(timeout_seconds)
            if session_id in self.waiting_queue:
                self.waiting_queue.remove(session_id)
                self._mark_session_waiting_exit(session_id)
                self._session_client_ids.pop(session_id, None)
                self._session_departments.pop(session_id, None)
                self._session_metadata.pop(session_id, None)
                await self._send_to_visitor(
                    session_id,
                    {
                        "type": "status",
                        "status": "unavailable",
                    },
                )
                logger.info(f"Timeout: no operator accepted chat {session_id} within {timeout_seconds}s")
        except asyncio.CancelledError:
            pass

    # ── Internal helpers ──

    def _mark_session_waiting_exit(self, session_id: str):
        """Persist queue exit for waiting sessions to avoid stale DB-backed queues."""
        try:
            transition_session(
                session_id,
                "bot",
                expected_current="waiting",
                audit_action="timeout",
            )
        except (InvalidTransitionError, ValueError):
            pass  # Session already transitioned. Safe to ignore
        except Exception as e:
            logger.warning(f"Failed to persist waiting-exit state for {session_id}: {e}")

    async def _restore_visitor_state(self, session_id: str) -> None:
        """Push current state to a freshly connected visitor WebSocket.

        Always queries DB as source of truth, then syncs in-memory state to match.
        Handles REST→WS race conditions and server restart scenarios.
        """
        # Cancel any pending disconnect cleanup. Visitor is back
        if session_id in self._disconnect_tasks:
            self._cancel_disconnect_task(session_id)
            operator_id = self.assignments.get(session_id)
            if operator_id:
                await self._send_to_operator(
                    operator_id,
                    {"type": "visitor_reconnected", "session_id": session_id},
                )
                logger.info(f"Visitor reconnected: {session_id}")

        # DB is the source of truth. Query first, then sync memory
        try:
            with get_session() as db:
                chat_session = db.get(ChatSession, session_id)
                if not chat_session:
                    return

                if chat_session.status == "live" and chat_session.assigned_operator_id:
                    # Sync in-memory assignment from DB
                    self.assignments[session_id] = chat_session.assigned_operator_id
                    operator_name = self._operator_names.get(chat_session.assigned_operator_id, "Support")
                    await self._send_to_visitor(
                        session_id,
                        {"type": "status", "status": "connected", "operator_name": operator_name},
                    )

                elif chat_session.status == "waiting":
                    # Sync in-memory queue from DB
                    if chat_session.client_id is not None:
                        self._session_client_ids[session_id] = chat_session.client_id
                    if session_id not in self.waiting_queue:
                        self.waiting_queue.append(session_id)
                        self._session_departments[session_id] = chat_session.department_id
                    # Remove stale assignment if session was transferred back to queue
                    self.assignments.pop(session_id, None)
                    await self._send_to_visitor(
                        session_id,
                        {
                            "type": "status",
                            "status": "waiting",
                            "queue_position": (
                                self.waiting_queue.index(session_id) + 1 if session_id in self.waiting_queue else 0
                            ),
                        },
                    )

                else:
                    # Session is "bot" or "closed". Clean up any stale in-memory state
                    self.assignments.pop(session_id, None)
                    self._session_departments.pop(session_id, None)
                    self._session_metadata.pop(session_id, None)
                    if session_id in self.waiting_queue:
                        self.waiting_queue.remove(session_id)

        except Exception as e:
            # Non-fatal: visitor is connected; state sync is best-effort.
            logger.warning(f"Failed to restore visitor state for {session_id}: {e}")

    async def _send_to_visitor(self, session_id: str, data: dict):
        """Deliver to a visitor, wherever their socket lives.

        Local socket first; otherwise hand the frame to the backplane so the
        process holding it can write. Every existing caller keeps working and
        gains cross-process delivery without changing, which is why the routing
        lives behind this name rather than at each of the ~15 call sites.

        The write itself is ``_send_to_visitor_local``. That separation is
        load-bearing: the backplane's subscriber calls the local variant, so a
        frame that arrives over Redis is written to the socket instead of being
        published again, which would loop forever.
        """
        if self.visitor_connections.get(session_id) is not None:
            await self._send_to_visitor_local(session_id, data)
            return

        from app.services.ws_backplane import publish_to_session

        await publish_to_session(session_id, data)

    async def _send_to_visitor_local(self, session_id: str, data: dict):
        ws = self.visitor_connections.get(session_id)
        if ws:
            try:
                await ws.send_json(data)
            except Exception as e:
                # Always name the exception CLASS: ``WebSocketDisconnect`` never
                # passes a message to ``Exception.__init__``, so interpolating
                # only ``{e}`` produced "Failed to send to visitor <id>:" with
                # nothing after the colon, a log line that says nothing.
                detail = f"{type(e).__name__}: {e}" if str(e) else type(e).__name__
                if is_client_gone(e):
                    # The visitor closed their tab. Expected, not a failure.
                    logger.debug(f"Visitor {session_id} already disconnected, message dropped ({detail})")
                else:
                    logger.warning(f"Failed to send to visitor {session_id}: {detail}")
                self.disconnect_visitor(session_id)
        else:
            logger.info(f"No WS for visitor {session_id}, message dropped: {data.get('type', 'unknown')}")

    async def _send_to_operator(self, operator_id: int, data: dict):
        """Deliver to an operator, wherever their socket lives.

        Mirror of ``_send_to_visitor``. See that docstring for why the routing
        sits behind the existing name and why the local write is separate.
        """
        if self.operator_connections.get(operator_id) is not None:
            await self._send_to_operator_local(operator_id, data)
            return

        from app.services.ws_backplane import publish_to_operator

        await publish_to_operator(operator_id, data)

    async def _send_to_operator_local(self, operator_id: int, data: dict):
        ws = self.operator_connections.get(operator_id)
        if ws:
            try:
                await ws.send_json(data)
            except Exception as e:
                logger.warning(f"Failed to send to operator {operator_id}: {e}")
                self.disconnect_operator(operator_id)

    def _visible_queue_for_operator(self, operator_id: int) -> list[dict]:
        """Build this operator's visible queue from the DATABASE.

        Derived from ``ChatSession.status == 'waiting'`` rather than the
        in-process ``waiting_queue`` list and its three sidecar dicts.

        WHY THE DATABASE, AND NOT REDIS. Above one process the in-memory queue
        diverges immediately: a handoff served by one worker appends only to that
        worker's list, so operators connected elsewhere never see the visitor,
        and a cancellation prunes only the process that handled it. Mirroring
        four structures into Redis would fix the symptom while keeping two
        sources of truth. Postgres already maintains ``status`` on every
        handoff / accept / timeout / leave-queue path. ``live_chat_availability_service``
        derives queue size the same way for the same reason (audit F33, which
        found the ``live_chat_queue`` table has no write path at all and is
        permanently empty). Deriving here removes state rather than relocating it.

        Runs sync SQLAlchemy, so callers must invoke it off the event loop.
        """
        with get_session() as db:
            operator_client_id, operator_dept = self._resolve_operator_scope(operator_id, db)
            if operator_client_id is None:
                # Fail closed. An operator whose workspace cannot be established
                # is never shown a queue, the same stance ``_should_notify_operator``
                # takes for an unknown operator (audit F03).
                return []

            rows = db.execute(
                select(ChatSession, Bot)
                .outerjoin(Bot, Bot.id == ChatSession.bot_id)
                .where(ChatSession.status == "waiting")
            ).all()

            visible: list[dict] = []
            for chat_session, bot in rows:
                if not self._queue_row_is_visible(
                    session_client_id=chat_session.client_id,
                    session_dept=chat_session.department_id,
                    operator_client_id=operator_client_id,
                    operator_dept=operator_dept,
                ):
                    continue

                lead = get_lead_info_by_session(db, chat_session.id)
                visible.append(
                    {
                        "session_id": chat_session.id,
                        "name": (lead.name if lead and lead.name else "Anonymous"),
                        "reason": chat_session.handoff_reason,
                        "bot_id": chat_session.bot_id,
                        "bot_name": bot.name if bot else None,
                    }
                )
            return visible

    def _resolve_operator_scope(self, operator_id: int, db) -> tuple[int | None, int | None]:
        """Return ``(client_id, department_id)`` for an operator.

        Local maps first: they are populated when the operator connects to THIS
        process, so for the common case this costs nothing and needs no query.
        Falls back to the database for an operator connected elsewhere, which is
        exactly the case that did not exist before the process split.
        """
        client_id = self._operator_client_ids.get(operator_id)
        dept = self._operator_departments.get(operator_id)
        if client_id is not None:
            return client_id, dept

        operator = db.get(Operator, operator_id)
        if operator is None:
            return None, None
        return operator.client_id, operator.department_id

    @staticmethod
    def _queue_row_is_visible(
        *,
        session_client_id: int | None,
        session_dept: int | None,
        operator_client_id: int | None,
        operator_dept: int | None,
    ) -> bool:
        """Whether one queued session may be shown to one operator.

         Pure, so the tenant-isolation rules stay unit-testable without a database
        . These are the checks audit F03 added, and they should be assertable in
         isolation rather than only through a full query.

         Tenant scoping: a session with no ``client_id`` stays visible, matching
         the original in-memory check which only skipped on a positive mismatch.
         Department: either side unset means no filtering.
        """
        if session_client_id is not None and session_client_id != operator_client_id:
            return False
        return session_dept is None or operator_dept is None or session_dept == operator_dept

    async def _notify_operator_queue(self, operator_id: int):
        """Send current queue to a specific operator (filtered by department), with visitor metadata."""
        # Off the event loop: this file had no to_thread usage, so its DB work ran
        # inline and every queue broadcast stalled the loop for all other sockets.
        # Same reasoning as the chat-path offload in f0c0ef8.
        visible_queue = await asyncio.to_thread(self._visible_queue_for_operator, operator_id)

        await self._send_to_operator(
            operator_id,
            {
                "type": "queue_update",
                "waiting": visible_queue,
                "count": len(visible_queue),
            },
        )

    async def _send_active_chats(self, operator_id: int):
        """Send this operator's active chat assignments so they can restore state after page refresh."""
        active = []
        for sid, oid in self.assignments.items():
            if oid == operator_id:
                meta = self._session_metadata.get(sid, {})
                visitor_online = sid in self.visitor_connections
                active.append(
                    {
                        "session_id": sid,
                        "visitor_name": meta.get("name", "Anonymous"),
                        "reason": meta.get("reason"),
                        "visitor_online": visitor_online,
                        "bot_id": meta.get("bot_id"),
                        "bot_name": meta.get("bot_name"),
                    }
                )

        if not active:
            # Check DB for assignments not yet in memory (server restart scenario)
            try:
                with get_session() as db:
                    sessions = (
                        db.execute(
                            select(ChatSession).where(
                                ChatSession.assigned_operator_id == operator_id,
                                ChatSession.status == "live",
                            )
                        )
                        .scalars()
                        .all()
                    )
                    for cs in sessions:
                        if cs.id not in self.assignments:
                            self.assignments[cs.id] = operator_id
                            lead = get_lead_info_by_session(db, cs.id)
                            visitor_online = cs.id in self.visitor_connections
                            # Restore bot label too. Operators returning
                            # after a refresh still need to know which bot
                            # each chat belongs to.
                            db_bot = db.get(Bot, cs.bot_id) if cs.bot_id else None
                            active.append(
                                {
                                    "session_id": cs.id,
                                    "visitor_name": lead.name if lead else "Anonymous",
                                    "reason": cs.handoff_reason,
                                    "visitor_online": visitor_online,
                                    "bot_id": cs.bot_id,
                                    "bot_name": db_bot.name if db_bot else None,
                                }
                            )
            except Exception as e:
                logger.warning(f"Failed to restore active chats from DB for operator {operator_id}: {e}")

        if active:
            await self._send_to_operator(
                operator_id,
                {
                    "type": "active_chats_restore",
                    "chats": active,
                },
            )

    # ── State queries ──

    def get_queue(self) -> list[str]:
        return list(self.waiting_queue)

    def get_operator_chats(self, operator_id: int) -> list[str]:
        return [sid for sid, oid in self.assignments.items() if oid == operator_id]

    def is_visitor_in_live_chat(self, session_id: str) -> bool:
        return session_id in self.assignments

    async def shutdown(self):
        """Graceful shutdown: notify clients and clean up tasks."""
        if self._cleanup_task:
            self._cleanup_task.cancel()
        for task in list(self._timeout_tasks.values()):
            task.cancel()
        for task in list(self._disconnect_tasks.values()):
            task.cancel()
        for task in list(self._operator_disconnect_tasks.values()):
            task.cancel()
        for ws in list(self.visitor_connections.values()):
            with contextlib.suppress(Exception):
                await ws.close(code=1001, reason="Server shutdown")
        for ws in list(self.operator_connections.values()):
            with contextlib.suppress(Exception):
                await ws.close(code=1001, reason="Server shutdown")
        logger.info("ConnectionManager shutdown complete")


# Singleton instance
manager = ConnectionManager()
