"""Reconciliation for orphaned add-on subscriptions (operator seats, branding).

Each add-on is a SEPARATE Razorpay subscription from the main plan. Every path
that ends or supersedes the parent is *supposed* to cancel it too.
``subscription_routes.cancel_subscription``,
``razorpay_service._handle_subscription_activated`` (cutover), and
``transition_service.promote_scheduled_change`` (scheduled downgrade). But each
does the gateway cancel best-effort and only logs on failure, and the cutover
re-create is an external call a rolled-back activation transaction can strand.
Any of those leaves an orphan: a monthly mandate that keeps billing a customer
who has churned or changed plans, with no live local subscription owning it.

This module is the durable safety net for all of those cases. It reconciles the
live add-on subscriptions *at Razorpay* against the local subscriptions that
should own them and cancels any orphan at the gateway, clearing any stale local
pointer. It mirrors ``invoice_reports`` / ``task_invoice_reconciliation_alert``:
the money path is never blocked inline, and this sweep is the guarantee those
tolerated failures never stay silent.

The sweep is written once and parameterised by :class:`_AddonSpec`, because an
add-on that is not in the sweep is an add-on whose failures ARE silent, and
that gap is invisible until a customer disputes a charge. A new add-on kind
belongs in :data:`_ADDON_SPECS` at the moment it is introduced.
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import Subscription
from app.services import razorpay_service

logger = logging.getLogger(__name__)

# Local parent statuses that legitimately own a live add-on. Anything else
# (canceled / expired / trial_expired) means the add-on should have been
# cancelled.
#
# ``paused`` is in this set even though it is not a billing state. A pause is a
# supported, REVERSIBLE super-admin override (``superadmin_plan_routes``'s
# status allow-list), and this sweep's only action is an IRREVERSIBLE gateway
# cancel — Razorpay has no un-cancel. Treating a pause as death meant support
# pausing an account for a billing dispute silently destroyed the customer's
# paid seats and branding removal that same night, and unpausing could not
# bring them back. Erring towards "leave it alone" costs at most some paused
# add-on billing; erring the other way is unrecoverable.
_LIVE_PARENT_STATUSES = ("active", "trialing", "past_due", "paused")

# Gateway subscription states that are still billing or can resume billing.
# ``completed`` / ``cancelled`` / ``expired`` add-ons are already dead at the
# gateway, so they are not orphans to act on.
_LIVE_GATEWAY_STATES = ("created", "authenticated", "active", "pending", "halted")


@dataclass(frozen=True)
class _AddonSpec:
    """How to sweep one kind of add-on.

    ``clear_local`` runs only after a SUCCESSFUL gateway cancel, and must drop
    both the pointer and whatever entitlement the add-on granted. Clearing the
    pointer alone would leave the row still entitling a feature whose mandate
    no longer exists, which is the free-paid-feature failure this sweep is
    partly here to prevent.

    ``iter_gateway`` and ``cancel_by_id`` deliberately resolve their
    ``razorpay_service`` attribute at CALL time rather than holding a
    reference captured when this module was imported. Binding early would make
    the sweep unpatchable, and a sweep that ignores a monkeypatched gateway is
    a sweep whose tests pass against the real Razorpay client.
    """

    name: str
    column: Any
    iter_gateway: Callable[[], Iterator[dict[str, Any]]]
    cancel_by_id: Callable[[str], None]
    clear_local: Callable[[Subscription], None]


def _clear_seat_addon(sub: Subscription) -> None:
    # Park the count as PENDING (wanted, not billed) before zeroing the live
    # mirror, exactly as ``execute_gateway_cancellation`` does. This sweep is
    # the one teardown path that used to drop it outright, so a customer whose
    # parent went terminal and later reactivated lost seats they had paid for
    # with nothing left on the row to restore them from. Entitlement still
    # follows an authorized charge; only the intent is preserved.
    wanted = int(sub.seat_addon_quantity or 0)
    sub.seat_addon_subscription_id = None
    sub.seat_addon_quantity = 0
    if wanted > 0:
        sub.seat_addon_pending_quantity = wanted


def _clear_branding_addon(sub: Subscription) -> None:
    sub.branding_addon_subscription_id = None
    sub.branding_addon_active = False
    sub.branding_addon_pending = False


_SEAT_SPEC = _AddonSpec(
    name="seat",
    column=Subscription.seat_addon_subscription_id,
    iter_gateway=lambda: razorpay_service.iter_seat_addon_subscriptions(),
    cancel_by_id=lambda addon_id: razorpay_service.cancel_seat_addon_by_id(addon_id),
    clear_local=_clear_seat_addon,
)

_BRANDING_SPEC = _AddonSpec(
    name="branding",
    column=Subscription.branding_addon_subscription_id,
    iter_gateway=lambda: razorpay_service.iter_branding_addon_subscriptions(),
    cancel_by_id=lambda addon_id: razorpay_service.cancel_branding_addon_by_id(addon_id),
    clear_local=_clear_branding_addon,
)

_ADDON_SPECS: tuple[_AddonSpec, ...] = (_SEAT_SPEC, _BRANDING_SPEC)


def _live_owned_addon_ids(session: Session, spec: _AddonSpec) -> set[str]:
    """Add-on ids referenced by a local subscription with a LIVE parent."""
    rows = (
        session.execute(
            select(spec.column).where(
                spec.column.is_not(None),
                Subscription.status.in_(_LIVE_PARENT_STATUSES),
            )
        )
        .scalars()
        .all()
    )
    return {row for row in rows if row}


def _local_owner(session: Session, spec: _AddonSpec, addon_subscription_id: str) -> Subscription | None:
    """The local subscription pointing at this add-on, whatever its status."""
    return session.execute(select(Subscription).where(spec.column == addon_subscription_id)).scalars().first()


def _find_orphans(session: Session, spec: _AddonSpec) -> list[dict[str, Any]]:
    """Live gateway add-ons of this kind that no live local subscription owns.

    An add-on is an orphan when it is still billing at the gateway but the
    local subscription that owned it is ``canceled``/``expired`` (or no local
    row references it at all, the rolled-back-activation case).
    """
    live_owned = _live_owned_addon_ids(session, spec)
    orphans: list[dict[str, Any]] = []
    for gateway_sub in spec.iter_gateway():
        gateway_id = gateway_sub.get("id")
        if not gateway_id or gateway_id in live_owned:
            continue
        if (gateway_sub.get("status") or "").lower() not in _LIVE_GATEWAY_STATES:
            continue
        owner = _local_owner(session, spec, gateway_id)
        orphans.append(
            {
                "id": gateway_id,
                "addon": spec.name,
                "gateway_status": gateway_sub.get("status"),
                "reason": "parent_dead" if owner is not None else "no_local_owner",
                "owner_subscription_id": owner.id if owner is not None else None,
                "owner_status": owner.status if owner is not None else None,
            }
        )
    return orphans


def _reconcile(session: Session, spec: _AddonSpec, *, cancel: bool) -> dict[str, Any]:
    orphans = _find_orphans(session, spec)
    cancelled: list[str] = []
    failed: list[str] = []

    if cancel:
        for orphan in orphans:
            gateway_id = orphan["id"]
            try:
                spec.cancel_by_id(gateway_id)
            except Exception:
                failed.append(gateway_id)
                logger.exception(
                    "Orphaned %s add-on %s could not be cancelled at Razorpay, the mandate "
                    "is STILL LIVE and billing. Needs manual reconciliation.",
                    spec.name,
                    gateway_id,
                )
                continue
            cancelled.append(gateway_id)
            owner = _local_owner(session, spec, gateway_id)
            if owner is not None:
                spec.clear_local(owner)
                session.flush()

    return {
        "orphans": [o["id"] for o in orphans],
        "details": orphans,
        "cancelled": cancelled,
        "failed": failed,
    }


def find_orphaned_seat_addons(session: Session) -> list[dict[str, Any]]:
    """Orphaned operator-seat add-ons at the gateway."""
    return _find_orphans(session, _SEAT_SPEC)


def find_orphaned_branding_addons(session: Session) -> list[dict[str, Any]]:
    """Orphaned branding-removal add-ons at the gateway."""
    return _find_orphans(session, _BRANDING_SPEC)


def reconcile_orphaned_seat_addons(session: Session, *, cancel: bool = True) -> dict[str, Any]:
    """Find (and, by default, cancel) orphaned seat add-ons at the gateway.

    Cancelling an orphan is unambiguously safe: by construction no live local
    subscription owns it. On a successful cancel any stale local pointer is
    cleared so the row stops advertising an add-on that no longer exists.
    Returns a summary the caller surfaces (loudly) for alerting.
    """
    return _reconcile(session, _SEAT_SPEC, cancel=cancel)


def reconcile_orphaned_branding_addons(session: Session, *, cancel: bool = True) -> dict[str, Any]:
    """Find (and, by default, cancel) orphaned branding add-ons at the gateway."""
    return _reconcile(session, _BRANDING_SPEC, cancel=cancel)


def reconcile_orphaned_addons(session: Session, *, cancel: bool = True) -> dict[str, Any]:
    """Sweep every add-on kind in one pass, for the scheduled reconciliation task.

    Returns the merged summary plus a per-kind breakdown, so an alert can say
    WHICH add-on leaked rather than just how many did.
    """
    per_addon = {spec.name: _reconcile(session, spec, cancel=cancel) for spec in _ADDON_SPECS}
    return {
        "orphans": [oid for result in per_addon.values() for oid in result["orphans"]],
        "details": [detail for result in per_addon.values() for detail in result["details"]],
        "cancelled": [oid for result in per_addon.values() for oid in result["cancelled"]],
        "failed": [oid for result in per_addon.values() for oid in result["failed"]],
        "by_addon": per_addon,
    }
