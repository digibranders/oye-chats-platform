"""Operator management, department CRUD, and live chat REST endpoints."""

import asyncio
import logging
import uuid

from fastapi import APIRouter, Depends, File, HTTPException, Query, Request, UploadFile, status
from pydantic import BaseModel, field_validator
from sqlalchemy import func, or_, select, update

from app.api.auth import get_current_bot, get_current_client_or_operator
from app.core.security import get_password_hash
from app.db.models import BANTSignal, Bot, ChatAuditLog, ChatMessage, ChatSession, Department, Operator
from app.db.repository import get_lead_info_by_session
from app.db.session import get_session
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
    # Per-department business hours — same JSONB shape as bot.business_hours.
    # Sentinel ``{}`` (empty dict) clears the schedule (always open).
    business_hours: dict | None = None


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
                    "business_hours": d.business_hours,
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
        if request.business_hours is not None:
            # Empty dict means "clear" — treat as None in the DB so the
            # resolver short-circuits to "always open" cleanly.
            dept.business_hours = request.business_hours or None
            # Invalidate state caches for every bot in this workspace —
            # otherwise visitors keep seeing the stale "out of hours" UI
            # for up to 5 seconds after the admin saves.
            from app.db.models import Bot
            from app.services.live_chat_availability_service import invalidate as invalidate_state

            bot_ids = (
                session.execute(
                    select(Bot.id).where(
                        Bot.client_id == auth["client_id"],
                        Bot.is_active.is_(True),
                    )
                )
                .scalars()
                .all()
            )
            for bot_id in bot_ids:
                invalidate_state(bot_id)
        session.commit()
        return {
            "id": dept.id,
            "name": dept.name,
            "description": dept.description,
            "business_hours": dept.business_hours,
        }


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

    # ── Plan enforcement: live_chat feature + operator count limit ──
    # ``enforce_feature`` is the legacy gate; the new entitlements service
    # adds quantitative limit checks (e.g. Starter = 1 operator included).
    from app.services.plan_entitlements_service import UNLIMITED, get_entitlements
    from app.services.plan_service import enforce_feature

    with get_session() as db:
        enforce_feature(db, client_id, "live_chat")
        entitlements = get_entitlements(client_id, db, include_usage=True)
        operator_limit = entitlements.limit_for("operators")
        if operator_limit != UNLIMITED:
            current_operators = int(entitlements.usage.get("operators", 0))
            if current_operators >= operator_limit:
                raise HTTPException(
                    status_code=403,
                    detail={
                        "error": "limit_reached",
                        "limit": "operators",
                        "current": current_operators,
                        "max": operator_limit,
                        "current_plan": entitlements.plan_slug,
                        "message": (
                            f"You've reached your plan's operator limit "
                            f"({current_operators}/{operator_limit}). "
                            f"Upgrade or purchase a seat to add more."
                        ),
                        "upgrade_url": "/billing",
                    },
                )
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
        # Capture name BEFORE the session context closes — accessing
        # ``operator.name`` after the ``with`` block raises
        # ``DetachedInstanceError`` because SQLAlchemy tries to refresh
        # the expired attribute against a closed session. Mirrors the same
        # pattern used in ``delete_operator`` below.
        operator_name = operator.name

    # Update operator's department in WS manager without triggering reconnect
    if department_changed:
        await manager.update_operator_department(operator_id, new_department_id)

    return {"success": True, "message": f"Operator '{operator_name}' updated."}


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
    """Visitor-initiated live chat request — runs through the state machine.

    The state machine ``LiveChatAvailabilityService`` decides what the widget
    should do based on the workspace's current live-chat reality (feature
    flag, operator presence, business hours, queue capacity). The endpoint
    returns a structured response the widget reads to pick its UI mode:

    * ``suggested_action == "route"`` — queue + notify operators (current path)
    * ``suggested_action == "wait"``  — queue + tell widget to show queue UI
      with auto-fallback timer
    * ``suggested_action == "offline_form"`` — do NOT queue, tell widget to
      switch to the offline message form with the matching ``state`` as the
      fallback reason

    Side effects (audit log, webhook, email notifications) only fire when
    the visitor will actually be queued — no point waking operators when the
    state machine has already decided to fall back to the form.
    """
    from app.services import live_chat_availability_service as availability_svc

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

        # Re-fetch bot in this session so SQLAlchemy doesn't complain about
        # detached instance access later. The Depends() bot may be from a
        # different session.
        db_bot = session.execute(select(Bot).where(Bot.id == chat_session.bot_id)).scalar_one_or_none()
        if db_bot is None:
            # Defensive: bot was deleted between request and processing
            return {
                "success": False,
                "state": "feature_disabled",
                "suggested_action": "offline_form",
                "fallback_reason": "feature_disabled",
            }

        # ── State machine decides what happens ─────────────────────────────
        # Pass the department_id so per-department business hours apply
        # (Sales 9-6 vs Support 24/7 in the same workspace).
        availability = availability_svc.resolve_live_chat_state(db_bot, session, department_id=request.department_id)

        # When the state machine says "show the offline form", we used to
        # short-circuit straight to the offline form. With Web Push enabled
        # that's the wrong call in the most important case — "nobody on WS,
        # but the workspace has push subscribers" is exactly the scenario push
        # was built for. So before falling back, ask the DB whether anyone in
        # this workspace can be reached via push; if so, promote the request
        # to a real waiting queue + fire push + tell the widget to show the
        # queue UI (it will fall back to the offline form on its own when the
        # ``queue_timeout_seconds`` window elapses without an accept).
        if availability.suggested_action == availability_svc.SuggestedAction.OFFLINE_FORM:
            from sqlalchemy import exists, or_

            from app.db.models import Operator as _OperatorModel
            from app.db.models import OperatorPushSubscription as _PushSub

            workspace_operator_ids = (
                session.execute(select(_OperatorModel.id).where(_OperatorModel.client_id == db_bot.client_id))
                .scalars()
                .all()
            )
            has_push_subscriber = session.execute(
                select(
                    exists().where(
                        or_(
                            _PushSub.client_id == db_bot.client_id,
                            _PushSub.operator_id.in_(workspace_operator_ids) if workspace_operator_ids else False,
                        )
                    )
                )
            ).scalar()

            from app.services.notification_broadcaster import broadcaster

            has_active_ws = broadcaster.connection_count(db_bot.client_id) > 0

            if not has_push_subscriber and not has_active_ws:
                # Original behaviour — no realtime channel reaches anyone, so
                # the visitor's only useful action is the offline form.
                session.add(
                    ChatAuditLog(
                        session_id=request.session_id,
                        action="handoff_fell_back",
                        details={
                            "reason": availability.state.value,
                            "requested_department_id": request.department_id,
                        },
                    )
                )
                session.commit()
                logger.info(
                    "Handoff fell back to offline form (no active push/WS subscribers): session=%s bot=%s reason=%s",
                    request.session_id,
                    bot.id,
                    availability.state.value,
                )
                return {
                    "success": True,
                    "state": availability.state.value,
                    "suggested_action": "offline_form",
                    "fallback_reason": availability.state.value,
                    "message_key": availability.message_key,
                    "next_available_at": availability.next_available_at,
                }

            # Push/WS-promotion path — at least one subscriber/connection exists, so push/WS
            # has a meaningful chance of waking someone. Fall through into
            # the standard "queue + notify" flow below; the existing code
            # there marks the session waiting, fires the audit + webhook,
            # enqueues the push dispatch, and returns the wait UI metadata.
            # The ``promoted_from_offline_form`` flag tells the response
            # builder to override the state machine's lingering OFFLINE_FORM
            # suggested_action — otherwise the widget would still render the
            # form instead of the queue UI.
            promoted_from_offline_form = True
            logger.info(
                "Handoff offline_form promoted to wait+push/WS: session=%s bot=%s reason=%s",
                request.session_id,
                bot.id,
                availability.state.value,
            )
        else:
            promoted_from_offline_form = False

        # State is AVAILABLE or ALL_BUSY → proceed with the existing queue +
        # notify flow. ALL_BUSY still queues (visitor will wait for capacity);
        # AVAILABLE queues and the next operator notification fires.

        # Update session status
        chat_session.status = "waiting"
        chat_session.handoff_reason = (
            request.reason.replace("<", "&lt;").replace(">", "&gt;") if request.reason else None
        )
        if request.department_id:
            chat_session.department_id = request.department_id

        timeout = db_bot.operator_timeout_seconds if db_bot else 120

        # Audit log — handoff requested
        session.add(
            ChatAuditLog(
                session_id=request.session_id,
                action="handoff_requested",
                details={
                    "reason": request.reason,
                    "department_id": request.department_id,
                    "state": availability.state.value,
                },
            )
        )
        session.commit()

        # Bust the state cache — the queue size just changed.
        availability_svc.invalidate(db_bot.id)

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

        # Cache queue timeout for the response — read BEFORE the session
        # closes so the value travels out cleanly.
        queue_timeout = db_bot.live_chat_queue_timeout_seconds or 20

        # Fan-out Web Push to any eligible operator who isn't already
        # watching the dashboard via WebSocket. The "user is trying to
        # connect" email has been deliberately removed in favour of push —
        # email now only fires when the visitor actually *sends a message*
        # in a waiting/unattended session (handled in ws_routes).
        from app.worker.enqueue import enqueue_sync

        enqueue_sync(
            "task_dispatch_handoff_push",
            request.session_id,
            bot.id,
            request.department_id,
            visitor_name,
            request.reason,
            queue_timeout,
        )
        # Schedule a cleanup pass for after the visitor's queue-timeout window
        # so stale on-device notifications get tag-replaced with "chat ended"
        # if no operator accepted. ARQ honours ``_defer_by`` natively.
        from datetime import timedelta as _td

        enqueue_sync(
            "task_handoff_escalation",
            request.session_id,
            _defer_by=_td(seconds=queue_timeout + 1),
        )

        # In-app bell + global banner. Persisted so an operator who was on
        # /knowledge when the handoff arrived can still see the request
        # waiting for them when they switch tabs.
        try:
            from app.services.notification_service import notify_handoff_request

            dept_name = None
            if request.department_id:
                from app.db.models import Department

                dept = session.get(Department, request.department_id)
                dept_name = dept.name if dept else None
            notify_handoff_request(
                session,
                client_id=bot.client_id,
                session_id=request.session_id,
                visitor_name=visitor_name,
                bot_name=bot.name,
                department_id=request.department_id,
                department_name=dept_name,
            )
        except Exception:
            logger.exception("Failed to record handoff_request notification")

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
            bot_id=bot.id,
            bot_name=bot.name,
        )
    )

    # Echo the resolved state so the widget can pick its UI mode without
    # waiting for the first WebSocket status push. When we promoted from
    # OFFLINE_FORM (push subscribers exist), tell the widget to render the
    # queue UI — "wait" matches the ALL_BUSY suggestion and renders the same
    # "Finding an available operator…" copy with the queue-timeout fallback.
    suggested_action_value = "wait" if promoted_from_offline_form else availability.suggested_action.value
    return {
        "success": True,
        "status": "waiting",
        "state": availability.state.value,
        "suggested_action": suggested_action_value,
        "message_key": availability.message_key,
        "queue_position": availability.queue_position,
        "eta_seconds": availability.eta_seconds,
        "queue_timeout_seconds": queue_timeout,
        "online_operator_count": availability.online_operator_count,
    }


@router.post("/cancel-handoff/{session_id}")
async def cancel_handoff(session_id: str, bot: Bot = Depends(get_current_bot)):
    """Visitor cancels a waiting handoff request, returning session to bot mode.

    Called by the widget when the visitor clicks "Cancel and return to AI chat"
    while still in the waiting state, especially if the WebSocket hasn't connected yet.
    """
    with get_session() as session:
        chat_session = session.execute(
            select(ChatSession).where(ChatSession.id == session_id, ChatSession.bot_id == bot.id)
        ).scalar_one_or_none()
        if not chat_session:
            raise HTTPException(status_code=404, detail="Session not found")

        if chat_session.status != "waiting":
            return {"success": True, "status": chat_session.status}

        chat_session.status = "bot"
        chat_session.assigned_operator_id = None
        session.add(ChatAuditLog(session_id=session_id, action="visitor_cancelled"))
        session.commit()

    # Also clean up in-memory state
    if session_id in manager.waiting_queue:
        manager.waiting_queue.remove(session_id)
    manager._cancel_timeout(session_id)
    manager._session_departments.pop(session_id, None)
    manager._session_metadata.pop(session_id, None)

    # Notify operators of updated queue
    for oid in list(manager.operator_connections.keys()):
        await manager._notify_operator_queue(oid)

    return {"success": True, "status": "bot"}


@router.get("/session-status/{session_id}")
def get_session_live_status(session_id: str, bot: Bot = Depends(get_current_bot)):
    """Get the current live chat status for a session.

    Called by the widget on mount to restore chatMode across page navigations.
    Returns the session status and operator name if assigned.
    """
    with get_session() as session:
        chat_session = session.execute(
            select(ChatSession).where(ChatSession.id == session_id, ChatSession.bot_id == bot.id)
        ).scalar_one_or_none()
        if not chat_session:
            return {"status": "bot", "operator_name": None}

        operator_name = None
        if chat_session.assigned_operator_id:
            operator = session.execute(
                select(Operator).where(Operator.id == chat_session.assigned_operator_id)
            ).scalar_one_or_none()
            if operator:
                operator_name = operator.name

        return {
            "status": chat_session.status,
            "operator_name": operator_name,
        }


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

        # Verify the session belongs to a bot owned by the operator's workspace.
        target_session = session.execute(select(ChatSession).where(ChatSession.id == session_id)).scalar_one_or_none()
        if not target_session:
            raise HTTPException(status_code=404, detail="Session not found")
        owning_bot = session.execute(select(Bot).where(Bot.id == target_session.bot_id)).scalar_one_or_none()
        if not owning_bot or owning_bot.client_id != auth["client_id"]:
            raise HTTPException(status_code=403, detail="Access denied.")

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

    # DB already committed status='live' — the in-memory manager is secondary.
    # If accept_chat returns False (already assigned in memory to another operator),
    # that means DB and memory diverged. Force-sync memory to match DB truth.
    accepted = await manager.accept_chat(session_id, operator_id, operator_name)
    if not accepted:
        logger.warning(
            f"DB accepted chat {session_id} for operator {operator_id} but in-memory "
            f"state shows a different assignee. DB is authoritative — proceeding."
        )

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
        asyncio.create_task(
            manager.request_handoff(
                session_id,
                timeout,
                request.target_department_id,
                bot_id=bot.id,
                bot_name=bot.name,
            )
        )

        return {"success": True, "transferred_to_department": dept_name}


@router.get("/me/status")
def get_my_operator_status(auth=Depends(get_current_client_or_operator)):
    """Get the current operator's online status. Used by the admin dashboard on mount."""
    with get_session() as session:
        if auth["type"] == "operator":
            operator = session.execute(select(Operator).where(Operator.id == auth["operator_id"])).scalar_one_or_none()
        else:
            client = auth["entity"]
            operator = session.execute(
                select(Operator).where(Operator.client_id == client.id, Operator.role == "owner").limit(1)
            ).scalar_one_or_none()

        if not operator:
            return {"is_online": False, "operator_name": None, "operator_id": None}

        return {
            "is_online": operator.is_online,
            "operator_name": operator.name,
            "operator_id": operator.id,
        }


class SetStatusRequest(BaseModel):
    is_online: bool


@router.post("/status")
async def set_operator_status(
    request: SetStatusRequest | None = None,
    auth=Depends(get_current_client_or_operator),
):
    """Set operator online/offline status explicitly.

    Accepts ``{"is_online": true/false}`` in the request body.
    Falls back to toggle behavior (backward compat) when no body is provided.

    When an operator transitions to offline, any sessions still assigned to
    them are immediately re-queued and the affected visitors are notified —
    otherwise the visitor's widget would stay glued to a dead live session.
    """
    operator_id_to_release: int | None = None

    with get_session() as session:
        if auth["type"] == "operator":
            operator = session.execute(select(Operator).where(Operator.id == auth["operator_id"])).scalar_one_or_none()
            if not operator:
                raise HTTPException(status_code=404, detail="Operator not found.")
            previously_online = operator.is_online
            new_online = request.is_online if request is not None else (not operator.is_online)
            operator.is_online = new_online
            session.commit()
            if previously_online and not new_online:
                operator_id_to_release = operator.id
            response = {"is_online": operator.is_online, "operator_name": operator.name, "operator_id": operator.id}
        else:
            # Client: find or create the owner's operator record.
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
                    operator_api_key=uuid.uuid4().hex,
                )
                session.add(operator)
                session.commit()
                session.refresh(operator)
                return {"is_online": True, "operator_name": operator.name, "operator_id": operator.id}

            previously_online = operator.is_online
            new_online = request.is_online if request is not None else (not operator.is_online)
            operator.is_online = new_online
            session.commit()
            if previously_online and not new_online:
                operator_id_to_release = operator.id
            response = {"is_online": operator.is_online, "operator_name": operator.name, "operator_id": operator.id}

    if operator_id_to_release is not None:
        try:
            await manager.mark_operator_offline_now(operator_id_to_release)
        except Exception:
            logger.exception("Failed to release sessions for operator %s going offline", operator_id_to_release)

    return response


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

    from app.services.r2_service import _build_public_url, upload_chat_file

    key = upload_chat_file(file_data, file.filename or "file", file.content_type)
    url = _build_public_url(key)

    return {"file_url": url, "filename": file.filename, "content_type": file.content_type, "size": len(file_data)}


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


# ──────────────────────────────────────────────────────────────────────────────
# Qualified-bot sessions (visitors currently chatting with AI whose BANT
# qualification has captured 2 or more dimensions). Surfaced in the live-chat
# console so operators can proactively engage warm leads before they bounce.
# ──────────────────────────────────────────────────────────────────────────────

_QUALIFIED_MIN_DIMENSIONS = 2


def _bant_dimensions_marked(cs: ChatSession) -> dict[str, bool]:
    """Return which BANT dimensions are 'marked' for a session.

    A dimension is considered marked when its dedicated score column is >0
    OR the free-text capture column is non-empty. This mirrors the rules the
    qualification service uses when writing to the columns and avoids
    surfacing false positives when only a placeholder string was stored.
    """
    return {
        "budget": bool(cs.bant_budget_score or (cs.bant_budget or "").strip()),
        "authority": bool(cs.bant_authority_score or (cs.bant_authority or "").strip()),
        "need": bool(cs.bant_need_score or (cs.bant_need or "").strip()),
        "timeline": bool(cs.bant_timeline_score or (cs.bant_timeline or "").strip()),
    }


@router.get("/qualified-bot-sessions/debug")
def debug_qualified_bot_sessions(auth=Depends(get_current_client_or_operator)):
    """Diagnostic view — returns every session in this workspace alongside the
    fields the qualifier evaluates so we can see why a row didn't surface.

    Strictly admin-only; not consumed by the UI. Useful when a session you
    expected to see in "Chatting with AI" is missing — usually because the
    status moved off ``bot`` or the BANT signals never landed in the
    expected columns.
    """
    client_id = auth["client_id"]
    rows = []
    with get_session() as session:
        all_sessions = session.execute(
            select(ChatSession, Bot)
            .join(Bot, ChatSession.bot_id == Bot.id)
            .where(Bot.client_id == client_id)
            .order_by(ChatSession.last_active_at.desc().nullslast())
            .limit(50)
        ).all()
        for cs, bot in all_sessions:
            dims = _bant_dimensions_marked(cs)
            rows.append(
                {
                    "session_id": cs.id,
                    "bot_name": bot.name,
                    "status": cs.status,
                    "assigned_operator_id": cs.assigned_operator_id,
                    "department_id": cs.department_id,
                    "bant_scores": {
                        "budget": cs.bant_budget_score or 0,
                        "authority": cs.bant_authority_score or 0,
                        "need": cs.bant_need_score or 0,
                        "timeline": cs.bant_timeline_score or 0,
                    },
                    "bant_text": {
                        "budget": cs.bant_budget,
                        "authority": cs.bant_authority,
                        "need": cs.bant_need,
                        "timeline": cs.bant_timeline,
                    },
                    "dimensions_marked": dims,
                    "dimensions_marked_count": sum(1 for v in dims.values() if v),
                    "dimensions_assessed": cs.dimensions_assessed or 0,
                    "bant_score": cs.bant_score or 0,
                    "bant_tier": cs.bant_tier,
                    "qualifies": (
                        cs.status == "bot"
                        and (
                            sum(1 for v in dims.values() if v) >= _QUALIFIED_MIN_DIMENSIONS
                            or (cs.dimensions_assessed or 0) >= _QUALIFIED_MIN_DIMENSIONS
                        )
                    ),
                    "last_active_at": cs.last_active_at.isoformat() if cs.last_active_at else None,
                }
            )
    return {"sessions": rows, "min_dimensions": _QUALIFIED_MIN_DIMENSIONS}


@router.get("/qualified-bot-sessions")
def get_qualified_bot_sessions(
    limit: int = Query(50, ge=1, le=200),
    auth=Depends(get_current_client_or_operator),
):
    """List visitors who are **currently** chatting with the AI and whose
    BANT qualification has captured at least 2 of 4 dimensions.

    "Currently" is enforced by a real-time presence heartbeat — the widget
    pings the connect-request endpoint every 5s while in bot mode, and the
    in-memory manager tracks which sessions have a fresh ping. As soon as
    the visitor closes the tab or navigates away, polling stops and the row
    auto-drops off the list within seconds. No time-window heuristic, no
    abandoned tabs ever shown."""

    client_id = auth["client_id"]
    operator_dept_id = auth["entity"].department_id if auth["type"] == "operator" else None

    # Pull the live presence set first — the widget's poll-driven heartbeat
    # is what makes this a "right-now" view rather than a historical list.
    present_session_ids = manager.get_present_bot_session_ids()
    if not present_session_ids:
        return {
            "sessions": [],
            "count": 0,
            "min_dimensions": _QUALIFIED_MIN_DIMENSIONS,
        }

    # Broad SQL prefilter: any presently-chatting bot session with at least
    # one positive BANT signal. The exact "≥2 dimensions" check runs in
    # Python below so the rule stays a single source of truth (matches the
    # badge logic on the Leads page) and is trivially debuggable.
    any_signal = or_(
        ChatSession.bant_budget_score > 0,
        ChatSession.bant_authority_score > 0,
        ChatSession.bant_need_score > 0,
        ChatSession.bant_timeline_score > 0,
        ChatSession.dimensions_assessed > 0,
    )

    items: list[dict] = []
    with get_session() as session:
        rows = session.execute(
            select(ChatSession, Bot)
            .join(Bot, ChatSession.bot_id == Bot.id)
            .where(
                Bot.client_id == client_id,
                ChatSession.status == "bot",
                ChatSession.id.in_(present_session_ids),
                any_signal,
            )
            .order_by(
                ChatSession.bant_score.desc(),
                ChatSession.bant_last_updated.desc().nullslast(),
            )
            .limit(limit * 4)  # over-fetch so the Python post-filter still hits ``limit``
        ).all()

        for chat_session, bot in rows:
            if operator_dept_id and chat_session.department_id and chat_session.department_id != operator_dept_id:
                continue

            dims = _bant_dimensions_marked(chat_session)
            dims_count = sum(1 for v in dims.values() if v)
            # Match if either the BANT-column count or the framework-agnostic
            # ``dimensions_assessed`` counter clears the threshold.
            effective_count = max(dims_count, chat_session.dimensions_assessed or 0)
            if effective_count < _QUALIFIED_MIN_DIMENSIONS:
                continue
            if len(items) >= limit:
                break

            lead = get_lead_info_by_session(session, chat_session.id)

            # Cheap "last user message" preview without loading the full thread.
            last_msg_row = session.execute(
                select(ChatMessage.content, ChatMessage.created_at)
                .where(
                    ChatMessage.session_id == chat_session.id,
                    ChatMessage.role.in_(("user", "bot")),
                )
                .order_by(ChatMessage.created_at.desc())
                .limit(1)
            ).first()

            preview = None
            last_message_at = None
            if last_msg_row:
                preview = (last_msg_row[0] or "")[:120]
                last_message_at = last_msg_row[1].isoformat() if last_msg_row[1] else None

            items.append(
                {
                    "session_id": chat_session.id,
                    "bot_id": bot.id,
                    "bot_name": bot.name,
                    "name": (lead.name if lead else None) or "Anonymous",
                    "email": lead.email if lead else None,
                    "phone": lead.phone if lead else None,
                    "company": lead.company if lead else None,
                    "location": chat_session.location,
                    "device": chat_session.device,
                    "department_id": chat_session.department_id,
                    "bant_dimensions": dims,
                    "bant_dimensions_count": dims_count,
                    "bant_scores": {
                        "budget": chat_session.bant_budget_score or 0,
                        "authority": chat_session.bant_authority_score or 0,
                        "need": chat_session.bant_need_score or 0,
                        "timeline": chat_session.bant_timeline_score or 0,
                    },
                    # Total recorded evidence rows per dimension — populated
                    # below in a single grouped query so the loop above stays
                    # O(N) instead of doing one extra query per row.
                    "bant_signal_counts": {
                        "budget": 0,
                        "authority": 0,
                        "need": 0,
                        "timeline": 0,
                    },
                    "bant_signal_total": 0,
                    "bant_score": chat_session.bant_score or 0,
                    "bant_tier": chat_session.bant_tier or "unqualified",
                    "last_message_preview": preview,
                    "last_message_at": last_message_at,
                    "bant_last_updated": (
                        chat_session.bant_last_updated.isoformat() if chat_session.bant_last_updated else None
                    ),
                    "created_at": (chat_session.created_at.isoformat() if chat_session.created_at else None),
                }
            )

        # ── One grouped query for evidence counts ───────────────────────────
        # Counts how many BANTSignal rows the extractor has recorded per
        # (session, dimension). Operators use this to distinguish a passing
        # mention from sustained engagement — a session with NEED×6 is hotter
        # than one with NEED×1 even when their composite scores match.
        item_session_ids = [it["session_id"] for it in items]
        if item_session_ids:
            count_rows = session.execute(
                select(
                    BANTSignal.session_id,
                    BANTSignal.dimension,
                    func.count(BANTSignal.id),
                )
                .where(BANTSignal.session_id.in_(item_session_ids))
                .group_by(BANTSignal.session_id, BANTSignal.dimension)
            ).all()

            counts_by_session: dict[str, dict[str, int]] = {}
            for sid, dim, cnt in count_rows:
                counts_by_session.setdefault(sid, {})[(dim or "").lower()] = int(cnt or 0)

            for it in items:
                bucket = counts_by_session.get(it["session_id"], {})
                if not bucket:
                    continue
                signal_counts = it["bant_signal_counts"]
                for dim_key in ("budget", "authority", "need", "timeline"):
                    signal_counts[dim_key] = bucket.get(dim_key, 0)
                it["bant_signal_total"] = sum(bucket.values())

    return {
        "sessions": items,
        "count": len(items),
        "min_dimensions": _QUALIFIED_MIN_DIMENSIONS,
    }


@router.post("/connect-request/{session_id}")
async def operator_connect_request(
    session_id: str,
    request: AcceptChatRequest | None = None,
    auth=Depends(get_current_client_or_operator),
):
    """Operator asks a bot-mode visitor whether they'd like to switch to a
    live conversation. The visitor sees a Yes/No popup; nothing changes
    server-side until they accept (then the takeover transition fires).

    Idempotent re-issuing for the same session simply refreshes the popup —
    e.g. operator clicks Connect twice. The visitor only ever sees the latest
    operator's name.
    """
    with get_session() as session:
        if auth["type"] == "operator":
            operator = session.execute(select(Operator).where(Operator.id == auth["operator_id"])).scalar_one_or_none()
        elif request and request.operator_id:
            operator = session.execute(
                select(Operator).where(
                    Operator.id == request.operator_id,
                    Operator.client_id == auth["client_id"],
                )
            ).scalar_one_or_none()
        else:
            operator = session.execute(
                select(Operator).where(Operator.client_id == auth["client_id"], Operator.role == "owner").limit(1)
            ).scalar_one_or_none()
            if not operator:
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

        target = session.execute(select(ChatSession).where(ChatSession.id == session_id)).scalar_one_or_none()
        if not target:
            raise HTTPException(status_code=404, detail="Session not found")

        owning_bot = session.execute(select(Bot).where(Bot.id == target.bot_id)).scalar_one_or_none()
        if not owning_bot or owning_bot.client_id != auth["client_id"]:
            raise HTTPException(status_code=403, detail="Access denied.")

        if target.status != "bot":
            raise HTTPException(
                status_code=409,
                detail=f"Session is currently '{target.status}' — connect requests only apply to bot conversations.",
            )

        operator_id = operator.id
        operator_name = operator.name

    payload = manager.create_connect_request(session_id, operator_id, operator_name)
    return {
        "success": True,
        "request_id": payload["request_id"],
        "expires_at": payload["expires_at"],
        "operator_name": operator_name,
    }


@router.post("/connect-request/{session_id}/cancel")
async def operator_cancel_connect_request(
    session_id: str,
    auth=Depends(get_current_client_or_operator),
):
    """Operator cancels a pending connect-request before the visitor responds."""
    existing = manager.get_connect_request(session_id)
    if not existing:
        return {"success": True, "cancelled": False}
    # Validate ownership — only the workspace that owns the bot may cancel.
    with get_session() as session:
        target = session.execute(select(ChatSession).where(ChatSession.id == session_id)).scalar_one_or_none()
        if not target:
            raise HTTPException(status_code=404, detail="Session not found")
        owning_bot = session.execute(select(Bot).where(Bot.id == target.bot_id)).scalar_one_or_none()
        if not owning_bot or owning_bot.client_id != auth["client_id"]:
            raise HTTPException(status_code=403, detail="Access denied.")
    manager.clear_connect_request(session_id)
    return {"success": True, "cancelled": True}


@router.post("/takeover/{session_id}")
async def takeover_bot_session(
    session_id: str,
    request: AcceptChatRequest | None = None,
    auth=Depends(get_current_client_or_operator),
):
    """Proactively take over a session currently being handled by the AI.

    Distinct from ``/accept`` which only claims sessions already in the
    ``waiting`` queue. Takeover transitions ``status='bot' → 'live'`` atomically
    so two operators can't take over the same visitor at once.
    """
    with get_session() as session:
        if auth["type"] == "operator":
            operator = session.execute(select(Operator).where(Operator.id == auth["operator_id"])).scalar_one_or_none()
        elif request and request.operator_id:
            operator = session.execute(
                select(Operator).where(
                    Operator.id == request.operator_id,
                    Operator.client_id == auth["client_id"],
                )
            ).scalar_one_or_none()
        else:
            operator = session.execute(
                select(Operator).where(Operator.client_id == auth["client_id"], Operator.role == "owner").limit(1)
            ).scalar_one_or_none()
            if not operator:
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

        if operator.max_concurrent_chats:
            active_count = session.execute(
                select(func.count())
                .select_from(ChatSession)
                .where(
                    ChatSession.assigned_operator_id == operator.id,
                    ChatSession.status == "live",
                )
            ).scalar()
            if active_count >= operator.max_concurrent_chats:
                raise HTTPException(
                    status_code=429,
                    detail=f"Operator already at max capacity ({operator.max_concurrent_chats} chats).",
                )

        target = session.execute(select(ChatSession).where(ChatSession.id == session_id)).scalar_one_or_none()
        if not target:
            raise HTTPException(status_code=404, detail="Session not found")

        owning_bot = session.execute(select(Bot).where(Bot.id == target.bot_id)).scalar_one_or_none()
        if not owning_bot or owning_bot.client_id != auth["client_id"]:
            raise HTTPException(status_code=403, detail="Access denied.")

        if target.status not in ("bot", "waiting"):
            raise HTTPException(
                status_code=409,
                detail=f"Session is already in '{target.status}' state and cannot be taken over.",
            )

        # Atomic claim — only transition if still in bot/waiting.
        claimed = session.execute(
            update(ChatSession)
            .where(
                ChatSession.id == session_id,
                ChatSession.status.in_(("bot", "waiting")),
            )
            .values(status="live", assigned_operator_id=operator.id)
            .returning(ChatSession.id)
        ).scalar_one_or_none()
        if not claimed:
            raise HTTPException(
                status_code=409,
                detail="Session changed state before takeover could complete.",
            )

        session.add(
            ChatAuditLog(
                session_id=session_id,
                operator_id=operator.id,
                action="takeover",
            )
        )

        lead = get_lead_info_by_session(session, session_id)
        visitor_name = (lead.name if lead else None) or "Anonymous"

        session.commit()
        operator_id = operator.id
        operator_name = operator.name
        department_id = target.department_id

    # Register session metadata in the in-memory manager so subsequent WS
    # events (read receipts, transfers, close) can resolve visitor info.
    manager._session_metadata[session_id] = {
        "name": visitor_name,
        "reason": "Operator proactively engaged qualified lead",
    }
    if department_id is not None:
        manager._session_departments[session_id] = department_id

    accepted = await manager.accept_chat(session_id, operator_id, operator_name)
    if not accepted:
        logger.warning(
            "Takeover for %s succeeded in DB but manager.accept_chat reported "
            "a divergent assignee. DB is authoritative — proceeding.",
            session_id,
        )

    # Tell every operator in this workspace that this session is no longer a
    # "qualified bot session" so it disappears from their list in real time.
    asyncio.create_task(manager.broadcast_qualified_bot_changed(auth["client_id"], session_id))

    return {
        "success": True,
        "status": "live",
        "operator_name": operator_name,
        "visitor_name": visitor_name,
    }


# ── Web Push subscriptions (operator notifications) ──────────────────────────


class PushSubscriptionKeys(BaseModel):
    p256dh: str
    auth: str


class PushSubscribeRequest(BaseModel):
    endpoint: str
    keys: PushSubscriptionKeys

    @field_validator("endpoint")
    @classmethod
    def _validate_endpoint(cls, v: str) -> str:
        v = v.strip()
        # Web Push endpoints are always https:// — provider-issued URLs.
        if not v.startswith("https://"):
            raise ValueError("endpoint must be an https:// URL")
        if len(v) > 2048:
            raise ValueError("endpoint too long")
        return v


@router.get("/push/vapid-public-key")
def get_vapid_public_key():
    """Return the server's VAPID public key (URL-safe base64).

    Public information — the frontend uses it as ``applicationServerKey`` when
    calling ``pushManager.subscribe()``. Safe to expose without auth, but we
    keep it on the operator router so the SDK call lives next to the rest of
    the push surface.
    """
    from app.config import PUSH_ENABLED, VAPID_PUBLIC_KEY

    return {"public_key": VAPID_PUBLIC_KEY if PUSH_ENABLED else "", "enabled": PUSH_ENABLED}


@router.post("/push/subscribe")
def push_subscribe(
    body: PushSubscribeRequest,
    request: Request,
    auth: dict = Depends(get_current_client_or_operator),
):
    """Register a Web Push subscription for the calling user.

    Accepts both operator and workspace-owner (client) logins. The row's
    ``operator_id`` or ``client_id`` is set depending on the auth type — a DB
    CHECK constraint guarantees exactly one is populated. Upsert by
    ``endpoint`` so the same browser re-subscribing simply re-binds to the
    current account (e.g. after re-login from the same machine, possibly as
    a different role).
    """
    from app.db.models import OperatorPushSubscription

    is_operator = auth["type"] == "operator"
    subscriber_id = auth["entity"].id
    # Capture UA at subscribe-time so the user can later distinguish "Laptop
    # Chrome" from "iPhone Safari" if they ever manage devices. Truncated to
    # a safe length; browsers produce UAs in the 100-400 char range.
    ua = (request.headers.get("user-agent") or "")[:512] or None

    with get_session() as session:
        existing = session.execute(
            select(OperatorPushSubscription).where(OperatorPushSubscription.endpoint == body.endpoint)
        ).scalar_one_or_none()
        if existing is not None:
            # Re-bind the endpoint to whichever account is logged in *now*.
            # The browser reuses the same endpoint after a clean re-subscribe,
            # so an operator → owner role switch on the same device surfaces
            # correctly. Clear the other FK to satisfy the XOR check.
            if is_operator:
                existing.operator_id = subscriber_id
                existing.client_id = None
            else:
                existing.client_id = subscriber_id
                existing.operator_id = None
            existing.p256dh = body.keys.p256dh
            existing.auth = body.keys.auth
            existing.user_agent = ua
        else:
            session.add(
                OperatorPushSubscription(
                    operator_id=subscriber_id if is_operator else None,
                    client_id=None if is_operator else subscriber_id,
                    endpoint=body.endpoint,
                    p256dh=body.keys.p256dh,
                    auth=body.keys.auth,
                    user_agent=ua,
                )
            )
        session.commit()

    return {"success": True}


@router.delete("/push/subscribe")
def push_unsubscribe(
    body: PushSubscribeRequest,
    auth: dict = Depends(get_current_client_or_operator),
):
    """Remove a Web Push subscription previously registered for this user.

    The frontend calls this when the user manually disables notifications or
    after ``pushManager.unsubscribe()`` returns. Idempotent: a delete on a
    non-existent endpoint is a no-op. Scoped to the calling user's own row —
    a subscriber cannot delete another account's subscription even if they
    happen to know the endpoint.
    """
    from sqlalchemy import delete as sa_delete

    from app.db.models import OperatorPushSubscription

    is_operator = auth["type"] == "operator"
    subscriber_id = auth["entity"].id
    scope = (
        OperatorPushSubscription.operator_id == subscriber_id
        if is_operator
        else OperatorPushSubscription.client_id == subscriber_id
    )
    with get_session() as session:
        session.execute(
            sa_delete(OperatorPushSubscription).where(
                scope,
                OperatorPushSubscription.endpoint == body.endpoint,
            )
        )
        session.commit()

    return {"success": True}
