"""Live chat connection manager — handles WebSocket routing between visitors and agents."""

import asyncio
import logging
from datetime import datetime

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

    # ── Visitor connections ──

    async def connect_visitor(self, session_id: str, ws: WebSocket):
        await ws.accept()
        self.visitor_connections[session_id] = ws
        logger.info(f"Visitor connected: {session_id}")

    def disconnect_visitor(self, session_id: str):
        self.visitor_connections.pop(session_id, None)
        self._cancel_timeout(session_id)
        if session_id in self.waiting_queue:
            self.waiting_queue.remove(session_id)
        logger.info(f"Visitor disconnected: {session_id}")

    # ── Agent connections ──

    async def connect_agent(self, agent_id: int, ws: WebSocket):
        await ws.accept()
        self.agent_connections[agent_id] = ws
        logger.info(f"Agent connected: {agent_id}")
        # Notify about waiting queue
        await self._notify_agent_queue(agent_id)

    def disconnect_agent(self, agent_id: int):
        self.agent_connections.pop(agent_id, None)
        logger.info(f"Agent disconnected: {agent_id}")

    # ── Handoff flow ──

    async def request_handoff(self, session_id: str, timeout_seconds: int = 120):
        """Add visitor to the waiting queue and notify agents."""
        if session_id not in self.waiting_queue:
            self.waiting_queue.append(session_id)

        # Notify visitor they're in queue
        await self._send_to_visitor(session_id, {
            "type": "status",
            "status": "waiting",
            "queue_position": self.waiting_queue.index(session_id) + 1,
        })

        # Notify all online agents
        for agent_id in list(self.agent_connections.keys()):
            await self._notify_agent_queue(agent_id)

        # Start timeout
        self._start_timeout(session_id, timeout_seconds)

    async def accept_chat(self, session_id: str, agent_id: int, agent_name: str):
        """Agent accepts a waiting chat."""
        if session_id in self.waiting_queue:
            self.waiting_queue.remove(session_id)
        self.assignments[session_id] = agent_id
        self._cancel_timeout(session_id)

        # Notify visitor
        await self._send_to_visitor(session_id, {
            "type": "status",
            "status": "connected",
            "agent_name": agent_name,
        })

        # Notify agent
        await self._send_to_agent(agent_id, {
            "type": "chat_accepted",
            "session_id": session_id,
        })

        logger.info(f"Agent {agent_id} ({agent_name}) accepted chat {session_id}")

    async def close_chat(self, session_id: str, bot_name: str = "AI Assistant"):
        """Agent closes a live chat, returns to bot mode."""
        agent_id = self.assignments.pop(session_id, None)
        self._cancel_timeout(session_id)

        await self._send_to_visitor(session_id, {
            "type": "status",
            "status": "closed",
            "bot_name": bot_name,
        })

        if agent_id:
            await self._send_to_agent(agent_id, {
                "type": "chat_closed",
                "session_id": session_id,
            })

        logger.info(f"Chat {session_id} closed")

    # ── Message routing ──

    async def route_visitor_message(self, session_id: str, content: str):
        """Route a message from visitor to their assigned agent."""
        agent_id = self.assignments.get(session_id)
        if agent_id and agent_id in self.agent_connections:
            await self._send_to_agent(agent_id, {
                "type": "message",
                "session_id": session_id,
                "role": "user",
                "content": content,
                "timestamp": datetime.utcnow().isoformat(),
            })

    async def route_agent_message(self, session_id: str, content: str, agent_name: str):
        """Route a message from agent to visitor."""
        await self._send_to_visitor(session_id, {
            "type": "message",
            "role": "agent",
            "content": content,
            "agent_name": agent_name,
            "timestamp": datetime.utcnow().isoformat(),
        })

    async def send_typing_to_visitor(self, session_id: str):
        """Notify visitor that agent is typing."""
        await self._send_to_visitor(session_id, {"type": "agent_typing"})

    async def send_typing_to_agent(self, session_id: str):
        """Notify agent that visitor is typing."""
        agent_id = self.assignments.get(session_id)
        if agent_id:
            await self._send_to_agent(agent_id, {
                "type": "visitor_typing",
                "session_id": session_id,
            })

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
            # Still waiting?
            if session_id in self.waiting_queue:
                self.waiting_queue.remove(session_id)
                await self._send_to_visitor(session_id, {
                    "type": "status",
                    "status": "unavailable",
                })
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
        """Send current queue to a specific agent."""
        await self._send_to_agent(agent_id, {
            "type": "queue_update",
            "waiting": self.waiting_queue,
            "count": len(self.waiting_queue),
        })

    # ── State queries ──

    def get_queue(self) -> list[str]:
        return list(self.waiting_queue)

    def get_agent_chats(self, agent_id: int) -> list[str]:
        return [sid for sid, aid in self.assignments.items() if aid == agent_id]

    def is_visitor_in_live_chat(self, session_id: str) -> bool:
        return session_id in self.assignments


# Singleton instance
manager = ConnectionManager()
