import logging
import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel, field_validator
from sqlalchemy import func, select

from app.api.auth import get_superadmin
from app.core.security import get_password_hash
from app.db.models import ChatMessage, ChatSession, Client, PlatformFeedback
from app.db.session import get_session
from app.services.audit_service import record_audit

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/superadmin", tags=["superadmin"])

# Allowed resolution states for platform feedback.
FEEDBACK_STATUSES = ("open", "in_progress", "resolved", "closed")
# States that "close the loop" — they stamp resolved_at/by and notify the client.
FEEDBACK_RESOLVED_STATES = ("resolved", "closed")


class CreateClientRequest(BaseModel):
    name: str
    email: str
    password: str
    website: str | None = None


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
            raise HTTPException(status_code=400, detail="A client with this email already exists.")

        new_client = Client(
            name=request.name,
            email=request.email,
            hashed_password=get_password_hash(request.password),
            api_key=str(uuid.uuid4().hex),
            website=request.website,
            is_superadmin=False,
        )

        session.add(new_client)
        session.commit()
        session.refresh(new_client)

        logger.info(f"Superadmin {superadmin.id} created new client {new_client.id} ({new_client.name})")

        return {
            "message": "Client created successfully",
            "client_id": new_client.id,
            "api_key": new_client.api_key,
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
            raise HTTPException(status_code=404, detail="Client not found.")

        # Prevent superadmin from deleting themselves
        if client.id == superadmin.id:
            raise HTTPException(status_code=400, detail="You cannot delete your own account.")

        # Prevent deleting other superadmins
        if client.is_superadmin:
            raise HTTPException(status_code=400, detail="Cannot delete a superadmin account.")

        client_name = client.name
        client_email = client.email

        # Delete the client — CASCADE will remove all bots, documents, sessions, messages
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
    with get_session() as session:
        stmt = select(Client).order_by(Client.created_at.desc())
        clients = session.execute(stmt).scalars().all()

        return [
            {
                "id": c.id,
                "name": c.name,
                "email": c.email,
                "is_superadmin": c.is_superadmin,
                "superadmin_role": c.superadmin_role,
                "website": c.website,
                "suspended_at": c.suspended_at.isoformat() if c.suspended_at else None,
                "created_at": c.created_at.isoformat() if c.created_at else None,
            }
            for c in clients
        ]


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


@router.get("/platform-feedback")
def get_platform_feedback(
    status_filter: str | None = Query(None, alias="status"),
    superadmin: Client = Depends(get_superadmin),
):
    """
    Superadmin only: Get all free-text feedback submitted via the admin
    dashboard "Feedback" side tab. Optionally filter by resolution ``status``.
    """
    if status_filter is not None and status_filter not in FEEDBACK_STATUSES:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid status. Must be one of: {', '.join(FEEDBACK_STATUSES)}",
        )
    try:
        from app.db.repository import get_all_platform_feedback

        with get_session() as session:
            return get_all_platform_feedback(session, status=status_filter)
    except Exception as e:
        logger.error(f"Failed to fetch platform feedback: {e}")
        raise HTTPException(status_code=500, detail="Failed to load platform feedback.") from e


class PlatformFeedbackUpdate(BaseModel):
    status: str | None = None
    admin_response: str | None = None

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
    if body.status is not None and body.status not in FEEDBACK_STATUSES:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid status. Must be one of: {', '.join(FEEDBACK_STATUSES)}",
        )
    if body.status is None and body.admin_response is None:
        raise HTTPException(status_code=400, detail="Provide status and/or admin_response to update.")

    from app.services.notification_service import notify_feedback_resolved

    with get_session() as session:
        feedback = session.get(PlatformFeedback, feedback_id)
        if not feedback:
            raise HTTPException(status_code=404, detail="Feedback not found.")

        before = {
            "status": feedback.status,
            "admin_response": feedback.admin_response,
            "resolved_at": feedback.resolved_at.isoformat() if feedback.resolved_at else None,
            "resolved_by": feedback.resolved_by,
        }

        was_resolved = feedback.status in FEEDBACK_RESOLVED_STATES

        if body.admin_response is not None:
            feedback.admin_response = body.admin_response
        if body.status is not None:
            feedback.status = body.status

        now_resolved = feedback.status in FEEDBACK_RESOLVED_STATES
        # Stamp resolver metadata on the transition INTO a resolved state.
        if now_resolved and not was_resolved:
            feedback.resolved_at = datetime.now(UTC)
            feedback.resolved_by = superadmin.id
        elif not now_resolved:
            # Re-opened — clear the resolution stamp so the loop is consistent.
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
            "id": feedback.id,
            "message": feedback.message,
            "attachment_url": feedback.attachment_url,
            "category": feedback.category,
            "status": feedback.status,
            "admin_response": feedback.admin_response,
            "resolved_at": feedback.resolved_at.isoformat() if feedback.resolved_at else None,
            "created_at": feedback.created_at.isoformat() if feedback.created_at else None,
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
