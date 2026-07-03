"""Plan transition orchestration — upgrades, downgrades, scheduled cutovers.

This module is the single source of truth for everything paid→paid
subscription transitions need:

  * Remaining-credit lookup for upgrade rollover (``remaining_plan_credits``).
  * Razorpay-specific paid→paid upgrade flow (``execute_paid_upgrade``):
    open a new sub and stash the customer's unused plan credits so the
    activation webhook can re-grant them as a top-up once payment clears.
    The OLD mandate is NOT cancelled here — under the UPI re-auth model it
    stays live until the new subscription authorizes and is retired at the
    new sub's activation webhook (so an abandoned checkout can't strand the
    customer).
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

Rollover model: unused **plan_grant** credits from the old subscription
are carried into the new subscription as a ``topup`` grant (12-month
expiry, same as a normal top-up). We snapshot the unused count *before*
cancelling the old mandate, then the activation webhook re-grants that
amount after the new plan's allowance is provisioned. This means the
customer never loses message credits they've already paid for, regardless
of how many days are left in the old billing cycle.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.db.models import Client, Operator, Plan, Subscription
from app.services import credit_service, email_service

logger = logging.getLogger("oyechats.transitions")


# ── Rollover ──────────────────────────────────────────────────────────────────


def remaining_plan_credits(session: Session, client_id: int) -> int:
    """Unused ``plan_grant`` credits the client still owns on the current cycle.

    Reads the live FIFO breakdown so the number reflects every chat that
    has already burned credits this month. Top-up credits are excluded —
    they're never cleared at renewal and carry over to the new
    subscription on their own.
    """
    breakdown = credit_service.get_balance_breakdown(session, client_id)
    return int(breakdown.get("plan", 0) or 0)


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
    """Open a checkout sheet for the new plan (UPI re-auth model, BL-2).

    Does NOT cancel the current mandate — the old subscription stays live
    until the new one authorizes, then is retired at the new sub's
    activation webhook (see ``_handle_subscription_activated``'s sibling
    sweep). Snapshots the customer's unused plan credits on the OLD sub's
    row so the activation webhook can re-grant them as a top-up after
    payment clears — keeping the route handler free of cross-step state.
    Returns the Razorpay checkout payload the frontend hands to
    ``new Razorpay({...})``.

    NOTE on ``upgrade_credit_pending_cents``: the column name is historical
    (the original implementation stored a currency proration in cents).
    It now stores an integer **credit count**. We kept the column name to
    avoid an Alembic migration just for the rename; semantics are
    documented here and at the call sites.

    Raises:
        RazorpayBillingError: gateway-side creation of the new subscription failed.
    """
    from app.services import razorpay_service

    # Snapshot unused plan credits BEFORE the new plan's allowance is granted —
    # the activation webhook will call ``reset_monthly_plan_credits`` before
    # granting the new allowance, so reading the breakdown later would return 0.
    rollover_credits = remaining_plan_credits(session, client.id)

    # DO NOT cancel the old mandate here (BL-2). Razorpay's UPI mandates can't be
    # swapped in place, so a plan change is cancel+recreate+re-authorize. Under
    # the re-auth model the OLD mandate must stay live until the NEW subscription
    # authorizes; if we hard-cancelled it now and the customer abandoned the
    # Razorpay checkout modal, they'd be stranded — old service gone, new never
    # authorized, and the rollover credits stuck in ``upgrade_credit_pending_cents``.
    # The old sub is retired instead at the NEW sub's activation webhook, where
    # ``_handle_subscription_activated`` gateway-cancels the superseded sibling
    # (identified via ``prev_razorpay_subscription_id`` in the new sub's notes).

    sub.upgrade_credit_pending_cents = rollover_credits
    sub.cancel_reason = sub.cancel_reason or "auto_upgrade"
    session.flush()

    payload = razorpay_service.create_subscription(
        session,
        client,
        new_plan,
        billing_cycle,
        extra_notes={"prev_razorpay_subscription_id": sub.razorpay_subscription_id or ""},
    )
    payload.setdefault("rollover_credits", rollover_credits)
    payload["prev_razorpay_subscription_id"] = sub.razorpay_subscription_id

    logger.info(
        "Upgrade queued: client=%s %s → %s, rollover=%d credits",
        client.id,
        sub.plan.slug if sub.plan else "?",
        new_plan.slug,
        rollover_credits,
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
    payload otherwise. The customer still needs to authorise the new
    mandate — this function emails them that re-auth link itself (via
    ``short_url``) so the cutover never silently strands them (NB-3).
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
    # Snapshot the old plan name before we clear the row — used in the
    # customer notification below.
    old_plan_name = sub.plan.name if sub.plan else "your previous plan"

    # Mark the old sub finalized first so the partial-unique index on
    # (client_id, status in active|trialing|past_due) doesn't trip when
    # ``_handle_subscription_activated`` later inserts the new row. This
    # ordering (terminal flip + flush BEFORE create_subscription) is what
    # keeps the index satisfied regardless of whether the row arrived here
    # as ``active`` (completed/cron path) or ``canceled`` (cancelled-webhook
    # path). We do NOT downgrade a row that already went terminal.
    if sub.status not in ("expired", "canceled"):
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

    # Notify the customer with the hosted re-auth link so they can authorise
    # the new (lower) plan's UPI mandate. Without this the cutover leaves them
    # with no active subscription and no path back (NB-3). A failed email must
    # NOT roll back the promotion — the checkout already exists and is
    # reconcilable via ``prev_razorpay_subscription_id`` on the new sub — so we
    # swallow send errors here (the send helper also captures them).
    reauth_url = payload.get("short_url")
    if reauth_url and client and client.email:
        try:
            email_service.send_downgrade_reauth_email(
                to_email=client.email,
                name=client.name,
                old_plan_name=old_plan_name,
                new_plan_name=new_plan.name,
                reauth_url=reauth_url,
            )
        except Exception:
            logger.exception(
                "promote_scheduled_change: re-auth email failed for client=%s (promotion stands)",
                client.id,
            )
    else:
        logger.warning(
            "promote_scheduled_change: no re-auth link/email for client=%s (short_url=%r) — "
            "customer must be reconciled manually",
            client.id if client else None,
            reauth_url,
        )

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
    """Re-grant the old plan's unused credits onto the new sub as a top-up.

    Looks up the old local row by ``prev_razorpay_subscription_id``,
    reads the rollover credit count stashed in
    ``upgrade_credit_pending_cents`` (column name is legacy — it stores a
    credit count, not cents), writes a credit-ledger ``topup`` for that
    amount, then zeros the column so re-runs of the activation webhook
    don't double-credit.

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
        note=f"Upgrade rollover (unused {old_sub.plan.slug if old_sub.plan else 'previous plan'} credits)",
        bot_id=new_sub.bot_id,
    )

    logger.info(
        "Applied upgrade rollover credits: client=%s bot=%s amount=%d",
        new_sub.client_id,
        new_sub.bot_id,
        credit_amount,
    )
    return credit_amount
