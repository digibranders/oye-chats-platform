"""Agent management REST endpoints for live chat."""

import logging

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select

from app.api.auth import get_current_client
from app.db.models import Agent, Bot, ChatSession, Client
from app.db.repository import get_lead_info_by_session
from app.db.session import get_session
from app.services.email_service import send_handoff_request_email
from app.services.live_chat_service import manager

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/agents", tags=["agents"])


class HandoffRequest(BaseModel):
    session_id: str
    reason: str | None = None


@router.post("/handoff")
def request_handoff(request: HandoffRequest, client: Client = Depends(get_current_client)):
    """Called by the widget (via REST) to initiate a handoff request."""
    import asyncio

    with get_session() as session:
        chat_session = session.execute(
            select(ChatSession).where(ChatSession.id == request.session_id)
        ).scalar_one_or_none()
        if not chat_session:
            raise HTTPException(status_code=404, detail="Session not found")

        # Update session status
        chat_session.status = "waiting"
        chat_session.handoff_reason = request.reason

        # Get bot for timeout setting
        bot = session.execute(select(Bot).where(Bot.id == chat_session.bot_id)).scalar_one_or_none()
        timeout = bot.agent_timeout_seconds if bot else 120

        session.commit()

        # Trigger email notification
        if bot and bot.notification_email and bot.email_on_handoff:
            lead_info = get_lead_info_by_session(session, request.session_id)
            contact = None
            if lead_info:
                contact = {"name": lead_info.name, "email": lead_info.email, "phone": lead_info.phone}
            send_handoff_request_email(bot.notification_email, bot.name, request.reason, contact)

    # Request handoff via connection manager (async)
    try:
        loop = asyncio.get_event_loop()
        loop.create_task(manager.request_handoff(request.session_id, timeout))
    except RuntimeError:
        # No running event loop (sync context)
        pass

    return {"success": True, "status": "waiting"}


@router.get("/queue")
def get_queue(client: Client = Depends(get_current_client)):
    """Get the current waiting queue with visitor info."""
    queue_ids = manager.get_queue()
    queue_items = []

    with get_session() as session:
        for sid in queue_ids:
            chat_session = session.execute(select(ChatSession).where(ChatSession.id == sid)).scalar_one_or_none()
            if chat_session:
                lead_info = get_lead_info_by_session(session, sid)
                queue_items.append(
                    {
                        "session_id": sid,
                        "name": lead_info.name if lead_info else None,
                        "email": lead_info.email if lead_info else None,
                        "reason": chat_session.handoff_reason,
                        "location": chat_session.location,
                        "device": chat_session.device,
                        "created_at": chat_session.created_at.isoformat() if chat_session.created_at else None,
                    }
                )

    return {"queue": queue_items, "count": len(queue_items)}


@router.post("/accept/{session_id}")
def accept_chat(session_id: str, client: Client = Depends(get_current_client)):
    """Agent accepts a waiting chat."""
    import asyncio

    with get_session() as session:
        # Get or create agent
        agent = session.execute(
            select(Agent).where(Agent.client_id == client.id, Agent.is_online.is_(True)).limit(1)
        ).scalar_one_or_none()

        if not agent:
            agent = session.execute(select(Agent).where(Agent.client_id == client.id).limit(1)).scalar_one_or_none()

        if not agent:
            raise HTTPException(status_code=400, detail="No agent profile found. Open Live Chat first.")

        # Update session
        chat_session = session.execute(select(ChatSession).where(ChatSession.id == session_id)).scalar_one_or_none()
        if not chat_session:
            raise HTTPException(status_code=404, detail="Session not found")

        chat_session.status = "live"
        chat_session.assigned_agent_id = agent.id
        session.commit()

        agent_name = agent.name

    try:
        loop = asyncio.get_event_loop()
        loop.create_task(manager.accept_chat(session_id, agent.id, agent_name))
    except RuntimeError:
        pass

    return {"success": True, "status": "live", "agent_name": agent_name}


@router.post("/close/{session_id}")
def close_chat(session_id: str, client: Client = Depends(get_current_client)):
    """Agent closes a live chat."""
    import asyncio

    with get_session() as session:
        chat_session = session.execute(select(ChatSession).where(ChatSession.id == session_id)).scalar_one_or_none()
        if not chat_session:
            raise HTTPException(status_code=404, detail="Session not found")

        bot = session.execute(select(Bot).where(Bot.id == chat_session.bot_id)).scalar_one_or_none()
        chat_session.status = "bot"
        chat_session.assigned_agent_id = None
        session.commit()

    try:
        loop = asyncio.get_event_loop()
        loop.create_task(manager.close_chat(session_id, bot.name if bot else "AI Assistant"))
    except RuntimeError:
        pass

    return {"success": True, "status": "bot"}


@router.post("/status")
def toggle_agent_status(client: Client = Depends(get_current_client)):
    """Toggle agent online/offline status."""
    with get_session() as session:
        agent = session.execute(select(Agent).where(Agent.client_id == client.id).limit(1)).scalar_one_or_none()

        if not agent:
            agent = Agent(client_id=client.id, name=client.name, email=client.email, is_online=True)
            session.add(agent)
            session.commit()
            session.refresh(agent)
            return {"is_online": True, "agent_name": agent.name}

        agent.is_online = not agent.is_online
        session.commit()
        return {"is_online": agent.is_online, "agent_name": agent.name}
