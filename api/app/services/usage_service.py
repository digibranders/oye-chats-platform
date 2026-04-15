"""Usage tracking and plan limit enforcement.

Central module for incrementing usage counters and checking whether a client
has capacity remaining on their current plan.  All enforcement endpoints
should call ``check_limit()`` before allowing the action, and
``increment_usage()`` after the action succeeds.
"""

import logging
from dataclasses import dataclass

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.db.models import Bot, Document, Operator
from app.services.plan_service import (
    UNLIMITED,
    get_client_plan,
    get_or_create_usage_record,
    get_plan_limit,
    is_feature_enabled,
)

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class LimitCheckResult:
    """Result of a plan limit check."""

    allowed: bool
    used: int
    limit: int
    overage_rate_cents: int
    metric: str


# ── Metric name → (UsageRecord counter field, UsageRecord limit field) ──
_METRIC_FIELDS: dict[str, tuple[str, str]] = {
    "ai_messages": ("ai_messages_used", "ai_messages_limit"),
    "live_chat_messages": ("live_chat_messages_used", "live_chat_messages_limit"),
    "url_scans": ("url_scans_used", "url_scans_limit"),
    "email_summaries": ("email_summaries_used", "email_summaries_limit"),
    "email_notifications": ("email_notifications_used", "email_notifications_limit"),
}


def check_limit(session: Session, client_id: int, metric: str) -> LimitCheckResult:
    """Check whether the client has capacity for the given metric.

    Does NOT raise — callers decide how to handle the result.
    """
    plan = get_client_plan(session, client_id)
    limit_value = get_plan_limit(plan, metric)

    # Unlimited plan — always allowed
    if limit_value == UNLIMITED:
        return LimitCheckResult(allowed=True, used=0, limit=-1, overage_rate_cents=0, metric=metric)

    record = get_or_create_usage_record(session, client_id)

    field_used, field_limit = _METRIC_FIELDS.get(metric, (None, None))
    if field_used is None:
        # Unknown metric — fail-open to avoid blocking legitimate traffic
        logger.warning(f"Unknown usage metric '{metric}' for client {client_id}")
        return LimitCheckResult(allowed=True, used=0, limit=-1, overage_rate_cents=0, metric=metric)

    used = getattr(record, field_used, 0)
    overage_rate = plan.overage_rate_cents or 0

    allowed = used < limit_value or overage_rate > 0
    return LimitCheckResult(
        allowed=allowed,
        used=used,
        limit=limit_value,
        overage_rate_cents=overage_rate,
        metric=metric,
    )


def enforce_limit(session: Session, client_id: int, metric: str) -> None:
    """Check limit and raise HTTP 429 if exceeded with no overage.

    Call this as a guard before performing the metered action.
    """
    result = check_limit(session, client_id, metric)
    if not result.allowed:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail={
                "error": "plan_limit_exceeded",
                "metric": metric,
                "used": result.used,
                "limit": result.limit,
                "message": f"You have reached your plan's {metric.replace('_', ' ')} limit ({result.limit}). "
                "Please upgrade your plan to continue.",
            },
        )


def enforce_feature(session: Session, client_id: int, feature: str) -> None:
    """Check if a feature is enabled on the client's plan, raise 403 if not."""
    plan = get_client_plan(session, client_id)
    if not is_feature_enabled(plan, feature):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "error": "feature_not_available",
                "feature": feature,
                "message": f"The '{feature.replace('_', ' ')}' feature is not included in your current plan. "
                "Please upgrade to access this feature.",
            },
        )


def increment_usage(session: Session, client_id: int, metric: str, amount: int = 1) -> int:
    """Increment a usage counter and return the new total.

    If the client has exceeded their limit and overage is enabled, also
    tracks overage messages and estimated overage cost.
    """
    record = get_or_create_usage_record(session, client_id)

    field_used, field_limit = _METRIC_FIELDS.get(metric, (None, None))
    if field_used is None:
        logger.warning(f"Cannot increment unknown metric '{metric}' for client {client_id}")
        return 0

    current = getattr(record, field_used, 0)
    new_value = current + amount
    setattr(record, field_used, new_value)

    # Track overage for ai_messages (the primary metered resource)
    limit_value = getattr(record, field_limit, 0)
    if metric == "ai_messages" and limit_value > 0 and new_value > limit_value:
        plan = get_client_plan(session, client_id)
        overage_rate = plan.overage_rate_cents or 0
        if overage_rate > 0:
            overage_messages = new_value - limit_value
            record.overage_messages = max(overage_messages, 0)
            record.overage_amount_cents = record.overage_messages * overage_rate

    session.flush()
    return new_value


def get_usage_summary(session: Session, client_id: int) -> dict:
    """Return a summary of the client's current-period usage vs limits.

    Designed for the admin dashboard usage meters.
    """
    plan = get_client_plan(session, client_id)
    record = get_or_create_usage_record(session, client_id)

    limits = plan.limits or {}

    # Count current bots and operators (live counts, not cached)
    bots_count = session.query(Bot.id).filter(Bot.client_id == client_id, Bot.is_active.is_(True)).count()
    operators_count = session.query(Operator.id).filter(Operator.client_id == client_id).count()

    # Calculate storage used (sum of document content lengths, rough estimate)
    from sqlalchemy import func as sa_func

    storage_bytes = (
        session.query(sa_func.sum(sa_func.length(Document.content))).filter(Document.client_id == client_id).scalar()
    ) or 0
    storage_used_mb = storage_bytes // (1024 * 1024)

    # Update snapshot fields
    record.bots_count = bots_count
    record.operators_count = operators_count
    record.storage_used_mb = storage_used_mb
    session.flush()

    return {
        "plan": {
            "id": plan.id,
            "name": plan.name,
            "slug": plan.slug,
        },
        "period": {
            "start": record.period_start.isoformat() if record.period_start else None,
            "end": record.period_end.isoformat() if record.period_end else None,
        },
        "usage": {
            "ai_messages": {"used": record.ai_messages_used, "limit": limits.get("ai_messages", 0)},
            "live_chat_messages": {
                "used": record.live_chat_messages_used,
                "limit": limits.get("live_chat_messages", 0),
            },
            "url_scans": {"used": record.url_scans_used, "limit": limits.get("url_scans", 0)},
            "email_summaries": {"used": record.email_summaries_used, "limit": limits.get("email_summaries", 0)},
            "email_notifications": {
                "used": record.email_notifications_used,
                "limit": limits.get("email_notifications", 0),
            },
            "bots": {"used": bots_count, "limit": limits.get("bots", UNLIMITED)},
            "operators": {"used": operators_count, "limit": limits.get("operators", UNLIMITED)},
            "storage_mb": {"used": storage_used_mb, "limit": limits.get("storage_mb", 0)},
        },
        "overage": {
            "messages": record.overage_messages,
            "amount_cents": record.overage_amount_cents,
            "rate_cents": plan.overage_rate_cents,
        },
    }
