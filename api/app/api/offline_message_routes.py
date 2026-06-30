"""Offline message endpoints — messages left by visitors when no operator is available."""

import logging
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select
from sqlalchemy.sql import func

from app.api.auth import get_current_client_or_operator
from app.db.models import Bot, OfflineMessage
from app.db.session import get_session
from app.services.email_service import (
    get_notification_recipients,
    send_offline_message_email,
    send_unavailable_callback_email,
    send_visitor_confirmation_email,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/offline-messages", tags=["offline-messages"])


# ── Request / Response Models ──


class SubmitOfflineMessageRequest(BaseModel):
    bot_key: str = Field(..., max_length=100)
    name: str = Field(..., min_length=1, max_length=200)
    email: str = Field(..., max_length=320)
    phone: str | None = Field(None, max_length=30)
    message: str = Field(..., min_length=1, max_length=5000)
    session_id: str | None = Field(None, max_length=100)
    department_id: int | None = None

    @field_validator("email")
    @classmethod
    def valid_email(cls, v):
        import re

        v = v.strip().lower()
        pattern = r"^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$"
        if not re.match(pattern, v):
            raise ValueError("Please enter a valid email address.")
        return v


class UpdateOfflineMessageRequest(BaseModel):
    status: str | None = None  # read|replied


# ── Public Endpoint (Widget) ──


@router.post("")
async def submit_offline_message(request: SubmitOfflineMessageRequest):
    """Submit an offline message (called by widget when no agent is available)."""
    with get_session() as session:
        bot = session.execute(
            select(Bot).where(Bot.bot_key == request.bot_key, Bot.is_active.is_(True))
        ).scalar_one_or_none()
        if not bot:
            raise HTTPException(status_code=404, detail="Bot not found.")

        msg = OfflineMessage(
            bot_id=bot.id,
            session_id=request.session_id,
            department_id=request.department_id,
            visitor_name=request.name.strip(),
            visitor_email=request.email.strip().lower(),
            visitor_phone=request.phone,
            message_body=request.message.strip(),
        )
        session.add(msg)
        session.commit()

        # Send team notification emails (multi-recipient)
        reply_to = bot.reply_to_email
        email_on_offline = getattr(bot, "email_on_offline", True)
        if not email_on_offline:
            logger.warning(
                "Offline team-notification skipped — email_on_offline=False on bot %s",
                bot.id,
            )
        else:
            recipients = get_notification_recipients(bot, "offline_message")
            if not recipients:
                # This was silently no-op before. If the bot has no
                # notification_email or notification_emails["offline_message"]
                # configured, the team literally cannot be notified — log
                # loudly so ops sees it in the first failure case.
                logger.warning(
                    "Offline team-notification not dispatched — bot %s has no notification recipients "
                    "(check bot.notification_emails['offline_message'] or bot.notification_email)",
                    bot.id,
                )
            for recipient in recipients:
                if request.phone and request.phone.strip():
                    send_unavailable_callback_email(
                        notification_email=recipient,
                        bot_name=bot.name,
                        contact={
                            "name": request.name.strip(),
                            "email": request.email.strip(),
                            "phone": request.phone.strip(),
                        },
                        reply_to=reply_to,
                    )
                else:
                    send_offline_message_email(
                        notification_email=recipient,
                        bot_name=bot.name,
                        visitor_name=request.name.strip(),
                        visitor_email=request.email.strip(),
                        message_preview=request.message.strip()[:200],
                        reply_to=reply_to,
                    )

        # Send visitor confirmation email
        if getattr(bot, "email_visitor_confirmation", True):
            send_visitor_confirmation_email(
                to_email=request.email.strip(),
                bot_name=bot.name,
                visitor_name=request.name.strip(),
                reply_to=reply_to,
            )
        else:
            logger.warning(
                "Visitor confirmation email skipped — email_visitor_confirmation=False on bot %s",
                bot.id,
            )

        logger.info(f"Offline message saved: {msg.id} from {request.email} for bot {bot.id}")

    # Notify connected operators about new offline message (live-chat console).
    from app.services.live_chat_service import manager

    notification = {
        "type": "offline_message_received",
        "visitor_name": request.name.strip(),
        "message_preview": request.message.strip()[:100],
    }
    for operator_id in list(manager.operator_connections.keys()):
        await manager._send_to_operator(operator_id, notification)

    # Drop a workspace-scoped notification into the bell so it survives a
    # reload + reaches operators on any page in the admin dashboard.
    try:
        from app.services.notification_service import notify_offline_message

        with get_session() as ns_session:
            # Re-read bot inside this session so the relationship is live for
            # the notification factory (the previous `bot` object is detached).
            bot_row = ns_session.execute(select(Bot).where(Bot.bot_key == request.bot_key)).scalar_one_or_none()
            if bot_row is not None:
                notify_offline_message(
                    ns_session,
                    client_id=bot_row.client_id,
                    visitor_name=request.name.strip(),
                    visitor_email=request.email.strip(),
                    message_preview=request.message.strip(),
                    offline_message_id=msg.id,
                    bot_name=bot_row.name,
                )
    except Exception:
        logger.exception("Failed to record offline_message notification")

    return {"success": True, "message": "Your message has been sent. We'll get back to you soon!"}


# ── Admin Endpoints ──


@router.get("")
def list_offline_messages(
    status_filter: str | None = Query(None, alias="status"),
    bot_id: int | None = None,
    page: int = Query(1, ge=1),
    limit: int = Query(20, ge=1, le=100),
    auth=Depends(get_current_client_or_operator),
):
    """List offline messages for the authenticated client/agent's bots."""
    client_id = auth["client_id"]
    with get_session() as session:
        # Get client's bot IDs
        bot_ids = [bid for (bid,) in session.execute(select(Bot.id).where(Bot.client_id == client_id)).all()]
        if not bot_ids:
            return {"messages": [], "total": 0, "page": page}

        query = select(OfflineMessage).where(OfflineMessage.bot_id.in_(bot_ids))

        if status_filter:
            query = query.where(OfflineMessage.status == status_filter)
        if bot_id:
            query = query.where(OfflineMessage.bot_id == bot_id)

        # Total count
        count_query = select(func.count()).select_from(OfflineMessage).where(OfflineMessage.bot_id.in_(bot_ids))
        if status_filter:
            count_query = count_query.where(OfflineMessage.status == status_filter)
        if bot_id:
            count_query = count_query.where(OfflineMessage.bot_id == bot_id)
        total = session.execute(count_query).scalar()

        # Paginate
        messages = (
            session.execute(query.order_by(OfflineMessage.created_at.desc()).offset((page - 1) * limit).limit(limit))
            .scalars()
            .all()
        )

        # Get bot names
        bot_names = {}
        if messages:
            unique_bot_ids = {m.bot_id for m in messages}
            for b in session.execute(select(Bot).where(Bot.id.in_(unique_bot_ids))).scalars().all():
                bot_names[b.id] = b.name

        return {
            "messages": [
                {
                    "id": m.id,
                    "bot_id": m.bot_id,
                    "bot_name": bot_names.get(m.bot_id),
                    "visitor_name": m.visitor_name,
                    "visitor_email": m.visitor_email,
                    "visitor_phone": m.visitor_phone,
                    "message_body": m.message_body,
                    "status": m.status,
                    "department_id": m.department_id,
                    "created_at": m.created_at.isoformat() if m.created_at else None,
                    "read_at": m.read_at.isoformat() if m.read_at else None,
                    "replied_at": m.replied_at.isoformat() if m.replied_at else None,
                }
                for m in messages
            ],
            "total": total,
            "page": page,
        }


@router.patch("/{message_id}")
def update_offline_message(
    message_id: int,
    request: UpdateOfflineMessageRequest,
    auth=Depends(get_current_client_or_operator),
):
    """Update an offline message status (mark as read/replied)."""
    client_id = auth["client_id"]
    with get_session() as session:
        msg = session.execute(select(OfflineMessage).where(OfflineMessage.id == message_id)).scalar_one_or_none()
        if not msg:
            raise HTTPException(status_code=404, detail="Message not found.")

        # Verify ownership
        bot = session.execute(select(Bot).where(Bot.id == msg.bot_id)).scalar_one_or_none()
        if not bot or bot.client_id != client_id:
            raise HTTPException(status_code=403, detail="Access denied.")

        if request.status == "read" and msg.status == "new":
            msg.status = "read"
            msg.read_at = datetime.now(UTC)
        elif request.status == "replied":
            msg.status = "replied"
            msg.replied_at = datetime.now(UTC)
            if not msg.read_at:
                msg.read_at = datetime.now(UTC)

        session.commit()
        return {"success": True, "status": msg.status}


@router.delete("/{message_id}")
def delete_offline_message(message_id: int, auth=Depends(get_current_client_or_operator)):
    """Delete an offline message."""
    client_id = auth["client_id"]
    with get_session() as session:
        msg = session.execute(select(OfflineMessage).where(OfflineMessage.id == message_id)).scalar_one_or_none()
        if not msg:
            raise HTTPException(status_code=404, detail="Message not found.")

        bot = session.execute(select(Bot).where(Bot.id == msg.bot_id)).scalar_one_or_none()
        if not bot or bot.client_id != client_id:
            raise HTTPException(status_code=403, detail="Access denied.")

        session.delete(msg)
        session.commit()
        return {"success": True}
