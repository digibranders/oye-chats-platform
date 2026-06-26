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
    CHECKOUT_TEST_CLIENT_IDS,
    RAZORPAY_ENABLED,
    RAZORPAY_KEY_ID,
    RAZORPAY_KEY_SECRET,
    RAZORPAY_TEST_PLAN_ID,
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
    bot_id: int | None = None,
) -> dict[str, Any]:
    """Create a Razorpay Order for a one-time top-up purchase.

    Returns the payload the admin frontend needs to open Razorpay Checkout —
    including the order id, key id (public, safe to expose), and the pack
    metadata it should display in the modal.

    The pack must come from ``pricing_config.topup_packs`` and have an
    ``amount`` (in the pack's currency major unit — rupees for INR — NOT
    paise; we convert here so the config table stays human-readable).

    Top-ups intentionally do NOT honour referral discounts — that incentive
    fires only on subscription checkout. See subscription_routes.create_checkout.

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
    amount_paise = amount_inr * 100
    if client.id in CHECKOUT_TEST_CLIENT_IDS:
        logger.warning("checkout test override: client %d top-up amount ₹%d → ₹1", client.id, amount_inr)
        amount_paise = 100
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
    # Per-bot top-ups stamp the target bot in notes so the captured-
    # payment handler grants to that bot's isolated ledger rather than
    # the client pool.
    if bot_id is not None:
        notes["bot_id"] = str(int(bot_id))

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
    total_count: int | None = None,
    extra_notes: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Create a Razorpay Subscription for ``plan`` and return Checkout payload.

    The Razorpay plan_id is sourced from ``plan.razorpay_plan_id_monthly`` /
    ``razorpay_plan_id_annual`` — these must be configured in the super admin
    once the plan is created in the Razorpay dashboard.

    ``total_count`` defaults to a cycle-appropriate value so subscriptions
    run for ~10 years and effectively last until the customer cancels.
    Razorpay caps ``total_count`` at 100 for annual plans and 120 for
    monthly plans, so we pick per cycle: monthly=120 (10 years), annual=100
    (~100 years — well beyond any realistic SaaS lifetime). Callers can
    still override with an explicit ``total_count``.

    Returns the Checkout payload: subscription_id, key_id, plan + customer
    metadata. The frontend opens ``new Razorpay({ subscription_id, ... })``;
    the customer authorises a UPI mandate (or pays with card) and Razorpay
    fires ``subscription.activated`` shortly after.
    """
    if billing_cycle not in ("monthly", "annual"):
        raise ValueError(f"Invalid billing_cycle '{billing_cycle}'")

    razorpay_plan_id = plan.razorpay_plan_id_annual if billing_cycle == "annual" else plan.razorpay_plan_id_monthly
    if client.id in CHECKOUT_TEST_CLIENT_IDS:
        if not RAZORPAY_TEST_PLAN_ID:
            raise ValueError(
                "RAZORPAY_TEST_PLAN_ID is not set. "
                "Create a ₹1/month plan in the Razorpay dashboard and set its plan ID in this env var."
            )
        logger.warning(
            "checkout test override: client %d subscription plan '%s' (%s) → test plan %s",
            client.id,
            plan.name,
            billing_cycle,
            RAZORPAY_TEST_PLAN_ID,
        )
        razorpay_plan_id = RAZORPAY_TEST_PLAN_ID
    elif not razorpay_plan_id:
        raise ValueError(
            f"Plan '{plan.name}' has no Razorpay plan id configured for {billing_cycle} billing. "
            "Create the plan in the Razorpay dashboard and set the id from super admin."
        )

    # Razorpay rejects total_count > 100 for annual plans; monthly accepts
    # up to 120 (12 cycles × 10 years). Fall back to the cycle-specific
    # max when the caller didn't override.
    if total_count is None:
        total_count = 100 if billing_cycle == "annual" else 120

    rzp = _get_razorpay()

    notes = {
        "oyechats_client_id": str(client.id),
        "oyechats_plan_id": str(plan.id),
        "billing_cycle": billing_cycle,
    }
    if extra_notes:
        # Caller-supplied notes carry transition metadata (e.g.
        # ``prev_razorpay_subscription_id``). String-coerce defensively —
        # Razorpay rejects non-string note values.
        for key, value in extra_notes.items():
            if value is None:
                continue
            notes[str(key)] = str(value)

    # Base subscription is always quantity 1 — the flat plan price already
    # covers the bundled included seats. Extra seats are billed on a SEPARATE
    # add-on subscription via create_seat_addon_subscription, because Razorpay
    # quantity multiplies the WHOLE plan amount (₹4,599×2 = ₹9,198, not ₹4,599+₹499).
    quantity = max(int(seat_quantity or 1), 1)

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


RAZORPAY_SEAT_PLAN_ID = "plan_T5rNFpt3vSkl4R"  # Extra Seat Monthly, ₹499


def create_seat_addon_subscription(
    session: Session,
    client: Client,
    *,
    extra_seats: int,
) -> dict[str, Any]:
    """Create a separate ₹499 × extra_seats Razorpay subscription for operator seats.

    Must be a distinct subscription from the main plan. Razorpay `quantity`
    multiplies the entire plan amount, which would make the main plan wrong
    (₹4,599×2 instead of ₹4,599+₹499). The Extra-Seat plan's amount IS the
    per-seat price (₹499), so ₹499 × extra_seats is exactly right here.
    """
    if extra_seats < 1:
        raise ValueError(f"extra_seats must be >= 1, got {extra_seats}")

    rzp = _get_razorpay()
    try:
        subscription = rzp.subscription.create(
            data={
                "plan_id": RAZORPAY_SEAT_PLAN_ID,
                "total_count": 120,
                "customer_notify": 1,
                "quantity": int(extra_seats),
                "notes": {
                    "oyechats_client_id": str(client.id),
                    "purpose": "seat_addon",
                },
            }
        )
    except Exception as exc:
        logger.exception(
            "Razorpay seat add-on subscription.create failed for client %s: %s",
            client.id,
            exc,
        )
        raise RazorpayBillingError("Could not create seat add-on subscription. Please try again.") from exc

    logger.info(
        "Created Razorpay seat add-on subscription %s for client %s (%d extra seats)",
        subscription["id"],
        client.id,
        extra_seats,
    )

    return {
        "provider": "razorpay",
        "subscription_id": subscription["id"],
        "key_id": RAZORPAY_KEY_ID,
        "name": "OyeChats operator seats",
        "description": f"{extra_seats} extra seat(s) — ₹499/seat/month",
        "prefill": {
            "name": client.name or "",
            "email": client.email or "",
        },
        "theme": {"color": "#6366f1"},
    }


def create_per_bot_subscription(
    session: Session,
    client: Client,
    plan: Plan,
    *,
    bot_name: str,
    bot_website: str | None,
    bot_allowed_domains: list[str] | None,
    bot_domain_check_enabled: bool,
    billing_cycle: str = "monthly",
) -> dict[str, Any]:
    """Mint a Razorpay subscription that funds exactly one new bot.

    Reuses :func:`create_subscription` so we get the same checkout payload
    shape as the account-level subscription flow. The extra notes are the
    only difference: ``purpose=per_bot_subscription`` flips
    :func:`_handle_subscription_activated` into per-bot mode (skip
    cancelling sibling subscriptions; create a Bot row from the carried
    fields after the mandate authenticates).

    No trial — bot #2+ charges immediately. The customer is already a
    paying account, so a second trial would be free credits we don't
    want to grant.
    """
    extra_notes: dict[str, str] = {
        "purpose": "per_bot_subscription",
        "bot_name": bot_name,
        "bot_domain_check_enabled": "1" if bot_domain_check_enabled else "0",
    }
    if bot_website:
        extra_notes["bot_website"] = bot_website
    if bot_allowed_domains:
        # Razorpay note values must be strings — pack as a JSON-encoded list
        # so the webhook handler can round-trip back to a Python list.
        import json as _json

        extra_notes["bot_allowed_domains"] = _json.dumps(list(bot_allowed_domains))

    return create_subscription(
        session,
        client,
        plan,
        billing_cycle=billing_cycle,
        extra_notes=extra_notes,
    )


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
        # Razorpay returns BadRequestError when the subscription is already in
        # a terminal state (cancelled/completed). The desired outcome — "stop
        # charging the customer" — is already achieved, so treat it as a no-op
        # instead of surfacing a 502 to the caller.
        exc_msg = str(exc).lower()
        if "not cancellable" in exc_msg or "cancelled status" in exc_msg or "completed status" in exc_msg:
            logger.warning(
                "Razorpay subscription %s is already in a terminal state — skipping cancel: %s",
                subscription.razorpay_subscription_id,
                exc,
            )
            return
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

    Concurrency note: the previous ``SELECT`` + ``INSERT`` pattern had a race
    window — two workers handling the same Razorpay retry (very common on
    5xx / connection-reset) could both pass the ``SELECT``, both flush, and
    only ``COMMIT`` would catch the duplicate via the unique constraint —
    by which point both had already granted credits / written ledger rows /
    sent confirmation emails. We now use an atomic
    ``INSERT … ON CONFLICT DO NOTHING`` and key off ``rowcount``: the worker
    whose insert won proceeds, the loser sees ``rowcount == 0`` and bails.
    Mirrors the Stripe path in ``billing_service._record_or_skip_webhook``.
    Postgres-only — every deployment is Postgres + pgvector.
    """
    if not event_id:
        logger.warning("Razorpay webhook missing x-razorpay-event-id — rejecting to prevent duplicate processing")
        return False
    from sqlalchemy.dialects.postgresql import insert

    stmt = (
        insert(ProcessedWebhook)
        .values(event_id=event_id, provider="razorpay")
        .on_conflict_do_nothing(index_elements=["event_id"])
    )
    result = session.execute(stmt)
    session.flush()
    # ``rowcount`` is 1 when our INSERT actually wrote a row, 0 when the
    # ON CONFLICT clause swallowed it because another worker got there first.
    return (result.rowcount or 0) > 0


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
        # Refunds — both event names land in the same handler. Razorpay
        # fires ``refund.created`` on initiation and ``refund.processed``
        # when settlement clears; we treat them identically and rely on
        # the upstream event-id dedupe so the same id never lands twice.
        "refund.created": _handle_refund_created,
        "refund.processed": _handle_refund_created,
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


def reconcile_subscription_from_razorpay(session: Session, razorpay_subscription_id: str) -> Subscription | None:
    """Idempotently fetch a Razorpay subscription and upsert it locally.

    Closes the window where a customer pays via Razorpay Checkout but the
    ``subscription.activated`` webhook hasn't yet created the local row
    (delayed delivery, worker outage, network blip). The verify endpoint
    calls this so the React admin can flip to "Subscription active"
    immediately on modal-close instead of leaving the customer in limbo.

    Idempotency: gates the upsert behind a synthetic event id
    ``reconcile:<razorpay_subscription_id>`` in ``processed_webhooks``. If
    the webhook (or a concurrent verify call) gets there first, this is a
    cheap no-op that just re-queries the local row.

    Returns the local ``Subscription`` if reconcile succeeded (now or
    previously), or ``None`` if Razorpay reports the subscription in a
    non-billable state we shouldn't materialise yet (e.g. ``created``,
    ``pending``, ``halted``) — let the webhook handle those.
    """
    synthetic_event_id = f"reconcile:{razorpay_subscription_id}"
    if not _record_or_skip_event(session, synthetic_event_id):
        # Webhook or another verify call already reconciled — just re-query.
        return _resolve_local_subscription(session, razorpay_subscription_id)

    rzp = _get_razorpay()
    try:
        sub_entity = rzp.subscription.fetch(razorpay_subscription_id)
    except Exception as exc:
        logger.exception(
            "Razorpay subscription.fetch failed during reconcile for %s",
            razorpay_subscription_id,
        )
        raise RazorpayBillingError("Could not fetch subscription from Razorpay.") from exc

    status = (sub_entity.get("status") or "").lower()
    if status not in ("active", "authenticated"):
        logger.info(
            "Razorpay subscription %s in non-billable state '%s' — deferring local upsert to webhook",
            razorpay_subscription_id,
            status,
        )
        return None

    # Synthesize a webhook-shaped payload and reuse the canonical handler so
    # the create-or-update logic stays in one place. ``_handle_subscription_activated``
    # consults ``notes.oyechats_client_id`` / ``oyechats_plan_id`` set at
    # ``create_subscription`` time.
    synthetic_payload = {"subscription": {"entity": sub_entity}}
    _handle_subscription_activated(session, synthetic_payload)
    return _resolve_local_subscription(session, razorpay_subscription_id)


def _create_bot_from_subscription_notes(
    session: Session,
    client_id: int,
    subscription: Subscription | None,
    plan_id: int,
    notes: dict[str, Any],
):
    """Materialise a Bot from the notes carried on a per-bot subscription.

    Called from :func:`_handle_subscription_activated` once a per-bot
    Razorpay subscription mandate authenticates. The bot is created NOW
    (post-payment) so a dismissed checkout leaves no orphan row.

    ``subscription`` may be ``None`` when the caller hasn't inserted the
    subscription row yet — the FK back is set later via
    ``bot.subscription_id = sub.id`` once the sub is flushed. This
    chicken-and-egg ordering is intentional: a per-bot subscription
    inserted with ``bot_id=NULL`` would collide with the legacy partial
    unique index ``ix_subscriptions_client_legacy_active``.

    Notes contract (set by :func:`create_per_bot_subscription`):

    * ``bot_name`` — required
    * ``bot_website`` — optional
    * ``bot_allowed_domains`` — optional JSON-encoded list
    * ``bot_domain_check_enabled`` — "1" or "0"
    """
    import json as _json
    import uuid as _uuid

    from app.db.models import Bot

    bot_name = (notes.get("bot_name") or "AI Assistant").strip() or "AI Assistant"
    bot_website = notes.get("bot_website") or None
    domain_check_raw = (notes.get("bot_domain_check_enabled") or "0").strip()
    domain_check_enabled = domain_check_raw == "1"

    allowed_domains: list[str] = []
    raw_domains = notes.get("bot_allowed_domains")
    if raw_domains:
        try:
            parsed = _json.loads(raw_domains) if isinstance(raw_domains, str) else raw_domains
            if isinstance(parsed, list):
                allowed_domains = [str(d) for d in parsed if isinstance(d, (str, int))]
        except (ValueError, TypeError):
            logger.warning("Could not parse bot_allowed_domains from notes: %r", raw_domains)

    bot = Bot(
        client_id=client_id,
        bot_key=f"bot-{_uuid.uuid4().hex[:12]}",
        name=bot_name,
        website=bot_website,
        plan_id=plan_id,
        subscription_id=subscription.id if subscription is not None else None,
        is_legacy_pooled=False,
        allowed_domains=allowed_domains,
        domain_check_enabled=domain_check_enabled,
    )
    session.add(bot)
    session.flush()
    return bot


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

        # Per-bot billing branch: this subscription funds one new Bot row
        # rather than replacing the client's existing subscription. Skip
        # the "cancel sibling subscriptions" sweep so the client can hold
        # one active subscription per bot concurrently.
        is_per_bot = (notes.get("purpose") or "").lower() == "per_bot_subscription"

        if not is_per_bot:
            # Account-level (legacy) flow: cancel any existing active
            # subscription for this client (upgrade flow).
            existing = (
                session.execute(
                    select(Subscription).where(
                        Subscription.client_id == client_id,
                        Subscription.status.in_(("active", "trialing", "past_due")),
                        Subscription.bot_id.is_(None),
                    )
                )
                .scalars()
                .all()
            )
            for old in existing:
                old.status = "canceled"
                old.canceled_at = datetime.now(UTC)

        # ``notes.prev_razorpay_subscription_id`` is set by the upgrade /
        # scheduled-promotion paths so we can recognise this is a transition
        # (not a first-time signup) and apply any pending proration credit.
        prev_rzp_sub_id = (notes.get("prev_razorpay_subscription_id") or "").strip() or None

        # For the per-bot path we have to materialise the Bot row FIRST so
        # the subscription INSERT can carry ``bot_id`` from the start.
        # Inserting a per-bot subscription with bot_id=NULL first would
        # collide with ``ix_subscriptions_client_legacy_active`` (which
        # enforces "one active client-level subscription per client" via
        # ``WHERE bot_id IS NULL AND status IN active/trialing/past_due``).
        new_bot = None
        if is_per_bot:
            new_bot = _create_bot_from_subscription_notes(session, client_id, None, plan_id, notes)

        local = Subscription(
            client_id=client_id,
            plan_id=plan_id,
            bot_id=new_bot.id if new_bot is not None else None,
            status="active",
            billing_cycle=notes.get("billing_cycle", "monthly"),
            operator_quantity=quantity,
            current_period_start=current_period_start,
            current_period_end=current_period_end,
            payment_provider="razorpay",
            razorpay_subscription_id=razorpay_sub_id,
            razorpay_customer_id=customer_id,
            prev_razorpay_subscription_id=prev_rzp_sub_id,
        )
        session.add(local)
        session.flush()

        if is_per_bot and new_bot is not None:
            # Now back-link the bot to the freshly inserted subscription so
            # the bot row knows which sub funds it. Uses ``post_update`` on
            # the Bot.subscription relationship to avoid the circular FK.
            new_bot.subscription_id = local.id
            session.flush()
            credit_service.grant_for_subscription(session, local)
            logger.info(
                "Activated per-bot Razorpay subscription %s → local %s (client %s, bot %s)",
                razorpay_sub_id,
                local.id,
                client_id,
                new_bot.id,
            )
            return f"Per-bot subscription activated: client {client_id}, bot {new_bot.id}"

        # Expire any unused plan_grant from the prior subscription before
        # handing out the new plan's allowance. Without this, a free-tier
        # customer who upgrades to Standard mid-cycle sees their leftover
        # free credits stacked on top of the new grant (e.g. 500 + 10,000
        # → 10,500 / 10,000). Mirrors the same reset → grant ordering used
        # by the Stripe change-plan path and ``start_trial_subscription``.
        credit_service.reset_monthly_plan_credits(session, client_id)
        credit_service.grant_for_subscription(session, local)

        # Apply any pending upgrade proration as a top-up credit. Idempotent —
        # the old sub's column is zeroed the first time this runs, so webhook
        # replays don't double-credit.
        from app.services import transition_service

        transition_service.apply_pending_proration(session, local, prev_rzp_sub_id)
        logger.info(
            "Activated Razorpay subscription %s → local %s (client %s)",
            razorpay_sub_id,
            local.id,
            client_id,
        )
        return f"Subscription activated for client {client_id}"

    # Existing local row — update fields and ensure first-month credits exist.
    # Card rescued out of dunning: drop the past_due anchor so a future
    # failure starts a fresh grace window instead of inheriting this one.
    if local.status == "past_due":
        local.past_due_since = None
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
    """Razorpay subscription completed — final invoice debited, no more cycles.

    Two paths from here:

      * Plain end-of-life: mark local row ``expired`` and return.
      * Scheduled downgrade cutover: a queued ``scheduled_plan_id`` is on
        the row. Promote it (status → expired + spin up a new Razorpay sub
        for the queued plan), so the customer transitions smoothly into
        the lower tier instead of dropping to no-subscription.
    """
    sub_entity = _extract_subscription_entity(payload)
    if not sub_entity:
        return "subscription entity missing"
    local = _resolve_local_subscription(session, sub_entity.get("id", ""))
    if not local:
        return "Subscription not found"

    if local.scheduled_plan_id:
        # Promotion path. ``promote_scheduled_change`` flips status to
        # expired itself so the partial-unique index allows the new row.
        from app.services import transition_service

        new_payload = transition_service.promote_scheduled_change(session, local)
        session.flush()
        if new_payload is None:
            # Race or stale state — fall through to plain expiry below.
            local.status = "expired"
            session.flush()
            return f"Subscription {sub_entity.get('id')} completed (scheduled change cleared)"
        return f"Subscription {sub_entity.get('id')} completed → promoted scheduled change"

    local.status = "expired"
    session.flush()
    return f"Subscription {sub_entity.get('id')} completed"


def _enter_past_due(local: Subscription) -> None:
    """Stamp ``past_due_since`` only on the FIRST entry into past_due.

    Razorpay can fire ``subscription.halted`` and ``subscription.pending``
    independently as the dunning state shifts; both land here. Without
    this idempotency guard the grace clock would reset on every retry.
    """
    from datetime import UTC
    from datetime import datetime as _dt

    if local.status != "past_due":
        local.past_due_since = _dt.now(UTC)
    local.status = "past_due"


def _handle_subscription_halted(session: Session, payload: dict[str, Any]) -> str:
    sub_entity = _extract_subscription_entity(payload)
    if not sub_entity:
        return "subscription entity missing"
    local = _resolve_local_subscription(session, sub_entity.get("id", ""))
    if not local:
        return "Subscription not found"
    _enter_past_due(local)
    session.flush()
    return f"Subscription {sub_entity.get('id')} halted"


def _handle_subscription_pending(session: Session, payload: dict[str, Any]) -> str:
    sub_entity = _extract_subscription_entity(payload)
    if not sub_entity:
        return "subscription entity missing"
    local = _resolve_local_subscription(session, sub_entity.get("id", ""))
    if not local:
        return "Subscription not found"
    _enter_past_due(local)
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

    purpose = notes.get("purpose")

    if purpose != "topup":
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

    # Notes may carry ``bot_id`` for per-bot top-ups (set by
    # ``create_topup_order(bot_id=...)``). Default to None → client pool.
    target_bot_id_raw = notes.get("bot_id")
    target_bot_id: int | None = None
    if target_bot_id_raw is not None:
        try:
            target_bot_id = int(target_bot_id_raw)
        except (TypeError, ValueError):
            target_bot_id = None

    credit_service.grant_topup(
        session,
        client_id,
        credits,
        note=f"Top-up ₹{amount_inr} pack (Razorpay {rzp_order_id or rzp_payment_id})",
        bot_id=target_bot_id,
    )
    logger.info(
        "Granted %d top-up credits to client %s bot %s via Razorpay payment %s",
        credits,
        client_id,
        target_bot_id,
        rzp_payment_id,
    )
    return f"Top-up credits granted to client {client_id} bot {target_bot_id}"


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


# ── Refund handling ─────────────────────────────────────────────────────────


def _handle_refund_created(session: Session, payload: dict[str, Any]) -> str:
    """Reverse credits on a Razorpay refund.

    The webhook payload follows Razorpay's standard ``payload.refund.entity``
    shape; the ``payment_id`` lets us locate the local ``Invoice`` row we
    wrote at capture time. Each event is uniquely identified by Razorpay's
    own event id (deduped one layer up via ``_record_or_skip_event``), so
    the cumulative-vs-delta bookkeeping that ``charge.refunded`` on Stripe
    needs is not required here: each refund event represents exactly its
    own amount.

    Both ``refund.created`` and ``refund.processed`` route here. Created
    fires the moment the refund is initiated; processed fires when the
    bank settles it. We claw back on the FIRST event so the customer
    can't keep using credits during the settlement window — the second
    event's clawback is a no-op (already-clawed delta returns 0).
    """
    refund_entity = (payload.get("refund") or {}).get("entity") or {}
    if not refund_entity:
        return "refund entity missing"

    payment_id = refund_entity.get("payment_id")
    refund_minor = int(refund_entity.get("amount") or 0)
    if not payment_id or refund_minor <= 0:
        return "refund missing payment_id or amount"

    inv = session.execute(select(Invoice).where(Invoice.razorpay_payment_id == payment_id)).scalars().first()
    if inv is None:
        logger.warning("refund event for unknown razorpay payment %s", payment_id)
        return f"Payment {payment_id} not found locally"

    charge_minor = int(inv.amount_cents or 0)
    if charge_minor <= 0:
        return f"Invoice {inv.id} has no recorded charge amount"

    clawed, entry_id = credit_service.clawback_refund(
        session,
        client_id=inv.client_id,
        charge_minor=charge_minor,
        refund_minor=refund_minor,
        note=f"Refund clawback for Razorpay refund {refund_entity.get('id', '?')}",
    )

    # Razorpay refunds may be partial; mirror Stripe's distinction so the
    # billing UI can render the right copy.
    inv.status = "refunded" if refund_minor >= charge_minor else "partially_refunded"
    session.flush()

    logger.info(
        "Razorpay refund: invoice=%s refund=%s amount_minor=%s clawed=%s entry=%s",
        inv.id,
        refund_entity.get("id"),
        refund_minor,
        clawed,
        entry_id,
    )
    return f"Refund processed: {clawed} credit(s) clawed back from invoice {inv.id}"
