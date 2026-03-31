"""Live chat connection manager — handles WebSocket routing between visitors and agents."""

import asyncio
import contextlib
import logging
from datetime import UTC, datetime

from fastapi import WebSocket
from sqlalchemy import select

from app.db.models import ChatSession
from app.db.repository import get_lead_info_by_session
from app.db.session import get_session

logger = logging.getLogger(__name__)


class ConnectionManager:
    """Manages WebSocket connections for live chat between visitors and agents."""

    # How long to wait for a visitor to reconnect before auto-closing the session.
    VISITOR_DISCONNECT_TIMEOUT = 120  # seconds

    def __init__(self):
        # session_id → WebSocket
        self.visitor_connections: dict[str, WebSocket] = {}
        # agent_id → WebSocket
        self.agent_connections: dict[int, WebSocket] = {}
        # session_ids waiting for an agent
        self.waiting_queue: list[str] = []
        # session_id → agent_id assignment
        self.assignments: dict[str, int] = {}
        # session_id → timeout task
        self._timeout_tasks: dict[str, asyncio.Task] = {}
        # session_id → disconnect cleanup task (visitor left mid-chat)
        self._disconnect_tasks: dict[str, asyncio.Task] = {}
        # session_id → department_id (for department-aware routing)
        self._session_departments: dict[str, int | None] = {}
        # agent_id → department_id (cached on connect)
        self._agent_departments: dict[int, int | None] = {}
        # agent_id → agent name (cached on connect for roster broadcasts)
        self._agent_names: dict[int, str] = {}
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
            # Visitor left mid-chat — notify agent but keep the assignment alive
            # so the visitor can reconnect.  Start a cleanup timer.
            agent_id = self.assignments[session_id]
            asyncio.ensure_future(self._handle_visitor_disconnect(session_id, agent_id))
        else:
            self._session_departments.pop(session_id, None)
            self._session_metadata.pop(session_id, None)

        logger.info(f"Visitor disconnected: {session_id} (was_waiting={was_waiting}, was_live={was_in_live_chat})")

    async def _handle_visitor_disconnect(self, session_id: str, agent_id: int):
        """Notify agent that visitor disconnected and start auto-close timer."""
        await self._send_to_agent(
            agent_id,
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
                # Clean up in-memory state and notify agent
                agent_id = self.assignments.pop(session_id, None)
                self._session_departments.pop(session_id, None)
                self._session_metadata.pop(session_id, None)
                if agent_id:
                    await self._send_to_agent(
                        agent_id,
                        {"type": "chat_closed", "session_id": session_id},
                    )
                await self.broadcast_agents_update()
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
                    chat_session.assigned_agent_id = None
                    session.commit()
        except Exception as e:
            logger.warning(f"Failed to persist session closure for {session_id}: {e}")

    # ── Agent connections ──

    async def connect_agent(
        self,
        agent_id: int,
        ws: WebSocket,
        department_id: int | None = None,
        agent_name: str = "",
        is_online: bool = True,
    ):
        # If agent already connected (multi-tab), close old connection gracefully
        old_ws = self.agent_connections.get(agent_id)
        if old_ws and old_ws is not ws:
            with contextlib.suppress(Exception):
                await old_ws.close(code=1000, reason="Replaced by new connection")

        await ws.accept()
        self.agent_connections[agent_id] = ws
        self._agent_departments[agent_id] = department_id
        self._agent_names[agent_id] = agent_name
        logger.info(f"Agent connected: {agent_id} ({agent_name}, dept={department_id})")

        # Send init state to this agent
        await self._send_to_agent(
            agent_id,
            {
                "type": "init",
                "agent_id": agent_id,
                "agent_name": agent_name,
                "is_online": is_online,
            },
        )

        # Send current queue
        await self._notify_agent_queue(agent_id)

        # Send active chats so agent can restore state after page refresh
        await self._send_active_chats(agent_id)

        # Broadcast updated roster to all agents
        await self.broadcast_agents_update()

    def disconnect_agent(self, agent_id: int):
        self.agent_connections.pop(agent_id, None)
        self._agent_departments.pop(agent_id, None)
        self._agent_names.pop(agent_id, None)
        logger.info(f"Agent disconnected: {agent_id}")

    async def disconnect_agent_and_broadcast(self, agent_id: int):
        """Disconnect agent and broadcast the updated roster."""
        self.disconnect_agent(agent_id)
        await self.broadcast_agents_update()

    # ── Handoff flow ──

    async def request_handoff(
        self,
        session_id: str,
        timeout_seconds: int = 120,
        department_id: int | None = None,
        visitor_name: str | None = None,
        reason: str | None = None,
    ):
        """Add visitor to the waiting queue and notify agents."""
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

        # Notify relevant agents (department-aware)
        for agent_id in list(self.agent_connections.keys()):
            if self._should_notify_agent(agent_id, department_id):
                await self._notify_agent_queue(agent_id)

        # Start timeout
        self._start_timeout(session_id, timeout_seconds)

    def _should_notify_agent(self, agent_id: int, department_id: int | None) -> bool:
        """Check if an agent should be notified about a queue item."""
        if department_id is None:
            return True
        agent_dept = self._agent_departments.get(agent_id)
        if agent_dept is None:
            return True
        return agent_dept == department_id

    async def accept_chat(self, session_id: str, agent_id: int, agent_name: str) -> bool:
        """Agent accepts a waiting chat. Returns False if already accepted."""
        # Concurrency guard: bail if already assigned
        if session_id in self.assignments:
            logger.warning(
                f"Chat {session_id} already assigned to agent {self.assignments[session_id]}, ignoring accept from {agent_id}"
            )
            return False

        if session_id in self.waiting_queue:
            self.waiting_queue.remove(session_id)
        self.assignments[session_id] = agent_id
        self._cancel_timeout(session_id)

        # Notify visitor
        await self._send_to_visitor(
            session_id,
            {
                "type": "status",
                "status": "connected",
                "agent_name": agent_name,
            },
        )

        # Notify accepting agent
        await self._send_to_agent(
            agent_id,
            {
                "type": "chat_accepted",
                "session_id": session_id,
                "visitor_name": self._session_metadata.get(session_id, {}).get("name", "Anonymous"),
                "reason": self._session_metadata.get(session_id, {}).get("reason"),
            },
        )

        # Notify all other agents: updated queue + roster
        for other_agent_id in list(self.agent_connections.keys()):
            if other_agent_id != agent_id:
                await self._notify_agent_queue(other_agent_id)

        await self.broadcast_agents_update()
        logger.info(f"Agent {agent_id} ({agent_name}) accepted chat {session_id}")
        return True

    async def close_chat(self, session_id: str, bot_name: str = "AI Assistant"):
        """Agent closes a live chat, returns to bot mode."""
        agent_id = self.assignments.pop(session_id, None)
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

        if agent_id:
            await self._send_to_agent(
                agent_id,
                {
                    "type": "chat_closed",
                    "session_id": session_id,
                },
            )

        await self.broadcast_agents_update()
        logger.info(f"Chat {session_id} closed")

    async def transfer_chat(self, session_id: str, old_agent_id: int | None, new_agent_id: int, new_agent_name: str):
        """Transfer a live chat from one agent to another."""
        self.assignments[session_id] = new_agent_id
        self._cancel_timeout(session_id)

        # Notify old agent
        if old_agent_id:
            await self._send_to_agent(
                old_agent_id,
                {
                    "type": "chat_transferred",
                    "session_id": session_id,
                    "transferred_to": new_agent_name,
                },
            )

        # Notify new agent
        await self._send_to_agent(
            new_agent_id,
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
                "agent_name": new_agent_name,
            },
        )

        # Update all agents: queue + roster
        for agent_id in list(self.agent_connections.keys()):
            await self._notify_agent_queue(agent_id)

        await self.broadcast_agents_update()
        logger.info(f"Chat {session_id} transferred from agent {old_agent_id} to {new_agent_id} ({new_agent_name})")

    # ── Roster broadcast ──

    async def broadcast_agents_update(self):
        """Push current agent roster (connected agents + their active chat counts) to all agents."""
        agents_payload = []
        for aid in list(self.agent_connections.keys()):
            active_count = len([sid for sid, a_id in self.assignments.items() if a_id == aid])
            agents_payload.append(
                {
                    "agent_id": aid,
                    "name": self._agent_names.get(aid, ""),
                    "active_chats": active_count,
                }
            )

        msg = {
            "type": "agents_update",
            "agents": agents_payload,
        }
        for agent_id in list(self.agent_connections.keys()):
            await self._send_to_agent(agent_id, msg)

    # ── Message routing ──

    async def route_visitor_message(self, session_id: str, content: str):
        """Route a message from visitor to their assigned agent."""
        agent_id = self.assignments.get(session_id)
        if agent_id and agent_id in self.agent_connections:
            await self._send_to_agent(
                agent_id,
                {
                    "type": "message",
                    "session_id": session_id,
                    "role": "user",
                    "content": content,
                    "timestamp": datetime.now(UTC).isoformat(),
                },
            )

    async def route_agent_message(self, session_id: str, content: str, agent_name: str):
        """Route a message from agent to visitor."""
        await self._send_to_visitor(
            session_id,
            {
                "type": "message",
                "role": "agent",
                "content": content,
                "agent_name": agent_name,
                "timestamp": datetime.now(UTC).isoformat(),
            },
        )

    async def send_typing_to_visitor(self, session_id: str):
        """Notify visitor that agent is typing."""
        await self._send_to_visitor(session_id, {"type": "agent_typing"})

    async def send_typing_to_agent(self, session_id: str):
        """Notify agent that visitor is typing."""
        agent_id = self.assignments.get(session_id)
        if agent_id:
            await self._send_to_agent(
                agent_id,
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
        """If no agent accepts within timeout, mark as unavailable."""
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
                logger.info(f"Timeout: no agent accepted chat {session_id} within {timeout_seconds}s")
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
                    chat_session.assigned_agent_id = None
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
            agent_id = self.assignments[session_id]
            agent_name = self._agent_names.get(agent_id, "Support")
            await self._send_to_visitor(
                session_id,
                {"type": "status", "status": "connected", "agent_name": agent_name},
            )
            # Cancel any pending disconnect cleanup — visitor is back
            if session_id in self._disconnect_tasks:
                self._cancel_disconnect_task(session_id)
                await self._send_to_agent(
                    agent_id,
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

                if chat_session.status == "live" and chat_session.assigned_agent_id:
                    # Restore the assignment so message routing works again
                    self.assignments[session_id] = chat_session.assigned_agent_id
                    agent_name = self._agent_names.get(chat_session.assigned_agent_id, "Support")
                    await self._send_to_visitor(
                        session_id,
                        {"type": "status", "status": "connected", "agent_name": agent_name},
                    )
                    logger.info(f"Restored live assignment for {session_id} → agent {chat_session.assigned_agent_id}")

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

    async def _send_to_agent(self, agent_id: int, data: dict):
        ws = self.agent_connections.get(agent_id)
        if ws:
            try:
                await ws.send_json(data)
            except Exception as e:
                logger.warning(f"Failed to send to agent {agent_id}: {e}")
                self.disconnect_agent(agent_id)

    async def _notify_agent_queue(self, agent_id: int):
        """Send current queue to a specific agent (filtered by department), with visitor metadata."""
        agent_dept = self._agent_departments.get(agent_id)

        visible_queue = []
        for sid in self.waiting_queue:
            session_dept = self._session_departments.get(sid)
            if session_dept is None or agent_dept is None or session_dept == agent_dept:
                meta = self._session_metadata.get(sid, {})
                visible_queue.append(
                    {
                        "session_id": sid,
                        "name": meta.get("name", "Anonymous"),
                        "reason": meta.get("reason"),
                    }
                )

        await self._send_to_agent(
            agent_id,
            {
                "type": "queue_update",
                "waiting": visible_queue,
                "count": len(visible_queue),
            },
        )

    async def _send_active_chats(self, agent_id: int):
        """Send this agent's active chat assignments so they can restore state after page refresh."""
        active = []
        for sid, aid in self.assignments.items():
            if aid == agent_id:
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
                                ChatSession.assigned_agent_id == agent_id,
                                ChatSession.status == "live",
                            )
                        )
                        .scalars()
                        .all()
                    )
                    for cs in sessions:
                        if cs.id not in self.assignments:
                            self.assignments[cs.id] = agent_id
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
                logger.warning(f"Failed to restore active chats from DB for agent {agent_id}: {e}")

        if active:
            await self._send_to_agent(
                agent_id,
                {
                    "type": "active_chats_restore",
                    "chats": active,
                },
            )

    # ── State queries ──

    def get_queue(self) -> list[str]:
        return list(self.waiting_queue)

    def get_agent_chats(self, agent_id: int) -> list[str]:
        return [sid for sid, aid in self.assignments.items() if aid == agent_id]

    def is_visitor_in_live_chat(self, session_id: str) -> bool:
        return session_id in self.assignments


# Singleton instance
manager = ConnectionManager()
