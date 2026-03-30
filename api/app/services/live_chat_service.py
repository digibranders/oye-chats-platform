"""Live chat connection manager — handles WebSocket routing between visitors and agents."""

import asyncio
import contextlib
import logging
from datetime import UTC, datetime

from fastapi import WebSocket

logger = logging.getLogger(__name__)


class ConnectionManager:
    """Manages WebSocket connections for live chat between visitors and agents."""

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

    def disconnect_visitor(self, session_id: str):
        self.visitor_connections.pop(session_id, None)
        self._cancel_timeout(session_id)
        self._session_departments.pop(session_id, None)
        self._session_metadata.pop(session_id, None)
        if session_id in self.waiting_queue:
            self.waiting_queue.remove(session_id)
        logger.info(f"Visitor disconnected: {session_id}")

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

    # ── State queries ──

    def get_queue(self) -> list[str]:
        return list(self.waiting_queue)

    def get_agent_chats(self, agent_id: int) -> list[str]:
        return [sid for sid, aid in self.assignments.items() if aid == agent_id]

    def is_visitor_in_live_chat(self, session_id: str) -> bool:
        return session_id in self.assignments


# Singleton instance
manager = ConnectionManager()
