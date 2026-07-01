"""In-app notification service for the admin dashboard.

Three responsibilities:

  1. **Persist** notifications scoped to a workspace (``client_id``).
  2. **Broadcast** them in real time to every connected dashboard tab in
     that workspace via the dedicated ``/ws/notifications`` channel. The
     broadcaster lives in :mod:`app.services.notification_broadcaster`;
     this module just calls into it after the DB row is committed.
  3. **Expose typed factories** (``notify_bot_created``,
     ``notify_plan_purchased``, …) so trigger sites stay one-line and the
     payload schema is centralised.

The service is intentionally synchronous on the DB side and *fires the
WebSocket broadcast as a best-effort background task*. A failed broadcast
must not roll back the persisted row — the operator will still see the
notification on next page load via the REST list endpoint.
"""

from __future__ import annotations

import logging
from collections.abc import Iterable
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import delete, func, select, update
from sqlalchemy.orm import Session

from app.db.models import Notification

logger = logging.getLogger(__name__)


# Notification types — kept as module-level constants so triggers don't
# hard-code free-form strings (and the frontend can mirror this list).
TYPE_PLAN_PURCHASED = "plan_purchased"
TYPE_BOT_CREATED = "bot_created"
TYPE_OFFLINE_MESSAGE = "offline_message_received"
TYPE_HANDOFF_REQUEST = "handoff_request"
TYPE_FEEDBACK_RESOLVED = "feedback_resolved"
TYPE_CRAWL_COMPLETED = "crawl_completed"

KNOWN_TYPES = frozenset(
    {
        TYPE_PLAN_PURCHASED,
        TYPE_BOT_CREATED,
        TYPE_OFFLINE_MESSAGE,
        TYPE_HANDOFF_REQUEST,
        TYPE_FEEDBACK_RESOLVED,
        TYPE_CRAWL_COMPLETED,
    }
)

# Soft cap on stored history. Anything older than the most recent
# ``MAX_HISTORY`` per workspace is pruned opportunistically when a new
# notification lands. Keeps the table bounded without a separate cron.
MAX_HISTORY = 200


def _serialize(row: Notification) -> dict[str, Any]:
    return {
        "id": row.id,
        "type": row.type,
        "title": row.title,
        "body": row.body,
        "link": row.link,
        "data": row.data or {},
        "is_read": bool(row.is_read),
        "read_at": row.read_at.isoformat() if row.read_at else None,
        "created_at": row.created_at.isoformat() if row.created_at else None,
    }


def _prune(session: Session, client_id: int) -> None:
    """Trim history to ``MAX_HISTORY`` rows per workspace."""
    keep_ids = (
        select(Notification.id)
        .where(Notification.client_id == client_id)
        .order_by(Notification.created_at.desc())
        .limit(MAX_HISTORY)
        .subquery()
    )
    session.execute(
        delete(Notification)
        .where(Notification.client_id == client_id)
        .where(Notification.id.not_in(select(keep_ids.c.id)))
    )


def create_notification(
    session: Session,
    *,
    client_id: int,
    type_: str,
    title: str,
    body: str | None = None,
    link: str | None = None,
    data: dict[str, Any] | None = None,
    operator_id: int | None = None,
    broadcast: bool = True,
) -> dict[str, Any]:
    """Persist a notification row and (best-effort) broadcast it.

    Returns the serialized notification payload. Safe to call from sync
    request handlers; the WebSocket broadcast is scheduled on the running
    event loop if one exists, otherwise skipped silently (e.g. when called
    from a Celery worker without a loop).
    """
    if type_ not in KNOWN_TYPES:
        logger.warning("Unknown notification type %r — persisting anyway", type_)

    row = Notification(
        client_id=client_id,
        operator_id=operator_id,
        type=type_,
        title=title,
        body=body,
        link=link,
        data=data or {},
    )
    session.add(row)
    session.flush()
    _prune(session, client_id)
    session.commit()
    session.refresh(row)

    payload = _serialize(row)

    if broadcast:
        try:
            from app.services.notification_broadcaster import broadcaster

            scheduled = broadcaster.schedule_broadcast(
                client_id,
                {"event": "notification.created", "notification": payload},
            )
            if not scheduled:
                # Not fatal: REST hydrate on next page load + the 30s
                # polling fallback in the frontend will catch it. Log at
                # DEBUG so prod isn't noisy.
                logger.debug(
                    "Notification %s persisted for client %s but live broadcast was skipped (no loop)",
                    payload.get("id"),
                    client_id,
                )
        except Exception:
            logger.exception("Notification broadcast failed (non-fatal)")

    return payload


def list_notifications(
    session: Session,
    client_id: int,
    *,
    limit: int = 30,
    before_id: int | None = None,
    unread_only: bool = False,
) -> list[dict[str, Any]]:
    stmt = select(Notification).where(Notification.client_id == client_id)
    if unread_only:
        stmt = stmt.where(Notification.is_read.is_(False))
    if before_id is not None:
        stmt = stmt.where(Notification.id < before_id)
    stmt = stmt.order_by(Notification.created_at.desc()).limit(min(limit, 100))
    rows = session.execute(stmt).scalars().all()
    return [_serialize(r) for r in rows]


def unread_count(session: Session, client_id: int) -> int:
    result = session.execute(
        select(func.count(Notification.id))
        .where(Notification.client_id == client_id)
        .where(Notification.is_read.is_(False))
    ).scalar_one()
    return int(result or 0)


def mark_read(session: Session, client_id: int, notification_id: int) -> bool:
    result = session.execute(
        update(Notification)
        .where(Notification.id == notification_id)
        .where(Notification.client_id == client_id)
        .where(Notification.is_read.is_(False))
        .values(is_read=True, read_at=datetime.now(UTC))
    )
    session.commit()
    return result.rowcount > 0


def mark_all_read(session: Session, client_id: int) -> int:
    result = session.execute(
        update(Notification)
        .where(Notification.client_id == client_id)
        .where(Notification.is_read.is_(False))
        .values(is_read=True, read_at=datetime.now(UTC))
    )
    session.commit()
    return int(result.rowcount or 0)


def delete_notification(session: Session, client_id: int, notification_id: int) -> bool:
    result = session.execute(
        delete(Notification).where(Notification.id == notification_id).where(Notification.client_id == client_id)
    )
    session.commit()
    return result.rowcount > 0


def clear_all(session: Session, client_id: int) -> int:
    result = session.execute(delete(Notification).where(Notification.client_id == client_id))
    session.commit()
    return int(result.rowcount or 0)


# ── Typed factory helpers ──────────────────────────────────────────────────


def notify_bot_created(
    session: Session,
    *,
    client_id: int,
    bot_id: int,
    bot_name: str,
    bot_key: str,
) -> dict[str, Any]:
    return create_notification(
        session,
        client_id=client_id,
        type_=TYPE_BOT_CREATED,
        title="New bot created",
        body=f"“{bot_name}” is ready. Add a knowledge base to start answering questions.",
        link=f"/knowledge?bot={bot_key}",
        data={"bot_id": bot_id, "bot_key": bot_key, "bot_name": bot_name},
    )


def notify_crawl_completed(
    session: Session,
    *,
    client_id: int,
    source: str,
    pages: int,
    chunks: int,
    duration_seconds: int | None = None,
    bot_id: int | None = None,
) -> dict[str, Any]:
    dur = ""
    if duration_seconds is not None:
        s = max(0, int(duration_seconds))
        dur = f" in {s // 60}m {s % 60}s" if s >= 60 else f" in {s}s"
    return create_notification(
        session,
        client_id=client_id,
        type_=TYPE_CRAWL_COMPLETED,
        title="Website crawl complete",
        body=f"{source} — {pages} page{'' if pages == 1 else 's'}, {chunks} chunks ingested{dur}.",
        link="/knowledge?tab=list",
        data={
            "source": source,
            "pages": pages,
            "chunks": chunks,
            "duration_seconds": duration_seconds,
            "bot_id": bot_id,
        },
    )


def notify_plan_purchased(
    session: Session,
    *,
    client_id: int,
    plan_name: str,
    billing_cycle: str | None = None,
    amount: float | None = None,
    currency: str | None = None,
) -> dict[str, Any]:
    cycle = f" ({billing_cycle})" if billing_cycle else ""
    return create_notification(
        session,
        client_id=client_id,
        type_=TYPE_PLAN_PURCHASED,
        title=f"Plan activated: {plan_name}{cycle}",
        body="Your subscription is live. Check your usage and limits in Billing.",
        link="/settings?tab=billing",
        data={
            "plan_name": plan_name,
            "billing_cycle": billing_cycle,
            "amount": amount,
            "currency": currency,
        },
    )


def notify_offline_message(
    session: Session,
    *,
    client_id: int,
    visitor_name: str,
    visitor_email: str,
    message_preview: str,
    offline_message_id: int | None = None,
    bot_name: str | None = None,
) -> dict[str, Any]:
    preview = (message_preview or "").strip()
    if len(preview) > 140:
        preview = preview[:137] + "…"
    return create_notification(
        session,
        client_id=client_id,
        type_=TYPE_OFFLINE_MESSAGE,
        title=f"New message from {visitor_name}",
        body=preview or "(no message)",
        link="/support?tab=messages",
        data={
            "visitor_name": visitor_name,
            "visitor_email": visitor_email,
            "offline_message_id": offline_message_id,
            "bot_name": bot_name,
        },
    )


def notify_handoff_request(
    session: Session,
    *,
    client_id: int,
    session_id: str,
    visitor_name: str | None = None,
    bot_name: str | None = None,
    department_id: int | None = None,
    department_name: str | None = None,
) -> dict[str, Any]:
    who = visitor_name or "A visitor"
    title = f"{who} wants to talk to a human"
    body = f"Live chat request via {bot_name}." if bot_name else "Live chat request waiting for an operator."
    return create_notification(
        session,
        client_id=client_id,
        type_=TYPE_HANDOFF_REQUEST,
        title=title,
        body=body,
        link=f"/support?session={session_id}",
        data={
            "session_id": session_id,
            "visitor_name": visitor_name,
            "bot_name": bot_name,
            "department_id": department_id,
            "department_name": department_name,
        },
    )


def notify_feedback_resolved(
    session: Session,
    *,
    client_id: int,
    feedback_id: int,
    message_preview: str,
    admin_response: str | None = None,
) -> dict[str, Any]:
    """Tell the submitting client their platform feedback was resolved."""
    preview = (message_preview or "").strip()
    if len(preview) > 140:
        preview = preview[:137] + "…"
    body = "Our team has responded to your feedback." if admin_response else "Your feedback has been marked resolved."
    return create_notification(
        session,
        client_id=client_id,
        type_=TYPE_FEEDBACK_RESOLVED,
        title="Your feedback was resolved",
        body=body,
        # Opens the "My Feedback" view in the dashboard (handled in AdminLayout);
        # note ``/feedback`` is a separate route that redirects to visitor CSAT.
        link=f"/?feedback={feedback_id}",
        data={
            "feedback_id": feedback_id,
            "message_preview": preview,
            "has_response": bool(admin_response),
        },
    )


def types_filter(types: Iterable[str] | None) -> list[str]:
    """Sanitise a caller-supplied list of notification types."""
    if not types:
        return []
    return [t for t in types if t in KNOWN_TYPES]
