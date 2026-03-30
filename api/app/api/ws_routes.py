"""WebSocket endpoints for live chat between visitors and agents."""

import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from sqlalchemy import select

from app.db.models import Agent, Bot, ChatSession, Client
from app.db.repository import add_chat_message
from app.db.session import get_session
from app.services.live_chat_service import manager

logger = logging.getLogger(__name__)

router = APIRouter(tags=["websocket"])


@router.websocket("/ws/chat/{session_id}")
async def visitor_websocket(ws: WebSocket, session_id: str, bot_key: str | None = None):
    """WebSocket for visitor (widget) side of live chat."""
    if not bot_key:
        await ws.close(code=4001, reason="Missing bot_key query param")
        return

    with get_session() as session:
        bot = session.execute(select(Bot).where(Bot.bot_key == bot_key, Bot.is_active.is_(True))).scalar_one_or_none()
        if not bot:
            await ws.close(code=4003, reason="Invalid bot key")
            return
        bot_id = bot.id

    await manager.connect_visitor(session_id, ws)

    try:
        while True:
            data = await ws.receive_json()
            msg_type = data.get("type")

            if msg_type == "message":
                content = data.get("content", "").strip()
                if not content:
                    continue

                with get_session() as session:
                    add_chat_message(session, session_id, role="user", content=content, bot_id=bot_id)
                    session.commit()

                await manager.route_visitor_message(session_id, content)

            elif msg_type == "typing":
                await manager.send_typing_to_agent(session_id)

    except WebSocketDisconnect:
        manager.disconnect_visitor(session_id)
    except Exception as e:
        logger.error(f"Visitor WS error for {session_id}: {e}")
        manager.disconnect_visitor(session_id)


def _resolve_agent_from_key(key: str, key_type: str) -> tuple[int, str, int, int | None, bool] | None:
    """Resolve agent_id, agent_name, client_id, department_id, is_online from an api_key or agent_key.

    Returns (agent_id, agent_name, client_id, department_id, is_online) or None if auth fails.
    """
    with get_session() as session:
        if key_type == "agent_key":
            agent = session.execute(select(Agent).where(Agent.agent_api_key == key)).scalar_one_or_none()
            if not agent:
                return None
            agent.is_online = True
            session.commit()
            return agent.id, agent.name, agent.client_id, agent.department_id, True

        # Client api_key auth — find or create agent from client profile
        client = session.execute(select(Client).where(Client.api_key == key)).scalar_one_or_none()
        if not client:
            return None

        agent = session.execute(select(Agent).where(Agent.client_id == client.id).limit(1)).scalar_one_or_none()

        if not agent:
            agent = Agent(
                client_id=client.id,
                name=client.name,
                email=client.email,
                is_online=True,
                role="owner",
            )
            session.add(agent)
            session.commit()
            session.refresh(agent)
        else:
            agent.is_online = True
            session.commit()

        return agent.id, agent.name, client.id, agent.department_id, agent.is_online


@router.websocket("/ws/agent")
async def agent_websocket(
    ws: WebSocket,
    api_key: str | None = None,
    agent_key: str | None = None,
):
    """WebSocket for agent (admin dashboard) side of live chat.

    Supports dual auth:
    - api_key: Client API key (owner/backward compat, resolves to first agent)
    - agent_key: Agent's own API key (for multi-agent)
    """
    if agent_key:
        result = _resolve_agent_from_key(agent_key, "agent_key")
    elif api_key:
        result = _resolve_agent_from_key(api_key, "api_key")
    else:
        await ws.close(code=4001, reason="Missing api_key or agent_key query param")
        return

    if not result:
        await ws.close(code=4003, reason="Invalid authentication key")
        return

    agent_id, agent_name, client_id, department_id, is_online = result

    await manager.connect_agent(
        agent_id,
        ws,
        department_id=department_id,
        agent_name=agent_name,
        is_online=is_online,
    )

    try:
        while True:
            data = await ws.receive_json()
            msg_type = data.get("type")

            if msg_type == "ping":
                await ws.send_json({"type": "pong"})

            elif msg_type == "message":
                target_session = data.get("session_id")
                content = data.get("content", "").strip()
                if not target_session or not content:
                    continue

                with get_session() as session:
                    add_chat_message(session, target_session, role="agent", content=content, bot_id=None)
                    session.commit()

                await manager.route_agent_message(target_session, content, agent_name)

            elif msg_type == "typing":
                target_session = data.get("session_id")
                if target_session:
                    await manager.send_typing_to_visitor(target_session)

            elif msg_type == "close_chat":
                target_session = data.get("session_id")
                if target_session:
                    with get_session() as session:
                        chat_session = session.execute(
                            select(ChatSession).where(ChatSession.id == target_session)
                        ).scalar_one_or_none()
                        if chat_session:
                            bot = session.execute(select(Bot).where(Bot.id == chat_session.bot_id)).scalar_one_or_none()
                            chat_session.status = "bot"
                            chat_session.assigned_agent_id = None
                            session.commit()
                            await manager.close_chat(target_session, bot.name if bot else "AI Assistant")

    except WebSocketDisconnect:
        await manager.disconnect_agent_and_broadcast(agent_id)
        with get_session() as session:
            agent_obj = session.execute(select(Agent).where(Agent.id == agent_id)).scalar_one_or_none()
            if agent_obj:
                agent_obj.is_online = False
                session.commit()
    except Exception as e:
        logger.error(f"Agent WS error for agent {agent_id}: {e}")
        await manager.disconnect_agent_and_broadcast(agent_id)
