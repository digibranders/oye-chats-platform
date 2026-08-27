import logging
import secrets
import uuid
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import case, distinct, func, or_, select

from app.api.auth import get_superadmin
from app.api.superadmin_plan_routes import _plan_monthly_usd_cents
from app.core.feedback import (
    FEEDBACK_AREAS,
    FEEDBACK_RESOLVED_STATES,
    FEEDBACK_SEVERITIES,
    FEEDBACK_STATUSES,
    FEEDBACK_TYPES,
)
from app.core.security import get_password_hash
from app.db.models import (
    Bot,
    ChatMessage,
    ChatSession,
    Client,
    CreditLedger,
    Invoice,
    Plan,
    PlatformFeedback,
    Subscription,
)
from app.db.session import get_session
from app.schemas.validators import EmailAddress, OptionalName, Password, RequiredName
from app.services.audit_service import record_audit

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/superadmin", tags=["superadmin"])


class CreateClientRequest(BaseModel):
    # Held to the same contract as ``/auth/register``. This path had no
    # validation at all, which made it the way to create an account whose
    # stored email cannot pass the login schema.
    name: RequiredName
    email: EmailAddress
    password: Password
    website: OptionalName = None


@router.post("/clients")
def create_client(request: CreateClientRequest, superadmin: Client = Depends(get_superadmin)):
    """
    Superadmin only: Create a new Client account.
    Client will create their own bots from the dashboard.
    """
    with get_session() as session:
        # Check if email exists
        stmt = select(Client).where(Client.email == request.email).limit(1)
        existing = session.execute(stmt).scalars().first()
        if existing:
            raise HTTPException(
                status_code=400,
                detail="An account with this email already exists. Please sign in instead.",
            )

        new_client = Client(
            name=request.name,
            email=request.email,
            hashed_password=get_password_hash(request.password),
            api_key=str(uuid.uuid4().hex),
            website=request.website,
            is_superadmin=False,
        )

        # This provisions a real paying customer, not platform staff, the
        # ``is_superadmin`` bypass in ``require_verified_email`` does not cover
        # them, so they verify like any other account. Mirrors the OTP handling
        # in ``/auth/register``: same 15-minute window, same double-gated
        # dev auto-verify, same non-production OTP logging.
        otp = str(secrets.randbelow(900000) + 100000)
        new_client.email_otp = otp
        new_client.email_otp_expires_at = datetime.now(UTC) + timedelta(minutes=15)
        from app.config import APP_ENV, DEV_AUTO_VERIFY_EMAIL

        new_client.is_verified = DEV_AUTO_VERIFY_EMAIL

        session.add(new_client)
        session.commit()
        session.refresh(new_client)

        if DEV_AUTO_VERIFY_EMAIL:
            logger.info("[DEV] auto-verified %s (local email delivery is gated)", new_client.email)
        elif APP_ENV != "production":
            logger.info("[DEV] email verification OTP for %s: %s", new_client.email, otp)

        # Fire after commit and swallow failures, a transient provider error
        # must never roll back a created client. The recipient can always pull a
        # fresh code from the "Resend code" action on /verify-email.
        try:
            from app.services.email_service import send_verification_otp_email

            send_verification_otp_email(new_client.email, new_client.name, otp)
        except Exception as mail_err:
            logger.warning("verification_otp_email_failed for client %s: %s", new_client.id, mail_err)

        logger.info(f"Superadmin {superadmin.id} created new client {new_client.id} ({new_client.name})")

        return {
            "message": "Client created successfully",
            "client_id": new_client.id,
            "api_key": new_client.api_key,
            "is_verified": bool(new_client.is_verified),
        }


@router.delete("/clients/{client_id}")
def delete_client(client_id: int, superadmin: Client = Depends(get_superadmin)):
    """
    Superadmin only: Delete a client and ALL their data (bots, documents, sessions, messages).
    Cannot delete yourself (the superadmin account).
    """
    with get_session() as session:
        stmt = select(Client).where(Client.id == client_id)
        client = session.execute(stmt).scalars().first()

        if not client:
            raise HTTPException(status_code=404, detail="Account not found.")

        # Prevent superadmin from deleting themselves
        if client.id == superadmin.id:
            raise HTTPException(status_code=400, detail="You cannot delete your own account.")

        # Prevent deleting other superadmins
        if client.is_superadmin:
            raise HTTPException(status_code=400, detail="Cannot delete a superadmin account.")

        # Issued tax documents are statutory records (Section 36: 72-month
        # retention) and their serials are gapless, a CASCADE delete would
        # leave permanent, unexplainable holes in the FY series and destroy
        # the substantiation behind filed GSTR returns.
        has_issued_invoice = (
            session.execute(
                select(Invoice.id).where(Invoice.client_id == client_id, Invoice.invoice_number.isnot(None)).limit(1)
            ).scalar()
            is not None
        )
        if has_issued_invoice:
            raise HTTPException(
                status_code=409,
                detail=(
                    "Client has issued tax invoices, which must be retained for GST compliance. "
                    "Suspend the account instead of deleting it."
                ),
            )

        client_name = client.name
        client_email = client.email

        # Delete the client. CASCADE will remove all bots, documents, sessions, messages
        session.delete(client)
        session.commit()

        logger.info(f"Superadmin {superadmin.id} deleted client {client_id} ({client_name}, {client_email})")

        return {
            "message": f"Client '{client_name}' and all associated data deleted successfully.",
            "deleted_client_id": client_id,
        }


@router.get("/clients")
def list_clients(superadmin: Client = Depends(get_superadmin)):
    """
    Superadmin only: Get all clients on the platform.
    """
    active_statuses = ("active", "trialing", "past_due")
    with get_session() as session:
        stmt = select(Client).order_by(Client.created_at.desc())
        clients = session.execute(stmt).scalars().all()
        client_ids = [c.id for c in clients]

        # Batch-load subscriptions + plans (no N+1) to derive each client's
        # current plan. With per-bot billing a client may hold several
        # subscriptions, so pick the "primary" one: prefer an active/trialing/
        # past_due subscription, then the most recently created.
        subs = (
            session.execute(select(Subscription).where(Subscription.client_id.in_(client_ids))).scalars().all()
            if client_ids
            else []
        )
        plan_by_id = {
            p.id: p
            for p in (
                session.execute(select(Plan).where(Plan.id.in_({s.plan_id for s in subs}))).scalars().all()
                if subs
                else []
            )
        }

        def _better(candidate: Subscription, current: Subscription | None) -> bool:
            if current is None:
                return True
            cand_active = candidate.status in active_statuses
            cur_active = current.status in active_statuses
            if cand_active != cur_active:
                return cand_active
            if candidate.created_at is None:
                return False
            if current.created_at is None:
                return True
            return candidate.created_at > current.created_at

        primary_sub: dict[int, Subscription] = {}
        active_counts: dict[int, int] = {}
        mrr_by_client: dict[int, int] = {}
        mrr_statuses = ("active", "trialing")  # matches /superadmin/revenue
        for s in subs:
            if s.status in active_statuses:
                active_counts[s.client_id] = active_counts.get(s.client_id, 0) + 1
            if s.status in mrr_statuses:
                p = plan_by_id.get(s.plan_id)
                if p:
                    mrr_by_client[s.client_id] = mrr_by_client.get(s.client_id, 0) + (
                        _plan_monthly_usd_cents(p, s.billing_cycle) * s.operator_quantity
                    )
            if _better(s, primary_sub.get(s.client_id)):
                primary_sub[s.client_id] = s

        # Bots per client + current credit balance (SUM(delta), the ledger's
        # documented source of truth). Both batch-loaded, one grouped query each.
        bots_by_client = (
            dict(
                session.execute(
                    select(Bot.client_id, func.count(Bot.id))
                    .where(Bot.client_id.in_(client_ids))
                    .group_by(Bot.client_id)
                ).all()
            )
            if client_ids
            else {}
        )
        credits_by_client = (
            dict(
                session.execute(
                    select(CreditLedger.client_id, func.coalesce(func.sum(CreditLedger.delta), 0))
                    .where(CreditLedger.client_id.in_(client_ids))
                    .group_by(CreditLedger.client_id)
                ).all()
            )
            if client_ids
            else {}
        )

        # Per-client conversation engagement, each a single grouped query so the
        # accounts table can show these columns without an N+1. Definitions match
        # the client-detail endpoint and /command-center:
        #   visitors   . distinct people (not conversations) — see fingerprint below
        #   bant       . sessions whose BANT tier reached mql/sal/sql
        #   handoffs   . sessions escalated to a human (operator assigned OR a
        #                handoff reason recorded — the reason survives after close)
        #   quotations . sessions whose pre-handoff quotation flow completed
        #
        # Distinct-visitor fingerprint = "<ip>--<device>", the same identity the
        # per-bot visitor analytics use (analytics_routes.py). ``location`` holds
        # "City, Country | 1.2.3.4" (or "IP: 1.2.3.4"); the IP is the part after
        # " | " when present, else the whole value, with empty/NULL → "Unknown".
        _raw_loc = func.coalesce(func.nullif(ChatSession.location, ""), "Unknown")
        _fingerprint = case(
            (_raw_loc.like("% | %"), func.split_part(_raw_loc, " | ", 2)),
            else_=_raw_loc,
        ).concat("--").concat(func.coalesce(ChatSession.device, ""))
        if client_ids:
            visitors_by_client = dict(
                session.execute(
                    select(ChatSession.client_id, func.count(distinct(_fingerprint)))
                    .where(ChatSession.client_id.in_(client_ids))
                    .group_by(ChatSession.client_id)
                ).all()
            )
            bant_by_client = dict(
                session.execute(
                    select(ChatSession.client_id, func.count(ChatSession.id))
                    .where(
                        ChatSession.client_id.in_(client_ids),
                        ChatSession.bant_tier.in_(("mql", "sal", "sql")),
                    )
                    .group_by(ChatSession.client_id)
                ).all()
            )
            handoffs_by_client = dict(
                session.execute(
                    select(ChatSession.client_id, func.count(ChatSession.id))
                    .where(
                        ChatSession.client_id.in_(client_ids),
                        or_(
                            ChatSession.assigned_operator_id.isnot(None),
                            ChatSession.handoff_reason.isnot(None),
                        ),
                    )
                    .group_by(ChatSession.client_id)
                ).all()
            )
            quotations_by_client = dict(
                session.execute(
                    select(ChatSession.client_id, func.count(ChatSession.id))
                    .where(
                        ChatSession.client_id.in_(client_ids),
                        ChatSession.quotation_state["status"].astext == "complete",
                    )
                    .group_by(ChatSession.client_id)
                ).all()
            )
        else:
            visitors_by_client = {}
            bant_by_client = {}
            handoffs_by_client = {}
            quotations_by_client = {}

        result = []
        for c in clients:
            sub = primary_sub.get(c.id)
            plan = plan_by_id.get(sub.plan_id) if sub else None
            result.append(
                {
                    "id": c.id,
                    "name": c.name,
                    "email": c.email,
                    "is_superadmin": c.is_superadmin,
                    "superadmin_role": c.superadmin_role,
                    "website": c.website,
                    "country": c.billing_country,
                    "suspended_at": c.suspended_at.isoformat() if c.suspended_at else None,
                    "plan_name": plan.name if plan else None,
                    "plan_slug": plan.slug if plan else None,
                    "subscription_status": sub.status if sub else None,
                    "active_subscriptions": active_counts.get(c.id, 0),
                    "mrr_cents": mrr_by_client.get(c.id, 0),
                    "bots_count": bots_by_client.get(c.id, 0),
                    "credits_balance": credits_by_client.get(c.id, 0),
                    "distinct_visitors": visitors_by_client.get(c.id, 0),
                    "bant_qualified_leads": bant_by_client.get(c.id, 0),
                    "operator_transfers": handoffs_by_client.get(c.id, 0),
                    "quotations_completed": quotations_by_client.get(c.id, 0),
                    "created_at": c.created_at.isoformat() if c.created_at else None,
                }
            )
        return result


@router.get("/stats")
def get_global_stats(superadmin: Client = Depends(get_superadmin)):
    """
    Superadmin only: Get aggregate global usage stats (Total Clients, Total Messages).
    """
    with get_session() as session:
        total_clients = session.execute(select(func.count(Client.id))).scalar() or 0
        total_messages = session.execute(select(func.count(ChatMessage.id))).scalar() or 0
        total_sessions = session.execute(select(func.count(ChatSession.id))).scalar() or 0

        return {"total_clients": total_clients, "total_messages": total_messages, "total_sessions": total_sessions}


@router.get("/feedback")
def get_global_feedback(superadmin: Client = Depends(get_superadmin)):
    """
    Superadmin only: Get all feedback across all clients.
    """
    try:
        from app.db.repository import get_global_feedback_data

        with get_session() as session:
            data = get_global_feedback_data(session)

            # Map raw session IDs to chronologically assigned user numbers per client
            session_to_user_map = {}
            client_counters = {}

            for item in data:
                sid = item["session_id"]
                cid = item["client_name"]

                if cid not in client_counters:
                    client_counters[cid] = 1

                if sid not in session_to_user_map:
                    session_to_user_map[sid] = f"User {client_counters[cid]}"
                    client_counters[cid] += 1

                # Replace the raw UUID with the readable name
                item["user"] = session_to_user_map[sid]
                # Remove raw session_id
                del item["session_id"]

            # Reverse order to show newest feedback first
            return sorted(data, key=lambda x: x["created_at"], reverse=True)

    except Exception as e:
        logger.error(f"Failed to fetch global feedback logs: {e}")
        raise HTTPException(status_code=500, detail="Failed to load feedback data.") from e


def _validate_feedback_filter(value: str | None, allowed: tuple[str, ...], field: str) -> None:
    if value is not None and value not in allowed:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid {field}. Must be one of: {', '.join(allowed)}",
        )


@router.get("/platform-feedback")
def get_platform_feedback(
    status_filter: str | None = Query(None, alias="status", max_length=64),
    type_filter: str | None = Query(None, alias="type", max_length=64),
    area_filter: str | None = Query(None, alias="area", max_length=64),
    severity_filter: str | None = Query(None, alias="severity", max_length=64),
    superadmin: Client = Depends(get_superadmin),
):
    """
    Superadmin only: Get all customer-submitted platform feedback. Optionally
    filter by resolution ``status`` and/or taxonomy (``type``/``area``/``severity``).
    """
    _validate_feedback_filter(status_filter, FEEDBACK_STATUSES, "status")
    _validate_feedback_filter(type_filter, FEEDBACK_TYPES, "type")
    _validate_feedback_filter(area_filter, FEEDBACK_AREAS, "area")
    _validate_feedback_filter(severity_filter, FEEDBACK_SEVERITIES, "severity")
    try:
        from app.db.repository import get_all_platform_feedback

        with get_session() as session:
            return get_all_platform_feedback(
                session,
                status=status_filter,
                type_=type_filter,
                area=area_filter,
                severity=severity_filter,
            )
    except Exception as e:
        logger.error(f"Failed to fetch platform feedback: {e}")
        raise HTTPException(status_code=500, detail="Failed to load platform feedback.") from e


class PlatformFeedbackUpdate(BaseModel):
    # Allow-listed in the handler against ``FEEDBACK_STATUSES``, which answers 400 with the
    # permitted set. Bounded here rather than re-declared as a ``Literal``:
    # two copies of one allow-list drift, and moving the rejection into the
    # schema would silently change this endpoint's status code.
    status: str | None = Field(default=None, max_length=64)
    admin_response: str | None = None
    # Optional re-classification during triage. Each is checked against the
    # same allow-list the create path uses (``app.core.feedback``).
    type: str | None = Field(default=None, max_length=64)
    area: str | None = Field(default=None, max_length=64)
    severity: str | None = Field(default=None, max_length=64)

    @field_validator("admin_response")
    @classmethod
    def response_trimmed(cls, v: str | None) -> str | None:
        if v is None:
            return None
        v = v.strip()
        if len(v) > 5000:
            raise ValueError("admin_response must be 5000 characters or fewer")
        return v or None


@router.patch("/platform-feedback/{feedback_id}")
def update_platform_feedback(
    feedback_id: int,
    body: PlatformFeedbackUpdate,
    request: Request,
    superadmin: Client = Depends(get_superadmin),
):
    """
    Superadmin only: triage/resolve a customer's platform feedback.

    Updates ``status`` and/or ``admin_response``. Transitioning into a resolved
    state (``resolved``/``closed``) stamps ``resolved_at``/``resolved_by`` and
    enqueues an in-app notification for the owning client. Audit-logged.
    """
    if getattr(superadmin, "superadmin_role", None) == "readonly":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Read-only super-admin: writes are not permitted.",
        )
    _validate_feedback_filter(body.status, FEEDBACK_STATUSES, "status")
    _validate_feedback_filter(body.type, FEEDBACK_TYPES, "type")
    _validate_feedback_filter(body.area, FEEDBACK_AREAS, "area")
    _validate_feedback_filter(body.severity, FEEDBACK_SEVERITIES, "severity")
    if all(v is None for v in (body.status, body.admin_response, body.type, body.area, body.severity)):
        raise HTTPException(status_code=400, detail="Provide a field to update.")

    from app.db.repository import _serialize_platform_feedback
    from app.services.notification_service import notify_feedback_resolved

    with get_session() as session:
        feedback = session.get(PlatformFeedback, feedback_id)
        if not feedback:
            raise HTTPException(status_code=404, detail="Feedback not found.")

        before = {
            "status": feedback.status,
            "admin_response": feedback.admin_response,
            "type": feedback.type,
            "area": feedback.area,
            "severity": feedback.severity,
            "resolved_at": feedback.resolved_at.isoformat() if feedback.resolved_at else None,
            "resolved_by": feedback.resolved_by,
        }

        was_resolved = feedback.status in FEEDBACK_RESOLVED_STATES

        if body.admin_response is not None:
            feedback.admin_response = body.admin_response
        if body.status is not None:
            feedback.status = body.status
        if body.type is not None:
            feedback.type = body.type
        if body.area is not None:
            feedback.area = body.area
        if body.severity is not None:
            feedback.severity = body.severity
        # Severity is bug-only. Clear it whenever the (possibly re-classified)
        # type is not a bug, regardless of which field changed this request.
        if feedback.type != "bug":
            feedback.severity = None

        now_resolved = feedback.status in FEEDBACK_RESOLVED_STATES
        # Stamp resolver metadata on the transition INTO a resolved state.
        if now_resolved and not was_resolved:
            feedback.resolved_at = datetime.now(UTC)
            feedback.resolved_by = superadmin.id
        elif not now_resolved:
            # Re-opened. Clear the resolution stamp so the loop is consistent.
            feedback.resolved_at = None
            feedback.resolved_by = None

        session.flush()

        record_audit(
            session,
            actor=superadmin,
            action="platform_feedback.update",
            target_type="platform_feedback",
            target_id=feedback.id,
            before=before,
            after={
                "status": feedback.status,
                "admin_response": feedback.admin_response,
                "type": feedback.type,
                "area": feedback.area,
                "severity": feedback.severity,
                "resolved_at": feedback.resolved_at.isoformat() if feedback.resolved_at else None,
                "resolved_by": feedback.resolved_by,
            },
            request=request,
        )

        # Notify the owning client only on the transition into resolved.
        notify_resolved = now_resolved and not was_resolved and feedback.client_id is not None
        notify_args = (
            {
                "client_id": feedback.client_id,
                "feedback_id": feedback.id,
                "message_preview": feedback.message,
                "admin_response": feedback.admin_response,
            }
            if notify_resolved
            else None
        )

        result = {
            "client_id": feedback.client_id,
            "resolved_by": feedback.resolved_by,
            **_serialize_platform_feedback(feedback),
        }
        session.commit()

    # Notification is created in its own session after the update commits so a
    # broadcast failure can never roll back the resolution.
    if notify_args is not None:
        try:
            with get_session() as notif_session:
                notify_feedback_resolved(notif_session, **notify_args)
        except Exception:
            logger.exception("Failed to enqueue feedback_resolved notification for feedback %s", feedback_id)

    return result
