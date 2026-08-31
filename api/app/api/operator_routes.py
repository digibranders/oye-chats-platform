"""Operator management, department CRUD, and live chat REST endpoints."""

import asyncio
import logging
import uuid
from datetime import UTC, datetime
from typing import Literal

from fastapi import APIRouter, Depends, File, HTTPException, Query, Request, UploadFile, status
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import func, or_, select, update

from app.api.auth import get_current_bot, get_current_client_or_operator, impersonation_writable
from app.api.bot_routes import BusinessHours
from app.api.invite_routes import _map_invite_error
from app.api.quotation_routes import build_quotation_summary
from app.core.rate_limit import key_from_operator_credential, limiter
from app.core.security import get_password_hash
from app.core.visitor_privacy import redact_visitor_ip, redact_visitor_metadata
from app.db.models import (
    BANTSignal,
    Bot,
    ChatAuditLog,
    ChatMessage,
    ChatSession,
    Client,
    Department,
    Operator,
)
from app.db.repository import get_lead_info_by_session
from app.db.session import get_session
from app.schemas.validators import (
    BoundedJsonObject,
    EmailAddress,
    HttpUrlStr,
    MediumText,
    Password,
    RequiredName,
    RowId,
    SessionId,
    ShortText,
)

# Imported as a MODULE, not by value. The gate/charge/persist helpers and the
# service singleton are all swapped in tests, and `from x import y` binds a
# separate name that a monkeypatch on the module would never reach.
from app.services import invite_service, plan_entitlements_service
from app.services import translation_service as translation_svc
from app.services.invite_service import InviteError
from app.services.language_service import language_from_locale, normalize_locale
from app.services.live_chat_service import manager
from app.services.qualification_service import (
    calculate_composite_score,
    framework_dimension_keys,
    get_framework_config,
    get_tier,
)
from app.services.session_state_machine import InvalidTransitionError, transition_session

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/operators", tags=["operators"])

# The three roles ``_require_manager_role`` and the RBAC checks branch on.
OperatorRole = Literal["owner", "admin", "operator"]

# ── /handoff idempotency ─────────────────────────────────────────────────────
#
# The widget re-polls ``POST /operators/handoff`` every 15s for as long as it is
# showing the offline form, and the endpoint used to re-run its entire fan-out
# on every call: an audit row, a webhook, one email per configured recipient, a
# push dispatch, a deferred escalation job, a bell notification, and a fresh
# queue timer. One visitor with a tab open produced roughly four of each per
# minute, indefinitely. Inside this window a repeat call still returns the
# current state, it just does not wake anybody a second time.
#
# Per-process, like ``ws_routes._should_email_visitor_message``: with two API
# workers the worst case is one fan-out per worker per window, which is a far
# cry from one every 15s. Bounded at 1000 entries; oldest are evicted FIFO.
HANDOFF_DEDUPE_SECONDS = 60
_HANDOFF_DEDUPE_MAX = 1000
_handoff_dedupe: dict[str, datetime] = {}


def _handoff_fanout_allowed(key: str) -> bool:
    """True when ``/handoff`` may fire the side effects behind ``key`` again.

    ``key`` is namespaced per fan-out, not merely per session: the queue fan-out
    and the offline-form fallback are independent windows, so suppressing a
    repeated fallback audit row must never suppress the notification for a real
    handoff that lands moments later because the team came online.

    Updates the debounce marker as a side effect when it returns True.
    """
    now = datetime.now(UTC)
    last = _handoff_dedupe.get(key)
    if last is not None and (now - last).total_seconds() < HANDOFF_DEDUPE_SECONDS:
        return False
    _handoff_dedupe[key] = now
    if len(_handoff_dedupe) > _HANDOFF_DEDUPE_MAX:
        cutoff = sorted(_handoff_dedupe.values())[len(_handoff_dedupe) // 2]
        for sid, ts in list(_handoff_dedupe.items()):
            if ts < cutoff:
                _handoff_dedupe.pop(sid, None)
    return True


def resolve_operator_seat_limit(db, client_id: int, bot_id: int | None) -> int:
    """The operator allowance for the scope the roster is counted in.

    The seat gate counts operators bound to ONE bot (each agent has its own
    allowance), so the limit has to come from the subscription that funds that
    bot. It used to come from ``get_entitlements(client_id, ...)`` — the ACCOUNT
    view, which resolves through ``get_client_subscription`` and therefore
    follows the highest-PRICED subscription across every scope. On a workspace
    with per-bot subscriptions the two scopes disagree, and both directions are
    real defects:

    * Seats bought on a cheaper agent raised ``operator_quantity`` on THAT row
      while the gate kept reading a pricier sibling's. The customer was billed
      every month and the seats never appeared anywhere — nothing reconciles
      that, because the seat mandate has a live, legitimate parent.
    * One purchase on the priciest row raised the account limit, and since the
      count is per-bot, every other agent silently gained the same capacity free.

    ``get_bot_entitlements`` is the documented tool for gates that are
    inherently per-bot: it follows the bot's own subscription and falls back to
    the account-level one when the bot has none, which is exactly the funding
    story for an agent with no subscription of its own.
    """
    return resolve_operator_seat_entitlements(db, client_id, bot_id).limit_for("operators")


def resolve_operator_seat_entitlements(db, client_id: int, bot_id: int | None):
    """The entitlements object behind :func:`resolve_operator_seat_limit`.

    Separate because the 403 body also names ``plan_slug``, and resolving the
    scope twice would risk the limit and the plan name disagreeing.
    """
    from app.services.plan_entitlements_service import get_bot_entitlements, get_entitlements

    if bot_id is None:
        return get_entitlements(client_id, db, include_usage=True)
    return get_bot_entitlements(bot_id, db, include_usage=True)


def _require_team_management_access(auth: dict) -> None:
    """Only workspace owners, admins, and direct client logins can manage operators/departments."""
    if auth["type"] == "client":
        return
    if getattr(auth["entity"], "role", "operator") not in {"owner", "admin"}:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You do not have permission to manage operators.",
        )


# Role hierarchy: higher index = higher privilege.
_ROLE_RANK = {"operator": 0, "admin": 1, "owner": 2}


def _prevent_role_escalation(auth: dict, target_role: str) -> None:
    """Block an operator from assigning a role higher than their own.

    Direct client logins (auth type "client") are unrestricted. They are the
    workspace owner by definition.  Operator-authenticated callers may only
    assign roles up to their own level (e.g. an admin cannot create an owner).
    """
    if auth["type"] == "client":
        return
    caller_role = getattr(auth["entity"], "role", "operator")
    if _ROLE_RANK.get(target_role, -1) > _ROLE_RANK.get(caller_role, 0):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"You cannot assign the '{target_role}' role, it exceeds your own privilege level.",
        )


# ── Request / Response Models ──


class HandoffRequest(BaseModel):
    session_id: SessionId
    reason: ShortText | None = None
    department_id: RowId | None = None


class CreateOperatorRequest(BaseModel):
    name: RequiredName
    email: EmailAddress
    password: Password
    bot_id: RowId
    role: OperatorRole = "operator"
    department_id: RowId | None = None

    @field_validator("name")
    @classmethod
    def name_not_empty(cls, v):
        if len(v) < 2:
            raise ValueError("Name must be at least 2 characters.")
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


class UpdateOperatorRequest(BaseModel):
    name: RequiredName | None = None
    email: EmailAddress | None = None
    role: OperatorRole | None = None
    bot_id: RowId | None = None
    department_id: RowId | None = None
    # Rendered as an ``<img src>`` in the operator console and beside operator
    # messages in the visitor's widget.
    avatar_url: HttpUrlStr | None = None
    # Routing capacity. An unbounded value here decides how many live
    # conversations one operator is handed.
    max_concurrent_chats: int | None = Field(None, ge=1, le=100)
    # Structurally validated by ``PushPreferencesModel`` on its own endpoint;
    # this legacy path only ever stores the blob, so bound it.
    notification_preferences: BoundedJsonObject | None = None
    # Soft deactivate / reactivate a teammate.
    #
    # Deliberately NOT the same act as ``DELETE /operators/{id}``:
    # ``ChatSession.assigned_operator_id`` is ``ON DELETE SET NULL``, so
    # deleting the row erases "who handled this chat" from every historical
    # conversation in the workspace. Flipping this flag frees the seat while
    # leaving the audit trail intact, the same soft pattern
    # ``transition_service.enforce_operator_ceiling`` (downgrade) and
    # ``invite_service.accept_invite`` (re-invite) already use.
    is_active: bool | None = None
    # ── Multilingual (Phase 4) ──
    # Languages this operator can handle unaided. A routing CAPABILITY that
    # decides which conversations Phase 5 will hand them, so it belongs on this
    # team-management route. The operator's own working language
    # (``preferred_locale``) deliberately does NOT live here: this whole
    # endpoint is gated behind ``_require_team_management_access``, so a plain
    # operator could never reach it to set their own. That one is self-service
    # at ``PUT /operators/me/language``.
    supported_languages: list[ShortText] | None = Field(None, max_length=20)


class CreateDepartmentRequest(BaseModel):
    name: RequiredName
    description: MediumText | None = None


class UpdateDepartmentRequest(BaseModel):
    name: RequiredName | None = None
    description: MediumText | None = None
    # Per-department business hours, the same shape, and now the same model,
    # as ``bot.business_hours``. Sentinel ``{}`` (all days unset) clears the
    # schedule; ``live_chat_availability_service`` reads both columns through
    # one evaluator, so one schema for both is the point.
    business_hours: BusinessHours | None = None


class AcceptChatRequest(BaseModel):
    operator_id: RowId | None = None


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
@impersonation_writable
def update_department(
    department_id: int, request: UpdateDepartmentRequest, auth=Depends(get_current_client_or_operator)
):
    """Update a department.

    Writable under a super-admin impersonation session (design §6.1,
    "Department edits (not invites)"). Name, description and business hours are
    configuration only. Creating and deleting departments stay denied: §6.1 says
    *edits*, and a delete also re-parents every operator in the department.
    """
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
            # Empty dict means "clear". Treat as None in the DB so the
            # resolver short-circuits to "always open" cleanly.
            dept.business_hours = request.business_hours or None
            # Invalidate state caches for every bot in this workspace.
            # Otherwise visitors keep seeing the stale "out of hours" UI
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
def delete_department(department_id: RowId, auth=Depends(get_current_client_or_operator)):
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

        # Build bot name lookup, one-to-one operator↔bot binding surfaces the
        # bot the operator handles in the team list UI.
        bot_ids = {a.bot_id for a in operators if a.bot_id}
        bot_names: dict[int, str] = {}
        if bot_ids:
            bots = session.execute(select(Bot).where(Bot.id.in_(bot_ids))).scalars().all()
            bot_names = {b.id: b.name for b in bots}

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
                    "bot_id": a.bot_id,
                    "bot_name": bot_names.get(a.bot_id),
                    "department_id": a.department_id,
                    "department_name": dept_names.get(a.department_id),
                    "is_online": a.is_online,
                    "is_active": a.is_active,
                    "avatar_url": a.avatar_url,
                    # The operator's own live-chat working language, and the
                    # languages they can handle. Read-only in the team list:
                    # ``preferred_locale`` is self-service (Support -> Live
                    # chat), and ``supported_languages`` has no editor until
                    # language-aware routing needs one.
                    "preferred_locale": a.preferred_locale,
                    "supported_languages": list(a.supported_languages or []),
                    "max_concurrent_chats": a.max_concurrent_chats,
                    "active_chats": active_count,
                    "last_seen_at": a.last_seen_at.isoformat() if a.last_seen_at else None,
                    "created_at": a.created_at.isoformat() if a.created_at else None,
                    # ``linked_client_id``, the underlying Client identity for
                    # invite-created operators, or ``self.id`` for a workspace
                    # owner who added themselves via /me/self-operator. NULL
                    # for legacy password-authenticated operators. Frontend
                    # uses this to identify the "self-operator" row so it can
                    # render a distinct "Leave live chat" action instead of
                    # the delete affordance.
                    "linked_client_id": a.linked_client_id,
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
    from app.services.plan_entitlements_service import UNLIMITED
    from app.services.plan_service import enforce_feature

    with get_session() as db:
        enforce_feature(db, client_id, "live_chat")
        entitlements = resolve_operator_seat_entitlements(db, client_id, request.bot_id)
        operator_limit = entitlements.limit_for("operators")
        if operator_limit != UNLIMITED:
            # Seats are per-bot: count only the operators already bound to the
            # target bot, not the workspace-wide total, so each bot has its own
            # allowance. (Bot ownership is validated in the create block below;
            # a bogus bot_id simply counts 0 here and 404s there.)
            current_operators = int(
                db.execute(
                    select(func.count(Operator.id)).where(
                        Operator.client_id == client_id,
                        Operator.bot_id == request.bot_id,
                        Operator.is_active.is_(True),
                    )
                ).scalar_one()
                or 0
            )
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
                            f"You've reached this agent's operator limit "
                            f"({current_operators}/{operator_limit}). "
                            f"Upgrade or purchase a seat to add more."
                        ),
                        "upgrade_url": "/billing",
                    },
                )
        db.commit()

    with get_session() as session:
        # Validate that the target bot belongs to this workspace. Fail loud so
        # the caller can't create an operator scoped to a bot they don't own.
        bot = session.execute(
            select(Bot).where(Bot.id == request.bot_id, Bot.client_id == client_id)
        ).scalar_one_or_none()
        if bot is None:
            raise HTTPException(status_code=404, detail="Bot not found in this workspace.")

        # Check for duplicate email. Scoped to this workspace only
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
            bot_id=request.bot_id,
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

        logger.info(f"Operator created: {operator.id} ({operator.name}) for client {client_id} bot {request.bot_id}")

        return {
            "id": operator.id,
            "name": operator.name,
            "email": operator.email,
            "role": operator.role,
            "bot_id": operator.bot_id,
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
    # Set when ``is_active`` actually flips, so the post-commit side effects
    # (entitlements cache, WS eviction) only run on a real transition.
    active_changed = False
    deactivated = False

    with get_session() as session:
        operator = session.execute(
            select(Operator).where(Operator.id == operator_id, Operator.client_id == auth["client_id"])
        ).scalar_one_or_none()
        if not operator:
            raise HTTPException(status_code=404, detail="Operator not found.")

        # Name + email are personal-identity fields. Only the operator being
        # edited can change them. An admin editing SOMEONE ELSE's row must not
        # be able to silently rebadge or reassign them by changing the email.
        # Self-edit is either: a legacy operator hitting this endpoint about
        # themselves, or a Client whose ``linked_client_id`` matches the row.
        caller_op_id = auth.get("operator_id") if auth["type"] == "operator" else None
        caller_client_id = auth.get("linked_client_id") or (auth["client_id"] if auth["type"] == "client" else None)
        is_self_edit = (caller_op_id is not None and caller_op_id == operator.id) or (
            caller_client_id is not None
            and operator.linked_client_id is not None
            and operator.linked_client_id == caller_client_id
        )

        if request.name is not None:
            if not is_self_edit:
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail="Only the operator themselves can change their name.",
                )
            operator.name = request.name.strip()
        if request.email is not None:
            if not is_self_edit:
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail="Only the operator themselves can change their email.",
                )
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
        if request.bot_id is not None and request.bot_id != operator.bot_id:
            new_bot = session.execute(
                select(Bot).where(Bot.id == request.bot_id, Bot.client_id == auth["client_id"])
            ).scalar_one_or_none()
            if new_bot is None:
                raise HTTPException(status_code=404, detail="Bot not found in this workspace.")
            # Reassignment must not leave dangling live chats on the old bot.
            # They belong to a bot this operator no longer serves. End them
            # cleanly by clearing the assignment; the WS layer will bounce them
            # back to waiting so another operator on the old bot can pick up.
            session.execute(
                update(ChatSession)
                .where(
                    ChatSession.assigned_operator_id == operator.id,
                    ChatSession.status == "live",
                )
                .values(assigned_operator_id=None, status="waiting")
            )
            operator.bot_id = request.bot_id
        if request.department_id is not None:
            # Track department change for dynamic WS update
            if operator.department_id != request.department_id:
                department_changed = True
                new_department_id = request.department_id
            operator.department_id = request.department_id
        if request.supported_languages is not None:
            # The route is already team-gated at the top, so no extra check
            # here. Normalized on write so Phase 5's routing filter can compare
            # against a bot's supported_locales without re-parsing.
            normalized_list: list[str] = []
            for raw in request.supported_languages:
                normalized = normalize_locale(raw)
                if not normalized:
                    raise HTTPException(
                        status_code=422,
                        detail=f"supported_languages contains an invalid locale: {raw[:32]!r}",
                    )
                if normalized not in normalized_list:
                    normalized_list.append(normalized)
            operator.supported_languages = normalized_list
        if request.avatar_url is not None:
            if not is_self_edit:
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail="Only the operator themselves can change their profile picture.",
                )
            operator.avatar_url = request.avatar_url
        if request.max_concurrent_chats is not None:
            operator.max_concurrent_chats = request.max_concurrent_chats
        if request.notification_preferences is not None:
            operator.notification_preferences = request.notification_preferences

        # ── Soft deactivate / reactivate ──────────────────────────────────
        # Its own block: neither direction is a plain column write. A
        # no-op (sending the value the row already holds) falls through
        # untouched so a full-object PATCH from the console never burns a
        # seat check or evicts a live socket for nothing.
        if request.is_active is not None and request.is_active != operator.is_active:
            if request.is_active:
                # Reactivation flips an inactive seat to active, so it
                # consumes one of the plan's operator seats. Gate on the same
                # ``SELECT ... FOR UPDATE`` helper ``POST /me/self-operator``
                # and the invite-accept path use, so a reactivation racing an
                # invite acceptance serialises on the workspace's
                # subscription row instead of both slipping past the ceiling.
                # Scoped to the operator's bot: seats are per-bot.
                try:
                    invite_service._require_seat_available(  # noqa: SLF001
                        session, auth["client_id"], operator.bot_id
                    )
                except InviteError as err:
                    raise _map_invite_error(err) from err
                operator.is_active = True
            else:
                # Same self-guard as ``delete_operator``: an operator must
                # not be able to lock themselves out of the workspace. The
                # workspace owner's own self-operator row has its own exit,
                # ``DELETE /me/self-operator``.
                if is_self_edit:
                    raise HTTPException(
                        status_code=400,
                        detail="You cannot deactivate your own account.",
                    )
                # In-flight conversations are NOT re-queued here. They are
                # handed over to ``manager.handle_operator_deactivated`` after
                # the commit, which finds them by ``status == 'live'`` and moves
                # DB rows and in-process queue state together. Clearing the rows
                # here would hide the sessions from that call: it would see zero
                # live sessions, never append them to ``manager.waiting_queue``
                # and never drop ``manager.assignments``, leaving the visitor
                # marked ``waiting`` in the DB but invisible to every operator.
                operator.is_active = False
                # Availability goes with it, in the same transaction. The
                # WebSocket's concurrent-operator cap counts
                # ``Operator.is_online`` with no ``is_active`` filter
                # (``ws_routes`` seat check), so a deactivated operator left
                # marked online keeps occupying a paid seat and can refuse a
                # legitimate teammate's connect with ``seat_limit``. Nothing
                # clears it later either: a deactivated operator cannot
                # reconnect to set it again.
                operator.is_online = False
                deactivated = True
            active_changed = True

        session.commit()
        # Capture name BEFORE the session context closes. Accessing
        # ``operator.name`` after the ``with`` block raises
        # ``DetachedInstanceError`` because SQLAlchemy tries to refresh
        # the expired attribute against a closed session. Mirrors the same
        # pattern used in ``delete_operator`` below.
        operator_name = operator.name

    # Seat usage changed. Without this the freed seat stays invisible for the
    # entitlements cache TTL and the customer is told to upgrade for a seat
    # they just freed (and a reactivation would not show as consumed).
    if active_changed:
        plan_entitlements_service.invalidate(auth["client_id"])

    # Update operator's department in WS manager without triggering reconnect
    if department_changed:
        await manager.update_operator_department(operator_id, new_department_id)

    # A deactivated operator must not keep an open console socket: the operator
    # WS handlers never re-read ``is_active``, so an open connection would still
    # accept chats and send messages after the seat was revoked. This closes it
    # and immediately re-queues the operator's in-flight conversations — no
    # grace period, because an inactive operator cannot reconnect.
    #
    # Deliberately non-fatal. The seat change is already committed and the API
    # contract is "the operator is deactivated"; a live-chat teardown failure
    # must not turn that into a 500 that invites the caller to retry an
    # already-applied change. It is logged loudly instead.
    if deactivated:
        try:
            await manager.handle_operator_deactivated(operator_id)
        except Exception:
            logger.exception(
                "Failed to release live sessions for deactivated operator %s",
                operator_id,
            )

    return {"success": True, "message": f"Operator '{operator_name}' updated."}


def _resolve_self_operator(session, auth: dict) -> Operator | None:
    """Look up the Operator row for the calling identity: an operator-key login
    resolves directly by id; a client login resolves via the row it is linked
    to (``Operator.linked_client_id``). Returns None if the caller has no
    operator profile at all (e.g. a client who has never added themselves as
    an operator)."""
    caller_op_id = auth.get("operator_id") if auth["type"] == "operator" else None
    if caller_op_id is not None:
        return session.execute(select(Operator).where(Operator.id == caller_op_id)).scalar_one_or_none()

    caller_client_id = (
        auth.get("linked_client_id")
        if auth["type"] == "operator"
        else (auth["client_id"] if auth["type"] == "client" else None)
    )
    if caller_client_id is None:
        return None
    return session.execute(
        select(Operator).where(Operator.linked_client_id == caller_client_id, Operator.client_id == auth["client_id"])
    ).scalar_one_or_none()


@router.post("/me/avatar")
async def upload_my_avatar(file: UploadFile = File(...), auth: dict = Depends(get_current_client_or_operator)):
    """Upload (or replace) the caller's own profile picture.

    Purely optional self-personalization for the operator workspace — an
    operator without one just shows initials (see ``AvatarCircle`` on the
    frontend), so there is no server-side requirement to ever call this.
    """
    from app.core.upload_guard import IMAGE_UPLOAD_TYPES, MAX_LOGO_BYTES, ensure_allowed_type, read_bounded
    from app.services.r2_service import UnsupportedImage, _build_public_url, upload_to_r2

    ensure_allowed_type(file, IMAGE_UPLOAD_TYPES)
    file_data = await read_bounded(file, MAX_LOGO_BYTES)

    try:
        file_key = upload_to_r2(file_data, file.filename, file.content_type)
    except UnsupportedImage as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Exception as e:
        logger.error(f"Operator avatar upload failed: {e}")
        raise HTTPException(status_code=500, detail="Failed to upload profile picture.") from e

    avatar_url = _build_public_url(file_key)

    with get_session() as session:
        operator = _resolve_self_operator(session, auth)
        if not operator:
            raise HTTPException(status_code=404, detail="No operator profile is linked to this account.")
        operator.avatar_url = avatar_url
        session.commit()

    return {"avatar_url": avatar_url}


@router.delete("/me/avatar")
def remove_my_avatar(auth: dict = Depends(get_current_client_or_operator)):
    """Remove the caller's own profile picture, reverting to initials."""
    with get_session() as session:
        operator = _resolve_self_operator(session, auth)
        if not operator:
            raise HTTPException(status_code=404, detail="No operator profile is linked to this account.")
        operator.avatar_url = None
        session.commit()

    return {"success": True}


@router.delete("/{operator_id}")
def delete_operator(operator_id: RowId, auth=Depends(get_current_client_or_operator)):
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
    """Visitor-initiated live chat request. Runs through the state machine.

    The state machine ``LiveChatAvailabilityService`` decides what the widget
    should do based on the workspace's current live-chat reality (feature
    flag, operator presence, business hours, queue capacity). The endpoint
    returns a structured response the widget reads to pick its UI mode:

    * ``suggested_action == "route"`` (queue + notify operators (current path)
    * ``suggested_action == "wait"``) queue + tell widget to show queue UI
      with auto-fallback timer
    * ``suggested_action == "offline_form"``. Do NOT queue, tell widget to
      switch to the offline message form with the matching ``state`` as the
      fallback reason

    Side effects (audit log, webhook, email notifications) only fire when
    the visitor will actually be queued, no point waking operators when the
    state machine has already decided to fall back to the form.
    """
    from app.services import live_chat_availability_service as availability_svc

    with get_session() as session:
        chat_session = session.execute(
            select(ChatSession).where(ChatSession.id == request.session_id)
        ).scalar_one_or_none()

        # Tenant-isolation guard: an existing session must belong to THIS bot.
        # ``bot`` is resolved from the public X-Bot-Key (embedded in every embed
        # script), so without this check a caller could pass another tenant's
        # session_id and mutate it (flip status→waiting, overwrite
        # handoff_reason/department_id, fire the victim's audit/webhook/push). We
        # cannot fold ``bot_id == bot.id`` into the query above because a genuine
        # miss must fall through to the create-path below; a foreign-but-existing
        # id would then look absent and trigger a primary-key-colliding insert.
        # Return 404 (not 403) so session existence isn't leaked. Matching the
        # cancel_handoff / session-status siblings.
        if chat_session is not None and chat_session.bot_id != bot.id:
            logger.warning(
                "Cross-tenant handoff attempt blocked: bot=%s session=%s owner_bot=%s",
                bot.id,
                request.session_id,
                chat_session.bot_id,
            )
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Session not found.",
            )

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

        # Plan gate: live chat AND its offline fallback are entitlement-gated
        # together. A Free-plan bot's widget never offers a handoff (the RAG
        # prompt no longer suggests one), but the endpoint is the real boundary,
        # so a crafted request must not be able to queue a chat or bounce the
        # visitor to the (plan-excluded) offline form. Deny by returning 403,
        # matching the offline-message endpoint. Deny-by-default on lookup error.
        if not plan_entitlements_service.is_live_chat_enabled_for_bot(db_bot.id, session):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="This workspace's plan does not include live chat.",
            )

        # ── State machine decides what happens ─────────────────────────────
        # Pass the department_id so per-department business hours apply
        # (Sales 9-6 vs Support 24/7 in the same workspace).
        availability = availability_svc.resolve_live_chat_state(db_bot, session, department_id=request.department_id)

        # When the state machine says "show the offline form", we used to
        # short-circuit straight to the offline form. With Web Push enabled
        # that's the wrong call in the most important case. "nobody on WS,
        # but the workspace has push subscribers" is exactly the scenario push
        # was built for. So before falling back, ask the DB whether anyone in
        # this workspace can be reached via push; if so, promote the request
        # to a real waiting queue + fire push + tell the widget to show the
        # queue UI (it will fall back to the offline form on its own when the
        # ``queue_timeout_seconds`` window elapses without an accept).
        if availability.suggested_action == availability_svc.SuggestedAction.OFFLINE_FORM:
            # Promotion exists for one situation: the workspace WANTS the chat
            # but nobody is on a socket right now, so a push may still wake
            # someone. It must never override the states that are a decision
            # rather than an absence. ``feature_disabled`` is the customer's own
            # ``live_chat_enabled`` toggle (the plan gate above only answers the
            # PLAN half - ``is_live_chat_enabled_for_bot`` says so explicitly),
            # ``out_of_hours`` is their published schedule, and ``queue_full``
            # is the capacity ceiling that exists to stop the queue growing.
            # Promoting any of those queued a visitor the workspace had already
            # declined to queue, as soon as a single push-subscription row
            # existed anywhere in the workspace.
            promotable = availability.state in (
                availability_svc.LiveChatState.ALL_OFFLINE,
                availability_svc.LiveChatState.NO_OPERATORS,
            )

            has_push_subscriber = False
            has_active_ws = False
            if promotable:
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
                # Either the state forbids queueing at all, or no realtime
                # channel reaches anyone; the visitor's only useful action is
                # the offline form.
                #
                # Deduped on its own window: the widget re-polls every 15s for
                # as long as it shows the form, and one audit row per poll per
                # visitor is unbounded growth for no added information.
                if _handoff_fanout_allowed(f"fellback:{request.session_id}"):
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
                    "Handoff fell back to offline form: session=%s bot=%s reason=%s promotable=%s",
                    request.session_id,
                    bot.id,
                    availability.state.value,
                    promotable,
                )
                return {
                    "success": True,
                    "state": availability.state.value,
                    "suggested_action": "offline_form",
                    "fallback_reason": availability.state.value,
                    "message_key": availability.message_key,
                    "next_available_at": availability.next_available_at,
                }

            # Push/WS-promotion path, at least one subscriber/connection exists, so push/WS
            # has a meaningful chance of waking someone. Fall through into
            # the standard "queue + notify" flow below; the existing code
            # there marks the session waiting, fires the audit + webhook,
            # enqueues the push dispatch, and returns the wait UI metadata.
            # The ``promoted_from_offline_form`` flag tells the response
            # builder to override the state machine's lingering OFFLINE_FORM
            # suggested_action. Otherwise the widget would still render the
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

        # Idempotency for the widget's 15s re-poll. Decided here, before any
        # side effect runs, and reused for every one of them below so a repeat
        # call still reports the current state without waking the workspace
        # again (and without restarting the queue timer).
        may_notify = _handoff_fanout_allowed(f"queued:{request.session_id}")

        # ``closed`` is terminal in the state machine, and this write reopens
        # it. That is deliberate: after ``/resolve`` the widget drops the
        # visitor back to the bot on the SAME session id, so refusing here
        # would leave a returning visitor with no way to reach a human again.
        # It is recorded so the bypass is visible in the audit trail instead of
        # being silent. The principled fix is a ``closed → waiting`` edge in
        # ``session_state_machine._TRANSITIONS`` so this write can go through
        # ``transition_session`` like the others.
        if chat_session.status == "closed":
            session.add(
                ChatAuditLog(
                    session_id=request.session_id,
                    action="handoff_reopened_closed_session",
                    details={"state": availability.state.value},
                )
            )
            logger.info(
                "Handoff reopened a closed session: session=%s bot=%s",
                request.session_id,
                bot.id,
            )

        # Update session status
        chat_session.status = "waiting"
        chat_session.handoff_reason = (
            request.reason.replace("<", "&lt;").replace(">", "&gt;") if request.reason else None
        )
        if request.department_id:
            chat_session.department_id = request.department_id

        timeout = db_bot.operator_timeout_seconds if db_bot else 120

        # Audit log. Handoff requested
        if may_notify:
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

        # Bust the state cache, the queue size just changed.
        availability_svc.invalidate(db_bot.id)

        # Get visitor name for queue display
        lead_info = get_lead_info_by_session(session, request.session_id)
        visitor_name = lead_info.name if lead_info else None

        # Cache queue timeout for the response. Read BEFORE the session
        # closes so the value travels out cleanly. Needed on every call,
        # deduped or not, because the widget uses it to time its own fallback.
        queue_timeout = db_bot.live_chat_queue_timeout_seconds or 20

        if not may_notify:
            logger.info(
                "Handoff re-poll within the %ss dedupe window, side effects skipped: session=%s bot=%s",
                HANDOFF_DEDUPE_SECONDS,
                request.session_id,
                bot.id,
            )

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
        if may_notify:
            fire_webhook(bot.id, "handoff_requested", webhook_data)

        # Email the team. Operators may not be watching the dashboard when a
        # visitor queues (that's exactly when this matters most), so this is
        # the notification path for "come look, someone's waiting" - same
        # email_on_* / notification_emails machinery as the qualified-lead
        # notification. Never blocks the handoff response on send failure.
        if may_notify and getattr(db_bot, "email_on_handoff", True):
            from app.services.email_service import get_notification_recipients, send_handoff_request_email

            recipients = get_notification_recipients(db_bot, "handoff_requested")
            if recipients:
                contact = {"name": lead_info.name, "email": lead_info.email} if lead_info else None
                reply_to = getattr(db_bot, "reply_to_email", None)
                for recipient in recipients:
                    try:
                        send_handoff_request_email(recipient, db_bot.name, request.reason, contact, reply_to=reply_to)
                    except Exception:
                        logger.warning("handoff_request_email_failed | bot=%s session=%s", bot.id, request.session_id)

        # Fan-out Web Push to any eligible operator who isn't already
        # watching the dashboard via WebSocket. The "user is trying to
        # connect" email has been deliberately removed in favour of push.
        # Email now only fires when the visitor actually *sends a message*
        # in a waiting/unattended session (handled in ws_routes).
        if may_notify:
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
            # Schedule a cleanup pass for after the visitor's queue-timeout
            # window so stale on-device notifications get tag-replaced with
            # "chat ended" if no operator accepted. ARQ honours ``_defer_by``.
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
            if may_notify:
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
    #
    # Always called, even for a deduped re-poll: the queue bookkeeping and the
    # visitor's timeout have to stay correct (a visitor who cancels and asks
    # again inside the dedupe window must still be queued and still time out).
    # Only the operator fan-out is suppressed.
    asyncio.create_task(
        manager.request_handoff(
            request.session_id,
            timeout,
            request.department_id,
            visitor_name=visitor_name,
            reason=request.reason,
            bot_id=bot.id,
            bot_name=bot.name,
            client_id=bot.client_id,
            notify_operators=may_notify,
        )
    )

    # Echo the resolved state so the widget can pick its UI mode without
    # waiting for the first WebSocket status push. When we promoted from
    # OFFLINE_FORM (push subscribers exist), tell the widget to render the
    # queue UI. "wait" matches the ALL_BUSY suggestion and renders the same
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
async def cancel_handoff(session_id: SessionId, bot: Bot = Depends(get_current_bot)):
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
        # Capture the workspace while the row is attached, the fan-out below
        # runs after this block closes, where ``bot`` is detached.
        notify_client_id = bot.client_id

    # Also clean up in-memory state. The DB write above is what actually removes
    # this visitor from the queue now that the queue is derived from
    # ``ChatSession.status``; these pops just drop this process's stale copies.
    if session_id in manager.waiting_queue:
        manager.waiting_queue.remove(session_id)
    manager._cancel_timeout(session_id)
    manager._session_departments.pop(session_id, None)
    manager._session_metadata.pop(session_id, None)

    # Notify operators of updated queue.
    #
    # Union of Redis presence and this process's sockets, not the local socket
    # table alone: an operator connected to another process would otherwise keep
    # showing a cancelled visitor in their queue indefinitely, since nothing else
    # pushes a correction. Same pattern and rationale as the offline-message
    # fan-out. The queue itself is now derived from the database, so every
    # operator that receives this recomputes the same answer.
    from app.services.operator_presence_service import get_online_operator_ids
    from app.services.ws_backplane import deliver_to_operator

    targets: set[int] = set(manager.operator_connections.keys())
    try:
        targets |= set(get_online_operator_ids(notify_client_id))
    except Exception:
        logger.warning("queue notify: presence lookup failed, using local sockets", exc_info=True)

    for oid in targets:
        if manager.operator_connections.get(oid) is not None:
            await manager._notify_operator_queue(oid)
        else:
            # Remote operator: recompute their view and publish it, since
            # _notify_operator_queue writes to a local socket.
            payload = {
                "type": "queue_update",
                "waiting": await asyncio.to_thread(manager._visible_queue_for_operator, oid),
            }
            payload["count"] = len(payload["waiting"])
            await deliver_to_operator(manager, oid, payload)

    return {"success": True, "status": "bot"}


@router.get("/session-status/{session_id}")
def get_session_live_status(session_id: SessionId, bot: Bot = Depends(get_current_bot)):
    """Get the current live chat status for a session.

    Called by the widget on mount to restore chatMode across page navigations.
    Returns the session status and operator name if assigned.
    """
    with get_session() as session:
        chat_session = session.execute(
            select(ChatSession).where(ChatSession.id == session_id, ChatSession.bot_id == bot.id)
        ).scalar_one_or_none()
        if not chat_session:
            return {"status": "bot", "operator_name": None, "operator_avatar": None}

        operator_name = None
        operator_avatar = None
        if chat_session.assigned_operator_id:
            operator = session.execute(
                select(Operator).where(Operator.id == chat_session.assigned_operator_id)
            ).scalar_one_or_none()
            if operator:
                operator_name = operator.name
                operator_avatar = operator.avatar_url

        return {
            "status": chat_session.status,
            "operator_name": operator_name,
            "operator_avatar": operator_avatar,
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

        for chat_session, bot in waiting_sessions:
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
                    "location": redact_visitor_ip(chat_session.location),
                    "device": chat_session.device,
                    "department_id": chat_session.department_id,
                    # ``bot_id`` / ``bot_name`` are surfaced so the operator
                    # console can scope the queue display to the sidebar-
                    # selected bot. Without these, a workspace with more than
                    # one bot bleeds waiting visitors across unrelated bots.
                    "bot_id": bot.id,
                    "bot_name": bot.name,
                    "created_at": chat_session.created_at.isoformat() if chat_session.created_at else None,
                }
            )

    return {"queue": queue_items, "count": len(queue_items)}


@router.post("/accept/{session_id}")
@impersonation_writable
async def accept_chat(
    session_id: SessionId,
    request: AcceptChatRequest | None = None,
    auth=Depends(get_current_client_or_operator),
):
    """Operator accepts a waiting chat.

    Writable under a super-admin impersonation session (design §6.1,
    "Conversation status / assignment changes"). Claiming a queued conversation
    is the entry point for reproducing Support triage bugs. The visitor here has
    already asked for a human, so this answers a request rather than initiating
    contact (which is why ``/takeover`` and ``/connect-request`` stay denied).
    """
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

        # One-to-one operator↔bot binding: this operator can only accept chats
        # on the bot they're assigned to. Chats from any other bot in the same
        # workspace must go to that bot's operator.
        if operator.bot_id != target_session.bot_id:
            raise HTTPException(
                status_code=403,
                detail=("This chat belongs to a different bot. Only the operator assigned to that bot can accept it."),
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
            raise HTTPException(status_code=409, detail="Chat was already accepted by another operator")

        # Audit log. Chat accepted
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
        operator_avatar = operator.avatar_url

    # DB already committed status='live', the in-memory manager is secondary.
    # If accept_chat returns False (already assigned in memory to another operator),
    # that means DB and memory diverged. Force-sync memory to match DB truth.
    accepted = await manager.accept_chat(
        session_id, operator_id, operator_name, operator_avatar, client_id=auth["client_id"]
    )
    if not accepted:
        logger.warning(
            f"DB accepted chat {session_id} for operator {operator_id} but in-memory "
            f"state shows a different assignee. DB is authoritative. Proceeding."
        )

    # Translate the pre-handoff transcript for this operator (Phase 4).
    # Deliberately AFTER the accept has committed and been broadcast, and
    # fire-and-forget: picking up a chat must stay instant, and the operator
    # already has the originals in front of them. Without this they inherit the
    # entire AI conversation in a language they may not read, with only messages
    # sent after the handoff translated - and that transcript is exactly the
    # context explaining why the visitor asked for a human.
    translation_svc.spawn_transcript_backfill(session_id)

    return {"success": True, "status": "live", "operator_name": operator_name}


@router.post("/close/{session_id}")
@impersonation_writable
async def close_chat(session_id: SessionId, auth=Depends(get_current_client_or_operator)):
    """Operator closes a live chat.

    Writable under a super-admin impersonation session (design §6.1,
    "Conversation status / assignment changes").
    """
    with get_session() as session:
        chat_session = session.execute(select(ChatSession).where(ChatSession.id == session_id)).scalar_one_or_none()
        if not chat_session:
            raise HTTPException(status_code=404, detail="Session not found")

        bot = session.execute(select(Bot).where(Bot.id == chat_session.bot_id)).scalar_one_or_none()
        if not bot or bot.client_id != auth["client_id"]:
            raise HTTPException(status_code=403, detail="Access denied.")

        # Capture bot_name inside the session block. Accessing bot.name after session.close()
        # raises DetachedInstanceError because SQLAlchemy expires objects on commit.
        bot_name = bot.name
        operator_id = auth.get("operator_id") or chat_session.assigned_operator_id
        bot_id = bot.id
        current_status = chat_session.status

    # Through the state machine, not around it. The direct write here had no
    # row lock and no CAS, so it could clobber a transition another worker had
    # just committed, and it resurrected a terminal ``closed`` conversation
    # back to ``bot``. ``expected_current`` is the status just read, which
    # keeps every legitimate close working (live and waiting both close) while
    # still losing loudly to a concurrent accept/transfer/resolve.
    if current_status == "closed":
        return {"success": True, "status": "closed"}
    try:
        transition_session(
            session_id,
            "bot",
            operator_id=operator_id,
            audit_action="closed",
            expected_current=current_status,
        )
    except InvalidTransitionError:
        raise HTTPException(status_code=409, detail="Conversation changed state before it could be closed.") from None

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

    asyncio.create_task(manager.close_chat(session_id, bot_name, client_id=auth["client_id"]))

    return {"success": True, "status": "bot"}


@router.post("/resolve/{session_id}")
@impersonation_writable
async def resolve_chat(session_id: SessionId, auth=Depends(get_current_client_or_operator)):
    """Operator resolves and hard-closes a live chat.

    Writable under a super-admin impersonation session (design §6.1,
    "Conversation status / assignment changes").


    Unlike ``/close`` (which returns the visitor to bot mode, ``status='bot'``),
    this marks the conversation ``status='closed'`` so it reads as *done* in
    reporting rather than an open bot conversation. The visitor-facing teardown
    is identical (the widget drops back to the bot via ``manager.close_chat``);
    only the persisted status and the audit action differ.
    """
    with get_session() as session:
        chat_session = session.execute(select(ChatSession).where(ChatSession.id == session_id)).scalar_one_or_none()
        if not chat_session:
            raise HTTPException(status_code=404, detail="Session not found")

        bot = session.execute(select(Bot).where(Bot.id == chat_session.bot_id)).scalar_one_or_none()
        if not bot or bot.client_id != auth["client_id"]:
            raise HTTPException(status_code=403, detail="Access denied.")

        bot_name = bot.name
        operator_id = auth.get("operator_id") or chat_session.assigned_operator_id
        bot_id = bot.id
        current_status = chat_session.status

    # Same CAS as ``/close`` above. ``closed`` is terminal, so a second resolve
    # is a no-op rather than a second audit row.
    if current_status == "closed":
        return {"success": True, "status": "closed"}
    try:
        transition_session(
            session_id,
            "closed",
            operator_id=operator_id,
            audit_action="resolved",
            expected_current=current_status,
        )
    except InvalidTransitionError:
        raise HTTPException(status_code=409, detail="Conversation changed state before it could be resolved.") from None

    from app.services.webhook_service import fire_webhook

    fire_webhook(
        bot_id,
        "chat_closed",
        {
            "session_id": session_id,
            "operator_id": operator_id,
            "resolution": "resolved",
        },
    )

    asyncio.create_task(manager.close_chat(session_id, bot_name, client_id=auth["client_id"]))

    return {"success": True, "status": "closed"}


class TransferRequest(BaseModel):
    target_operator_id: RowId | None = None
    target_department_id: RowId | None = None


@router.post("/transfer/{session_id}")
@impersonation_writable
async def transfer_chat(session_id: SessionId, request: TransferRequest, auth=Depends(get_current_client_or_operator)):
    """Transfer a live chat to another operator or department.

    Writable under a super-admin impersonation session (design §6.1,
    "Conversation status / assignment changes"). Reassignment is the other half
    of Support triage, and every notification it fires goes to the Account's own
    operators, never to the Lead.
    """
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

            # One-to-one operator↔bot binding: reject transfers to an operator
            # bound to a different bot.  A chat on bot A must not end up
            # owned by bot B's operator.
            if target_operator.bot_id != chat_session.bot_id:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        "Target operator handles a different bot. "
                        "Transfer only to an operator assigned to this chat's bot."
                    ),
                )

            chat_session.assigned_operator_id = target_operator.id
            if target_operator.department_id:
                chat_session.department_id = target_operator.department_id
            # Audit log. Transferred to operator
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
            asyncio.create_task(
                manager.transfer_chat(
                    session_id,
                    old_operator_id,
                    target_operator.id,
                    target_name,
                    client_id=auth["client_id"],
                )
            )

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
        # Audit log. Transferred to department
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
                client_id=bot.client_id,
            )
        )

        return {"success": True, "transferred_to_department": dept_name}


def _resolve_status_operator(session, auth: dict, bot_id: int | None = None) -> Operator | None:
    """The Operator row a caller's *availability* refers to.

    Distinct from ``_resolve_self_operator``, which resolves only the linked
    self-op row: this one carries the legacy owner-role fallback as well, and
    the preference order below is the same one ``POST /operators/status`` uses.
    Extracted so every reader of "which operator row is this caller" answers
    identically — a badge that disagreed with the availability toggle about the
    answer would report a queue belonging to somebody else.

        1. Self-op row (``linked_client_id == client.id``).
        2. Legacy owner-role row.

    ``bot_id`` scopes the lookup: a workspace with two bots must not resolve
    bot B's row for a caller who is only an operator on bot A.
    """
    if auth["type"] == "operator":
        return session.execute(
            select(Operator).where(Operator.id == auth["operator_id"], Operator.is_active.is_(True))
        ).scalar_one_or_none()

    client = auth["entity"]
    self_op_stmt = select(Operator).where(
        Operator.client_id == client.id,
        Operator.linked_client_id == client.id,
        Operator.is_active.is_(True),
    )
    if bot_id is not None:
        self_op_stmt = self_op_stmt.where(Operator.bot_id == bot_id)
    operator = session.execute(self_op_stmt).scalar_one_or_none()
    if operator:
        return operator

    legacy_stmt = select(Operator).where(
        Operator.client_id == client.id,
        Operator.role == "owner",
        Operator.is_active.is_(True),
    )
    if bot_id is not None:
        legacy_stmt = legacy_stmt.where(Operator.bot_id == bot_id)
    return session.execute(legacy_stmt.limit(1)).scalar_one_or_none()


@router.get("/me/status")
def get_my_operator_status(
    bot_id: int | None = None,
    auth=Depends(get_current_client_or_operator),
):
    """Get the caller's online status for a specific bot.

    ``bot_id`` scopes the lookup to the caller's operator row bound to that
    bot, a workspace with two bots must not report ``is_online=True`` for
    bot B just because the admin is online as bot A's operator. Absent
    ``bot_id`` the endpoint retains its historic "any of my operator rows"
    behaviour for callers that haven't been updated yet.

    Preference order matches ``POST /operators/status`` so the two endpoints
    can never disagree:
        1. Self-op row (``linked_client_id == client.id``).
        2. Legacy owner-role row.
    """
    with get_session() as session:
        operator = _resolve_status_operator(session, auth, bot_id)

        if not operator:
            return {"is_online": False, "operator_name": None, "operator_id": None}

        return {
            "is_online": operator.is_online,
            "operator_name": operator.name,
            "operator_id": operator.id,
        }


@router.get("/me/waiting-count")
def get_my_waiting_count(
    bot_id: int | None = None,
    auth=Depends(get_current_client_or_operator),
):
    """How many visitors are waiting for a person, for this caller, right now.

    The console's rail badge reads this. It used to derive that number from the
    notifications feed instead — every unread ``handoff_request`` row — which
    is a pile of history, not a queue: it counted visitors who had asked for a
    person weeks earlier and long since left, so the rail said six people were
    waiting on the same screen where the inbox said nobody was.

    The live queue exists on the operator websocket as ``queue_update``, but
    that socket is deliberately owned by the inbox page, so the shell cannot
    read it from anywhere else. Hence this: the same view the socket sends,
    over HTTP, for a caller who is not on that page.

    ``_visible_queue_for_operator`` derives from ``ChatSession.status`` in
    Postgres rather than any in-process list, so the answer is the same on
    every worker.

    Returns ``0`` rather than 404 for a caller with no operator profile: the
    badge's question is "how many are waiting for me", and "none, because you
    take no chats" is an answer, not an error.
    """
    with get_session() as session:
        operator = _resolve_status_operator(session, auth, bot_id)
        if not operator:
            return {"count": 0}
        operator_id = operator.id

    return {"count": len(manager._visible_queue_for_operator(operator_id))}


# ── Notification preferences (self-service) ─────────────────────────────────
#
# The prefs JSONB has always existed on ``Operator`` and is consulted by every
# push dispatch task, but the only way to write it was the admin-facing
# ``PATCH /operators/{id}``. These endpoints let the signed-in user manage
# their own alerts from any client.
#
# Which row is written follows *who actually receives the push*: an operator
# token is stored against ``operator_id`` and filtered by
# ``filter_operators_by_push_prefs``; an owner token is stored against
# ``client_id`` and filtered by ``client_wants_push``. Writing anywhere else
# would save a preference that never gets consulted.

# Opt-out categories, mirroring ``push_service._EVENT_CATEGORY`` values.
_PUSH_EVENT_KEYS = {"handoff_request", "chat_transferred", "offline_message"}


class QuietHoursModel(BaseModel):
    start: str
    end: str
    tz: str = "UTC"

    @field_validator("start", "end")
    @classmethod
    def _valid_hhmm(cls, v: str) -> str:
        try:
            hh, mm = v.split(":", 1)
            if not (0 <= int(hh) <= 23 and 0 <= int(mm) <= 59):
                raise ValueError
        except (ValueError, TypeError):
            raise ValueError("time must be 'HH:MM' in 24-hour form") from None
        return v


class PushPreferencesModel(BaseModel):
    enabled: bool = True
    events: dict[str, bool] = Field(default_factory=dict)
    quiet_hours: QuietHoursModel | None = None

    @field_validator("events")
    @classmethod
    def _known_events(cls, v: dict[str, bool]) -> dict[str, bool]:
        # Drop unknown keys rather than 400, a newer client sending a category
        # this deploy doesn't know about shouldn't fail the whole save.
        return {k: bool(val) for k, val in v.items() if k in _PUSH_EVENT_KEYS}


class NotificationPreferencesRequest(BaseModel):
    push: PushPreferencesModel = Field(default_factory=PushPreferencesModel)


def _default_prefs() -> dict:
    """Absent prefs mean fully opted in. Render that explicitly for clients."""
    return {
        "push": {
            "enabled": True,
            "events": {k: True for k in sorted(_PUSH_EVENT_KEYS)},
            "quiet_hours": None,
        }
    }


def _normalize_prefs(stored: dict | None) -> dict:
    """Fill in every field so the caller never has to infer a default."""
    out = _default_prefs()
    if not isinstance(stored, dict):
        return out
    push = stored.get("push")
    if not isinstance(push, dict):
        return out
    if isinstance(push.get("enabled"), bool):
        out["push"]["enabled"] = push["enabled"]
    events = push.get("events")
    if isinstance(events, dict):
        for k in _PUSH_EVENT_KEYS:
            if isinstance(events.get(k), bool):
                out["push"]["events"][k] = events[k]
    quiet = push.get("quiet_hours")
    if isinstance(quiet, dict) and quiet.get("start") and quiet.get("end"):
        out["push"]["quiet_hours"] = {
            "start": quiet.get("start"),
            "end": quiet.get("end"),
            "tz": quiet.get("tz") or "UTC",
        }
    return out


def _prefs_target(session, auth):
    """Resolve the row whose prefs govern *this* caller's pushes."""
    if auth["type"] == "operator":
        return session.execute(
            select(Operator).where(Operator.id == auth["operator_id"], Operator.is_active.is_(True))
        ).scalar_one_or_none()
    return session.execute(select(Client).where(Client.id == auth["client_id"])).scalar_one_or_none()


@router.get("/me/notification-preferences")
def get_my_notification_preferences(auth=Depends(get_current_client_or_operator)):
    """Return the caller's own push preferences, fully defaulted."""
    with get_session() as session:
        target = _prefs_target(session, auth)
        if target is None:
            raise HTTPException(status_code=404, detail="No notification profile for this account")
        return _normalize_prefs(target.notification_preferences)


@router.put("/me/notification-preferences")
def set_my_notification_preferences(
    request: NotificationPreferencesRequest,
    auth=Depends(get_current_client_or_operator),
):
    """Replace the caller's own push preferences and echo the saved state."""
    with get_session() as session:
        target = _prefs_target(session, auth)
        if target is None:
            raise HTTPException(status_code=404, detail="No notification profile for this account")

        payload = request.model_dump(mode="json")
        normalized = _normalize_prefs(payload)
        target.notification_preferences = normalized
        session.commit()
        return normalized


def _language_target(session, auth):
    """Resolve the Operator row whose working language governs *this* caller.

    Unlike ``_prefs_target``, this can only ever be an Operator: a Client row
    has no ``preferred_locale``, because the preference is about reading live
    chat, which is an operator activity. For a client-authenticated owner we
    resolve the same row the WebSocket path would (``_resolve_operator_from_key``):
    the invite-linked operator first, then the workspace's owner row. If those
    disagreed, the console and the socket would translate into different
    languages for the same human.
    """
    if auth["type"] == "operator":
        return session.execute(
            select(Operator).where(Operator.id == auth["operator_id"], Operator.is_active.is_(True))
        ).scalar_one_or_none()

    client_id = auth["client_id"]
    linked = (
        session.execute(
            select(Operator).where(
                Operator.client_id == client_id,
                Operator.linked_client_id == client_id,
                Operator.is_active.is_(True),
            )
        )
        .scalars()
        .first()
    )
    if linked is not None:
        return linked
    return session.execute(
        select(Operator).where(Operator.client_id == client_id, Operator.role == "owner").limit(1)
    ).scalar_one_or_none()


class OperatorLanguageRequest(BaseModel):
    """The caller's own working language. Empty string clears it."""

    preferred_locale: ShortText | None = None


def _available_locales_for(session, operator) -> list[str]:
    """The locales this operator's bot can hold a conversation in.

    These are what the Support translation picker offers. Translating into a
    language no visitor of this bot can write in produces nothing to read, so
    the picker is scoped to the bot's ``supported_locales`` rather than to the
    whole platform catalogue.

    Not gated on ``language_config.enabled``: a customer configuring a bot has
    a supported list before they flip multilingual on, and emptying every
    operator's picker in the meantime would look broken. Whether translation
    actually runs is decided by ``translation_service.is_translation_enabled``,
    which checks both flags.

    ``Operator.bot_id`` is NOT NULL, so this is a single row lookup.
    """
    bot = session.get(Bot, operator.bot_id) if operator.bot_id else None
    config = bot.language_config or {} if bot is not None else {}
    if not isinstance(config, dict):
        return []

    locales: list[str] = []
    raw = config.get("supported_locales")
    if isinstance(raw, list):
        for item in raw:
            if not isinstance(item, str):
                continue
            normalized = normalize_locale(item)
            if normalized and normalized not in locales:
                locales.append(normalized)

    if not locales:
        # A bot with a default but no explicit supported list still offers that
        # one language, rather than nothing at all.
        fallback = config.get("default_locale")
        normalized = normalize_locale(fallback) if isinstance(fallback, str) else None
        if normalized:
            locales.append(normalized)

    return locales


@router.get("/me/language")
def get_my_language(auth=Depends(get_current_client_or_operator)):
    """Return the caller's own live-chat working language.

    ``available_locales`` is what the picker may offer. It is derived per
    request from live bot config, so a locale an admin adds in the bot's
    Language settings shows up on the operator's next load with no extra
    invalidation.
    """
    with get_session() as session:
        target = _language_target(session, auth)
        if target is None:
            raise HTTPException(status_code=404, detail="No operator profile for this account")
        return {
            "preferred_locale": target.preferred_locale,
            "supported_languages": list(target.supported_languages or []),
            "available_locales": _available_locales_for(session, target),
        }


@router.put("/me/language")
def set_my_language(
    request: OperatorLanguageRequest,
    auth=Depends(get_current_client_or_operator),
):
    """Set the caller's OWN live-chat working language.

    Self-service by design. ``PATCH /operators/{id}`` is gated behind
    ``_require_team_management_access``, so a plain operator can never reach
    it; routing their own language preference through there would have made
    the setting unreachable for exactly the people who need it. An admin
    setting someone else's reading language would also silently change what
    that person sees on every conversation.
    """
    with get_session() as session:
        target = _language_target(session, auth)
        if target is None:
            raise HTTPException(status_code=404, detail="No operator profile for this account")

        raw = request.preferred_locale
        if raw is None or not raw.strip():
            # Clearing the preference turns translation off for this operator:
            # they read every message in the language it was written in.
            target.preferred_locale = None
        else:
            normalized = normalize_locale(raw)
            if not normalized:
                raise HTTPException(status_code=422, detail="preferred_locale is not a valid BCP-47 locale.")
            target.preferred_locale = normalized
        session.commit()
        return {"preferred_locale": target.preferred_locale}


class SetStatusRequest(BaseModel):
    # Both fields optional so callers can:
    #   * ``{}`` or no body    → pure toggle (legacy, backward compat).
    #   * ``{"is_online": …}`` → explicit set.
    #   * ``{"bot_id": …}``    → toggle, but scope the operator lookup to a
    #                            specific bot. The frontend sends this when
    #                            the sidebar has an active bot so a workspace
    #                            with two bots doesn't flip the wrong row.
    is_online: bool | None = None
    bot_id: int | None = None


@router.post("/status")
async def set_operator_status(
    request: SetStatusRequest | None = None,
    auth=Depends(get_current_client_or_operator),
):
    """Set operator online/offline status explicitly.

    Accepts ``{"is_online": true/false}`` in the request body.
    Falls back to toggle behavior (backward compat) when no body is provided.

    When an operator transitions to offline, any sessions still assigned to
    them are immediately re-queued and the affected visitors are notified.
    Otherwise the visitor's widget would stay glued to a dead live session.
    """
    operator_id_to_release: int | None = None

    with get_session() as session:
        if auth["type"] == "operator":
            operator = session.execute(
                select(Operator).where(Operator.id == auth["operator_id"], Operator.is_active.is_(True))
            ).scalar_one_or_none()
            if not operator:
                raise HTTPException(status_code=404, detail="Operator not found.")
            previously_online = operator.is_online
            explicit = request is not None and request.is_online is not None
            new_online = request.is_online if explicit else (not operator.is_online)
            operator.is_online = new_online
            session.commit()
            if previously_online and not new_online:
                operator_id_to_release = operator.id
            response = {"is_online": operator.is_online, "operator_name": operator.name, "operator_id": operator.id}
        else:
            client = auth["entity"]
            target_bot_id = request.bot_id if request is not None else None
            self_op_stmt = select(Operator).where(
                Operator.client_id == client.id,
                Operator.linked_client_id == client.id,
                Operator.is_active.is_(True),
            )
            if target_bot_id is not None:
                self_op_stmt = self_op_stmt.where(Operator.bot_id == target_bot_id)
            operator = session.execute(self_op_stmt).scalar_one_or_none()
            if not operator:
                legacy_stmt = select(Operator).where(
                    Operator.client_id == client.id,
                    Operator.role == "owner",
                    Operator.is_active.is_(True),
                )
                if target_bot_id is not None:
                    legacy_stmt = legacy_stmt.where(Operator.bot_id == target_bot_id)
                operator = session.execute(legacy_stmt.limit(1)).scalar_one_or_none()

            if not operator:
                # Refuse to silently mint an operator row. The frontend catches
                # this structured error and prompts "Add yourself as an operator
                # for this workspace?", on confirm it calls the explicit
                # ``POST /me/self-operator`` endpoint which requires an
                # explicit ``bot_id`` so the caller consciously picks which
                # bot they're going to handle. This matches the pre-merge UX
                # where going online required an explicit opt-in dialog.
                raise HTTPException(
                    status_code=404,
                    detail={
                        "error": "no_operator_row",
                        "message": (
                            "You're not on this workspace's operator roster yet. "
                            "Add yourself as an operator before going online."
                        ),
                    },
                )

            previously_online = operator.is_online
            # Explicit set when the caller sent ``is_online``; otherwise pure
            # toggle. A body that only carries ``bot_id`` for scoping still
            # counts as a toggle. Treat that identically to no body at all.
            explicit = request is not None and request.is_online is not None
            new_online = request.is_online if explicit else (not operator.is_online)
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
def get_session_details(session_id: SessionId, auth=Depends(get_current_client_or_operator)):
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
            # ``None`` rather than "Unknown" when there is no geography to
            # name, because the Inbox details panel renders this field verbatim
            # and hides the row on a falsy value, it used to print the raw
            # "IP: 1.2.3.4" stamp at an operator.
            "location": redact_visitor_ip(chat_session.location),
            "device": chat_session.device,
            # The same visitor address reaches the wire a second way, as the
            # ``ip_intel.resolved_for_ip`` dedup marker inside this blob, and
            # here on every plan, since this route has no visitor-intelligence
            # gate at all. The company/ASN/threat fields the operator actually
            # reads survive; see ``redact_visitor_metadata``.
            "visitor_metadata": redact_visitor_metadata(chat_session.visitor_metadata),
            "page_url": chat_session.page_url,
            "referrer": chat_session.referrer,
            "visitor_rating": chat_session.visitor_rating,
            "handoff_reason": chat_session.handoff_reason,
            # Phase 4. Drives the conversation language badge in the operator
            # sidebar and tells the console which translation key to render.
            "language_code": chat_session.language_code,
            "locale": chat_session.locale,
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
            "quotation": build_quotation_summary(bot, chat_session),
        }


class QualificationOverrideRequest(BaseModel):
    # A rubric dimension key ("budget", "authority", "metrics", …). The set is
    # bot-configurable, so it cannot be a ``Literal`` here, the handler checks
    # membership against that bot's own config. This bounds the shape so a
    # non-identifier never reaches the lookup or the audit row.
    dimension: str = Field(..., min_length=1, max_length=64, pattern=r"^[a-z][a-z0-9_]*$")
    # Scores are a 0-100 rubric value and feed the composite tier calculation;
    # ``ge=0`` alone let an operator write an arbitrarily large score and pin
    # every session to the top tier.
    score: int = Field(..., ge=0, le=100)


_LEGACY_DIMENSION_TEXT_ATTR = {
    "need": "bant_need",
    "budget": "bant_budget",
    "authority": "bant_authority",
    "timeline": "bant_timeline",
}
_LEGACY_DIMENSION_SCORE_ATTR = {
    "need": "bant_need_score",
    "budget": "bant_budget_score",
    "authority": "bant_authority_score",
    "timeline": "bant_timeline_score",
}


@router.patch("/session/{session_id}/qualification")
def override_qualification_dimension(
    session_id: SessionId, request: QualificationOverrideRequest, auth=Depends(get_current_client_or_operator)
):
    """Manually correct or reset one qualification dimension's score (BR-03).

    The automated extraction path (``rag_service._background_bant_extraction``)
    deliberately never downgrades a dimension's score, and budget/authority
    scores never decay, by design, so a weak follow-up can't erase a strong
    earlier signal. But that also means a single false-positive extraction, or
    a visitor typing an implausible statement in bad faith ("we have a
    $50k/month budget approved"), permanently misclassifies a lead with no
    remedy short of direct database editing. This gives operators an audited
    way to correct or reset (score=0) a dimension without weakening the
    never-downgrade guarantee for the automated path. Every override is
    still logged as an append-only ``BANTSignal`` row, same as an LLM or
    CTA-click signal, just tagged ``source="operator_override"``.
    """
    from datetime import UTC, datetime

    with get_session() as session:
        chat_session = session.execute(select(ChatSession).where(ChatSession.id == session_id)).scalar_one_or_none()
        if not chat_session:
            raise HTTPException(status_code=404, detail="Session not found")

        bot = session.execute(select(Bot).where(Bot.id == chat_session.bot_id)).scalar_one_or_none()
        if not bot or bot.client_id != auth["client_id"]:
            raise HTTPException(status_code=403, detail="Access denied.")

        config = get_framework_config(bot)
        dimensions = framework_dimension_keys(config) or list(_LEGACY_DIMENSION_TEXT_ATTR)
        if request.dimension not in dimensions:
            raise HTTPException(
                status_code=400, detail=f"Unknown dimension '{request.dimension}' for this bot's framework."
            )

        dim_config = config.get(request.dimension) or {}
        max_score = max((int(o.get("score", 0)) for o in dim_config.get("options") or []), default=25)
        if request.score > max_score:
            raise HTTPException(
                status_code=400,
                detail=f"score {request.score} exceeds the max ({max_score}) for dimension '{request.dimension}'.",
            )

        dimension_scores = dict(chat_session.dimension_scores or {})
        dim_entry = (
            dimension_scores.get(request.dimension) if isinstance(dimension_scores.get(request.dimension), dict) else {}
        )
        score_before = int(dim_entry.get("score", 0) or 0)

        new_value = None if request.score == 0 else dim_entry.get("value")
        dimension_scores[request.dimension] = {"score": request.score, "value": new_value}
        chat_session.dimension_scores = dimension_scores

        if request.dimension in _LEGACY_DIMENSION_SCORE_ATTR:
            setattr(chat_session, _LEGACY_DIMENSION_SCORE_ATTR[request.dimension], request.score)
            setattr(chat_session, _LEGACY_DIMENSION_TEXT_ATTR[request.dimension], new_value)

        chat_session.bant_score = calculate_composite_score(dimension_scores, config)
        chat_session.bant_tier = get_tier(chat_session.bant_score, thresholds=config.get("thresholds"))
        chat_session.dimensions_assessed = sum(
            1
            for payload in dimension_scores.values()
            if isinstance(payload, dict) and int(payload.get("score", 0) or 0) > 0
        )
        chat_session.bant_last_updated = datetime.now(UTC)

        session.add(
            BANTSignal(
                session_id=session_id,
                message_id=None,
                dimension=request.dimension,
                signal_text=f"Operator override ({auth.get('type')} id={auth.get('operator_id') or auth.get('client_id')})",
                extracted_value=str(request.score),
                confidence="operator",
                score_before=score_before,
                score_after=request.score,
                source="operator_override",
            )
        )

        session.commit()

        return {
            "session_id": session_id,
            "dimension": request.dimension,
            "score_before": score_before,
            "score_after": request.score,
            "bant_score": chat_session.bant_score,
            "bant_tier": chat_session.bant_tier,
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
    session_id: SessionId = Query(...),
    file: UploadFile = File(...),
    auth: dict = Depends(get_current_client_or_operator),
):
    """Upload a file during live chat. Returns a URL to embed in messages."""
    ALLOWED_TYPES = {"image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf", "text/plain"}
    MAX_SIZE = 10 * 1024 * 1024  # 10 MB

    if file.content_type not in ALLOWED_TYPES:
        raise HTTPException(status_code=400, detail=f"File type '{file.content_type}' is not allowed.")

    # Bounded read, not read-then-measure: the previous order pulled the whole
    # body into memory and only then objected to its size.
    from app.core.upload_guard import read_bounded

    file_data = await read_bounded(file, MAX_SIZE)

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
    rating: int | None = Field(None, ge=1, le=5)
    resolved: bool | None = None


@router.post("/sessions/{session_id}/rating")
async def submit_visitor_rating(
    session_id: SessionId,
    body: VisitorRatingRequest,
    bot: Bot = Depends(get_current_bot),
):
    """Record a visitor's post-chat satisfaction rating and resolution status.

    Auth: X-Bot-Key header (widget). Both fields are optional. Subsequent
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
    """Diagnostic view. Returns every session in this workspace alongside the
    fields the qualifier evaluates so we can see why a row didn't surface.

    Strictly admin-only; not consumed by the UI. Useful when a session you
    expected to see in "Chatting with AI" is missing. Usually because the
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

    "Currently" is enforced by a real-time presence heartbeat, the widget
    pings the connect-request endpoint every 5s while in bot mode, and the
    in-memory manager tracks which sessions have a fresh ping. As soon as
    the visitor closes the tab or navigates away, polling stops and the row
    auto-drops off the list within seconds. No time-window heuristic, no
    abandoned tabs ever shown."""

    client_id = auth["client_id"]
    operator_dept_id = auth["entity"].department_id if auth["type"] == "operator" else None

    # Plan gate. Starter+Free plans don't get BANT surfacing at all. We
    # short-circuit here so BANT signals never leak via this endpoint even
    # if a stale frontend keeps polling. The Live Chat page also hides the
    # panel and skips the poll, but backend defence is authoritative.
    from app.services.plan_entitlements_service import get_entitlements

    with get_session() as _ent_session:
        entitlements = get_entitlements(client_id, _ent_session)
    if not entitlements.has_feature("bant"):
        return {
            "sessions": [],
            "count": 0,
            "min_dimensions": _QUALIFIED_MIN_DIMENSIONS,
        }

    # Pull the live presence set first, the widget's poll-driven heartbeat
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
                    "location": redact_visitor_ip(chat_session.location),
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
                    # Total recorded evidence rows per dimension. Populated
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
        # mention from sustained engagement, a session with NEED×6 is hotter
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
    session_id: SessionId,
    request: AcceptChatRequest | None = None,
    auth=Depends(get_current_client_or_operator),
):
    """Operator asks a bot-mode visitor whether they'd like to switch to a
    live conversation. The visitor sees a Yes/No popup; nothing changes
    server-side until they accept (then the takeover transition fires).

    Idempotent re-issuing for the same session simply refreshes the popup.
    E.g. operator clicks Connect twice. The visitor only ever sees the latest
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
                detail=f"Session is currently '{target.status}'. Connect requests only apply to bot conversations.",
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
    session_id: SessionId,
    auth=Depends(get_current_client_or_operator),
):
    """Operator cancels a pending connect-request before the visitor responds."""
    existing = manager.get_connect_request(session_id)
    if not existing:
        return {"success": True, "cancelled": False}
    # Validate ownership. Only the workspace that owns the bot may cancel.
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
    session_id: SessionId,
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

        # Atomic claim. Only transition if still in bot/waiting.
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
        operator_avatar = operator.avatar_url
        department_id = target.department_id

    # Register session metadata in the in-memory manager so subsequent WS
    # events (read receipts, transfers, close) can resolve visitor info.
    manager._session_metadata[session_id] = {
        "name": visitor_name,
        "reason": "Operator proactively engaged qualified lead",
    }
    if department_id is not None:
        manager._session_departments[session_id] = department_id

    accepted = await manager.accept_chat(
        session_id, operator_id, operator_name, operator_avatar, client_id=auth["client_id"]
    )
    if not accepted:
        logger.warning(
            "Takeover for %s succeeded in DB but manager.accept_chat reported "
            "a divergent assignee. DB is authoritative. Proceeding.",
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


# ── Translation preview / on-demand backfill (Phase 4) ───────────────────────


class TranslateRequest(BaseModel):
    """Translate one string in the context of a conversation the caller owns.

    ``session_id`` is REQUIRED and ownership-checked. Without it this endpoint
    would be an authenticated, unmetered LLM proxy: any tenant could post
    arbitrary text and get model output back on the platform's bill.

    There is deliberately no ``target_locale`` field. The target is derived
    server-side from the session (previewing an outgoing reply) or from the
    caller's own ``preferred_locale`` (backfilling an incoming message).
    Accepting a caller-supplied target would let one workspace drive
    translation into arbitrary languages for cost, and would contradict the
    rule that the server owns every language decision.
    """

    session_id: SessionId
    text: MediumText
    # When present, the result is persisted into that row's ``translations``.
    # This is the bounded backfill path used after a transfer between
    # operators working in different languages. Absent means preview only.
    message_id: RowId | None = None


@router.post("/translate")
@limiter.limit("30/minute", key_func=key_from_operator_credential)
async def translate_for_session(
    request: Request,
    body: TranslateRequest,
    auth=Depends(get_current_client_or_operator),
):
    """Translate text for a conversation, for preview or backfill.

    Auth is ``get_current_client_or_operator``, matching every other inbox
    route: workspace owners reach the console with ``X-API-Key`` and team
    members with ``X-Operator-Key``, and an operator-only dependency here would
    401 the most common persona.
    """
    with get_session() as session:
        chat_session = session.execute(
            select(ChatSession).where(ChatSession.id == body.session_id)
        ).scalar_one_or_none()
        if not chat_session:
            raise HTTPException(status_code=404, detail="Session not found")

        bot = session.execute(select(Bot).where(Bot.id == chat_session.bot_id)).scalar_one_or_none()
        if not bot or bot.client_id != auth["client_id"]:
            raise HTTPException(status_code=403, detail="Access denied.")
        if not translation_svc.is_translation_enabled(bot):
            raise HTTPException(status_code=403, detail="Translation is not enabled for this bot.")

        session_language = chat_session.language_code
        if not session_language:
            raise HTTPException(status_code=409, detail="This conversation has no resolved language yet.")

        operator_row = _language_target(session, auth)
        operator_language = language_from_locale(operator_row.preferred_locale) if operator_row else None

        # Two distinct jobs behind one endpoint, distinguished by message_id:
        #
        #   backfill (message_id present) - an existing message, written in
        #       whatever language it was written in, rendered INTO the reading
        #       operator's language. Used after a transfer between operators
        #       working in different languages.
        #   preview  (message_id absent)  - a draft the operator is about to
        #       send, in THEIR language, rendered INTO the visitor's.
        if body.message_id is not None:
            stored_message = session.execute(
                select(ChatMessage).where(
                    ChatMessage.id == body.message_id,
                    ChatMessage.session_id == body.session_id,
                )
            ).scalar_one_or_none()
            if stored_message is None:
                raise HTTPException(status_code=404, detail="Message not found in this session.")
            source_language = stored_message.source_language
            target_language = operator_language
        else:
            source_language = operator_language
            target_language = language_from_locale(session_language)

        bot_id = bot.id
        bot_client_id = bot.client_id
        session.expunge(bot)

    if not source_language or not target_language:
        raise HTTPException(status_code=409, detail="Source or target language is unknown for this request.")

    source_base = language_from_locale(source_language) or source_language
    if source_base == target_language:
        # Zero provider calls, and an honest response rather than a fake one.
        return {
            "translated": body.text,
            "target_locale": target_language,
            "cached": True,
            "status": "same_language",
        }

    if not translation_svc.charge_for_translation(bot, body.message_id, target_language):
        raise HTTPException(status_code=402, detail="Translation is unavailable on this plan or balance.")

    try:
        result = await translation_svc.translation_service.translate(
            body.text, source_base, target_language, bot_id=bot_id
        )
    except translation_svc.TranslationUnavailable:
        if body.message_id is not None:
            translation_svc.store_translation(body.message_id, target_language, status="failed")
        raise HTTPException(status_code=503, detail="Translation provider is unavailable. Try again.") from None

    if body.message_id is not None:
        translation_svc.store_translation(
            body.message_id,
            target_language,
            content=result.content,
            provider=result.provider,
            model=result.model,
        )

    logger.info(
        "translation_preview | client_id=%s bot_id=%s target=%s cached=%s",
        bot_client_id,
        bot_id,
        target_language,
        result.cached,
    )
    return {
        "translated": result.content,
        "target_locale": target_language,
        "cached": result.cached,
        "status": "ok",
    }


# Web Push subscription endpoints moved to app/api/push_routes.py, same URLs
# (`/operators/push/*`), separate router registered in main.py.
