"""Involuntary-churn recovery.

Razorpay retries a failed recurring charge (``pending`` -> retries -> ``halted``)
and hosts a page where the customer can retry the same instrument, swap the
card, or move to UPI/eMandate. On success the subscription returns to ``active``
WITHOUT a new subscription being created.

That is why this module only ever RESOLVES a link. It never mints a mandate.
``/resume`` mints one because an at-cycle-end cancellation is irreversible at
the gateway. There is nothing left to authorise. A halted subscription is
still alive, so minting here would leave two live mandates and double-charge a
customer who authorises the new one.
"""

from __future__ import annotations

import logging
from collections.abc import Mapping
from dataclasses import dataclass
from types import MappingProxyType

logger = logging.getLogger(__name__)

# States from which Razorpay's hosted page can still bring a subscription back
# to ``active``. ``active`` is excluded: there is nothing to recover, and the
# instrument on a healthy subscription cannot be swapped in place.
RECOVERABLE_GATEWAY_STATES = frozenset({"pending", "halted"})

# Days elapsed in past_due -> marker key. Shaped around Razorpay's own retry
# behaviour: it retries roughly daily for T+3 days before halting, so day 0 is
# a calm heads-up ("we'll retry automatically") and the urgent messaging starts
# at day 3 when retries are genuinely exhausted. Every key must land strictly
# inside PAYMENT_FAILED_GRACE_DAYS or we would promise a deadline that has
# already passed. Enforced by test.
# Read-only: a plain dict here is process-wide mutable state that any caller or
# test could reshape, and it decides when customers get told their service is
# ending. Mirrors the frozenset above.
DUNNING_CADENCE: Mapping[int, str] = MappingProxyType(
    {
        0: "failed_0",
        3: "halted_3",
        5: "warning_5",
    }
)

# Written by the expiry cron when the grace window elapses, not by the cadence.
SUSPENDED_MARKER = "suspended"


class DunningError(RuntimeError):
    """The gateway could not be reached to resolve a recovery link."""


@dataclass(frozen=True)
class RecoveryLink:
    """Outcome of resolving a failing subscription's hosted recovery page.

    ``recoverable=False`` is a settled negative answer (terminal state, healthy
    subscription, or no hosted link). A gateway failure raises ``DunningError``
    instead, because "we couldn't check" and "your subscription is dead" must
    never be conflated in front of a paying customer.
    """

    recoverable: bool
    url: str | None
    gateway_status: str | None


def _client():
    """Indirection so tests can substitute a fake without patching razorpay."""
    from app.services.razorpay_service import _get_razorpay

    return _get_razorpay()


def get_recovery_link(razorpay_subscription_id: str | None) -> RecoveryLink:
    """Resolve the hosted recovery page for a failing subscription.

    Raises ``DunningError`` on a gateway failure rather than returning
    ``recoverable=False``, the two mean very different things, and reporting a
    transient timeout as "your subscription is dead" is worse than an error.
    """
    if not razorpay_subscription_id:
        # Manual/comped subscription, no gateway mandate exists to recover.
        return RecoveryLink(recoverable=False, url=None, gateway_status=None)

    try:
        entity = _client().subscription.fetch(razorpay_subscription_id) or {}
    except Exception as exc:  # noqa: BLE001  Normalised into our own error type
        # exception(), not warning(): a mis-keyed environment (RAZORPAY_ENABLED
        # off, bad credentials) surfaces here as a permanent fault wearing a
        # transient message, and without the traceback nobody can tell the two
        # apart from an infinite "please try again" banner.
        logger.exception("dunning: could not fetch subscription %s", razorpay_subscription_id)
        raise DunningError("Could not reach the payment provider. Please try again.") from exc

    status = str(entity.get("status") or "").lower() or None
    url = entity.get("short_url") or None

    # A recoverable state with no hosted link is not actionable: emailing a
    # button that goes nowhere is worse than saying nothing. Logged because
    # this is the one case where a PAYING customer is genuinely unrecoverable
    # and would otherwise be suspended with nobody noticing.
    if status not in RECOVERABLE_GATEWAY_STATES or not url:
        if status in RECOVERABLE_GATEWAY_STATES and not url:
            logger.warning(
                "dunning: subscription %s is %s but has no short_url. Customer cannot self-recover",
                razorpay_subscription_id,
                status,
            )
        return RecoveryLink(recoverable=False, url=None, gateway_status=status)

    return RecoveryLink(recoverable=True, url=url, gateway_status=status)


def due_email(days_in_past_due: float, sent: Mapping[str, str] | None) -> str | None:
    """Marker key for the email due now, or ``None``.

    Catches up to the NEWEST unsent bucket at or before today, rather than
    firing only on an exact day match. Exact-match would silently drop an
    email permanently whenever a tick was missed, and not just on a worker
    outage: any tick where the gateway lookup fails leaves the marker unwritten
    and burns that bucket forever. Losing the day-5 email means a customer is
    suspended having received only "don't worry, we'll retry".

    The anti-spam intent is preserved exactly: only the newest due bucket is
    ever returned, so a late day-3 is superseded by day-5 rather than both
    landing together, and an older marker is never sent after a newer one.

    ``days_in_past_due`` is typed ``float`` because the natural caller
    computation (``elapsed.total_seconds() / 86400``) is fractional; an int
    lookup against a fractional day would have silently matched nothing.
    """
    if days_in_past_due < 0:
        return None
    due = [day for day in DUNNING_CADENCE if day <= days_in_past_due]
    if not due:
        return None
    marker = DUNNING_CADENCE[max(due)]
    # Membership, not truthiness: an empty-string timestamp still means sent.
    return None if marker in (sent or {}) else marker
