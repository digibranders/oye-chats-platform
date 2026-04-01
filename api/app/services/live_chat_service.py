"""Live chat connection manager — handles WebSocket routing between visitors and operators."""

import asyncio
import contextlib
import logging
from datetime import UTC, datetime

from fastapi import WebSocket
from sqlalchemy import select

from app.db.models import ChatSession, Operator
from app.db.repository import get_lead_info_by_session
from app.db.session import get_session

logger = logging.getLogger(__name__)


class ConnectionManager:
    """Manages WebSocket connections for live chat between visitors and operators."""

    # How long to wait for a visitor to reconnect before auto-closing the session.
    VISITOR_DISCONNECT_TIMEOUT = 120  # seconds

    # How long to wait for an operator to reconnect before marking them truly offline.
    # Covers tab switches, short network blips, and browser background throttling.
    OPERATOR_DISCONNECT_TIMEOUT = 60  # seconds

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
        # session_id → department_id (for department-aware routing)
        self._session_departments: dict[str, int | None] = {}
        # operator_id → department_id (cached on connect)
        self._operator_departments: dict[int, int | None] = {}
        # operator_id → operator name (cached on connect for roster broadcasts)
        self._operator_names: dict[int, str] = {}
        # session_id → { name, reason } (visitor metadata for queue display)
        self._session_metadata: dict[str, dict] = {}

    # ── Visitor connections ──

    async def connect_visitor(self, session_id: str, ws: WebSocket):
        await ws.accept()
        self.visitor_connections[session_id] = ws
        logger.info(f"Visitor connected: {session_id}")
        # Sync state to visitor: handles both the REST→WS race condition (visitor WS
        # opens after handoff REST call but before manager.request_handoff fires) and
        # server-restart scenarios where in-memory state was cleared.
        await self._restore_visitor_state(session_id)

    def disconnect_visitor(self, session_id: str):
        was_waiting = session_id in self.waiting_queue
        was_in_live_chat = session_id in self.assignments
        self.visitor_connections.pop(session_id, None)
        self._cancel_timeout(session_id)

        if was_waiting:
            self.waiting_queue.remove(session_id)
            self._session_departments.pop(session_id, None)
            self._session_metadata.pop(session_id, None)
            self._mark_session_waiting_exit(session_id)
        elif was_in_live_chat:
            # Visitor left mid-chat — notify operator but keep the assignment alive
            # so the visitor can reconnect.  Start a cleanup timer.
            operator_id = self.assignments[session_id]
            asyncio.ensure_future(self._handle_visitor_disconnect(session_id, operator_id))
        else:
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
        # Start auto-close timer — if visitor doesn't reconnect within the window,
        # close the chat automatically.
        self._cancel_disconnect_task(session_id)
        task = asyncio.create_task(self._visitor_disconnect_timeout(session_id))
        self._disconnect_tasks[session_id] = task

    async def _visitor_disconnect_timeout(self, session_id: str):
        """Auto-close a chat if the visitor doesn't reconnect within the timeout."""
        try:
            await asyncio.sleep(self.VISITOR_DISCONNECT_TIMEOUT)
            if session_id in self.assignments and session_id not in self.visitor_connections:
                logger.info(f"Visitor {session_id} did not reconnect — auto-closing chat")
                # Persist to DB
                self._mark_session_closed(session_id)
                # Clean up in-memory state and notify operator
                operator_id = self.assignments.pop(session_id, None)
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
        """Persist session closure to DB."""
        try:
            with get_session() as session:
                chat_session = session.get(ChatSession, session_id)
                if chat_session and chat_session.status == "live":
                    chat_session.status = "bot"
                    chat_session.assigned_operator_id = None
                    session.commit()
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
    ):
        # Cancel any pending grace-period timeout — operator is back before it expired.
        # This is the key reconnection-recovery path: tab switch, network blip, etc.
        self._cancel_operator_disconnect_task(operator_id)

        # If operator already connected (multi-tab), close old connection gracefully
        old_ws = self.operator_connections.get(operator_id)
        if old_ws and old_ws is not ws:
            with contextlib.suppress(Exception):
                await old_ws.close(code=1000, reason="Replaced by new connection")

        await ws.accept()
        self.operator_connections[operator_id] = ws
        self._operator_departments[operator_id] = department_id
        self._operator_names[operator_id] = operator_name
        logger.info(f"Operator connected: {operator_id} ({operator_name}, dept={department_id})")

        # Send init state to this operator
        await self._send_to_operator(
            operator_id,
            {
                "type": "init",
                "operator_id": operator_id,
                "operator_name": operator_name,
                "is_online": is_online,
            },
        )

        # Send current queue
        await self._notify_operator_queue(operator_id)

        # Send active chats so operator can restore state after page refresh
        await self._send_active_chats(operator_id)

        # Broadcast updated roster to all operators
        await self.broadcast_operators_update()

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

    async def _operator_disconnect_timeout(self, operator_id: int):
        """Full cleanup when an operator doesn't reconnect within the grace period."""
        try:
            await asyncio.sleep(self.OPERATOR_DISCONNECT_TIMEOUT)
            # Still not reconnected — do the full cleanup now.
            if operator_id not in self.operator_connections:
                logger.info(
                    f"Operator {operator_id} did not reconnect within "
                    f"{self.OPERATOR_DISCONNECT_TIMEOUT}s — marking offline"
                )
                self._operator_departments.pop(operator_id, None)
                self._operator_names.pop(operator_id, None)
                # Persist offline status to DB
                try:
                    with get_session() as db:
                        op_obj = db.execute(select(Operator).where(Operator.id == operator_id)).scalar_one_or_none()
                        if op_obj:
                            op_obj.is_online = False
                            db.commit()
                except Exception as e:
                    logger.warning(f"Failed to persist offline status for operator {operator_id}: {e}")
                # Broadcast updated roster to all remaining operators
                await self.broadcast_operators_update()
        except asyncio.CancelledError:
            pass
        finally:
            self._operator_disconnect_tasks.pop(operator_id, None)

    # ── Handoff flow ──

    async def request_handoff(
        self,
        session_id: str,
        timeout_seconds: int = 120,
        department_id: int | None = None,
        visitor_name: str | None = None,
        reason: str | None = None,
    ):
        """Add visitor to the waiting queue and notify operators."""
        if session_id not in self.waiting_queue:
            self.waiting_queue.append(session_id)
        self._session_departments[session_id] = department_id
        self._session_metadata[session_id] = {
            "name": visitor_name or "Anonymous",
            "reason": reason,
        }

        # Notify visitor they're in queue
        await self._send_to_visitor(
            session_id,
            {
                "type": "status",
                "status": "waiting",
                "queue_position": self.waiting_queue.index(session_id) + 1,
            },
        )

        # Notify relevant operators (department-aware)
        for operator_id in list(self.operator_connections.keys()):
            if self._should_notify_operator(operator_id, department_id):
                await self._notify_operator_queue(operator_id)

        # Start timeout
        self._start_timeout(session_id, timeout_seconds)

    def _should_notify_operator(self, operator_id: int, department_id: int | None) -> bool:
        """Check if an operator should be notified about a queue item."""
        if department_id is None:
            return True
        operator_dept = self._operator_departments.get(operator_id)
        if operator_dept is None:
            return True
        return operator_dept == department_id

    async def accept_chat(self, session_id: str, operator_id: int, operator_name: str) -> bool:
        """Operator accepts a waiting chat. Returns False if already accepted."""
        # Concurrency guard: bail if already assigned
        if session_id in self.assignments:
            logger.warning(
                f"Chat {session_id} already assigned to operator {self.assignments[session_id]}, ignoring accept from {operator_id}"
            )
            return False

        if session_id in self.waiting_queue:
            self.waiting_queue.remove(session_id)
        self.assignments[session_id] = operator_id
        self._cancel_timeout(session_id)

        # Notify visitor
        await self._send_to_visitor(
            session_id,
            {
                "type": "status",
                "status": "connected",
                "agent_name": operator_name,
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

        # Notify new operator
        await self._send_to_operator(
            new_operator_id,
            {
                "type": "chat_accepted",
                "session_id": session_id,
                "visitor_name": self._session_metadata.get(session_id, {}).get("name", "Anonymous"),
                "reason": self._session_metadata.get(session_id, {}).get("reason"),
            },
        )

        # Notify visitor
        await self._send_to_visitor(
            session_id,
            {
                "type": "status",
                "status": "connected",
                "agent_name": new_operator_name,
            },
        )

        # Update all operators: queue + roster
        for operator_id in list(self.operator_connections.keys()):
            await self._notify_operator_queue(operator_id)

        await self.broadcast_operators_update()
        logger.info(
            f"Chat {session_id} transferred from operator {old_operator_id} to {new_operator_id} ({new_operator_name})"
        )

    # ── Roster broadcast ──

    async def broadcast_operators_update(self):
        """Push current operator roster to all connected operators.

        Includes operators that are within their grace period (WS dropped but not
        yet timed out) so their active_chats count stays visible to the team.
        """
        operators_payload = []
        seen_ids: set[int] = set()

        # Currently connected operators — fully online
        for oid in list(self.operator_connections.keys()):
            active_count = len([sid for sid, o_id in self.assignments.items() if o_id == oid])
            operators_payload.append(
                {
                    "operator_id": oid,
                    "name": self._operator_names.get(oid, ""),
                    "active_chats": active_count,
                    "is_online": True,
                }
            )
            seen_ids.add(oid)

        # Operators in grace period — WS dropped but assignments still live
        for oid in list(self._operator_disconnect_tasks.keys()):
            if oid not in seen_ids:
                active_count = len([sid for sid, o_id in self.assignments.items() if o_id == oid])
                if active_count > 0:
                    operators_payload.append(
                        {
                            "operator_id": oid,
                            "name": self._operator_names.get(oid, ""),
                            "active_chats": active_count,
                            "is_online": False,  # temporarily away
                        }
                    )

        msg = {
            "type": "operators_update",
            "operators": operators_payload,
        }
        for operator_id in list(self.operator_connections.keys()):
            await self._send_to_operator(operator_id, msg)

    # ── Message routing ──

    async def route_visitor_message(self, session_id: str, content: str):
        """Route a message from visitor to their assigned operator."""
        operator_id = self.assignments.get(session_id)
        if operator_id and operator_id in self.operator_connections:
            await self._send_to_operator(
                operator_id,
                {
                    "type": "message",
                    "session_id": session_id,
                    "role": "user",
                    "content": content,
                    "timestamp": datetime.now(UTC).isoformat(),
                },
            )

    async def route_operator_message(self, session_id: str, content: str, operator_name: str):
        """Route a message from operator to visitor."""
        await self._send_to_visitor(
            session_id,
            {
                "type": "message",
                "role": "operator",
                "content": content,
                "agent_name": operator_name,
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
            with get_session() as session:
                chat_session = session.get(ChatSession, session_id)
                if chat_session and chat_session.status == "waiting":
                    chat_session.status = "bot"
                    chat_session.assigned_operator_id = None
                    session.commit()
        except Exception as e:
            # Queue correctness degrades if this fails, but websocket flow should continue.
            logger.warning(f"Failed to persist waiting-exit state for {session_id}: {e}")

    async def _restore_visitor_state(self, session_id: str) -> None:
        """Push current state to a freshly connected visitor WebSocket.

        Covers two failure scenarios:
        - Race condition: visitor WS opens after REST /handoff returns but before
          manager.request_handoff fires — the queued status send lands on a missing
          connection, so the visitor never receives their queue position.
        - Server restart: in-memory assignments/queue are cleared but the DB still
          records live or waiting sessions.
        """
        # Happy path: state is already tracked in memory
        if session_id in self.assignments:
            operator_id = self.assignments[session_id]
            operator_name = self._operator_names.get(operator_id, "Support")
            await self._send_to_visitor(
                session_id,
                {"type": "status", "status": "connected", "agent_name": operator_name},
            )
            # Cancel any pending disconnect cleanup — visitor is back
            if session_id in self._disconnect_tasks:
                self._cancel_disconnect_task(session_id)
                await self._send_to_operator(
                    operator_id,
                    {"type": "visitor_reconnected", "session_id": session_id},
                )
                logger.info(f"Visitor reconnected: {session_id}")
            return

        if session_id in self.waiting_queue:
            await self._send_to_visitor(
                session_id,
                {
                    "type": "status",
                    "status": "waiting",
                    "queue_position": self.waiting_queue.index(session_id) + 1,
                },
            )
            return

        # Fall through to DB for restart recovery
        try:
            with get_session() as db:
                chat_session = db.get(ChatSession, session_id)
                if not chat_session:
                    return

                if chat_session.status == "live" and chat_session.assigned_operator_id:
                    # Restore the assignment so message routing works again
                    self.assignments[session_id] = chat_session.assigned_operator_id
                    operator_name = self._operator_names.get(chat_session.assigned_operator_id, "Support")
                    await self._send_to_visitor(
                        session_id,
                        {"type": "status", "status": "connected", "agent_name": operator_name},
                    )
                    logger.info(
                        f"Restored live assignment for {session_id} → operator {chat_session.assigned_operator_id}"
                    )

                elif chat_session.status == "waiting":
                    if session_id not in self.waiting_queue:
                        self.waiting_queue.append(session_id)
                        self._session_departments[session_id] = chat_session.department_id
                    await self._send_to_visitor(
                        session_id,
                        {
                            "type": "status",
                            "status": "waiting",
                            "queue_position": self.waiting_queue.index(session_id) + 1,
                        },
                    )
                    logger.info(f"Restored waiting state for {session_id}")
        except Exception as e:
            # Non-fatal: visitor is connected; state sync is best-effort.
            logger.warning(f"Failed to restore visitor state for {session_id}: {e}")

    async def _send_to_visitor(self, session_id: str, data: dict):
        ws = self.visitor_connections.get(session_id)
        if ws:
            try:
                await ws.send_json(data)
            except Exception as e:
                logger.warning(f"Failed to send to visitor {session_id}: {e}")
                self.disconnect_visitor(session_id)

    async def _send_to_operator(self, operator_id: int, data: dict):
        ws = self.operator_connections.get(operator_id)
        if ws:
            try:
                await ws.send_json(data)
            except Exception as e:
                logger.warning(f"Failed to send to operator {operator_id}: {e}")
                self.disconnect_operator(operator_id)

    async def _notify_operator_queue(self, operator_id: int):
        """Send current queue to a specific operator (filtered by department), with visitor metadata."""
        operator_dept = self._operator_departments.get(operator_id)

        visible_queue = []
        for sid in self.waiting_queue:
            session_dept = self._session_departments.get(sid)
            if session_dept is None or operator_dept is None or session_dept == operator_dept:
                meta = self._session_metadata.get(sid, {})
                visible_queue.append(
                    {
                        "session_id": sid,
                        "name": meta.get("name", "Anonymous"),
                        "reason": meta.get("reason"),
                    }
                )

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
                            active.append(
                                {
                                    "session_id": cs.id,
                                    "visitor_name": lead.name if lead else "Anonymous",
                                    "reason": cs.handoff_reason,
                                    "visitor_online": visitor_online,
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


# Singleton instance
manager = ConnectionManager()
