"""Operator management, department CRUD, and live chat REST endpoints."""

import asyncio
import logging
import uuid

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile, status
from pydantic import BaseModel, field_validator
from sqlalchemy import func, select, update

from app.api.auth import get_current_bot, get_current_client_or_operator
from app.core.security import get_password_hash
from app.db.models import Bot, ChatAuditLog, ChatMessage, ChatSession, Department, Operator
from app.db.repository import get_lead_info_by_session
from app.db.session import get_session
from app.services.email_service import send_handoff_request_email
from app.services.live_chat_service import manager

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/operators", tags=["operators"])


def _require_team_management_access(auth: dict) -> None:
    """Only workspace owners, admins, and direct client logins can manage operators/departments."""
    if auth["type"] == "client":
        return
    if getattr(auth["entity"], "role", "operator") not in {"owner", "admin"}:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You do not have permission to manage team members.",
        )


# Role hierarchy: higher index = higher privilege.
_ROLE_RANK = {"operator": 0, "admin": 1, "owner": 2}


def _prevent_role_escalation(auth: dict, target_role: str) -> None:
    """Block an operator from assigning a role higher than their own.

    Direct client logins (auth type "client") are unrestricted — they are the
    workspace owner by definition.  Operator-authenticated callers may only
    assign roles up to their own level (e.g. an admin cannot create an owner).
    """
    if auth["type"] == "client":
        return
    caller_role = getattr(auth["entity"], "role", "operator")
    if _ROLE_RANK.get(target_role, -1) > _ROLE_RANK.get(caller_role, 0):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"You cannot assign the '{target_role}' role — it exceeds your own privilege level.",
        )


# ── Request / Response Models ──


class HandoffRequest(BaseModel):
    session_id: str
    reason: str | None = None
    department_id: int | None = None


class CreateOperatorRequest(BaseModel):
    name: str
    email: str
    password: str
    role: str = "operator"
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
        if v not in ("owner", "admin", "operator"):
            raise ValueError("Role must be owner, admin, or operator.")
        return v


class UpdateOperatorRequest(BaseModel):
    name: str | None = None
    email: str | None = None
    role: str | None = None
    department_id: int | None = None
    avatar_url: str | None = None
    max_concurrent_chats: int | None = None
    notification_preferences: dict | None = None

    @field_validator("role")
    @classmethod
    def valid_role(cls, v):
        if v is None:
            return v
        if v not in ("owner", "admin", "operator"):
            raise ValueError("Role must be owner, admin, or operator.")
        return v

    @field_validator("email")
    @classmethod
    def valid_email(cls, v):
        if v is None:
            return v
        import re

        v = v.strip().lower()
        pattern = r"^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$"
        if not re.match(pattern, v):
            raise ValueError("Please enter a valid email address.")
        return v


class CreateDepartmentRequest(BaseModel):
    name: str
    description: str | None = None


class UpdateDepartmentRequest(BaseModel):
    name: str | None = None
    description: str | None = None


class AcceptChatRequest(BaseModel):
    operator_id: int | None = None


# ── Department Endpoints ──


@router.get("/departments")
def list_departments(auth=Depends(get_current_client_or_operator)):
    """List all departments for the authenticated client/operator."""
    client_id = auth["client_id"]
    with get_session() as session:
        departments = (
            session.execute(select(Department).where(Department.client_id == client_id).order_by(Department.id))
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
def create_department(request: CreateDepartmentRequest, auth=Depends(get_current_client_or_operator)):
    """Create a new department."""
    _require_team_management_access(auth)
    with get_session() as session:
        dept = Department(
            client_id=auth["client_id"],
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
    department_id: int, request: UpdateDepartmentRequest, auth=Depends(get_current_client_or_operator)
):
    """Update a department."""
    _require_team_management_access(auth)
    with get_session() as session:
        dept = session.execute(
            select(Department).where(Department.id == department_id, Department.client_id == auth["client_id"])
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
def delete_department(department_id: int, auth=Depends(get_current_client_or_operator)):
    """Delete a department. Operators in this department are moved to no department."""
    _require_team_management_access(auth)
    with get_session() as session:
        dept = session.execute(
            select(Department).where(Department.id == department_id, Department.client_id == auth["client_id"])
        ).scalar_one_or_none()
        if not dept:
            raise HTTPException(status_code=404, detail="Department not found.")

        # Unassign operators from this department
        operators = session.execute(select(Operator).where(Operator.department_id == department_id)).scalars().all()
        for op in operators:
            op.department_id = None

        # Capture name before commit to avoid DetachedInstanceError
        dept_name = dept.name
        session.delete(dept)
        session.commit()
        return {"success": True, "message": f"Department '{dept_name}' deleted."}


# ── Operator CRUD Endpoints ──


@router.get("")
def list_operators(auth=Depends(get_current_client_or_operator)):
    """List all operators for the authenticated client/operator."""
    client_id = auth["client_id"]
    with get_session() as session:
        operators = (
            session.execute(select(Operator).where(Operator.client_id == client_id).order_by(Operator.id))
            .scalars()
            .all()
        )

        # Build department name lookup
        dept_ids = {a.department_id for a in operators if a.department_id}
        dept_names = {}
        if dept_ids:
            depts = session.execute(select(Department).where(Department.id.in_(dept_ids))).scalars().all()
            dept_names = {d.id: d.name for d in depts}

        # Count active sessions per operator
        result = []
        for a in operators:
            active_count = session.execute(
                select(func.count())
                .select_from(ChatSession)
                .where(ChatSession.assigned_operator_id == a.id, ChatSession.status == "live")
            ).scalar()

            result.append(
                {
                    "id": a.id,
                    "name": a.name,
                    "email": a.email,
                    "role": a.role,
                    "department_id": a.department_id,
                    "department_name": dept_names.get(a.department_id),
                    "is_online": a.is_online,
                    "avatar_url": a.avatar_url,
                    "max_concurrent_chats": a.max_concurrent_chats,
                    "active_chats": active_count,
                    "last_seen_at": a.last_seen_at.isoformat() if a.last_seen_at else None,
                    "created_at": a.created_at.isoformat() if a.created_at else None,
                }
            )

        return {"operators": result}


@router.post("/create")
def create_operator(request: CreateOperatorRequest, auth=Depends(get_current_client_or_operator)):
    """Create a new operator with login credentials."""
    _require_team_management_access(auth)
    _prevent_role_escalation(auth, request.role)
    client_id = auth["client_id"]

    # ── Plan enforcement: check live_chat feature and operator limit ──
    from app.services.usage_service import enforce_feature

    with get_session() as db:
        enforce_feature(db, client_id, "live_chat")
        db.commit()

    with get_session() as session:
        # Check for duplicate email — scoped to this workspace only
        existing = session.execute(
            select(Operator).where(Operator.email == request.email, Operator.client_id == client_id)
        ).scalar_one_or_none()
        if existing:
            raise HTTPException(status_code=409, detail="An operator with this email already exists.")

        # Auto-create default "General" department if none exists
        dept_count = session.execute(
            select(func.count()).select_from(Department).where(Department.client_id == client_id)
        ).scalar()
        if dept_count == 0:
            general_dept = Department(client_id=client_id, name="General", description="Default department")
            session.add(general_dept)
            session.flush()
            default_dept_id = general_dept.id
        else:
            default_dept_id = None

        operator = Operator(
            client_id=client_id,
            name=request.name.strip(),
            email=request.email,
            hashed_password=get_password_hash(request.password),
            operator_api_key=uuid.uuid4().hex,
            role=request.role,
            department_id=request.department_id or default_dept_id,
        )
        session.add(operator)
        session.commit()
        session.refresh(operator)

        logger.info(f"Operator created: {operator.id} ({operator.name}) for client {client_id}")

        return {
            "id": operator.id,
            "name": operator.name,
            "email": operator.email,
            "role": operator.role,
            "department_id": operator.department_id,
        }


@router.patch("/{operator_id}")
async def update_operator(
    operator_id: int, request: UpdateOperatorRequest, auth=Depends(get_current_client_or_operator)
):
    """Update an operator's profile (owner/admin only)."""
    _require_team_management_access(auth)
    if request.role is not None:
        _prevent_role_escalation(auth, request.role)
    department_changed = False
    new_department_id = None

    with get_session() as session:
        operator = session.execute(
            select(Operator).where(Operator.id == operator_id, Operator.client_id == auth["client_id"])
        ).scalar_one_or_none()
        if not operator:
            raise HTTPException(status_code=404, detail="Operator not found.")

        if request.name is not None:
            operator.name = request.name.strip()
        if request.email is not None:
            # Validate workspace-scoped uniqueness, excluding this operator
            dup = session.execute(
                select(Operator).where(
                    Operator.email == request.email,
                    Operator.client_id == auth["client_id"],
                    Operator.id != operator_id,
                )
            ).scalar_one_or_none()
            if dup:
                raise HTTPException(status_code=409, detail="An operator with this email already exists.")
            operator.email = request.email  # already normalized by field_validator
        if request.role is not None:
            # Only workspace owners (client login or owner-role operators) can
            # assign the "owner" role.  Admins can assign admin/operator but not
            # escalate to owner.
            if request.role == "owner" and auth["type"] != "client":
                caller_role = getattr(auth["entity"], "role", "operator")
                if caller_role != "owner":
                    raise HTTPException(
                        status_code=status.HTTP_403_FORBIDDEN,
                        detail="Only workspace owners can assign the owner role.",
                    )
            operator.role = request.role
        if request.department_id is not None:
            # Track department change for dynamic WS update
            if operator.department_id != request.department_id:
                department_changed = True
                new_department_id = request.department_id
            operator.department_id = request.department_id
        if request.avatar_url is not None:
            operator.avatar_url = request.avatar_url
        if request.max_concurrent_chats is not None:
            operator.max_concurrent_chats = request.max_concurrent_chats
        if request.notification_preferences is not None:
            operator.notification_preferences = request.notification_preferences

        session.commit()

    # Update operator's department in WS manager without triggering reconnect
    if department_changed:
        await manager.update_operator_department(operator_id, new_department_id)

    return {"success": True, "message": f"Operator '{operator.name}' updated."}


@router.delete("/{operator_id}")
def delete_operator(operator_id: int, auth=Depends(get_current_client_or_operator)):
    """Delete an operator (owner/admin only)."""
    _require_team_management_access(auth)
    # Prevent operators from deleting their own account
    if auth["type"] == "operator" and auth["operator_id"] == operator_id:
        raise HTTPException(status_code=400, detail="You cannot delete your own account.")
    with get_session() as session:
        operator = session.execute(
            select(Operator).where(Operator.id == operator_id, Operator.client_id == auth["client_id"])
        ).scalar_one_or_none()
        if not operator:
            raise HTTPException(status_code=404, detail="Operator not found.")

        # Unassign active sessions
        active_sessions = (
            session.execute(select(ChatSession).where(ChatSession.assigned_operator_id == operator_id)).scalars().all()
        )
        for cs in active_sessions:
            cs.assigned_operator_id = None
            cs.status = "bot"

        # Capture name before commit to avoid DetachedInstanceError
        op_name = operator.name
        session.delete(operator)
        session.commit()
        return {"success": True, "message": f"Operator '{op_name}' deleted."}


# ── Live Chat Flow Endpoints ──


@router.post("/handoff")
async def request_handoff(request: HandoffRequest, bot: Bot = Depends(get_current_bot)):
    """Called by the widget (via REST) to initiate a handoff request."""
    with get_session() as session:
        chat_session = session.execute(
            select(ChatSession).where(ChatSession.id == request.session_id)
        ).scalar_one_or_none()

        # Create the session if the visitor hasn't chatted yet (direct handoff)
        if not chat_session:
            chat_session = ChatSession(
                id=request.session_id,
                bot_id=bot.id,
                client_id=bot.client_id,
            )
            session.add(chat_session)
            session.flush()

        # Update session status
        chat_session.status = "waiting"
        chat_session.handoff_reason = (
            request.reason.replace("<", "&lt;").replace(">", "&gt;") if request.reason else None
        )
        if request.department_id:
            chat_session.department_id = request.department_id

        # Get bot for timeout setting (re-fetch within this session)
        db_bot = session.execute(select(Bot).where(Bot.id == chat_session.bot_id)).scalar_one_or_none()
        timeout = db_bot.operator_timeout_seconds if db_bot else 120

        # Audit log — handoff requested
        session.add(
            ChatAuditLog(
                session_id=request.session_id,
                action="handoff_requested",
                details={"reason": request.reason, "department_id": request.department_id},
            )
        )
        session.commit()

        # Get visitor name for queue display
        lead_info = get_lead_info_by_session(session, request.session_id)
        visitor_name = lead_info.name if lead_info else None

        # Fire webhook for handoff_requested event
        from app.services.webhook_service import fire_webhook

        webhook_data = {
            "session_id": request.session_id,
            "reason": request.reason,
            "department_id": request.department_id,
        }
        if lead_info:
            webhook_data["contact"] = {
                "name": lead_info.name,
                "email": lead_info.email,
                "phone": lead_info.phone,
            }
        fire_webhook(bot.id, "handoff_requested", webhook_data)

        # Trigger email notification (multi-recipient)
        if bot and bot.email_on_handoff:
            from app.services.email_service import get_notification_recipients

            recipients = get_notification_recipients(bot, "handoff_request")
            if recipients:
                contact = None
                if lead_info:
                    contact = {"name": lead_info.name, "email": lead_info.email, "phone": lead_info.phone}
                reply_to = getattr(bot, "reply_to_email", None)
                for recipient in recipients:
                    send_handoff_request_email(recipient, bot.name, request.reason, contact, reply_to=reply_to)

    # Schedule in-memory queue update as a background task so the REST response
    # is not held up by WebSocket sends. asyncio.create_task() is safe here
    # because async endpoints run directly on the event loop.
    asyncio.create_task(
        manager.request_handoff(
            request.session_id,
            timeout,
            request.department_id,
            visitor_name=visitor_name,
            reason=request.reason,
        )
    )

    return {"success": True, "status": "waiting"}


@router.get("/queue")
def get_queue(auth=Depends(get_current_client_or_operator)):
    """Get waiting chat queue from DB source-of-truth with visitor info."""
    client_id = auth["client_id"]
    operator_dept_id = auth["entity"].department_id if auth["type"] == "operator" else None
    queue_items = []

    with get_session() as session:
        waiting_sessions = session.execute(
            select(ChatSession, Bot)
            .join(Bot, ChatSession.bot_id == Bot.id)
            .where(Bot.client_id == client_id, ChatSession.status == "waiting")
            .order_by(ChatSession.created_at.asc())
        ).all()

        for chat_session, _ in waiting_sessions:
            # Department filtering for operator-scoped queues
            if operator_dept_id and chat_session.department_id and chat_session.department_id != operator_dept_id:
                continue

            lead_info = get_lead_info_by_session(session, chat_session.id)
            queue_items.append(
                {
                    "session_id": chat_session.id,
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
async def accept_chat(
    session_id: str,
    request: AcceptChatRequest | None = None,
    auth=Depends(get_current_client_or_operator),
):
    """Operator accepts a waiting chat."""
    with get_session() as session:
        # Resolve the operator
        if auth["type"] == "operator":
            operator = session.execute(select(Operator).where(Operator.id == auth["operator_id"])).scalar_one_or_none()
        elif request and request.operator_id:
            operator = session.execute(
                select(Operator).where(Operator.id == request.operator_id, Operator.client_id == auth["client_id"])
            ).scalar_one_or_none()
        else:
            # Fallback for client/owner auth: find the owner operator record.
            # Prefer the role='owner' record to avoid ambiguity with sub-operators.
            operator = session.execute(
                select(Operator)
                .where(
                    Operator.client_id == auth["client_id"],
                    Operator.role == "owner",
                )
                .limit(1)
            ).scalar_one_or_none()
            if not operator:
                # Last resort: any operator for this client that is online
                operator = session.execute(
                    select(Operator)
                    .where(
                        Operator.client_id == auth["client_id"],
                        Operator.is_online.is_(True),
                    )
                    .limit(1)
                ).scalar_one_or_none()

        if not operator:
            raise HTTPException(status_code=400, detail="No operator profile found.")

        # Enforce max concurrent chats
        if operator.max_concurrent_chats:
            active_count = session.execute(
                select(func.count())
                .select_from(ChatSession)
                .where(ChatSession.assigned_operator_id == operator.id, ChatSession.status == "live")
            ).scalar()
            if active_count >= operator.max_concurrent_chats:
                raise HTTPException(
                    status_code=429,
                    detail=f"Operator already at max capacity ({operator.max_concurrent_chats} chats).",
                )

        # DB-level race condition guard: atomically claim the session only if still waiting.
        # Using UPDATE ... WHERE status='waiting' ensures only one operator wins the race.
        result = session.execute(
            update(ChatSession)
            .where(ChatSession.id == session_id, ChatSession.status == "waiting")
            .values(status="live", assigned_operator_id=operator.id)
            .returning(ChatSession.id)
        )
        claimed = result.scalar_one_or_none()
        if not claimed:
            # Either session doesn't exist or was already accepted by another operator
            existing = session.execute(select(ChatSession).where(ChatSession.id == session_id)).scalar_one_or_none()
            if not existing:
                raise HTTPException(status_code=404, detail="Session not found")
            raise HTTPException(status_code=409, detail="Chat was already accepted by another operator")

        # Audit log — chat accepted
        session.add(
            ChatAuditLog(
                session_id=session_id,
                operator_id=operator.id,
                action="accepted",
            )
        )
        session.commit()
        operator_name = operator.name
        operator_id = operator.id

    accepted = await manager.accept_chat(session_id, operator_id, operator_name)
    if not accepted:
        raise HTTPException(status_code=409, detail="Chat was already accepted by another operator")

    return {"success": True, "status": "live", "operator_name": operator_name}


@router.post("/close/{session_id}")
async def close_chat(session_id: str, auth=Depends(get_current_client_or_operator)):
    """Operator closes a live chat."""
    with get_session() as session:
        chat_session = session.execute(select(ChatSession).where(ChatSession.id == session_id)).scalar_one_or_none()
        if not chat_session:
            raise HTTPException(status_code=404, detail="Session not found")

        bot = session.execute(select(Bot).where(Bot.id == chat_session.bot_id)).scalar_one_or_none()
        if not bot or bot.client_id != auth["client_id"]:
            raise HTTPException(status_code=403, detail="Access denied.")

        # Capture bot_name inside the session block — accessing bot.name after session.close()
        # raises DetachedInstanceError because SQLAlchemy expires objects on commit.
        bot_name = bot.name
        # Audit log — chat closed by operator
        operator_id = auth.get("operator_id") or chat_session.assigned_operator_id
        session.add(
            ChatAuditLog(
                session_id=session_id,
                operator_id=operator_id,
                action="closed",
            )
        )
        chat_session.status = "bot"
        chat_session.assigned_operator_id = None
        bot_id = bot.id
        session.commit()

    # Fire webhook for chat_closed event
    from app.services.webhook_service import fire_webhook

    fire_webhook(
        bot_id,
        "chat_closed",
        {
            "session_id": session_id,
            "operator_id": operator_id,
        },
    )

    asyncio.create_task(manager.close_chat(session_id, bot_name))

    return {"success": True, "status": "bot"}


class TransferRequest(BaseModel):
    target_operator_id: int | None = None
    target_department_id: int | None = None


@router.post("/transfer/{session_id}")
async def transfer_chat(session_id: str, request: TransferRequest, auth=Depends(get_current_client_or_operator)):
    """Transfer a live chat to another operator or department."""
    if not request.target_operator_id and not request.target_department_id:
        raise HTTPException(status_code=400, detail="Must specify target_operator_id or target_department_id.")

    with get_session() as session:
        chat_session = session.execute(select(ChatSession).where(ChatSession.id == session_id)).scalar_one_or_none()
        if not chat_session:
            raise HTTPException(status_code=404, detail="Session not found.")
        if chat_session.status != "live":
            raise HTTPException(status_code=400, detail="Session is not in live chat mode.")

        # Verify ownership
        bot = session.execute(select(Bot).where(Bot.id == chat_session.bot_id)).scalar_one_or_none()
        if not bot or bot.client_id != auth["client_id"]:
            raise HTTPException(status_code=403, detail="Access denied.")

        old_operator_id = chat_session.assigned_operator_id

        if request.target_operator_id:
            target_operator = session.execute(
                select(Operator).where(
                    Operator.id == request.target_operator_id, Operator.client_id == auth["client_id"]
                )
            ).scalar_one_or_none()
            if not target_operator:
                raise HTTPException(status_code=404, detail="Target operator not found.")

            chat_session.assigned_operator_id = target_operator.id
            if target_operator.department_id:
                chat_session.department_id = target_operator.department_id
            # Audit log — transferred to operator
            session.add(
                ChatAuditLog(
                    session_id=session_id,
                    operator_id=old_operator_id,
                    action="transferred",
                    details={"transferred_to_operator_id": target_operator.id},
                )
            )
            session.commit()

            target_name = target_operator.name

            # Notify via WebSocket
            asyncio.create_task(manager.transfer_chat(session_id, old_operator_id, target_operator.id, target_name))

            return {"success": True, "transferred_to": target_name, "operator_id": target_operator.id}

        # Transfer to department: verify ownership then put back in queue
        dept = session.execute(
            select(Department).where(
                Department.id == request.target_department_id,
                Department.client_id == auth["client_id"],
            )
        ).scalar_one_or_none()
        if not dept:
            raise HTTPException(status_code=404, detail="Target department not found.")

        old_operator_id = chat_session.assigned_operator_id
        chat_session.status = "waiting"
        chat_session.assigned_operator_id = None
        chat_session.department_id = request.target_department_id
        # Audit log — transferred to department
        session.add(
            ChatAuditLog(
                session_id=session_id,
                operator_id=old_operator_id,
                action="transferred",
                details={"transferred_to_department_id": request.target_department_id},
            )
        )
        session.commit()
        dept_name = dept.name

        timeout = bot.operator_timeout_seconds or 120
        # Notify old operator that the chat was transferred away
        if old_operator_id:
            asyncio.create_task(
                manager._send_to_operator(
                    old_operator_id,
                    {"type": "chat_transferred", "session_id": session_id, "transferred_to": dept_name},
                )
            )
        asyncio.create_task(manager.request_handoff(session_id, timeout, request.target_department_id))

        return {"success": True, "transferred_to_department": dept_name}


@router.post("/status")
def toggle_operator_status(auth=Depends(get_current_client_or_operator)):
    """Toggle operator online/offline status."""
    with get_session() as session:
        if auth["type"] == "operator":
            operator = session.execute(select(Operator).where(Operator.id == auth["operator_id"])).scalar_one_or_none()
            if not operator:
                raise HTTPException(status_code=404, detail="Operator not found.")
            operator.is_online = not operator.is_online
            session.commit()
            return {"is_online": operator.is_online, "operator_name": operator.name, "operator_id": operator.id}

        # Client: find or create the owner's operator record.
        # Filter by role='owner' to avoid matching sub-operators for the same client.
        import uuid as _uuid

        client = auth["entity"]
        operator = session.execute(
            select(Operator).where(Operator.client_id == client.id, Operator.role == "owner").limit(1)
        ).scalar_one_or_none()

        if not operator:
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
            return {"is_online": True, "operator_name": operator.name, "operator_id": operator.id}

        operator.is_online = not operator.is_online
        session.commit()
        return {"is_online": operator.is_online, "operator_name": operator.name, "operator_id": operator.id}


# ── Session Details Endpoint ──


@router.get("/session/{session_id}/details")
def get_session_details(session_id: str, auth=Depends(get_current_client_or_operator)):
    """Get full visitor/session details for the operator sidebar."""
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

        # Get assigned operator name
        operator_name = None
        if chat_session.assigned_operator_id:
            operator = session.execute(
                select(Operator).where(Operator.id == chat_session.assigned_operator_id)
            ).scalar_one_or_none()
            operator_name = operator.name if operator else None

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
            "operator_name": operator_name,
        }


# ── Public Department List (Widget) ──


@router.get("/departments/public")
def list_departments_public(bot: Bot = Depends(get_current_bot)):
    """List departments for a bot (used by widget to show department picker)."""
    with get_session() as session:
        departments = (
            session.execute(select(Department).where(Department.client_id == bot.client_id).order_by(Department.id))
            .scalars()
            .all()
        )
        return {"departments": [{"id": d.id, "name": d.name} for d in departments]}


# ── Chat File Upload ──


@router.post("/upload-chat-file")
async def upload_chat_file_route(
    session_id: str = Query(...),
    file: UploadFile = File(...),
    auth: dict = Depends(get_current_client_or_operator),
):
    """Upload a file during live chat. Returns a URL to embed in messages."""
    ALLOWED_TYPES = {"image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf", "text/plain"}
    MAX_SIZE = 10 * 1024 * 1024  # 10 MB

    if file.content_type not in ALLOWED_TYPES:
        raise HTTPException(status_code=400, detail=f"File type '{file.content_type}' is not allowed.")

    file_data = await file.read()
    if len(file_data) > MAX_SIZE:
        raise HTTPException(status_code=400, detail="File exceeds 10 MB limit.")

    # Verify session ownership
    with get_session() as session:
        chat_session = session.execute(select(ChatSession).where(ChatSession.id == session_id)).scalar_one_or_none()
        if not chat_session:
            raise HTTPException(status_code=404, detail="Session not found.")
        bot_obj = session.execute(select(Bot).where(Bot.id == chat_session.bot_id)).scalar_one_or_none()
        if not bot_obj or bot_obj.client_id != auth["client_id"]:
            raise HTTPException(status_code=403, detail="Access denied.")

    from app.services.b2_service import _build_public_url, upload_chat_file

    key = upload_chat_file(file_data, file.filename or "file", file.content_type)
    url = _build_public_url(key)

    return {"url": url, "filename": file.filename, "content_type": file.content_type, "size": len(file_data)}


# ── Post-chat visitor satisfaction rating ──


class VisitorRatingRequest(BaseModel):
    rating: int | None = None
    resolved: bool | None = None

    @field_validator("rating")
    @classmethod
    def validate_rating(cls, v: int | None) -> int | None:
        if v is not None and (v < 1 or v > 5):
            raise ValueError("Rating must be between 1 and 5")
        return v


@router.post("/sessions/{session_id}/rating")
async def submit_visitor_rating(
    session_id: str,
    body: VisitorRatingRequest,
    bot: Bot = Depends(get_current_bot),
):
    """Record a visitor's post-chat satisfaction rating and resolution status.

    Auth: X-Bot-Key header (widget). Both fields are optional — subsequent
    calls silently overwrite previous values.
    """
    if body.rating is None and body.resolved is None:
        raise HTTPException(status_code=422, detail="At least one of rating or resolved is required")
    with get_session() as session:
        chat_session = session.execute(select(ChatSession).where(ChatSession.id == session_id)).scalar_one_or_none()
        if not chat_session:
            raise HTTPException(status_code=404, detail="Session not found")
        if chat_session.bot_id != bot.id:
            raise HTTPException(status_code=403, detail="Access denied")
        if body.rating is not None:
            chat_session.visitor_rating = body.rating
        if body.resolved is not None:
            chat_session.visitor_resolved = body.resolved
        session.commit()
    return {"ok": True}
