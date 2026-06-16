"""Plan transition orchestration — upgrades, downgrades, scheduled cutovers.

This module is the single source of truth for everything paid→paid
subscription transitions need:

  * Proration math for unused current-period time (``compute_unused_proration``).
  * Razorpay-specific paid→paid upgrade flow (``execute_paid_upgrade``):
    cancel old mandate immediately, open new sub, stash proration credit
    so the activation webhook can apply it once payment clears.
  * Razorpay-specific paid→paid downgrade flow (``schedule_paid_downgrade``):
    queue the new plan to take effect at the current period's end. The old
    mandate is cancelled at-period-end on the gateway so Razorpay stops
    debiting after the current cycle.
  * Promotion of a queued change (``promote_scheduled_change``): called by
    both the ``subscription.completed`` webhook and the daily ARQ cron
    safety-net so whichever path fires first wins.
  * Seat-overflow guard (``check_seat_overflow``): refuses to schedule a
    downgrade when the customer has more active operators than the target
    plan allows; the route turns this into a 409 with the seat-picker
    payload the frontend renders.

The proration model is "unused-fraction × old plan monthly price". It is
deliberately the same regardless of monthly vs. annual cycle — for annual
subs we still credit *unused months* via the same fraction, then convert
back to monthly equivalents in the ledger. This keeps the customer-visible
math identical across cycles, at the cost of a fraction of a percent of
precision that the ledger absorbs.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.db.models import Client, Operator, Plan, Subscription
from app.services import credit_service

logger = logging.getLogger("oyechats.transitions")


# ── Proration ─────────────────────────────────────────────────────────────────


def compute_unused_proration(sub: Subscription) -> int:
    """Refund value (in plan-currency cents) for unused current-cycle time.

    Returns 0 when the subscription has no period anchors set, when the
    period is already over (defensive — the cron should have rolled it),
    or when the period started in the future (clock skew tolerance).
    """
    if sub is None or sub.plan is None:
        return 0
    if not sub.current_period_start or not sub.current_period_end:
        return 0

    now = datetime.now(UTC)
    total = (sub.current_period_end - sub.current_period_start).total_seconds()
    if total <= 0:
        return 0
    used = max(0.0, (now - sub.current_period_start).total_seconds())
    unused_frac = max(0.0, 1.0 - (used / total))

    monthly_price = int(sub.plan.monthly_price_cents or 0)
    return int(round(monthly_price * unused_frac))


# ── Seat overflow ─────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class SeatOverflow:
    """Returned by ``check_seat_overflow`` when the customer can't downgrade yet."""

    active_seats: int
    allowed_seats: int

    @property
    def excess(self) -> int:
        return max(0, self.active_seats - self.allowed_seats)


def check_seat_overflow(session: Session, client_id: int, target_plan: Plan) -> SeatOverflow | None:
    """Return ``SeatOverflow`` if active operator count exceeds the new plan's seats.

    Returns ``None`` when the customer is already within the new plan's
    seat allowance. The caller decides whether to refuse the transition
    or merely warn — this helper is intentionally pure.
    """
    allowed = int(target_plan.included_operator_seats or 0)
    active = int(
        session.scalar(
            select(func.count(Operator.id)).where(
                Operator.client_id == client_id,
                Operator.is_active.is_(True),
            )
        )
        or 0
    )
    if active <= allowed:
        return None
    return SeatOverflow(active_seats=active, allowed_seats=allowed)


# ── Upgrade (paid → paid, immediate, Razorpay) ────────────────────────────────


def execute_paid_upgrade(
    session: Session,
    client: Client,
    sub: Subscription,
    new_plan: Plan,
    billing_cycle: str,
) -> dict[str, Any]:
    """Cancel the current Razorpay mandate, open a checkout sheet for the new plan.

    Stashes the proration credit on the OLD sub's row so the activation
    webhook can apply it after payment clears — keeping the route handler
    free of cross-step state. Returns the Razorpay checkout payload the
    frontend hands to ``new Razorpay({...})``.

    Raises:
        RazorpayBillingError: gateway-side cancellation or creation failed.
    """
    from app.services import razorpay_service

    proration_cents = compute_unused_proration(sub)

    # Cancel immediately — the customer is paying for the new tier in the
    # very next step, so we don't want the old mandate's autopay to fire
    # again. We do this BEFORE creating the new sub so a gateway failure
    # leaves the old mandate intact (safer than the reverse ordering).
    razorpay_service.cancel_subscription(sub, at_period_end=False)

    sub.upgrade_credit_pending_cents = proration_cents
    sub.cancel_reason = sub.cancel_reason or "auto_upgrade"
    session.flush()

    payload = razorpay_service.create_subscription(
        session,
        client,
        new_plan,
        billing_cycle,
        extra_notes={"prev_razorpay_subscription_id": sub.razorpay_subscription_id or ""},
    )
    payload.setdefault("proration_credit_cents", proration_cents)
    payload["prev_razorpay_subscription_id"] = sub.razorpay_subscription_id

    logger.info(
        "Upgrade queued: client=%s %s → %s, proration=%d cents",
        client.id,
        sub.plan.slug if sub.plan else "?",
        new_plan.slug,
        proration_cents,
    )
    return payload


# ── Downgrade (paid → paid, scheduled at period end, Razorpay) ────────────────


def schedule_paid_downgrade(
    session: Session,
    sub: Subscription,
    new_plan: Plan,
    billing_cycle: str,
) -> datetime:
    """Queue ``new_plan`` to take effect at ``sub.current_period_end``.

    The gateway mandate is cancelled ``at_period_end=True`` so Razorpay
    stops debiting after the current cycle. Local state captures the
    pending change; the webhook (or cron) promotes it at cutover.

    Returns the cutover datetime.

    Raises:
        ValueError: when the subscription has no period anchor to schedule against.
        RazorpayBillingError: gateway-side scheduling failed.
    """
    from app.services import razorpay_service

    if not sub.current_period_end:
        raise ValueError("Subscription has no current_period_end — cannot schedule cutover")

    razorpay_service.cancel_subscription(sub, at_period_end=True)

    sub.cancel_at_period_end = True
    sub.scheduled_plan_id = new_plan.id
    sub.scheduled_billing_cycle = billing_cycle
    sub.scheduled_change_at = sub.current_period_end
    sub.cancel_reason = sub.cancel_reason or "scheduled_downgrade"
    session.flush()

    logger.info(
        "Downgrade scheduled: client=%s %s → %s at %s",
        sub.client_id,
        sub.plan.slug if sub.plan else "?",
        new_plan.slug,
        sub.scheduled_change_at.isoformat(),
    )
    return sub.scheduled_change_at


# ── Reversibility ─────────────────────────────────────────────────────────────


def cancel_scheduled_change(session: Session, sub: Subscription) -> bool:
    """Clear a queued downgrade. Returns True if one was actually queued.

    Idempotent: returns False (no error) when called on a subscription
    that has no scheduled change. The caller decides whether to resurrect
    the gateway mandate (most providers require a new auth) — this helper
    only owns local state because the resurrection path is provider-
    specific.
    """
    if not sub.scheduled_plan_id:
        return False

    sub.scheduled_plan_id = None
    sub.scheduled_billing_cycle = None
    sub.scheduled_change_at = None
    # We intentionally leave ``cancel_at_period_end`` alone — if the
    # caller wants to keep the existing mandate live they must call the
    # gateway resume helper separately; otherwise the row honestly
    # reflects that the customer is still on the cancellation track.
    session.flush()

    logger.info(
        "Scheduled change cancelled for sub=%s (client=%s)",
        sub.id,
        sub.client_id,
    )
    return True


# ── Promotion (called by webhook + cron) ──────────────────────────────────────


def promote_scheduled_change(session: Session, sub: Subscription) -> dict[str, Any] | None:
    """Promote a queued scheduled change into a fresh Razorpay subscription.

    Idempotent: returns ``None`` if there's nothing to promote (already
    promoted or never scheduled). Returns the new Razorpay checkout
    payload otherwise — the customer still needs to authorise the new
    mandate. The caller is responsible for emailing them the auth link.
    """
    from app.services import razorpay_service

    if not sub.scheduled_plan_id:
        return None

    new_plan = session.get(Plan, sub.scheduled_plan_id)
    if new_plan is None:
        logger.warning(
            "Scheduled change for sub=%s points at missing plan_id=%s — clearing",
            sub.id,
            sub.scheduled_plan_id,
        )
        sub.scheduled_plan_id = None
        sub.scheduled_billing_cycle = None
        sub.scheduled_change_at = None
        session.flush()
        return None

    billing_cycle = sub.scheduled_billing_cycle or "monthly"
    client = sub.client

    # Mark the old sub finalized first so the partial-unique index on
    # (client_id, status in active|trialing|past_due) doesn't trip when
    # ``_handle_subscription_activated`` later inserts the new row.
    sub.status = "expired"
    sub.scheduled_plan_id = None
    sub.scheduled_billing_cycle = None
    sub.scheduled_change_at = None
    session.flush()

    payload = razorpay_service.create_subscription(
        session,
        client,
        new_plan,
        billing_cycle,
        extra_notes={"prev_razorpay_subscription_id": sub.razorpay_subscription_id or ""},
    )
    payload["prev_razorpay_subscription_id"] = sub.razorpay_subscription_id
    payload["status"] = "scheduled_change_promoted"

    logger.info(
        "Scheduled change promoted: client=%s old_sub=%s → new plan %s",
        client.id,
        sub.id,
        new_plan.slug,
    )
    return payload


# ── Pending-proration application (called inside the activation webhook) ──────


def apply_pending_proration(
    session: Session,
    new_sub: Subscription,
    prev_razorpay_subscription_id: str | None,
) -> int:
    """If the new subscription replaced an old one with a pending proration, redeem it.

    Looks up the old local row by ``prev_razorpay_subscription_id``,
    reads its ``upgrade_credit_pending_cents``, writes a credit-ledger
    ``topup`` for that amount, then zeros the column so re-runs of the
    activation webhook don't double-credit.

    Returns the credit amount applied (0 when there was nothing pending).
    """
    if not prev_razorpay_subscription_id:
        return 0

    old_sub = session.scalars(
        select(Subscription).where(Subscription.razorpay_subscription_id == prev_razorpay_subscription_id)
    ).first()
    if old_sub is None or not old_sub.upgrade_credit_pending_cents:
        return 0

    credit_amount = int(old_sub.upgrade_credit_pending_cents)
    old_sub.upgrade_credit_pending_cents = 0
    session.flush()

    credit_service.grant_topup(
        session,
        new_sub.client_id,
        amount=credit_amount,
        note=f"Upgrade credit (unused {old_sub.plan.slug if old_sub.plan else 'previous plan'} time)",
    )

    logger.info(
        "Applied upgrade-proration credit: client=%s amount=%d",
        new_sub.client_id,
        credit_amount,
    )
    return credit_amount
