"""Offline message endpoints — messages left by visitors when no operator is available."""

import logging
from datetime import UTC, datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request
from pydantic import BaseModel
from slowapi.util import get_remote_address
from sqlalchemy import select
from sqlalchemy.sql import func

from app.api.auth import get_current_client_or_operator
from app.core.rate_limit import limiter
from app.db.models import Bot, OfflineMessage
from app.db.session import get_session
from app.schemas.validators import (
    BotKey,
    EmailAddress,
    Name,
    Phone,
    RequiredLongText,
    RequiredName,
    RowId,
    SessionId,
    bounded_list,
)
from app.schemas.ws import MAX_TRANSCRIPT_TURNS, TranscriptTurn
from app.services.email_service import (
    get_notification_recipients,
    redact_email,
    send_offline_message_email,
    send_unavailable_callback_email,
    send_visitor_confirmation_email,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/offline-messages", tags=["offline-messages"])


# ── Request / Response Models ──


class SubmitOfflineMessageRequest(BaseModel):
    """Unauthenticated widget submission — the bot key is the only credential.

    ``reason`` and ``transcript`` were undeclared here while the widget has
    been sending both since the fallback-reason feature shipped. Pydantic's
    default is to ignore unknown keys, so on this path they were parsed and
    dropped — the columns stayed null and the admin inbox showed no fallback
    cause, while the WebSocket fallback (``submit_offline_form``) stored them
    correctly. Declaring them is the fix: same fields, same bounds, same
    behaviour on both paths.
    """

    bot_key: BotKey
    name: RequiredName
    email: EmailAddress
    phone: Phone | None = None
    message: RequiredLongText
    session_id: SessionId | None = None
    department_id: RowId | None = None
    # Resolver state at the moment the visitor fell back to the form
    # (``no_operators``, ``out_of_hours``, ``queue_timeout``, …). Drives the
    # admin filter and the "why so many of these?" analytics.
    reason: Name = "manual"
    # Bot turns preceding the fallback, so the replying operator has context.
    # Same shape and cap as the WebSocket frame.
    transcript: Annotated[list[TranscriptTurn], bounded_list(MAX_TRANSCRIPT_TURNS)] | None = None


class UpdateOfflineMessageRequest(BaseModel):
    # ``new`` is the initial state; an admin moves a message to ``read`` or
    # ``replied``. Previously a free ``str`` compared against the same three
    # values downstream, so anything else silently no-opped.
    status: Literal["new", "read", "replied"] | None = None


# ── Public Endpoint (Widget) ──


@router.post("")
@limiter.limit("5/minute", key_func=get_remote_address)
async def submit_offline_message(request: Request, body: SubmitOfflineMessageRequest):
    """Submit an offline message (called by widget when no agent is available).

    Unauthenticated by necessity — it is the out-of-hours form on a public
    widget, and the bot key it carries is public too. Every accepted submission
    fans out to real inboxes: one e-mail per configured team recipient, PLUS a
    confirmation to whatever address the CALLER typed. Ungated that is an
    e-mail amplifier — a script with a bot key lifted from any customer's page
    could bury that customer's team in mail and, because the confirmation goes
    to an attacker-chosen recipient, use our sending domain to spray a third
    party. The per-IP ceiling here is well above what a human filling in a form
    can reach and turns the amplifier into a trickle.
    """
    with get_session() as session:
        bot = session.execute(
            select(Bot).where(Bot.bot_key == body.bot_key, Bot.is_active.is_(True))
        ).scalar_one_or_none()
        if not bot:
            raise HTTPException(status_code=404, detail="Bot not found.")

        msg = OfflineMessage(
            bot_id=bot.id,
            session_id=body.session_id,
            department_id=body.department_id,
            visitor_name=body.name.strip(),
            visitor_email=body.email.strip().lower(),
            visitor_phone=body.phone,
            message_body=body.message.strip(),
            fallback_reason=body.reason,
            transcript=[turn.model_dump() for turn in body.transcript] if body.transcript else None,
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
                if body.phone and body.phone.strip():
                    send_unavailable_callback_email(
                        notification_email=recipient,
                        bot_name=bot.name,
                        contact={
                            "name": body.name.strip(),
                            "email": body.email.strip(),
                            "phone": body.phone.strip(),
                        },
                        reply_to=reply_to,
                    )
                else:
                    send_offline_message_email(
                        notification_email=recipient,
                        bot_name=bot.name,
                        visitor_name=body.name.strip(),
                        visitor_email=body.email.strip(),
                        message_preview=body.message.strip()[:200],
                        reply_to=reply_to,
                    )

        # Send visitor confirmation email
        if getattr(bot, "email_visitor_confirmation", True):
            send_visitor_confirmation_email(
                to_email=body.email.strip(),
                company_name=(bot.company_name or bot.name),
                visitor_name=body.name.strip(),
                reply_to=reply_to,
            )
        else:
            logger.warning(
                "Visitor confirmation email skipped — email_visitor_confirmation=False on bot %s",
                bot.id,
            )

        # PRIVACY — ``body.email`` is the visitor's, straight off the offline
        # form, and this INFO record becomes a Sentry breadcrumb. The message id
        # is the join key to the stored row; the domain is all the log needs.
        logger.info(f"Offline message saved: {msg.id} from {redact_email(body.email)} for bot {bot.id}")

        # Capture the workspace id while the row is still session-attached; the
        # operator fan-out below runs after this block closes, where ``bot`` is
        # detached and attribute access would raise DetachedInstanceError.
        notify_client_id = bot.client_id

    # Notify connected operators about new offline message (live-chat console).
    #
    # "Who is connected" MUST come from Redis presence, not from this process's
    # ``manager.operator_connections``. A fresh ``manager`` in another process has
    # an always-empty socket table, so iterating it here notified nobody whenever
    # the submission landed on a process that happened to hold no operator
    # sockets — and the Web Push fan-out below does not cover the gap, because it
    # deliberately skips operators "currently on WS" using that same Redis
    # presence, which correctly reports them online. Both channels stayed silent
    # and the notification was lost outright.
    #
    # ``worker/tasks.py`` hit this exact bug and fixed it the same way; this call
    # site was simply missed. Delivery goes through the backplane so the frame
    # reaches the operator wherever their socket actually lives.
    from app.services.live_chat_service import manager
    from app.services.operator_presence_service import get_online_operator_ids
    from app.services.ws_backplane import deliver_to_operator

    notification = {
        "type": "offline_message_received",
        "visitor_name": body.name.strip(),
        "message_preview": body.message.strip()[:100],
    }
    # UNION of Redis presence and this process's own sockets, never just one of
    # them. Presence alone would be a regression: it lags a socket by up to one
    # heartbeat, so an operator who has just connected here would be skipped
    # where the old local-only loop reached them. Local sockets alone is the bug
    # being fixed. The union is strictly a superset of the old behaviour, which
    # is what makes this safe to ship with the backplane flag still off.
    targets: set[int] = set(manager.operator_connections.keys())
    try:
        targets |= set(get_online_operator_ids(notify_client_id))
    except Exception:
        # Presence is best-effort; degrade to local-only rather than dropping.
        logger.warning("offline_message: presence lookup failed, using local sockets", exc_info=True)

    for operator_id in targets:
        await deliver_to_operator(manager, operator_id, notification)

    # Fan out a Web Push to off-WS operators + workspace owner so out-of-hours
    # submissions surface as OS notifications, not just emails. The task skips
    # operators currently on WS (they got the frame above).
    try:
        from app.worker.enqueue import enqueue_sync

        enqueue_sync("task_dispatch_offline_message_push", msg.id)
    except Exception:
        logger.exception(
            "Failed to enqueue offline-message push for message=%s bot=%s",
            msg.id,
            bot.id,
        )

    # Drop a workspace-scoped notification into the bell so it survives a
    # reload + reaches operators on any page in the admin dashboard.
    try:
        from app.services.notification_service import notify_offline_message

        with get_session() as ns_session:
            # Re-read bot inside this session so the relationship is live for
            # the notification factory (the previous `bot` object is detached).
            bot_row = ns_session.execute(select(Bot).where(Bot.bot_key == body.bot_key)).scalar_one_or_none()
            if bot_row is not None:
                notify_offline_message(
                    ns_session,
                    client_id=bot_row.client_id,
                    visitor_name=body.name.strip(),
                    visitor_email=body.email.strip(),
                    message_preview=body.message.strip(),
                    offline_message_id=msg.id,
                    bot_name=bot_row.name,
                )
    except Exception:
        logger.exception("Failed to record offline_message notification")

    return {"success": True, "message": "Your message has been sent. We'll get back to you soon!"}


# ── Admin Endpoints ──


@router.get("")
def list_offline_messages(
    status_filter: Literal["new", "read", "replied"] | None = Query(None, alias="status"),
    bot_id: RowId | None = Query(None),
    page: int = Query(1, ge=1),
    limit: int = Query(20, ge=1, le=100),
    acting_as: str | None = Header(None, alias="X-Acting-Role", max_length=32),
    auth=Depends(get_current_client_or_operator),
):
    """List offline messages for the authenticated client / operator.

    Client / workspace-owner sessions see every bot in the workspace.
    Operator sessions are one-to-one with a bot — they see messages for that
    bot only, and the operator's ``bot_id`` overrides any ``bot_id`` query
    parameter so a modified request can't peek at a sibling bot's inbox.
    """
    client_id = auth["client_id"]
    with get_session() as session:
        # Get client's bot IDs
        bot_ids = [bid for (bid,) in session.execute(select(Bot.id).where(Bot.client_id == client_id)).all()]

        # Operator scoping: collapse the workspace's bot list down to the one
        # bot this operator is bound to. Overrides any ``bot_id`` query param
        # so an operator can't peek at a sibling bot's messages by changing
        # the URL. Falls back to the entity attribute if the auth resolver's
        # cached ``bot_id`` field isn't populated (older code path).
        if auth["type"] == "operator":
            operator_bot_id = auth.get("bot_id") or getattr(auth.get("entity"), "bot_id", None)
            if operator_bot_id is None or operator_bot_id not in bot_ids:
                return {"messages": [], "total": 0, "page": page}
            bot_ids = [operator_bot_id]
            bot_id = operator_bot_id
        elif auth["type"] == "client" and (acting_as or "").lower() == "operator":
            # Self-operator path — owner added themselves as operator in their
            # own workspace and the switcher pill is in "operator" mode. Look
            # up their self-operator row and scope to its bot.
            from app.db.models import Operator as _Op

            self_op_bot_id = session.execute(
                select(_Op.bot_id).where(
                    _Op.client_id == client_id,
                    _Op.linked_client_id == client_id,
                    _Op.is_active.is_(True),
                )
            ).scalar_one_or_none()
            if self_op_bot_id is not None and self_op_bot_id in bot_ids:
                bot_ids = [self_op_bot_id]
                bot_id = self_op_bot_id

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
