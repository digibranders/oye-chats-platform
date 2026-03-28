"""Agent management, department CRUD, and live chat REST endpoints."""

import logging
import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, field_validator
from sqlalchemy import func, select

from app.api.auth import get_current_client, get_current_client_or_agent
from app.core.security import get_password_hash
from app.db.models import Agent, Bot, ChatMessage, ChatSession, Client, Department
from app.db.repository import get_lead_info_by_session
from app.db.session import get_session
from app.services.email_service import send_handoff_request_email
from app.services.live_chat_service import manager

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/agents", tags=["agents"])


# ── Request / Response Models ──


class HandoffRequest(BaseModel):
    session_id: str
    reason: str | None = None
    department_id: int | None = None


class CreateAgentRequest(BaseModel):
    name: str
    email: str
    password: str
    role: str = "agent"
    department_id: int | None = None

    @field_validator("name")
    @classmethod
    def name_not_empty(cls, v):
        v = v.strip()
        if len(v) < 2:
            raise ValueError("Name must be at least 2 characters.")
        return v

    @field_validator("email")
    @classmethod
    def valid_email(cls, v):
        import re

        v = v.strip().lower()
        pattern = r"^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$"
        if not re.match(pattern, v):
            raise ValueError("Please enter a valid email address.")
        return v

    @field_validator("password")
    @classmethod
    def strong_password(cls, v):
        import re

        if len(v) < 8:
            raise ValueError("Password must be at least 8 characters.")
        if not re.search(r"[A-Za-z]", v):
            raise ValueError("Password must contain at least one letter.")
        if not re.search(r"[0-9]", v):
            raise ValueError("Password must contain at least one number.")
        return v

    @field_validator("role")
    @classmethod
    def valid_role(cls, v):
        if v not in ("owner", "admin", "agent"):
            raise ValueError("Role must be owner, admin, or agent.")
        return v


class UpdateAgentRequest(BaseModel):
    name: str | None = None
    email: str | None = None
    role: str | None = None
    department_id: int | None = None
    avatar_url: str | None = None
    max_concurrent_chats: int | None = None
    notification_preferences: dict | None = None


class CreateDepartmentRequest(BaseModel):
    name: str
    description: str | None = None


class UpdateDepartmentRequest(BaseModel):
    name: str | None = None
    description: str | None = None


class AcceptChatRequest(BaseModel):
    agent_id: int | None = None


# ── Department Endpoints ──


@router.get("/departments")
def list_departments(client: Client = Depends(get_current_client)):
    """List all departments for the client."""
    with get_session() as session:
        departments = (
            session.execute(select(Department).where(Department.client_id == client.id).order_by(Department.id))
            .scalars()
            .all()
        )
        return {
            "departments": [
                {
                    "id": d.id,
                    "name": d.name,
                    "description": d.description,
                    "created_at": d.created_at.isoformat() if d.created_at else None,
                }
                for d in departments
            ]
        }


@router.post("/departments")
def create_department(request: CreateDepartmentRequest, client: Client = Depends(get_current_client)):
    """Create a new department."""
    with get_session() as session:
        dept = Department(
            client_id=client.id,
            name=request.name.strip(),
            description=request.description,
        )
        session.add(dept)
        session.commit()
        session.refresh(dept)
        return {
            "id": dept.id,
            "name": dept.name,
            "description": dept.description,
        }


@router.patch("/departments/{department_id}")
def update_department(
    department_id: int, request: UpdateDepartmentRequest, client: Client = Depends(get_current_client)
):
    """Update a department."""
    with get_session() as session:
        dept = session.execute(
            select(Department).where(Department.id == department_id, Department.client_id == client.id)
        ).scalar_one_or_none()
        if not dept:
            raise HTTPException(status_code=404, detail="Department not found.")
        if request.name is not None:
            dept.name = request.name.strip()
        if request.description is not None:
            dept.description = request.description
        session.commit()
        return {"id": dept.id, "name": dept.name, "description": dept.description}


@router.delete("/departments/{department_id}")
def delete_department(department_id: int, client: Client = Depends(get_current_client)):
    """Delete a department. Agents in this department are moved to no department."""
    with get_session() as session:
        dept = session.execute(
            select(Department).where(Department.id == department_id, Department.client_id == client.id)
        ).scalar_one_or_none()
        if not dept:
            raise HTTPException(status_code=404, detail="Department not found.")

        # Unassign agents from this department
        agents = session.execute(select(Agent).where(Agent.department_id == department_id)).scalars().all()
        for agent in agents:
            agent.department_id = None

        session.delete(dept)
        session.commit()
        return {"success": True, "message": f"Department '{dept.name}' deleted."}


# ── Agent CRUD Endpoints ──


@router.get("")
def list_agents(client: Client = Depends(get_current_client)):
    """List all agents for the client."""
    with get_session() as session:
        agents = session.execute(select(Agent).where(Agent.client_id == client.id).order_by(Agent.id)).scalars().all()

        # Count active sessions per agent
        result = []
        for a in agents:
            active_count = session.execute(
                select(func.count())
                .select_from(ChatSession)
                .where(ChatSession.assigned_agent_id == a.id, ChatSession.status == "live")
            ).scalar()

            result.append(
                {
                    "id": a.id,
                    "name": a.name,
                    "email": a.email,
                    "role": a.role,
                    "department_id": a.department_id,
                    "is_online": a.is_online,
                    "avatar_url": a.avatar_url,
                    "max_concurrent_chats": a.max_concurrent_chats,
                    "active_chats": active_count,
                    "last_seen_at": a.last_seen_at.isoformat() if a.last_seen_at else None,
                    "created_at": a.created_at.isoformat() if a.created_at else None,
                }
            )

        return {"agents": result}


@router.post("/create")
def create_agent(request: CreateAgentRequest, client: Client = Depends(get_current_client)):
    """Create a new agent with login credentials."""
    with get_session() as session:
        # Check for duplicate email
        existing = session.execute(select(Agent).where(Agent.email == request.email)).scalar_one_or_none()
        if existing:
            raise HTTPException(status_code=409, detail="An agent with this email already exists.")

        # Auto-create default "General" department if none exists
        dept_count = session.execute(
            select(func.count()).select_from(Department).where(Department.client_id == client.id)
        ).scalar()
        if dept_count == 0:
            general_dept = Department(client_id=client.id, name="General", description="Default department")
            session.add(general_dept)
            session.flush()
            default_dept_id = general_dept.id
        else:
            default_dept_id = None

        agent = Agent(
            client_id=client.id,
            name=request.name.strip(),
            email=request.email,
            hashed_password=get_password_hash(request.password),
            agent_api_key=uuid.uuid4().hex,
            role=request.role,
            department_id=request.department_id or default_dept_id,
        )
        session.add(agent)
        session.commit()
        session.refresh(agent)

        logger.info(f"Agent created: {agent.id} ({agent.name}) for client {client.id}")

        return {
            "id": agent.id,
            "name": agent.name,
            "email": agent.email,
            "role": agent.role,
            "department_id": agent.department_id,
        }


@router.patch("/{agent_id}")
def update_agent(agent_id: int, request: UpdateAgentRequest, client: Client = Depends(get_current_client)):
    """Update an agent's profile (admin only)."""
    with get_session() as session:
        agent = session.execute(
            select(Agent).where(Agent.id == agent_id, Agent.client_id == client.id)
        ).scalar_one_or_none()
        if not agent:
            raise HTTPException(status_code=404, detail="Agent not found.")

        if request.name is not None:
            agent.name = request.name.strip()
        if request.email is not None:
            agent.email = request.email.strip().lower()
        if request.role is not None:
            agent.role = request.role
        if request.department_id is not None:
            agent.department_id = request.department_id
        if request.avatar_url is not None:
            agent.avatar_url = request.avatar_url
        if request.max_concurrent_chats is not None:
            agent.max_concurrent_chats = request.max_concurrent_chats
        if request.notification_preferences is not None:
            agent.notification_preferences = request.notification_preferences

        session.commit()
        return {"success": True, "message": f"Agent '{agent.name}' updated."}


@router.delete("/{agent_id}")
def delete_agent(agent_id: int, client: Client = Depends(get_current_client)):
    """Delete an agent."""
    with get_session() as session:
        agent = session.execute(
            select(Agent).where(Agent.id == agent_id, Agent.client_id == client.id)
        ).scalar_one_or_none()
        if not agent:
            raise HTTPException(status_code=404, detail="Agent not found.")

        # Unassign active sessions
        active_sessions = (
            session.execute(select(ChatSession).where(ChatSession.assigned_agent_id == agent_id)).scalars().all()
        )
        for cs in active_sessions:
            cs.assigned_agent_id = None
            cs.status = "bot"

        session.delete(agent)
        session.commit()
        return {"success": True, "message": f"Agent '{agent.name}' deleted."}


# ── Live Chat Flow Endpoints ──


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
        if request.department_id:
            chat_session.department_id = request.department_id

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
        loop.create_task(manager.request_handoff(request.session_id, timeout, request.department_id))
    except RuntimeError:
        pass

    return {"success": True, "status": "waiting"}


@router.get("/queue")
def get_queue(auth=Depends(get_current_client_or_agent)):
    """Get the current waiting queue with visitor info."""
    client_id = auth["client_id"]
    agent_dept_id = None

    # If agent, filter by their department
    if auth["type"] == "agent":
        agent_dept_id = auth["entity"].department_id

    queue_ids = manager.get_queue()
    queue_items = []

    with get_session() as session:
        for sid in queue_ids:
            chat_session = session.execute(select(ChatSession).where(ChatSession.id == sid)).scalar_one_or_none()

            if not chat_session:
                continue

            # Verify this session belongs to the same client
            bot = session.execute(select(Bot).where(Bot.id == chat_session.bot_id)).scalar_one_or_none()
            if not bot or bot.client_id != client_id:
                continue

            # If agent has a department, only show their department's queue
            if agent_dept_id and chat_session.department_id and chat_session.department_id != agent_dept_id:
                continue

            lead_info = get_lead_info_by_session(session, sid)
            queue_items.append(
                {
                    "session_id": sid,
                    "name": lead_info.name if lead_info else None,
                    "email": lead_info.email if lead_info else None,
                    "reason": chat_session.handoff_reason,
                    "location": chat_session.location,
                    "device": chat_session.device,
                    "department_id": chat_session.department_id,
                    "created_at": chat_session.created_at.isoformat() if chat_session.created_at else None,
                }
            )

    return {"queue": queue_items, "count": len(queue_items)}


@router.post("/accept/{session_id}")
def accept_chat(
    session_id: str,
    request: AcceptChatRequest | None = None,
    auth=Depends(get_current_client_or_agent),
):
    """Agent accepts a waiting chat."""
    import asyncio

    with get_session() as session:
        # Resolve the agent
        if auth["type"] == "agent":
            agent = session.execute(select(Agent).where(Agent.id == auth["agent_id"])).scalar_one_or_none()
        elif request and request.agent_id:
            agent = session.execute(
                select(Agent).where(Agent.id == request.agent_id, Agent.client_id == auth["client_id"])
            ).scalar_one_or_none()
        else:
            # Fallback: first online agent for this client
            agent = session.execute(
                select(Agent).where(Agent.client_id == auth["client_id"], Agent.is_online.is_(True)).limit(1)
            ).scalar_one_or_none()
            if not agent:
                agent = session.execute(
                    select(Agent).where(Agent.client_id == auth["client_id"]).limit(1)
                ).scalar_one_or_none()

        if not agent:
            raise HTTPException(status_code=400, detail="No agent profile found.")

        # Update session
        chat_session = session.execute(select(ChatSession).where(ChatSession.id == session_id)).scalar_one_or_none()
        if not chat_session:
            raise HTTPException(status_code=404, detail="Session not found")

        chat_session.status = "live"
        chat_session.assigned_agent_id = agent.id
        session.commit()

        agent_name = agent.name
        agent_id = agent.id

    try:
        loop = asyncio.get_event_loop()
        loop.create_task(manager.accept_chat(session_id, agent_id, agent_name))
    except RuntimeError:
        pass

    return {"success": True, "status": "live", "agent_name": agent_name}


@router.post("/close/{session_id}")
def close_chat(session_id: str, auth=Depends(get_current_client_or_agent)):
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
def toggle_agent_status(auth=Depends(get_current_client_or_agent)):
    """Toggle agent online/offline status."""
    with get_session() as session:
        if auth["type"] == "agent":
            agent = session.execute(select(Agent).where(Agent.id == auth["agent_id"])).scalar_one_or_none()
            if not agent:
                raise HTTPException(status_code=404, detail="Agent not found.")
            agent.is_online = not agent.is_online
            session.commit()
            return {"is_online": agent.is_online, "agent_name": agent.name, "agent_id": agent.id}

        # Client: backward compat — find or create agent from client profile
        client = auth["entity"]
        agent = session.execute(select(Agent).where(Agent.client_id == client.id).limit(1)).scalar_one_or_none()

        if not agent:
            agent = Agent(client_id=client.id, name=client.name, email=client.email, is_online=True, role="owner")
            session.add(agent)
            session.commit()
            session.refresh(agent)
            return {"is_online": True, "agent_name": agent.name, "agent_id": agent.id}

        agent.is_online = not agent.is_online
        session.commit()
        return {"is_online": agent.is_online, "agent_name": agent.name, "agent_id": agent.id}


# ── Session Details Endpoint ──


@router.get("/session/{session_id}/details")
def get_session_details(session_id: str, auth=Depends(get_current_client_or_agent)):
    """Get full visitor/session details for the agent sidebar."""
    with get_session() as session:
        chat_session = session.execute(select(ChatSession).where(ChatSession.id == session_id)).scalar_one_or_none()
        if not chat_session:
            raise HTTPException(status_code=404, detail="Session not found")

        # Verify ownership
        bot = session.execute(select(Bot).where(Bot.id == chat_session.bot_id)).scalar_one_or_none()
        if not bot or bot.client_id != auth["client_id"]:
            raise HTTPException(status_code=403, detail="Access denied.")

        lead_info = get_lead_info_by_session(session, session_id)
        message_count = session.execute(
            select(func.count()).select_from(ChatMessage).where(ChatMessage.session_id == session_id)
        ).scalar()

        # Get department name
        dept_name = None
        if chat_session.department_id:
            dept = session.execute(
                select(Department).where(Department.id == chat_session.department_id)
            ).scalar_one_or_none()
            dept_name = dept.name if dept else None

        # Get assigned agent name
        agent_name = None
        if chat_session.assigned_agent_id:
            agent = session.execute(
                select(Agent).where(Agent.id == chat_session.assigned_agent_id)
            ).scalar_one_or_none()
            agent_name = agent.name if agent else None

        return {
            "session_id": session_id,
            "status": chat_session.status,
            "location": chat_session.location,
            "device": chat_session.device,
            "visitor_metadata": chat_session.visitor_metadata,
            "handoff_reason": chat_session.handoff_reason,
            "created_at": chat_session.created_at.isoformat() if chat_session.created_at else None,
            "last_active_at": chat_session.last_active_at.isoformat() if chat_session.last_active_at else None,
            "bant": {
                "need": chat_session.bant_need,
                "timeline": chat_session.bant_timeline,
                "authority": chat_session.bant_authority,
                "budget": chat_session.bant_budget,
            },
            "lead_info": {
                "name": lead_info.name if lead_info else None,
                "email": lead_info.email if lead_info else None,
                "phone": lead_info.phone if lead_info else None,
                "company": lead_info.company if lead_info else None,
            }
            if lead_info
            else None,
            "message_count": message_count,
            "bot_name": bot.name,
            "department_name": dept_name,
            "agent_name": agent_name,
        }


# ── Public Department List (Widget) ──


@router.get("/departments/public")
def list_departments_public(bot_key: str = Query(...)):
    """List departments for a bot (used by widget to show department picker)."""
    with get_session() as session:
        bot = session.execute(select(Bot).where(Bot.bot_key == bot_key, Bot.is_active.is_(True))).scalar_one_or_none()
        if not bot:
            raise HTTPException(status_code=404, detail="Bot not found.")

        departments = (
            session.execute(select(Department).where(Department.client_id == bot.client_id).order_by(Department.id))
            .scalars()
            .all()
        )
        return {"departments": [{"id": d.id, "name": d.name} for d in departments]}
