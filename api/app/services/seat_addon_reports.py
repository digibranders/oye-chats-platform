"""Reconciliation for orphaned operator-seat add-on subscriptions.

The operator-seat add-on (P0-3) is a SEPARATE Razorpay subscription from the
main plan. Every path that ends or supersedes the parent is *supposed* to
cancel it too — ``subscription_routes.cancel_subscription``,
``razorpay_service._handle_subscription_activated`` (cutover), and
``transition_service.promote_scheduled_change`` (scheduled downgrade). But
each does the gateway cancel best-effort and only logs on failure, and the
cutover re-create is an external call a rolled-back activation transaction can
strand. Any of those leaves an orphan: a ₹499/seat/month mandate that keeps
billing a customer who has churned or changed plans, with no live local
subscription owning it.

This module is the durable safety net for all of those cases. It reconciles
the live seat-add-on subscriptions *at Razorpay* against the local
subscriptions that should own them and cancels any orphan at the gateway,
clearing any stale local pointer. It mirrors ``invoice_reports`` /
``task_invoice_reconciliation_alert``: the money path is never blocked inline,
and this sweep is the guarantee those tolerated failures never stay silent.
"""

from __future__ import annotations

import logging
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import Subscription
from app.services import razorpay_service

logger = logging.getLogger(__name__)

# Local parent statuses that legitimately own a live seat add-on. Anything
# else (canceled / expired) means the add-on should have been cancelled.
_LIVE_PARENT_STATUSES = ("active", "trialing", "past_due")

# Gateway subscription states that are still billing or can resume billing.
# ``completed`` / ``cancelled`` / ``expired`` add-ons are already dead at the
# gateway, so they are not orphans to act on.
_LIVE_GATEWAY_STATES = ("created", "authenticated", "active", "pending", "halted")


def _live_owned_addon_ids(session: Session) -> set[str]:
    """Seat-add-on ids referenced by a local subscription with a LIVE parent."""
    rows = (
        session.execute(
            select(Subscription.seat_addon_subscription_id).where(
                Subscription.seat_addon_subscription_id.is_not(None),
                Subscription.status.in_(_LIVE_PARENT_STATUSES),
            )
        )
        .scalars()
        .all()
    )
    return {row for row in rows if row}


def _local_owner(session: Session, seat_addon_subscription_id: str) -> Subscription | None:
    """The local subscription pointing at this add-on, whatever its status."""
    return (
        session.execute(
            select(Subscription).where(Subscription.seat_addon_subscription_id == seat_addon_subscription_id)
        )
        .scalars()
        .first()
    )


def find_orphaned_seat_addons(session: Session) -> list[dict[str, Any]]:
    """Return live gateway seat add-ons that no live local subscription owns.

    An add-on is an orphan when it is still billing at the gateway but the
    local subscription that owned it is ``canceled``/``expired`` (or no local
    row references it at all — the rolled-back-activation case).
    """
    live_owned = _live_owned_addon_ids(session)
    orphans: list[dict[str, Any]] = []
    for gateway_sub in razorpay_service.iter_seat_addon_subscriptions():
        gateway_id = gateway_sub.get("id")
        if not gateway_id or gateway_id in live_owned:
            continue
        if (gateway_sub.get("status") or "").lower() not in _LIVE_GATEWAY_STATES:
            continue
        owner = _local_owner(session, gateway_id)
        orphans.append(
            {
                "id": gateway_id,
                "gateway_status": gateway_sub.get("status"),
                "reason": "parent_dead" if owner is not None else "no_local_owner",
                "owner_subscription_id": owner.id if owner is not None else None,
                "owner_status": owner.status if owner is not None else None,
            }
        )
    return orphans


def reconcile_orphaned_seat_addons(session: Session, *, cancel: bool = True) -> dict[str, Any]:
    """Find — and, by default, cancel — orphaned seat add-ons at the gateway.

    Cancelling an orphan is unambiguously safe: by construction no live local
    subscription owns it. On a successful cancel any stale local pointer is
    cleared so the row stops advertising an add-on that no longer exists.
    Returns a summary the caller surfaces (loudly) for alerting.
    """
    orphans = find_orphaned_seat_addons(session)
    cancelled: list[str] = []
    failed: list[str] = []

    if cancel:
        for orphan in orphans:
            gateway_id = orphan["id"]
            try:
                razorpay_service.cancel_seat_addon_by_id(gateway_id)
            except Exception:
                failed.append(gateway_id)
                logger.exception(
                    "Orphaned seat add-on %s could not be cancelled at Razorpay — the mandate "
                    "is STILL LIVE and billing. Needs manual reconciliation.",
                    gateway_id,
                )
                continue
            cancelled.append(gateway_id)
            owner = _local_owner(session, gateway_id)
            if owner is not None:
                owner.seat_addon_subscription_id = None
                owner.seat_addon_quantity = 0
                session.flush()

    return {
        "orphans": [o["id"] for o in orphans],
        "details": orphans,
        "cancelled": cancelled,
        "failed": failed,
    }
