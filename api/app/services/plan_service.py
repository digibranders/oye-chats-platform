"""Plan management service — resolves client plans, enforces limits, and manages plan CRUD."""

import logging
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import Bot, Operator, Plan, Subscription, UsageRecord

logger = logging.getLogger(__name__)

# Sentinel value: -1 in a limit field means "unlimited"
UNLIMITED = -1


def get_active_plans(session: Session) -> list[Plan]:
    """Return all active plans ordered by sort_order (for pricing page display)."""
    stmt = select(Plan).where(Plan.is_active.is_(True)).order_by(Plan.sort_order)
    return list(session.execute(stmt).scalars().all())


def get_plan_by_slug(session: Session, slug: str) -> Plan | None:
    """Look up a plan by its URL-safe slug."""
    return session.execute(select(Plan).where(Plan.slug == slug)).scalars().first()


def get_plan_by_id(session: Session, plan_id: int) -> Plan | None:
    """Look up a plan by its database ID."""
    return session.execute(select(Plan).where(Plan.id == plan_id)).scalars().first()


def get_default_plan(session: Session) -> Plan | None:
    """Return the plan marked as default (auto-assigned to new signups)."""
    return session.execute(select(Plan).where(Plan.is_default.is_(True))).scalars().first()


def get_client_subscription(session: Session, client_id: int) -> Subscription | None:
    """Return the client's current active/trialing/past_due subscription, if any."""
    stmt = (
        select(Subscription)
        .where(
            Subscription.client_id == client_id,
            Subscription.status.in_(("active", "trialing", "past_due")),
        )
        .order_by(Subscription.created_at.desc())
        .limit(1)
    )
    return session.execute(stmt).scalars().first()


def get_client_plan(session: Session, client_id: int) -> Plan:
    """Resolve the client's current plan. Falls back to the default (free) plan."""
    sub = get_client_subscription(session, client_id)
    if sub:
        plan = get_plan_by_id(session, sub.plan_id)
        if plan:
            return plan

    # No active subscription — fall back to the default plan
    default = get_default_plan(session)
    if default:
        return default

    # Absolute fallback: return the free plan by slug
    free_plan = get_plan_by_slug(session, "free")
    if free_plan:
        return free_plan

    # Should never happen — seed data ensures at least one plan exists
    raise RuntimeError("No plans found in the database. Run the seed migration.")


def get_plan_limit(plan: Plan, metric: str) -> int:
    """Extract a specific limit value from the plan's JSONB limits field.

    Returns UNLIMITED (-1) if the metric is not found (fail-open for unknown metrics).
    """
    limits: dict = plan.limits or {}
    return limits.get(metric, UNLIMITED)


def is_feature_enabled(plan: Plan, feature: str) -> bool:
    """Check whether a specific feature is enabled on this plan."""
    features: dict = plan.features or {}
    return features.get(feature, False)


def enforce_feature(session: Session, client_id: int, feature: str) -> None:
    """Raise HTTP 403 if a feature is not enabled on the client's current plan.

    Feature gating is independent of credits — it controls which capabilities
    a tier exposes (e.g. ``live_chat``, ``bant``, ``sso``). The ``features``
    JSONB column on ``Plan`` is the source of truth.
    """
    from fastapi import HTTPException, status

    plan = get_client_plan(session, client_id)
    if not is_feature_enabled(plan, feature):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "error": "feature_not_available",
                "feature": feature,
                "message": (
                    f"The '{feature.replace('_', ' ')}' feature is not included in your "
                    f"current plan. Please upgrade to access this feature."
                ),
            },
        )


def get_current_usage_record(session: Session, client_id: int) -> UsageRecord | None:
    """Get the usage record for the current billing period."""
    now = datetime.now(UTC)
    stmt = (
        select(UsageRecord)
        .where(
            UsageRecord.client_id == client_id,
            UsageRecord.period_start <= now,
            UsageRecord.period_end > now,
        )
        .limit(1)
    )
    return session.execute(stmt).scalars().first()


def get_or_create_usage_record(session: Session, client_id: int) -> UsageRecord:
    """Get or create the usage record for the current billing period.

    If no record exists (new signup, period rollover), creates one based on
    the client's current plan limits.
    """
    record = get_current_usage_record(session, client_id)
    if record:
        return record

    # Determine period boundaries from subscription or default to calendar month
    plan = get_client_plan(session, client_id)
    sub = get_client_subscription(session, client_id)

    if sub and sub.current_period_start and sub.current_period_end:
        period_start = sub.current_period_start
        period_end = sub.current_period_end
    else:
        # Default to calendar month for free-tier / no subscription
        now = datetime.now(UTC)
        period_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        # Next month first day
        if now.month == 12:
            period_end = period_start.replace(year=now.year + 1, month=1)
        else:
            period_end = period_start.replace(month=now.month + 1)

    limits = plan.limits or {}

    # Count current bots and operators for snapshot fields
    bots_count = session.execute(select(Bot.id).where(Bot.client_id == client_id, Bot.is_active.is_(True))).all()
    operators_count = session.execute(select(Operator.id).where(Operator.client_id == client_id)).all()

    record = UsageRecord(
        client_id=client_id,
        plan_id=plan.id,
        period_start=period_start,
        period_end=period_end,
        ai_messages_limit=limits.get("ai_messages", 0),
        live_chat_messages_limit=limits.get("live_chat_messages", 0),
        url_scans_limit=limits.get("url_scans", 0),
        email_summaries_limit=limits.get("email_summaries", 0),
        email_notifications_limit=limits.get("email_notifications", 0),
        storage_limit_mb=limits.get("storage_mb", 0),
        bots_count=len(bots_count),
        operators_count=len(operators_count),
    )
    session.add(record)
    session.flush()
    return record


def assign_default_plan_to_client(session: Session, client_id: int) -> Subscription:
    """Create a free-tier subscription for a new client signup."""
    default_plan = get_default_plan(session) or get_plan_by_slug(session, "free")
    if not default_plan:
        raise RuntimeError("No default plan found. Run the seed migration.")

    now = datetime.now(UTC)
    # Free plans don't have a trial — mark as active immediately
    status = "active" if default_plan.monthly_price_cents == 0 else "trialing"

    period_start = now
    # Calendar month for free tier
    if now.month == 12:
        period_end = now.replace(year=now.year + 1, month=1, day=1, hour=0, minute=0, second=0, microsecond=0)
    else:
        period_end = now.replace(month=now.month + 1, day=1, hour=0, minute=0, second=0, microsecond=0)

    sub = Subscription(
        client_id=client_id,
        plan_id=default_plan.id,
        status=status,
        billing_cycle="monthly",
        operator_quantity=1,
        current_period_start=period_start,
        current_period_end=period_end,
        payment_provider="manual",
    )
    session.add(sub)
    session.flush()

    logger.info(f"Assigned default plan '{default_plan.slug}' to client {client_id}")
    return sub
