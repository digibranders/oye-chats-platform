"""Razorpay billing integration.

Razorpay is the primary billing provider for OyeChats — Indian customers,
INR pricing, UPI Autopay for recurring mandates. This module mirrors the
shape of ``billing_service`` (Stripe) so the routes layer can pick a provider
based on ``Subscription.payment_provider``.

Conventions:

* All amounts are stored and passed to Razorpay in **paise** (the minor unit
  of INR). Plan rows store paise in ``monthly_price_cents`` despite the legacy
  column name — see ``models.Plan.currency``.
* Webhook signatures are verified against the **raw** request body using the
  webhook secret. Razorpay explicitly warns: ``"Do not parse or cast the
  webhook request body"``. Routes therefore pass ``await request.body()``
  straight in.
* The Razorpay Python SDK (``razorpay==2.x``) is imported lazily so that the
  rest of the API still boots when keys aren't configured — useful for local
  dev and for the test suite.
* Idempotency uses ``ProcessedWebhook`` keyed on the ``x-razorpay-event-id``
  HTTP header. The same table is shared with the Stripe handler.

References (Razorpay docs, validated against this implementation):

* Orders API:       https://razorpay.com/docs/api/orders/create/
* Subscriptions:    https://razorpay.com/docs/api/payments/subscriptions/
* Webhook signatures: HMAC-SHA256(raw_body, webhook_secret) compared to the
                     ``X-Razorpay-Signature`` header.
* Payment signatures (after Checkout success):
    one-time: HMAC-SHA256(``order_id|payment_id``, key_secret)
    subscription: HMAC-SHA256(``payment_id|subscription_id``, key_secret)
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import (
    RAZORPAY_ENABLED,
    RAZORPAY_KEY_ID,
    RAZORPAY_KEY_SECRET,
    RAZORPAY_WEBHOOK_SECRET,
)
from app.db.models import Client, Invoice, Plan, ProcessedWebhook, Subscription
from app.services import credit_service

if TYPE_CHECKING:
    import razorpay

logger = logging.getLogger(__name__)


# ── Exceptions ────────────────────────────────────────────────────────────────


class RazorpayBillingError(Exception):
    """Base class for Razorpay-specific billing errors."""


class SignatureMismatch(RazorpayBillingError):
    """Raised when a webhook or payment signature fails HMAC verification.

    Always treated as a hard failure (fail-closed). Never swallow.
    """


class WebhookReplay(RazorpayBillingError):
    """Raised when a webhook event has already been processed.

    Distinct from a signature mismatch so callers can return 200 OK on replays
    (Razorpay will keep retrying otherwise) without obscuring real failures.
    """


# ── Client init ───────────────────────────────────────────────────────────────


def _get_razorpay() -> razorpay.Client:
    """Lazily import and configure the Razorpay SDK.

    Raises ``RuntimeError`` if ``RAZORPAY_KEY_ID`` / ``RAZORPAY_KEY_SECRET``
    are not set. Callers are expected to gate against ``RAZORPAY_ENABLED``
    before invoking any function that reaches the network.
    """
    if not RAZORPAY_ENABLED:
        raise RuntimeError("Razorpay is not configured. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET.")

    import razorpay  # local import keeps the dep optional at boot time

    return razorpay.Client(auth=(RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET))


# ── Top-up Orders (one-time payment) ──────────────────────────────────────────


def create_topup_order(
    session: Session,
    client: Client,
    pack: dict[str, Any],
    *,
    discount_bps: int = 0,
    extra_notes: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Create a Razorpay Order for a one-time top-up purchase.

    Returns the payload the admin frontend needs to open Razorpay Checkout —
    including the order id, key id (public, safe to expose), and the pack
    metadata it should display in the modal.

    The pack must come from ``pricing_config.topup_packs`` and have an
    ``amount`` (in the pack's currency major unit — rupees for INR — NOT
    paise; we convert here so the config table stays human-readable).

    ``discount_bps`` is the customer-facing referral discount in basis
    points. Applied in paise so 10% off ₹1,599 yields ₹1,439.10 worth of
    paise (143910), not ₹1,439 (whole-rupee flooring).

    ``extra_notes`` is merged into the Razorpay order notes — used by the
    referral flow to record discount provenance. Razorpay caps notes at
    15 keys × 256 chars per value; we keep our own keys tight to leave
    headroom for callers.

    Standard Razorpay test/live merchant accounts can only charge INR. A
    USD-priced pack on this provider would silently mis-bill the customer,
    so we fail-fast with ValueError instead of letting the order create.
    """
    if not pack.get("amount"):
        raise ValueError("Top-up pack is missing 'amount'")

    currency = str(pack.get("currency", "INR")).upper()
    if currency != "INR":
        raise ValueError(
            f"Razorpay only supports INR top-ups; got '{currency}'. Use the Stripe provider for non-INR packs."
        )

    rzp = _get_razorpay()
    amount_inr = int(pack["amount"])
    original_paise = amount_inr * 100
    discount_bps_int = max(0, min(10_000, int(discount_bps or 0)))
    amount_paise = original_paise - (original_paise * discount_bps_int) // 10_000
    credits = int(pack["credits"])
    bonus_pct = int(pack.get("bonus_pct", 0) or 0)

    # Razorpay caps notes at 15 keys × 256 chars. We keep it tight.
    notes = {
        "purpose": "topup",
        "client_id": str(client.id),
        "credits": str(credits),
        "amount_inr": str(amount_inr),
        "bonus_pct": str(bonus_pct),
    }
    if discount_bps_int:
        notes["original_amount_paise"] = str(original_paise)
        notes["charged_amount_paise"] = str(amount_paise)
    if extra_notes:
        notes.update({str(k): str(v)[:256] for k, v in extra_notes.items()})

    receipt = f"topup_c{client.id}_{int(datetime.now(UTC).timestamp())}"

    try:
        order = rzp.order.create(
            data={
                "amount": amount_paise,
                "currency": currency,
                "receipt": receipt,
                "notes": notes,
                # Avoid partial payments — credits must be granted on a single
                # captured payment, not after partial settlement.
                "payment_capture": 1,
            }
        )
    except Exception as exc:  # razorpay's BadRequestError, ServerError, etc.
        logger.exception(
            "Razorpay order.create failed for client %s (amount=%s INR): %s",
            client.id,
            amount_inr,
            exc,
        )
        raise RazorpayBillingError("Could not start top-up checkout. Please try again.") from exc

    logger.info(
        "Created Razorpay top-up order %s for client %s: ₹%d → %d credits (bonus %d%%)",
        order["id"],
        client.id,
        amount_inr,
        credits,
        bonus_pct,
    )

    return {
        "provider": "razorpay",
        "order_id": order["id"],
        "amount": amount_paise,
        "currency": currency,
        "credits": credits,
        "bonus_pct": bonus_pct,
        "key_id": RAZORPAY_KEY_ID,
        "name": "OyeChats credits",
        "description": (f"{credits:,} credits" + (f" (includes {bonus_pct}% bonus)" if bonus_pct else "")),
        "prefill": {
            "name": client.name or "",
            "email": client.email or "",
        },
        "theme": {"color": "#6366f1"},
        "receipt": receipt,
    }


def verify_topup_signature(
    *,
    razorpay_order_id: str,
    razorpay_payment_id: str,
    razorpay_signature: str,
) -> None:
    """Verify the order-level payment signature returned by Razorpay Checkout.

    Razorpay computes ``HMAC_SHA256(order_id + "|" + payment_id, key_secret)``
    and includes the digest in the Checkout success callback. The Razorpay
    SDK's ``utility.verify_payment_signature`` raises on mismatch; we
    re-raise as our own :class:`SignatureMismatch` so callers don't need to
    know SDK details.
    """
    rzp = _get_razorpay()
    try:
        rzp.utility.verify_payment_signature(
            {
                "razorpay_order_id": razorpay_order_id,
                "razorpay_payment_id": razorpay_payment_id,
                "razorpay_signature": razorpay_signature,
            }
        )
    except Exception as exc:
        logger.warning(
            "Razorpay payment signature mismatch (order=%s payment=%s): %s",
            razorpay_order_id,
            razorpay_payment_id,
            exc,
        )
        raise SignatureMismatch("Razorpay payment signature verification failed") from exc


# ── Subscriptions ─────────────────────────────────────────────────────────────


def create_subscription(
    session: Session,
    client: Client,
    plan: Plan,
    billing_cycle: str = "monthly",
    *,
    seat_quantity: int | None = None,
    total_count: int = 120,
) -> dict[str, Any]:
    """Create a Razorpay Subscription for ``plan`` and return Checkout payload.

    The Razorpay plan_id is sourced from ``plan.razorpay_plan_id_monthly`` /
    ``razorpay_plan_id_annual`` — these must be configured in the super admin
    once the plan is created in the Razorpay dashboard.

    ``total_count`` defaults to 120 cycles (10 years monthly / 10 years
    annual) so subscriptions effectively run until the customer cancels.
    Razorpay requires a finite count, so this is the standard SaaS pattern.

    Returns the Checkout payload: subscription_id, key_id, plan + customer
    metadata. The frontend opens ``new Razorpay({ subscription_id, ... })``;
    the customer authorises a UPI mandate (or pays with card) and Razorpay
    fires ``subscription.activated`` shortly after.
    """
    if billing_cycle not in ("monthly", "annual"):
        raise ValueError(f"Invalid billing_cycle '{billing_cycle}'")

    razorpay_plan_id = plan.razorpay_plan_id_annual if billing_cycle == "annual" else plan.razorpay_plan_id_monthly
    if not razorpay_plan_id:
        raise ValueError(
            f"Plan '{plan.name}' has no Razorpay plan id configured for {billing_cycle} billing. "
            "Create the plan in the Razorpay dashboard and set the id from super admin."
        )

    rzp = _get_razorpay()

    notes = {
        "oyechats_client_id": str(client.id),
        "oyechats_plan_id": str(plan.id),
        "billing_cycle": billing_cycle,
    }

    quantity = max(int(seat_quantity or plan.included_operator_seats or 1), 1)

    try:
        subscription = rzp.subscription.create(
            data={
                "plan_id": razorpay_plan_id,
                "total_count": int(total_count),
                "customer_notify": 1,
                "quantity": quantity,
                "notes": notes,
            }
        )
    except Exception as exc:
        logger.exception(
            "Razorpay subscription.create failed for client %s plan %s: %s",
            client.id,
            plan.slug,
            exc,
        )
        raise RazorpayBillingError("Could not create subscription. Please try again.") from exc

    logger.info(
        "Created Razorpay subscription %s for client %s on plan %s (%s, qty=%d)",
        subscription["id"],
        client.id,
        plan.slug,
        billing_cycle,
        quantity,
    )

    return {
        "provider": "razorpay",
        "subscription_id": subscription["id"],
        "short_url": subscription.get("short_url"),
        "key_id": RAZORPAY_KEY_ID,
        "name": "OyeChats",
        "description": f"{plan.name} ({billing_cycle})",
        "prefill": {
            "name": client.name or "",
            "email": client.email or "",
        },
        "theme": {"color": "#6366f1"},
    }


def verify_subscription_payment_signature(
    *,
    razorpay_payment_id: str,
    razorpay_subscription_id: str,
    razorpay_signature: str,
) -> None:
    """Verify the subscription-level payment signature from Razorpay Checkout.

    Razorpay computes ``HMAC_SHA256(payment_id + "|" + subscription_id, key_secret)``
    when a subscription is authenticated through Checkout. SDK raises on
    mismatch; we surface a typed exception.
    """
    rzp = _get_razorpay()
    try:
        rzp.utility.verify_subscription_payment_signature(
            {
                "razorpay_payment_id": razorpay_payment_id,
                "razorpay_subscription_id": razorpay_subscription_id,
                "razorpay_signature": razorpay_signature,
            }
        )
    except Exception as exc:
        logger.warning(
            "Razorpay subscription signature mismatch (payment=%s sub=%s): %s",
            razorpay_payment_id,
            razorpay_subscription_id,
            exc,
        )
        raise SignatureMismatch("Razorpay subscription signature verification failed") from exc


def cancel_subscription(subscription: Subscription, *, at_period_end: bool = True) -> None:
    """Cancel a Razorpay subscription at period end (default) or immediately.

    Razorpay's parameter is ``cancel_at_cycle_end`` (1 = at end, 0 = now).
    Local DB state is updated by the webhook handler — we don't double-write
    here, mirroring the Stripe flow.
    """
    if not subscription.razorpay_subscription_id:
        logger.warning(
            "cancel_subscription called for subscription %s without razorpay id — skipping",
            subscription.id,
        )
        return

    rzp = _get_razorpay()
    try:
        rzp.subscription.cancel(
            subscription.razorpay_subscription_id,
            data={"cancel_at_cycle_end": 1 if at_period_end else 0},
        )
    except Exception as exc:
        logger.exception(
            "Razorpay subscription.cancel failed for %s: %s",
            subscription.razorpay_subscription_id,
            exc,
        )
        raise RazorpayBillingError("Could not cancel the subscription with Razorpay.") from exc

    logger.info(
        "Cancelled Razorpay subscription %s (at_period_end=%s)",
        subscription.razorpay_subscription_id,
        at_period_end,
    )


def update_subscription_quantity(
    session: Session,
    sub: Subscription,
    new_quantity: int,
) -> int:
    """Update the seat quantity on a Razorpay subscription.

    Razorpay supports updating subscription ``quantity`` mid-cycle; the next
    invoice picks up the new amount (Razorpay handles proration on its side).
    Local mirror is updated immediately so live-chat seat enforcement sees
    the new limit without waiting for a webhook round-trip.
    """
    new_quantity = max(int(new_quantity), 0)
    plan = sub.plan
    floor = int(plan.included_operator_seats) if plan and plan.included_operator_seats else 1
    if new_quantity < floor:
        raise ValueError(f"Cannot set seats below included floor of {floor}")

    if sub.razorpay_subscription_id:
        rzp = _get_razorpay()
        try:
            rzp.subscription.edit(
                sub.razorpay_subscription_id,
                data={"quantity": new_quantity, "schedule_change_at": "now"},
            )
        except Exception as exc:
            logger.exception(
                "Razorpay subscription.edit (qty=%d) failed for %s: %s",
                new_quantity,
                sub.razorpay_subscription_id,
                exc,
            )
            raise RazorpayBillingError("Could not update seats with Razorpay.") from exc

    sub.operator_quantity = new_quantity
    session.flush()
    logger.info("Updated seat count for subscription %s to %d", sub.id, new_quantity)
    return new_quantity


# ── Webhooks ──────────────────────────────────────────────────────────────────


def verify_webhook_signature(*, payload: bytes, signature: str) -> None:
    """Verify the X-Razorpay-Signature header against the raw payload.

    Uses the SDK's utility (which is just ``hmac.new(secret, payload,
    sha256).hexdigest()`` under the hood — kept as SDK call so we follow
    upstream changes if the algorithm ever evolves).

    ``RAZORPAY_WEBHOOK_SECRET`` must be set; we fail-closed if missing.
    """
    if not RAZORPAY_WEBHOOK_SECRET:
        raise RuntimeError("RAZORPAY_WEBHOOK_SECRET not configured")
    rzp = _get_razorpay()
    try:
        rzp.utility.verify_webhook_signature(
            payload.decode("utf-8") if isinstance(payload, bytes) else payload,
            signature,
            RAZORPAY_WEBHOOK_SECRET,
        )
    except Exception as exc:
        raise SignatureMismatch("Razorpay webhook signature mismatch") from exc


def _record_or_skip_event(session: Session, event_id: str | None) -> bool:
    """Insert an event id into ``processed_webhooks`` or report it as a replay.

    ``x-razorpay-event-id`` is present on every modern Razorpay webhook
    delivery.  Reject events without an id to prevent duplicate processing
    that could grant credits twice or create duplicate subscriptions.
    """
    if not event_id:
        logger.warning("Razorpay webhook missing x-razorpay-event-id — rejecting to prevent duplicate processing")
        return False
    existing = session.get(ProcessedWebhook, event_id)
    if existing is not None:
        return False
    session.add(ProcessedWebhook(event_id=event_id, provider="razorpay"))
    session.flush()
    return True


def handle_webhook_event(session: Session, event: dict[str, Any], event_id: str | None) -> str:
    """Dispatch a verified Razorpay webhook event to the right handler.

    The dispatch table is intentionally small. Razorpay supports more events,
    but only these affect billing state for OyeChats:

    * ``subscription.activated``  → first authentication, grant initial credits
    * ``subscription.charged``    → recurring renewal, reset + grant credits
    * ``subscription.cancelled``  → mark canceled in our DB
    * ``subscription.completed``  → all cycles complete, mark canceled
    * ``subscription.halted``     → repeated failures, mark past_due
    * ``subscription.pending``    → mandate pending, mark past_due
    * ``payment.captured``        → top-up payment success, grant credits
    * ``payment.failed``          → log only (retry handled by Razorpay)
    * ``order.paid``              → backup path for top-ups (some flows emit
                                    this instead of payment.captured)
    """
    if not _record_or_skip_event(session, event_id):
        return f"Duplicate event {event_id} skipped"

    event_name = event.get("event", "")
    payload = event.get("payload") or {}

    handlers = {
        "subscription.activated": _handle_subscription_activated,
        "subscription.charged": _handle_subscription_charged,
        "subscription.cancelled": _handle_subscription_cancelled,
        "subscription.completed": _handle_subscription_completed,
        "subscription.halted": _handle_subscription_halted,
        "subscription.pending": _handle_subscription_pending,
        "subscription.paused": _handle_subscription_halted,  # treat like halted
        "subscription.resumed": _handle_subscription_activated,  # re-grant if needed
        "payment.captured": _handle_payment_captured,
        "payment.failed": _handle_payment_failed,
        "order.paid": _handle_payment_captured,  # alias path for top-ups
    }
    handler = handlers.get(event_name)
    if handler is None:
        return f"Unhandled event type: {event_name}"
    return handler(session, payload)


# ── Handlers ──────────────────────────────────────────────────────────────────


def _extract_subscription_entity(payload: dict[str, Any]) -> dict[str, Any] | None:
    """Pull the subscription entity out of the standard webhook envelope."""
    return ((payload.get("subscription") or {}).get("entity")) or None


def _extract_payment_entity(payload: dict[str, Any]) -> dict[str, Any] | None:
    return ((payload.get("payment") or {}).get("entity")) or None


def _extract_order_entity(payload: dict[str, Any]) -> dict[str, Any] | None:
    return ((payload.get("order") or {}).get("entity")) or None


def _resolve_local_subscription(session: Session, razorpay_subscription_id: str) -> Subscription | None:
    return (
        session.execute(select(Subscription).where(Subscription.razorpay_subscription_id == razorpay_subscription_id))
        .scalars()
        .first()
    )


def _client_id_from_notes(notes: dict[str, Any] | None) -> int | None:
    if not notes:
        return None
    raw = notes.get("oyechats_client_id") or notes.get("client_id")
    try:
        return int(raw) if raw is not None else None
    except (TypeError, ValueError):
        return None


def _plan_id_from_notes(notes: dict[str, Any] | None) -> int | None:
    if not notes:
        return None
    raw = notes.get("oyechats_plan_id") or notes.get("plan_id")
    try:
        return int(raw) if raw is not None else None
    except (TypeError, ValueError):
        return None


def _handle_subscription_activated(session: Session, payload: dict[str, Any]) -> str:
    """First mandate-authentication or restart after a paused state.

    Creates the local Subscription row if it doesn't exist yet, grants the
    initial month's credits, and stores the Razorpay customer id.
    """
    sub_entity = _extract_subscription_entity(payload)
    if not sub_entity:
        return "subscription entity missing"

    razorpay_sub_id = sub_entity.get("id")
    if not razorpay_sub_id:
        return "subscription id missing"

    local = _resolve_local_subscription(session, razorpay_sub_id)
    notes = sub_entity.get("notes") or {}
    client_id = _client_id_from_notes(notes)
    plan_id = _plan_id_from_notes(notes)

    current_period_start = (
        datetime.fromtimestamp(sub_entity["current_start"], tz=UTC) if sub_entity.get("current_start") else None
    )
    current_period_end = (
        datetime.fromtimestamp(sub_entity["current_end"], tz=UTC) if sub_entity.get("current_end") else None
    )
    quantity = int(sub_entity.get("quantity") or 1)
    customer_id = sub_entity.get("customer_id")

    if local is None:
        if client_id is None or plan_id is None:
            logger.warning(
                "Razorpay subscription.activated for %s missing client/plan in notes — cannot create local row",
                razorpay_sub_id,
            )
            return "missing notes; cannot create subscription"

        # Cancel any existing active subscription for this client (upgrade flow).
        existing = (
            session.execute(
                select(Subscription).where(
                    Subscription.client_id == client_id,
                    Subscription.status.in_(("active", "trialing", "past_due")),
                )
            )
            .scalars()
            .all()
        )
        for old in existing:
            old.status = "canceled"
            old.canceled_at = datetime.now(UTC)

        local = Subscription(
            client_id=client_id,
            plan_id=plan_id,
            status="active",
            billing_cycle=notes.get("billing_cycle", "monthly"),
            operator_quantity=quantity,
            current_period_start=current_period_start,
            current_period_end=current_period_end,
            payment_provider="razorpay",
            razorpay_subscription_id=razorpay_sub_id,
            razorpay_customer_id=customer_id,
        )
        session.add(local)
        session.flush()

        credit_service.grant_for_subscription(session, local)
        logger.info(
            "Activated Razorpay subscription %s → local %s (client %s)",
            razorpay_sub_id,
            local.id,
            client_id,
        )
        return f"Subscription activated for client {client_id}"

    # Existing local row — update fields and ensure first-month credits exist.
    local.status = "active"
    if current_period_start:
        local.current_period_start = current_period_start
    if current_period_end:
        local.current_period_end = current_period_end
    if customer_id and not local.razorpay_customer_id:
        local.razorpay_customer_id = customer_id
    local.operator_quantity = quantity
    session.flush()
    return f"Subscription {razorpay_sub_id} re-activated"


def _handle_subscription_charged(session: Session, payload: dict[str, Any]) -> str:
    """Recurring payment captured. Reset + grant the new month's credits.

    Razorpay fires this on every successful cycle — including the very first
    one immediately after activation. We avoid double-granting by checking
    whether the subscription's ``current_period_start`` is roughly the same
    as the period reported on this event, in which case the
    ``subscription.activated`` handler already granted credits.
    """
    sub_entity = _extract_subscription_entity(payload)
    pay_entity = _extract_payment_entity(payload)
    if not sub_entity:
        return "subscription entity missing"

    razorpay_sub_id = sub_entity.get("id")
    local = _resolve_local_subscription(session, razorpay_sub_id) if razorpay_sub_id else None
    if local is None:
        logger.warning("subscription.charged for unknown razorpay_subscription_id %s", razorpay_sub_id)
        return "Subscription not found"

    new_period_start = (
        datetime.fromtimestamp(sub_entity["current_start"], tz=UTC) if sub_entity.get("current_start") else None
    )
    new_period_end = (
        datetime.fromtimestamp(sub_entity["current_end"], tz=UTC) if sub_entity.get("current_end") else None
    )

    # Record the invoice if a payment entity was included.
    if pay_entity and pay_entity.get("id"):
        rzp_payment_id = pay_entity["id"]
        existing = (
            session.execute(select(Invoice).where(Invoice.razorpay_payment_id == rzp_payment_id)).scalars().first()
        )
        if not existing:
            session.add(
                Invoice(
                    client_id=local.client_id,
                    subscription_id=local.id,
                    amount_cents=int(pay_entity.get("amount", 0)),
                    currency=str(pay_entity.get("currency", "INR")).lower(),
                    status="paid",
                    razorpay_payment_id=rzp_payment_id,
                    period_start=new_period_start,
                    period_end=new_period_end,
                    description=(f"{local.plan.name if local.plan else 'Plan'} — {local.billing_cycle}"),
                    paid_at=datetime.now(UTC),
                )
            )

    # Detect first-cycle charge that overlaps with the activated grant.
    is_first_cycle = (
        local.current_period_start is not None
        and new_period_start is not None
        and abs((new_period_start - local.current_period_start).total_seconds()) < 86400
    )
    if not is_first_cycle:
        credit_service.reset_monthly_plan_credits(session, local.client_id)
        credit_service.grant_for_subscription(session, local)
        logger.info(
            "Renewed monthly credits for client %s from subscription.charged (%s)",
            local.client_id,
            razorpay_sub_id,
        )

    if new_period_start:
        local.current_period_start = new_period_start
    if new_period_end:
        local.current_period_end = new_period_end
    local.status = "active"
    session.flush()
    return f"Subscription {razorpay_sub_id} charged"


def _handle_subscription_cancelled(session: Session, payload: dict[str, Any]) -> str:
    sub_entity = _extract_subscription_entity(payload)
    if not sub_entity:
        return "subscription entity missing"
    local = _resolve_local_subscription(session, sub_entity.get("id", ""))
    if not local:
        return "Subscription not found"
    local.status = "canceled"
    local.canceled_at = datetime.now(UTC)
    session.flush()
    return f"Subscription {sub_entity.get('id')} cancelled"


def _handle_subscription_completed(session: Session, payload: dict[str, Any]) -> str:
    sub_entity = _extract_subscription_entity(payload)
    if not sub_entity:
        return "subscription entity missing"
    local = _resolve_local_subscription(session, sub_entity.get("id", ""))
    if not local:
        return "Subscription not found"
    local.status = "expired"
    session.flush()
    return f"Subscription {sub_entity.get('id')} completed"


def _handle_subscription_halted(session: Session, payload: dict[str, Any]) -> str:
    sub_entity = _extract_subscription_entity(payload)
    if not sub_entity:
        return "subscription entity missing"
    local = _resolve_local_subscription(session, sub_entity.get("id", ""))
    if not local:
        return "Subscription not found"
    local.status = "past_due"
    session.flush()
    return f"Subscription {sub_entity.get('id')} halted"


def _handle_subscription_pending(session: Session, payload: dict[str, Any]) -> str:
    sub_entity = _extract_subscription_entity(payload)
    if not sub_entity:
        return "subscription entity missing"
    local = _resolve_local_subscription(session, sub_entity.get("id", ""))
    if not local:
        return "Subscription not found"
    local.status = "past_due"
    session.flush()
    return f"Subscription {sub_entity.get('id')} pending"


def _handle_payment_captured(session: Session, payload: dict[str, Any]) -> str:
    """Top-up payment captured — grant top-up credits and record the invoice.

    Subscription-cycle payments are handled by ``subscription.charged``; we
    detect a top-up by ``notes.purpose == 'topup'`` on the order. Anything
    else here (e.g., a one-off invoice payment) we ignore for now.
    """
    pay_entity = _extract_payment_entity(payload)
    order_entity = _extract_order_entity(payload)
    notes: dict[str, Any] = {}
    if pay_entity:
        notes = pay_entity.get("notes") or {}
    if not notes and order_entity:
        notes = order_entity.get("notes") or {}

    if notes.get("purpose") != "topup":
        # Subscription cycles arrive via subscription.charged; ignore here.
        return "payment.captured ignored (not a topup)"

    client_id = _client_id_from_notes(notes)
    credits = int(notes.get("credits") or 0)
    if not client_id or credits <= 0:
        logger.warning("Top-up payment.captured missing client_id or credits in notes: %s", notes)
        return "missing topup metadata"

    rzp_payment_id = pay_entity.get("id") if pay_entity else None
    rzp_order_id = (pay_entity or {}).get("order_id") or (order_entity or {}).get("id")

    # Idempotency-safe Invoice insert: skip if we've already recorded this payment.
    if rzp_payment_id:
        existing_inv = (
            session.execute(select(Invoice).where(Invoice.razorpay_payment_id == rzp_payment_id)).scalars().first()
        )
        if existing_inv and existing_inv.status == "paid":
            return f"Top-up {rzp_payment_id} already recorded"

    amount_paise = int((pay_entity or {}).get("amount") or (order_entity or {}).get("amount") or 0)
    amount_inr = int(notes.get("amount_inr") or (amount_paise // 100))

    invoice = Invoice(
        client_id=client_id,
        subscription_id=None,
        amount_cents=amount_paise,
        currency=str((pay_entity or {}).get("currency", "INR")).lower(),
        status="paid",
        razorpay_payment_id=rzp_payment_id,
        description=f"Top-up ₹{amount_inr} pack",
        paid_at=datetime.now(UTC),
    )
    session.add(invoice)
    session.flush()

    credit_service.grant_topup(
        session,
        client_id,
        credits,
        note=f"Top-up ₹{amount_inr} pack (Razorpay {rzp_order_id or rzp_payment_id})",
    )
    logger.info(
        "Granted %d top-up credits to client %s via Razorpay payment %s",
        credits,
        client_id,
        rzp_payment_id,
    )
    return f"Top-up credits granted to client {client_id}"


def _handle_payment_failed(session: Session, payload: dict[str, Any]) -> str:
    """Log + leave it to Razorpay's retry/dunning. No DB state change."""
    pay = _extract_payment_entity(payload) or {}
    logger.warning(
        "Razorpay payment.failed: id=%s order=%s reason=%s",
        pay.get("id"),
        pay.get("order_id"),
        pay.get("error_description") or pay.get("error_reason"),
    )
    return "payment.failed logged"
