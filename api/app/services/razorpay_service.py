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

import hashlib
import hmac
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
    RAZORPAY_SEAT_PLAN_ID,
    RAZORPAY_TEST_PLAN_ID,
    RAZORPAY_WEBHOOK_SECRET,
)
from app.db.models import Client, DiscountedPlanCache, Invoice, Plan, ProcessedWebhook, Subscription
from app.services import credit_service

if TYPE_CHECKING:
    import razorpay

logger = logging.getLogger(__name__)


# ── Exceptions ────────────────────────────────────────────────────────────────


# Minimum paise a discounted recurring plan may charge (remediation C3 floor).
# ₹1.00 is Razorpay's own minimum; combined with the 50% discount cap this
# makes a near-free plan unreachable from any code configuration.
MIN_DISCOUNTED_PLAN_PAISE = 100


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
    discount_bps: int | None = None,
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

    ``discount_bps`` controls the referral customer-discount:
      * ``None`` (default) → auto-resolve the client's standing discount from
        their attached referral code, so the discount applies to EVERY
        subscription they ever create (checkout, plan change, upgrade,
        downgrade cutover, per-bot) and recurs on all future charges.
      * an explicit ``int`` (including ``0``) → use that value verbatim,
        bypassing auto-resolution (e.g. to force full price).
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

    # Auto-resolve the customer's standing referral discount when the caller
    # didn't pass one explicitly. Centralising it here is what guarantees the
    # discount follows the customer across ALL future payments — every
    # subscription path (first checkout, change-plan, upgrade, downgrade
    # cutover, per-bot) flows through here, so none can silently drop it.
    if discount_bps is None:
        from app.services.discount_service import resolve_customer_discount_bps

        discount_bps, _ = resolve_customer_discount_bps(session, client)

    # Apply a recurring customer discount by swapping in a discounted plan.
    # Test-client override is excluded from discounts so QA flows stay clean.
    if discount_bps and client.id not in CHECKOUT_TEST_CLIENT_IDS:
        razorpay_plan_id = resolve_discounted_plan(session, plan, billing_cycle, discount_bps)

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
        # The plan actually billed — may differ from plan.razorpay_plan_id_*
        # when a discount was applied. The route stores this on
        # Subscription.razorpay_billing_plan_id for audit.
        "billing_plan_id": razorpay_plan_id,
    }


def resolve_discounted_plan(
    session: Session,
    base_plan: Plan,
    billing_cycle: str,
    discount_bps: int,
) -> str:
    """Return a Razorpay plan_id for base_plan discounted by discount_bps.

    Looks up the (base_plan_id, billing_cycle, discount_bps) cache first.
    On a miss, creates a new Razorpay plan at the discounted paise amount,
    inserts it into the cache, and returns the new plan_id.

    Razorpay Offers have no create API, so recurring discounts are modelled
    as discounted plans — a lower plan amount recurs automatically every
    cycle with no per-cycle coupon redemption required.

    Discount math: discounted = base - floor(base × bps / 10000).
    Integer floor keeps paise whole; the tiny rounding difference (<₹1) is
    in the customer's favour.
    """
    if not (0 < discount_bps < 10000):
        raise ValueError(f"discount_bps must be 1–9999, got {discount_bps}")
    if billing_cycle not in ("monthly", "annual"):
        raise ValueError(f"billing_cycle must be 'monthly' or 'annual', got {billing_cycle!r}")

    cached = session.scalars(
        select(DiscountedPlanCache)
        .where(DiscountedPlanCache.base_plan_id == base_plan.id)
        .where(DiscountedPlanCache.billing_cycle == billing_cycle)
        .where(DiscountedPlanCache.discount_bps == discount_bps)
    ).first()
    if cached is not None:
        return cached.razorpay_plan_id

    base_amount = int(base_plan.annual_price_cents if billing_cycle == "annual" else base_plan.monthly_price_cents)
    discounted_paise = base_amount - (base_amount * discount_bps) // 10000
    # Minimum-price floor (remediation C3): even with the discount cap, never
    # create a near-free recurring plan. Razorpay also rejects sub-₹1 charges.
    if discounted_paise < MIN_DISCOUNTED_PLAN_PAISE:
        raise ValueError(
            f"discounted price ₹{discounted_paise / 100:.2f} is below the ₹{MIN_DISCOUNTED_PLAN_PAISE / 100:.2f} "
            f"minimum (base ₹{base_amount / 100:.2f}, {discount_bps} bps)"
        )
    period = "yearly" if billing_cycle == "annual" else "monthly"

    rzp = _get_razorpay()
    plan = rzp.plan.create(
        data={
            "period": period,
            "interval": 1,
            "item": {
                "name": f"{base_plan.name} {billing_cycle} -{discount_bps // 100}%",
                "amount": discounted_paise,
                "currency": "INR",
            },
            "notes": {
                "base_plan_id": str(base_plan.id),
                "discount_bps": str(discount_bps),
            },
        }
    )

    row = DiscountedPlanCache(
        base_plan_id=base_plan.id,
        billing_cycle=billing_cycle,
        discount_bps=discount_bps,
        razorpay_plan_id=plan["id"],
        amount_paise=discounted_paise,
    )
    session.add(row)
    session.flush()
    return plan["id"]


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


# ── Refunds ─────────────────────────────────────────────────────────────────────


def refund_payment(payment_id: str, amount: int | None = None) -> dict[str, Any]:
    """Issue a refund against a captured Razorpay payment.

    ``amount`` is the refund amount in **paise** (the minor unit of INR). When
    ``None`` the full captured amount is refunded — Razorpay treats an omitted
    ``amount`` as a full refund.

    Razorpay fires ``refund.created`` / ``refund.processed`` webhooks after this
    call; :func:`_handle_refund_created` claws the granted credits back from the
    same ledger scope. This helper only initiates the gateway refund — local
    ``Invoice.status`` bookkeeping is the caller's responsibility (the webhook
    path also reconciles it), mirroring how :func:`cancel_subscription` leaves
    DB state to the webhook handler.

    Returns the raw Razorpay refund entity (id, status, amount, ...).
    """
    if not payment_id:
        raise ValueError("payment_id is required to issue a refund")

    rzp = _get_razorpay()
    data: dict[str, Any] = {}
    if amount is not None:
        if amount <= 0:
            raise ValueError(f"Refund amount must be positive, got {amount}")
        data["amount"] = int(amount)

    try:
        refund = rzp.payment.refund(payment_id, data)
    except Exception as exc:
        logger.exception("Razorpay payment.refund failed for payment %s: %s", payment_id, exc)
        raise RazorpayBillingError("Could not issue the refund with Razorpay.") from exc

    logger.info(
        "Issued Razorpay refund %s for payment %s (amount=%s)",
        (refund or {}).get("id"),
        payment_id,
        amount if amount is not None else "full",
    )
    return refund


# ── Webhooks ──────────────────────────────────────────────────────────────────


def verify_webhook_signature(*, payload: bytes, signature: str) -> None:
    """Verify the X-Razorpay-Signature header against the raw payload.

    Uses the SDK's utility (which is just ``hmac.new(secret, payload,
    sha256).hexdigest()`` under the hood — kept as SDK call so we follow
    upstream changes if the algorithm ever evolves).

    ``RAZORPAY_WEBHOOK_SECRET`` must be set; we fail-closed if missing.

    The HMAC is computed over the **exact raw bytes** Razorpay sent (never a
    ``decode("utf-8")`` round-trip, which can diverge and raises outright on
    non-UTF-8 bytes) and compared with :func:`hmac.compare_digest` (constant
    time). This is byte-for-byte the algorithm the Razorpay SDK uses, so we
    drop the SDK dependency on this trust-boundary hot path.
    """
    if not RAZORPAY_WEBHOOK_SECRET:
        raise RuntimeError("RAZORPAY_WEBHOOK_SECRET not configured")
    body = payload if isinstance(payload, bytes) else str(payload).encode("utf-8")
    expected = hmac.new(RAZORPAY_WEBHOOK_SECRET.encode("utf-8"), body, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, signature or ""):
        raise SignatureMismatch("Razorpay webhook signature mismatch")


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
        "refund.failed": _handle_refund_failed,
        # Disputes / chargebacks. Razorpay withdraws the funds on ``lost`` —
        # that's when we claw the credits back. ``created`` / ``won`` only move
        # the invoice's dispute status (H6).
        "payment.dispute.created": _handle_dispute_created,
        "payment.dispute.lost": _handle_dispute_lost,
        "payment.dispute.won": _handle_dispute_won,
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


def reconcile_subscription_from_razorpay(
    session: Session,
    razorpay_subscription_id: str,
    *,
    expected_client_id: int | None = None,
) -> Subscription | None:
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

    # L2 — defense-in-depth ownership check. The Razorpay HMAC already gates the
    # verify endpoint, but an authenticated caller passing someone else's
    # ``razorpay_subscription_id`` must not be able to upsert a row owned by the
    # ``notes.oyechats_client_id`` it carries. When the caller's identity is
    # known, refuse to materialise a subscription whose notes name a different
    # client (the webhook path, which has no caller, passes None and is trusted).
    if expected_client_id is not None:
        notes = sub_entity.get("notes") or {}
        notes_client_id = _client_id_from_notes(notes)
        if notes_client_id is not None and int(notes_client_id) != int(expected_client_id):
            logger.warning(
                "Reconcile ownership mismatch: caller %s tried to reconcile subscription %s owned by %s",
                expected_client_id,
                razorpay_subscription_id,
                notes_client_id,
            )
            raise RazorpayBillingError("Subscription does not belong to the requesting client.")

    # Synthesize a webhook-shaped payload and reuse the canonical handler so
    # the create-or-update logic stays in one place. ``_handle_subscription_activated``
    # consults ``notes.oyechats_client_id`` / ``oyechats_plan_id`` set at
    # ``create_subscription`` time.
    synthetic_payload = {"subscription": {"entity": sub_entity}}
    _handle_subscription_activated(session, synthetic_payload)
    return _resolve_local_subscription(session, razorpay_subscription_id)


def reconcile_topup_from_razorpay(
    session: Session,
    razorpay_order_id: str,
    razorpay_payment_id: str,
    *,
    expected_client_id: int | None = None,
) -> bool:
    """Idempotently grant a top-up from a verified Checkout callback (L3).

    Safety net mirroring :func:`reconcile_subscription_from_razorpay` for the
    top-up path: if the ``payment.captured`` / ``order.paid`` webhook is dropped
    (delayed delivery, worker outage), the browser's ``/credits/topup/verify``
    call still credits the customer instead of leaving paid-but-no-credits.

    Idempotency is twofold: a synthetic ``reconcile:topup:<order_id>`` event in
    ``processed_webhooks`` collapses concurrent verify calls, and
    :func:`_handle_payment_captured` itself early-returns when the payment's
    Invoice already exists — so this and the real webhook can never double-grant.

    Returns ``True`` when this call performed (or attempted) the grant, ``False``
    when another path already handled it or the payment isn't a captured top-up.
    """
    synthetic_event_id = f"reconcile:topup:{razorpay_order_id}"
    if not _record_or_skip_event(session, synthetic_event_id):
        return False  # webhook or another verify call already reconciled

    rzp = _get_razorpay()
    try:
        order = rzp.order.fetch(razorpay_order_id)
        payment = rzp.payment.fetch(razorpay_payment_id)
    except Exception as exc:
        logger.exception(
            "Razorpay fetch failed during top-up reconcile for order %s / payment %s",
            razorpay_order_id,
            razorpay_payment_id,
        )
        raise RazorpayBillingError("Could not fetch top-up from Razorpay.") from exc

    notes = (order or {}).get("notes") or {}
    if notes.get("purpose") != "topup":
        return False

    # L2-style ownership check: a caller must not reconcile someone else's order.
    if expected_client_id is not None:
        notes_client_id = _client_id_from_notes(notes)
        if notes_client_id is not None and int(notes_client_id) != int(expected_client_id):
            logger.warning(
                "Top-up reconcile ownership mismatch: caller %s, order %s owned by %s",
                expected_client_id,
                razorpay_order_id,
                notes_client_id,
            )
            raise RazorpayBillingError("Top-up does not belong to the requesting client.")

    # Only a genuinely captured payment grants credits — an authorized-but-not-
    # captured payment must wait for the webhook (or it never captures at all).
    if (payment or {}).get("status") != "captured":
        return False

    # Reuse the canonical handler so the invoice insert, NV2 amount
    # reconciliation, bot-scope resolution, and grant all stay in one place.
    synthetic_payload = {
        "payment": {"entity": {**payment, "notes": notes}},
        "order": {"entity": order},
    }
    _handle_payment_captured(session, synthetic_payload)
    return True


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
                allowed_domains = [str(d) for d in parsed if isinstance(d, str | int)]
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


def _emit_plan_purchased_notification(session: Session, client_id: int, plan_id: int, billing_cycle: str) -> None:
    """Best-effort: drop a ``plan_purchased`` row into the in-app bell.

    Wrapped in a broad try/except so a notification failure can never break
    subscription activation — the bell is a UX nicety, the activation is
    the business-critical path.
    """
    try:
        from app.db.models import Plan
        from app.services.notification_service import notify_plan_purchased

        plan = session.get(Plan, plan_id)
        notify_plan_purchased(
            session,
            client_id=client_id,
            plan_name=plan.name if plan else "Plan",
            billing_cycle=billing_cycle,
        )
    except Exception:
        logger.exception(
            "Failed to record plan_purchased notification (razorpay) for client %s plan %s",
            client_id,
            plan_id,
        )


def _grant_subscription_period(
    session: Session,
    subscription: Subscription,
    period_end: datetime | None,
    invoice_id: int | None = None,
) -> bool:
    """Reset + grant the plan's monthly credits for ``period_end``, once.

    Idempotent per billing period (remediation H4): if the subscription's
    ``last_granted_period_end`` already equals ``period_end``, this is a no-op
    and returns ``False``. Otherwise it resets the prior period's unused plan
    grant, grants the new allowance, advances the marker, and returns ``True``.

    A ``None`` ``period_end`` (event missing ``current_end``) still grants but
    cannot advance the marker; that is logged so a missing period is visible
    rather than silently double-granting on a later event.
    """
    if (
        period_end is not None
        and subscription.last_granted_period_end is not None
        and subscription.last_granted_period_end == period_end
    ):
        return False

    credit_service.reset_monthly_plan_credits(session, subscription.client_id, bot_id=subscription.bot_id)
    credit_service.grant_for_subscription(session, subscription, reference_id=invoice_id)
    if period_end is not None:
        subscription.last_granted_period_end = period_end
    else:
        logger.warning(
            "Granted subscription %s credits without a period end — marker not advanced",
            subscription.razorpay_subscription_id,
        )
    return True


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
            _emit_plan_purchased_notification(session, client_id, plan_id, notes.get("billing_cycle", "monthly"))
            return f"Per-bot subscription activated: client {client_id}, bot {new_bot.id}"

        # Expire any unused plan_grant from the prior subscription before
        # handing out the new plan's allowance. Without this, a free-tier
        # customer who upgrades to Standard mid-cycle sees their leftover
        # free credits stacked on top of the new grant (e.g. 500 + 10,000
        # → 10,500 / 10,000). Mirrors the same reset → grant ordering used
        # by the Stripe change-plan path and ``start_trial_subscription``.
        # Sets the period marker so the first subscription.charged for this
        # period is a no-op (H4).
        _grant_subscription_period(session, local, current_period_end)

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
        _emit_plan_purchased_notification(session, client_id, plan_id, notes.get("billing_cycle", "monthly"))
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

    # Record the invoice if a payment entity was included. Flushed so its id can
    # link the period grant for precise refund clawback (C2 / NV5).
    period_invoice_id: int | None = None
    if pay_entity and pay_entity.get("id"):
        rzp_payment_id = pay_entity["id"]
        existing = (
            session.execute(select(Invoice).where(Invoice.razorpay_payment_id == rzp_payment_id)).scalars().first()
        )
        if existing:
            period_invoice_id = existing.id
        else:
            period_invoice = Invoice(
                client_id=local.client_id,
                subscription_id=local.id,
                bot_id=local.bot_id,  # records ledger scope for refund clawback (C2)
                amount_cents=int(pay_entity.get("amount", 0)),
                currency=str(pay_entity.get("currency", "INR")).lower(),
                status="paid",
                razorpay_payment_id=rzp_payment_id,
                period_start=new_period_start,
                period_end=new_period_end,
                description=(f"{local.plan.name if local.plan else 'Plan'} — {local.billing_cycle}"),
                paid_at=datetime.now(UTC),
            )
            session.add(period_invoice)
            session.flush()
            period_invoice_id = period_invoice.id

    # Grant this period's credits at most once, keyed on the period end marker
    # (replaces the old fragile 24h time-window heuristic — H4). The activation
    # grant set the marker for the first period, so the first charged event for
    # that period is a no-op; each later renewal advances to a new period.
    if _grant_subscription_period(session, local, new_period_end, invoice_id=period_invoice_id):
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

    # A ``payment.captured`` webhook carries only the PAYMENT entity, but top-up
    # metadata lives on the ORDER's notes. When the order entity isn't in the
    # payload (the common payment.captured shape), fetch the order so a top-up
    # can be granted from payment.captured alone — not only from order.paid (H5).
    order_id_for_notes = (pay_entity or {}).get("order_id")
    if not notes and order_id_for_notes:
        try:
            fetched_order = _get_razorpay().order.fetch(order_id_for_notes)
            notes = (fetched_order or {}).get("notes") or {}
        except Exception:
            logger.warning("Could not fetch Razorpay order %s for top-up notes", order_id_for_notes)

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

    # Defense-in-depth (NV2): the credits to grant come from server-set order
    # notes, but the money actually captured comes from Razorpay. Reconcile the
    # two before granting so a future order-create bug — or any path that lets
    # notes drift from the charged amount — can never mint credits the customer
    # didn't pay for. ``CHECKOUT_TEST_CLIENT_IDS`` orders are deliberately
    # charged ₹1 (100 paise) while their notes carry the real pack price, so we
    # exempt exactly that documented override and nothing else.
    notes_amount_inr = notes.get("amount_inr")
    if notes_amount_inr is not None:
        expected_paise = int(notes_amount_inr) * 100
        is_test_override = client_id in CHECKOUT_TEST_CLIENT_IDS and amount_paise == 100
        if not is_test_override and amount_paise != expected_paise:
            raise RazorpayBillingError(
                f"Top-up amount mismatch for client {client_id}: captured {amount_paise} paise "
                f"but order notes declare ₹{notes_amount_inr} ({expected_paise} paise); "
                f"refusing to grant {credits} credits (payment {rzp_payment_id})"
            )

    # Notes may carry ``bot_id`` for per-bot top-ups (set by
    # ``create_topup_order(bot_id=...)``). Default to None → client pool.
    # Resolved before the invoice insert so the invoice records the ledger
    # scope this payment credited (remediation C2 — drives refund clawback).
    target_bot_id_raw = notes.get("bot_id")
    target_bot_id: int | None = None
    if target_bot_id_raw is not None:
        try:
            target_bot_id = int(target_bot_id_raw)
        except (TypeError, ValueError):
            target_bot_id = None

    invoice = Invoice(
        client_id=client_id,
        subscription_id=None,
        bot_id=target_bot_id,
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
        bot_id=target_bot_id,
        reference_id=invoice.id,  # link grant → invoice for precise refund clawback (C2)
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

    Both ``refund.created`` and ``refund.processed`` route here. Created fires
    the moment the refund is initiated; processed fires when the bank settles
    it. We claw back on the FIRST event so the customer can't keep using credits
    during the settlement window, and dedupe on the refund id so the second
    event never claws again — even if a fresh grant arrived in between (N2).
    """
    refund_entity = (payload.get("refund") or {}).get("entity") or {}
    if not refund_entity:
        return "refund entity missing"

    payment_id = refund_entity.get("payment_id")
    refund_minor = int(refund_entity.get("amount") or 0)
    if not payment_id or refund_minor <= 0:
        return "refund missing payment_id or amount"

    # Dedupe by REFUND id, not just webhook event id. ``refund.created`` and
    # ``refund.processed`` are distinct events (distinct ``x-razorpay-event-id``)
    # for the SAME refund, so the top-level event dedup lets both through.
    # Without this, a grant that lands between the two events would be clawed a
    # second time (remediation N2). First event to arrive claws; the rest no-op.
    refund_id = refund_entity.get("id")
    # A refund with no id can't be deduped — reject rather than process it
    # un-deduped (which would let refund.created + refund.processed double-claw).
    if not refund_id:
        logger.warning("refund event missing id for payment %s — rejecting", payment_id)
        return "refund missing id"
    if not _record_or_skip_event(session, f"refund:{refund_id}"):
        return f"Refund {refund_id} already clawed back"

    inv = session.execute(select(Invoice).where(Invoice.razorpay_payment_id == payment_id)).scalars().first()
    if inv is None:
        logger.warning("refund event for unknown razorpay payment %s", payment_id)
        return f"Payment {payment_id} not found locally"

    charge_minor = int(inv.amount_cents or 0)
    if charge_minor <= 0:
        return f"Invoice {inv.id} has no recorded charge amount"

    # Reverse credits from the SAME ledger scope and grant type the payment
    # credited (remediation C2): the invoice records the bot scope, and a
    # subscription invoice (subscription_id set) paid for a plan_grant while a
    # one-off invoice paid for a topup.
    reasons = ("plan_grant",) if inv.subscription_id is not None else ("topup",)
    clawed, entry_id = credit_service.clawback_refund(
        session,
        client_id=inv.client_id,
        charge_minor=charge_minor,
        refund_minor=refund_minor,
        note=f"Refund clawback for Razorpay refund {refund_entity.get('id', '?')}",
        bot_id=inv.bot_id,
        reasons=reasons,
        invoice_id=inv.id,  # claw back the grant THIS invoice paid for (C2 / NV5)
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


def _handle_refund_failed(session: Session, payload: dict[str, Any]) -> str:
    """A previously-initiated refund FAILED at the gateway — restore the credits
    we clawed on ``refund.created`` (remediation N1).

    Deduped on ``refund_failed:<id>`` so a replay can't over-restore. Matches the
    original clawback rows by the deterministic note we wrote, mirrors them back,
    and re-marks the invoice ``paid`` since the money was never actually returned.
    """
    refund_entity = (payload.get("refund") or {}).get("entity") or {}
    refund_id = refund_entity.get("id")
    if not refund_id:
        return "refund.failed missing id"
    if not _record_or_skip_event(session, f"refund_failed:{refund_id}"):
        return f"Refund {refund_id} failure already handled"

    payment_id = refund_entity.get("payment_id")
    inv = _invoice_for_payment(session, payment_id) if payment_id else None
    if inv is None:
        logger.warning("refund.failed for unknown razorpay payment %s (refund %s)", payment_id, refund_id)
        return f"Payment {payment_id} not found locally"

    restored = credit_service.reverse_refund_clawback(
        session,
        client_id=inv.client_id,
        bot_id=inv.bot_id,
        clawback_note=f"Refund clawback for Razorpay refund {refund_id}",
    )
    if inv.status in ("refunded", "partially_refunded"):
        inv.status = "paid"
    session.flush()
    logger.info("Razorpay refund %s failed → restored %s credits to invoice %s", refund_id, restored, inv.id)
    return f"Refund {refund_id} failed: restored {restored} credit(s) to invoice {inv.id}"


# ── Dispute / chargeback handling ────────────────────────────────────────────


def _extract_dispute_entity(payload: dict[str, Any]) -> dict[str, Any]:
    return (payload.get("dispute") or {}).get("entity") or {}


def _invoice_for_payment(session: Session, payment_id: str) -> Invoice | None:
    return session.execute(select(Invoice).where(Invoice.razorpay_payment_id == payment_id)).scalars().first()


def _handle_dispute_created(session: Session, payload: dict[str, Any]) -> str:
    """A dispute/chargeback was opened. Razorpay withdraws the funds only on
    ``lost``, so here we just flag the invoice; the credit clawback happens in
    :func:`_handle_dispute_lost` (H6)."""
    dispute = _extract_dispute_entity(payload)
    payment_id = dispute.get("payment_id")
    if not payment_id:
        return "dispute missing payment_id"
    inv = _invoice_for_payment(session, payment_id)
    if inv is None:
        logger.warning("dispute.created for unknown razorpay payment %s", payment_id)
        return f"Payment {payment_id} not found locally"
    inv.status = "disputed"
    session.flush()
    return f"Dispute {dispute.get('id')} opened on invoice {inv.id}"


def _handle_dispute_lost(session: Session, payload: dict[str, Any]) -> str:
    """Dispute lost — Razorpay has withdrawn the funds, so reverse the credits
    the payment granted, from the SAME ledger scope and grant type a refund
    would use (C2). Deduped on the dispute id so a replay (or created→lost
    sequence) can't double-claw."""
    dispute = _extract_dispute_entity(payload)
    dispute_id = dispute.get("id")
    payment_id = dispute.get("payment_id")
    if not payment_id:
        return "dispute missing payment_id"
    if dispute_id and not _record_or_skip_event(session, f"dispute_lost:{dispute_id}"):
        return f"Dispute {dispute_id} already clawed back"
    inv = _invoice_for_payment(session, payment_id)
    if inv is None:
        logger.warning("dispute.lost for unknown razorpay payment %s", payment_id)
        return f"Payment {payment_id} not found locally"
    charge_minor = int(inv.amount_cents or 0)
    dispute_minor = int(dispute.get("amount") or charge_minor)
    reasons = ("plan_grant",) if inv.subscription_id is not None else ("topup",)
    clawed, _entry = credit_service.clawback_refund(
        session,
        client_id=inv.client_id,
        charge_minor=charge_minor,
        refund_minor=dispute_minor,
        note=f"Chargeback clawback for Razorpay dispute {dispute_id or '?'}",
        bot_id=inv.bot_id,
        reasons=reasons,
        invoice_id=inv.id,  # claw back the grant THIS invoice paid for (C2 / NV5)
    )
    inv.status = "dispute_lost"
    session.flush()
    return f"Dispute {dispute_id} lost: {clawed} credit(s) clawed from invoice {inv.id}"


def _handle_dispute_won(session: Session, payload: dict[str, Any]) -> str:
    """Dispute won — funds retained. We never clawed (clawback is on ``lost``),
    so just clear the dispute flag."""
    dispute = _extract_dispute_entity(payload)
    payment_id = dispute.get("payment_id")
    if not payment_id:
        return "dispute missing payment_id"
    inv = _invoice_for_payment(session, payment_id)
    if inv is None:
        return f"Payment {payment_id} not found locally"
    if inv.status == "disputed":
        inv.status = "paid"
    session.flush()
    return f"Dispute {dispute.get('id')} won on invoice {inv.id}"
