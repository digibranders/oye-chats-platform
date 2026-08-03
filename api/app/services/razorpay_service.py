"""Razorpay billing integration.

Razorpay is the primary billing provider for OyeChats — Indian customers,
INR pricing, UPI Autopay for recurring mandates. This module mirrors the
shape expected by the routes layer
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
  HTTP header.

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
from collections.abc import Iterator
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import (
    CHECKOUT_TEST_CLIENT_IDS,
    EXTRA_SEAT_PRICE_USD_CENTS,
    RAZORPAY_ENABLED,
    RAZORPAY_KEY_ID,
    RAZORPAY_KEY_SECRET,
    RAZORPAY_SEAT_PLAN_ID,
    RAZORPAY_SEAT_PLAN_ID_USD,
    RAZORPAY_SEAT_PLAN_PRICE_CENTS,
    RAZORPAY_TEST_PLAN_ID,
    RAZORPAY_WEBHOOK_SECRET,
)
from app.core.dates import add_months
from app.core.pricing import charge_currency, format_amount
from app.db.models import Client, DiscountedPlanCache, Invoice, Plan, ProcessedWebhook, Subscription
from app.services import credit_service, email_service, invoice_service

if TYPE_CHECKING:
    import razorpay

logger = logging.getLogger(__name__)


# ── Exceptions ────────────────────────────────────────────────────────────────


# Minimum paise a discounted recurring plan may charge (remediation C3 floor).
# ₹1.00 is Razorpay's own minimum; combined with the 50% discount cap this
# makes a near-free plan unreachable from any code configuration.
MIN_DISCOUNTED_PLAN_PAISE = 100
# Same floor for the USD rail, in cents — Razorpay's international minimum.
MIN_DISCOUNTED_PLAN_CENTS_USD = 50


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


class WebhookOutOfOrder(RazorpayBillingError):
    """Raised when a webhook references state that doesn't exist locally *yet*.

    Razorpay fires ``subscription.charged`` and ``subscription.activated``
    near-simultaneously on the first payment, and ``charged`` can win the
    race — arriving before the activation handler has linked the
    ``razorpay_subscription_id``. Ack-dropping that event (the old behaviour)
    permanently lost the period's invoice: Razorpay never retries a 2xx.

    Raising instead routes the event through the standard failure path: the
    transaction (including the idempotency row) rolls back, the raw event is
    dead-lettered, and the route returns 5xx so Razorpay redelivers — by which
    time activation has landed and the retry processes cleanly. Verified in
    prod 2026-07-02 (client 11's first live charge lost its invoice this way).
    """


class RazorpayTransientError(RazorpayBillingError):
    """Raised when a webhook can't be *decided* because a dependent Razorpay read
    failed (e.g. ``order.fetch`` timed out), so we don't yet know whether it was a
    top-up.

    Swallowing this (the old behaviour) acked the event as "ignored" and burned
    the idempotency row, permanently losing a paid top-up — customer charged,
    zero credits, never reprocessed. Raising routes it through the standard
    failure path (rollback + dead-letter + 5xx) so Razorpay redelivers; the
    Invoice/credit idempotency makes the eventual success a no-op (finding C).
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

    The pack must come from ``pricing_config.topup_packs`` and carry an INR
    price under ``inr`` (rupees, major unit — NOT paise; we convert here so the
    config table stays human-readable). ``amount`` is accepted as a legacy
    alias. Any ``usd`` on the pack is DISPLAY ONLY — Razorpay charges INR, so we
    must never bill the USD figure.

    Top-ups intentionally do NOT honour referral discounts — that incentive
    fires only on subscription checkout. See subscription_routes.create_checkout.
    """
    amount_inr_major = pack.get("inr") if pack.get("inr") is not None else pack.get("amount")
    if not amount_inr_major:
        raise ValueError("Top-up pack is missing an INR amount ('inr')")

    # Razorpay charges INR on this rail regardless of the display currency.
    currency = "INR"

    rzp = _get_razorpay()
    amount_inr = int(amount_inr_major)
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
    # The modal advertises USD prices to non-INR buyers while Razorpay charges
    # INR. Carry the display price into notes so the invoice line can name the
    # pack the customer chose ("$249 pack") — GST documents must state values in
    # INR, so the USD figure stays descriptive only. Fall back to the pack's
    # ``usd`` when no explicit display_amount is configured.
    display_amount = pack.get("display_amount")
    display_currency = str(pack.get("display_currency") or "").upper()
    if display_amount is None and pack.get("usd") is not None:
        display_amount = pack.get("usd")
        display_currency = "USD"
    if display_amount is not None and display_currency:
        symbol = "$" if display_currency == "USD" else f"{display_currency} "
        notes["display_price"] = f"{symbol}{display_amount}"
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


def _plan_id_for_rail(plan: Plan, billing_cycle: str, currency: str) -> str | None:
    """Razorpay plan id for ``plan`` on the ``currency`` rail, or None if unset.

    Returning None (rather than falling back to the other rail) is the whole
    point: a Razorpay plan's currency is fixed at creation, so an INR id used
    for a USD customer would debit rupees against a dollar quote. The caller
    turns None into a hard error.
    """
    if currency == "USD":
        return plan.razorpay_plan_id_annual_usd if billing_cycle == "annual" else plan.razorpay_plan_id_monthly_usd
    return plan.razorpay_plan_id_annual if billing_cycle == "annual" else plan.razorpay_plan_id_monthly


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

    # Which rail this customer is charged on. Resolved from the client here —
    # not passed in by the caller — for the same reason ``discount_bps`` is:
    # EVERY subscription path (first checkout, change-plan, upgrade, downgrade
    # cutover, per-bot) flows through this function, so resolving centrally is
    # what guarantees none of them can silently mint an INR mandate for an
    # international customer.
    currency = charge_currency(getattr(client, "billing_country", None))
    razorpay_plan_id = _plan_id_for_rail(plan, billing_cycle, currency)
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
            f"Plan '{plan.name}' has no {currency} Razorpay plan id configured for {billing_cycle} billing. "
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
        razorpay_plan_id = resolve_discounted_plan(session, plan, billing_cycle, discount_bps, currency=currency)

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


# Razorpay subscription states in which the hosted checkout can still be paid.
# Anything else (cancelled/completed/expired/active) means the pending checkout is
# dead and a fresh one must be minted.
_AUTHORIZABLE_SUB_STATES = frozenset({"created", "authenticated", "pending"})


def rebuild_upgrade_checkout(
    subscription_id: str, client: Client, plan: Plan, billing_cycle: str
) -> dict[str, Any] | None:
    """Rebuild the Checkout payload for an EXISTING (in-flight) Razorpay
    subscription — used to return a pending upgrade's checkout on a double-submit
    instead of minting a second subscription (finding D).

    Fetches the subscription to recover its ``short_url`` (Razorpay's hosted
    checkout) and billed plan id. Raises rather than silently minting a new sub on
    a fetch failure, so we never reopen the double-charge window. Returns ``None``
    when the pending sub is no longer authorizable (abandoned → cancelled/expired)
    so the caller can clear the stale marker and mint a fresh checkout instead of
    handing back a dead one (M3).
    """
    try:
        sub = _get_razorpay().subscription.fetch(subscription_id)
    except Exception as exc:
        logger.exception("Could not reload pending upgrade subscription %s: %s", subscription_id, exc)
        raise RazorpayBillingError("Could not reload your pending upgrade. Please try again.") from exc
    status = str(sub.get("status") or "").lower()
    if status not in _AUTHORIZABLE_SUB_STATES:
        logger.info("Pending upgrade sub %s is '%s' — not reusable; caller will re-mint", subscription_id, status)
        return None
    return {
        "provider": "razorpay",
        "subscription_id": subscription_id,
        "short_url": sub.get("short_url"),
        "key_id": RAZORPAY_KEY_ID,
        "name": "OyeChats",
        "description": f"{plan.name} ({billing_cycle})",
        "prefill": {"name": client.name or "", "email": client.email or ""},
        "theme": {"color": "#6366f1"},
        "billing_plan_id": sub.get("plan_id"),
    }


def resolve_discounted_plan(
    session: Session,
    base_plan: Plan,
    billing_cycle: str,
    discount_bps: int,
    *,
    currency: str = "INR",
) -> str:
    """Return a Razorpay plan_id for base_plan discounted by discount_bps.

    Looks up the (base_plan_id, billing_cycle, discount_bps, currency) cache
    first. On a miss, creates a new Razorpay plan at the discounted amount,
    inserts it into the cache, and returns the new plan_id.

    Razorpay Offers have no create API, so recurring discounts are modelled
    as discounted plans — a lower plan amount recurs automatically every
    cycle with no per-cycle coupon redemption required.

    ``currency`` selects the rail: the discount is computed off that rail's
    base price (``*_price_usd_cents`` for USD) and the minted plan carries that
    currency. It is part of the cache key because a Razorpay plan's currency is
    fixed at creation — reusing an INR plan for a USD customer would debit
    rupees against a dollar quote.

    Discount math: discounted = base - floor(base × bps / 10000).
    Integer floor keeps minor units whole; the tiny rounding difference (<1
    major unit) is in the customer's favour.
    """
    if not (0 < discount_bps < 10000):
        raise ValueError(f"discount_bps must be 1–9999, got {discount_bps}")
    if billing_cycle not in ("monthly", "annual"):
        raise ValueError(f"billing_cycle must be 'monthly' or 'annual', got {billing_cycle!r}")
    if currency not in ("INR", "USD"):
        raise ValueError(f"currency must be 'INR' or 'USD', got {currency!r}")

    if currency == "USD":
        base_amount = int(
            (base_plan.annual_price_usd_cents if billing_cycle == "annual" else base_plan.monthly_price_usd_cents) or 0
        )
        minimum = MIN_DISCOUNTED_PLAN_CENTS_USD
    else:
        base_amount = int(base_plan.annual_price_cents if billing_cycle == "annual" else base_plan.monthly_price_cents)
        minimum = MIN_DISCOUNTED_PLAN_PAISE
    discounted_paise = base_amount - (base_amount * discount_bps) // 10000
    # Minimum-price floor (remediation C3): even with the discount cap, never
    # create a near-free recurring plan. Razorpay also rejects sub-₹1 charges.
    if discounted_paise < minimum:
        raise ValueError(
            f"discounted price {format_amount(discounted_paise, currency)} is below the "
            f"{format_amount(minimum, currency)} minimum "
            f"(base {format_amount(base_amount, currency)}, {discount_bps} bps)"
        )

    cached = session.scalars(
        select(DiscountedPlanCache)
        .where(DiscountedPlanCache.base_plan_id == base_plan.id)
        .where(DiscountedPlanCache.billing_cycle == billing_cycle)
        .where(DiscountedPlanCache.discount_bps == discount_bps)
        .where(DiscountedPlanCache.currency == currency)
    ).first()
    # A cache hit is only valid if the cached amount still equals the price the
    # CURRENT base plan produces. Otherwise the base price changed since we
    # cached and the row points at a Razorpay plan billing the old amount, so we
    # must create a fresh discounted plan and refresh the row (audit F34).
    if cached is not None and cached.amount_paise == discounted_paise:
        return cached.razorpay_plan_id

    period = "yearly" if billing_cycle == "annual" else "monthly"

    rzp = _get_razorpay()
    plan = rzp.plan.create(
        data={
            "period": period,
            "interval": 1,
            "item": {
                "name": f"{base_plan.name} {billing_cycle} -{discount_bps // 100}% {currency}",
                "amount": discounted_paise,
                "currency": currency,
            },
            "notes": {
                "base_plan_id": str(base_plan.id),
                "discount_bps": str(discount_bps),
                "currency": currency,
            },
        }
    )

    if cached is not None:
        # Refresh the stale row in place — the UNIQUE (base_plan_id, cycle, bps,
        # currency) constraint means we can't insert a second row for the same key.
        cached.razorpay_plan_id = plan["id"]
        cached.amount_paise = discounted_paise
    else:
        session.add(
            DiscountedPlanCache(
                base_plan_id=base_plan.id,
                billing_cycle=billing_cycle,
                discount_bps=discount_bps,
                currency=currency,
                razorpay_plan_id=plan["id"],
                amount_paise=discounted_paise,
            )
        )
    session.flush()
    return plan["id"]


def create_plan_for_price(*, name: str, amount_paise: int, period: str, currency: str = "INR") -> str:
    """Mint a fresh immutable Razorpay plan at ``amount_paise`` and return its id.

    Used when a super-admin edits a plan's price (finding B): Razorpay plans are
    immutable, so a new price needs a new plan. ``period`` is Razorpay's cadence
    (``"monthly"`` / ``"yearly"``).
    """
    if amount_paise <= 0:
        raise ValueError(f"amount_paise must be positive, got {amount_paise}")
    if period not in ("monthly", "yearly"):
        raise ValueError(f"period must be 'monthly' or 'yearly', got {period!r}")
    rzp = _get_razorpay()
    try:
        plan = rzp.plan.create(
            data={
                "period": period,
                "interval": 1,
                "item": {"name": name[:255], "amount": int(amount_paise), "currency": currency},
            }
        )
    except Exception as exc:
        logger.exception("Razorpay plan.create failed for new price %s (%s): %s", amount_paise, period, exc)
        raise RazorpayBillingError("Could not create Razorpay plan for the new price. Please try again.") from exc
    return plan["id"]


def create_seat_addon_subscription(
    session: Session,
    client: Client,
    *,
    extra_seats: int,
) -> dict[str, Any]:
    """Create a separate (seat-price × extra_seats) Razorpay subscription for operator seats.

    Must be a distinct subscription from the main plan. Razorpay `quantity`
    multiplies the entire plan amount, which would make the main plan wrong
    (e.g. ₹949×2 instead of ₹949+₹449). The Extra-Seat plan's amount IS the
    per-seat price (₹449 — ``RAZORPAY_SEAT_PLAN_PRICE_CENTS``), so
    ``price × extra_seats`` is exactly right here.

    Seats follow the customer's rail: an international client bills against the
    USD seat plan, so the add-on currency can never disagree with the main
    subscription's.
    """
    if extra_seats < 1:
        raise ValueError(f"extra_seats must be >= 1, got {extra_seats}")

    currency = charge_currency(getattr(client, "billing_country", None))
    seat_plan_id = RAZORPAY_SEAT_PLAN_ID_USD if currency == "USD" else RAZORPAY_SEAT_PLAN_ID
    if not seat_plan_id:
        env_var = "RAZORPAY_SEAT_PLAN_ID_USD" if currency == "USD" else "RAZORPAY_SEAT_PLAN_ID"
        raise RazorpayBillingError(
            f"Extra-seat billing is not configured for the {currency} rail ({env_var} is unset). "
            "Set it to the environment's seat add-on plan id."
        )

    rzp = _get_razorpay()
    try:
        subscription = rzp.subscription.create(
            data={
                "plan_id": seat_plan_id,
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

    return _seat_checkout_payload(subscription["id"], client, extra_seats, short_url=subscription.get("short_url"))


def _seat_checkout_payload(
    subscription_id: str, client: Client, extra_seats: int, *, short_url: str | None = None
) -> dict[str, Any]:
    """Checkout payload for a seat add-on subscription. Reused when re-opening an
    unauthorized pending purchase (finding A C1) so we never need a Razorpay
    round-trip just to rebuild it — the JS SDK only needs subscription_id + key.
    ``short_url`` (Razorpay's hosted checkout) is included when known so a webhook
    path can email the customer a re-authorization link.

    The quoted per-seat price follows the client's rail, so the description can
    never advertise rupees against a dollar charge."""
    currency = charge_currency(getattr(client, "billing_country", None))
    seat_minor = EXTRA_SEAT_PRICE_USD_CENTS if currency == "USD" else RAZORPAY_SEAT_PLAN_PRICE_CENTS
    seat_display = format_amount(seat_minor, currency)
    return {
        "provider": "razorpay",
        "subscription_id": subscription_id,
        "short_url": short_url,
        "key_id": RAZORPAY_KEY_ID,
        "name": "OyeChats operator seats",
        "description": f"{extra_seats} extra seat(s) — {seat_display}/seat/month",
        "prefill": {
            "name": client.name or "",
            "email": client.email or "",
        },
        "theme": {"color": "#6366f1"},
    }


def edit_seat_addon_quantity(
    session: Session, sub: Subscription, extra_seats: int, *, require_authorization: bool = True
) -> dict[str, Any] | None:
    """Set the operator-seat add-on quantity for ``sub``.

    Creates the add-on subscription on first use, edits its quantity thereafter,
    and cancels it when ``extra_seats`` drops to 0. The main plan subscription is
    NEVER touched here (P0-3).

    Returns the Razorpay Checkout payload ONLY on a customer-initiated first
    purchase (``require_authorization=True``, the default) — the seat
    subscription is created in ``created`` state and charges nothing until the
    customer authorizes the mandate, so entitlement must wait for the seat
    ``activated`` webhook (finding A). The desired count is stashed in
    ``seat_addon_pending_quantity`` and ``seat_addon_quantity`` stays 0 until
    then. Returns ``None`` when no authorization step is needed: an edit on an
    already-authorized add-on, a reduction/cancel, or the SYSTEM seat-carry at a
    plan cutover (``require_authorization=False``) — there the seats were already
    authorized on the prior subscription, so they activate immediately.
    """
    extra_seats = max(int(extra_seats), 0)
    if extra_seats == 0:
        if sub.seat_addon_subscription_id:
            cancel_seat_addon(session, sub)
        sub.seat_addon_quantity = 0
        sub.seat_addon_pending_quantity = None
        session.flush()
        return None

    if not sub.seat_addon_subscription_id:
        addon = create_seat_addon_subscription(session, sub.client, extra_seats=extra_seats)
        sub.seat_addon_subscription_id = addon["subscription_id"]
        if require_authorization:
            # Customer first purchase → mandate not yet authorized. Stash the
            # desired count as PENDING and return the checkout. Do NOT set
            # seat_addon_quantity/operator_quantity — the activation webhook does.
            sub.seat_addon_pending_quantity = extra_seats
            session.flush()
            return addon
        # System carry across a plan cutover. The carried seats move onto a NEW
        # Razorpay seat sub minted in ``created`` state — a fresh UPI mandate that
        # does NOT charge until re-authorized. We therefore MUST NOT grant
        # entitlement here: bumping operator_quantity would hand the customer free,
        # unbilled seats indefinitely (a revenue leak). We keep only the billed
        # mirror; entitlement stays gated on a seat ``activated``/``charged``
        # webhook (finding A), so if the carried mandate is re-authorized the seats
        # activate then, and if it isn't they never entitle and never leak.
        #
        # KNOWN PRE-EXISTING GAP (out of scope, tracked separately): nothing here
        # surfaces the carried-seat checkout for re-authorization the way
        # ``promote_scheduled_change`` does for the plan, so carried seats are
        # currently suspended after a cutover until the customer re-buys them.
        # The old code had the same uncharged-carry gap; this PR does not widen it.
        sub.seat_addon_quantity = extra_seats
        sub.seat_addon_pending_quantity = None
        session.flush()
        return None

    # A seat sub id is already present. CRITICAL (finding A C1): a pending,
    # never-authorized first purchase ALSO has seat_addon_subscription_id set
    # (the sub sits in ``created`` state and never charges). If we fell through
    # to the "edit + entitle" path below, a customer who dismissed the checkout
    # and retried would get entitled seats with no mandate and no charge — the
    # exact free-seats bug. So while a purchase is still pending authorization,
    # keep re-authorizing: update the created sub's quantity if it changed,
    # re-stash pending, and return the checkout again. Never entitle here.
    if require_authorization and sub.seat_addon_pending_quantity is not None:
        rzp = _get_razorpay()
        if int(sub.seat_addon_pending_quantity) != extra_seats:
            try:
                rzp.subscription.edit(sub.seat_addon_subscription_id, data={"quantity": extra_seats})
            except Exception as exc:
                logger.exception(
                    "Razorpay seat add-on quantity update (pending re-auth, qty=%d) failed for %s: %s",
                    extra_seats,
                    sub.seat_addon_subscription_id,
                    exc,
                )
                raise RazorpayBillingError("Could not update seat add-on with Razorpay.") from exc
        sub.seat_addon_pending_quantity = extra_seats
        session.flush()
        return _seat_checkout_payload(sub.seat_addon_subscription_id, sub.client, extra_seats)

    # Existing, already-authorized add-on → the mandate can be charged now, so
    # apply the new quantity immediately.
    rzp = _get_razorpay()
    try:
        rzp.subscription.edit(
            sub.seat_addon_subscription_id,
            data={"quantity": extra_seats, "schedule_change_at": "now"},
        )
    except Exception as exc:
        logger.exception(
            "Razorpay seat add-on edit (qty=%d) failed for %s: %s",
            extra_seats,
            sub.seat_addon_subscription_id,
            exc,
        )
        raise RazorpayBillingError("Could not update seat add-on with Razorpay.") from exc
    sub.seat_addon_quantity = extra_seats
    sub.seat_addon_pending_quantity = None
    session.flush()
    return None


def cancel_seat_addon(session: Session, sub: Subscription) -> None:
    """Cancel the seat add-on subscription at the gateway and clear the mirror."""
    if not sub.seat_addon_subscription_id:
        return
    rzp = _get_razorpay()
    try:
        rzp.subscription.cancel(
            sub.seat_addon_subscription_id,
            data={"cancel_at_cycle_end": 0},
        )
    except Exception as exc:
        logger.exception(
            "Razorpay seat add-on cancel failed for %s: %s",
            sub.seat_addon_subscription_id,
            exc,
        )
        raise RazorpayBillingError("Could not cancel the seat add-on with Razorpay.") from exc
    sub.seat_addon_subscription_id = None
    sub.seat_addon_quantity = 0
    session.flush()


def cancel_seat_addon_by_id(seat_addon_subscription_id: str) -> None:
    """Cancel a seat add-on subscription at the gateway by its raw id.

    Unlike :func:`cancel_seat_addon`, this takes no local ``Subscription`` and
    touches no local row — it exists for the reconciliation sweep
    (:func:`seat_addon_reports.reconcile_orphaned_seat_addons`), which cancels
    orphans that may have NO local owner at all (e.g. an add-on minted by an
    activation whose transaction later rolled back). The caller is responsible
    for clearing any stale local pointer separately.
    """
    if not seat_addon_subscription_id:
        return
    rzp = _get_razorpay()
    try:
        rzp.subscription.cancel(
            seat_addon_subscription_id,
            data={"cancel_at_cycle_end": 0},
        )
    except Exception as exc:
        logger.exception(
            "Razorpay seat add-on cancel (by id) failed for %s: %s",
            seat_addon_subscription_id,
            exc,
        )
        raise RazorpayBillingError("Could not cancel the seat add-on with Razorpay.") from exc


def iter_seat_addon_subscriptions(*, page_size: int = 100, max_pages: int = 50) -> Iterator[dict[str, Any]]:
    """Yield every operator-seat add-on subscription known to Razorpay.

    Pages through the Razorpay subscriptions list and filters to add-on rows —
    identified by ``notes.purpose == "seat_addon"`` and, defensively, the
    Extra-Seat ``plan_id``. Used by the reconciliation sweep to find add-ons
    whose local owner is gone. ``max_pages`` bounds the scan; if it is hit the
    shortfall is logged loudly so a silently-partial sweep can't masquerade as
    a clean one.
    """
    rzp = _get_razorpay()
    skip = 0
    for _ in range(max_pages):
        resp = rzp.subscription.all({"count": page_size, "skip": skip})
        items = resp.get("items", []) if isinstance(resp, dict) else []
        if not items:
            return
        for item in items:
            item_notes = item.get("notes") or {}
            if (item_notes.get("purpose") or "").lower() != "seat_addon":
                continue
            item_plan_id = item.get("plan_id")
            if item_plan_id and item_plan_id != RAZORPAY_SEAT_PLAN_ID:
                continue
            yield item
        if len(items) < page_size:
            return
        skip += page_size
    logger.error(
        "iter_seat_addon_subscriptions hit the max_pages=%d cap — some subscriptions were "
        "NOT scanned for orphan reconciliation. Increase the cap or investigate volume.",
        max_pages,
    )


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
    here.
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


def _record_seat_invoice(session: Session, sub: Subscription, payload: dict[str, Any]) -> None:
    """Emit a payment-history invoice for a seat add-on charge (finding A).

    Seat revenue must be documented for GST/reconciliation just like a plan
    charge — but it grants NO credits. Idempotent on the Razorpay payment id;
    routed through ``finalize_invoice_safely`` so it becomes a numbered GST tax
    invoice when invoicing v2 is on, and so a finalize failure never blocks the
    webhook.
    """
    pay_entity = _extract_payment_entity(payload) or {}
    payment_id = pay_entity.get("id")
    if not payment_id:
        return
    existing = session.execute(select(Invoice).where(Invoice.razorpay_payment_id == payment_id)).scalars().first()
    if existing:
        return
    invoice = Invoice(
        client_id=sub.client_id,
        subscription_id=sub.id,
        bot_id=sub.bot_id,
        amount_cents=int(pay_entity.get("amount") or 0),
        currency=str(pay_entity.get("currency") or "INR").lower(),
        status="paid",
        razorpay_payment_id=payment_id,
        description="Operator seat add-on",
        paid_at=_capture_paid_at(pay_entity),
    )
    session.add(invoice)
    session.flush()
    invoice_service.finalize_invoice_safely(session, invoice)


def _handle_seat_addon_event(
    session: Session, event_name: str, sub_entity: dict[str, Any], payload: dict[str, Any]
) -> str:
    """Seat add-on lifecycle. Grants NO plan credits, but gates seat entitlement
    on mandate authorization and invoices seat charges (finding A)."""
    seat_sub_id = sub_entity.get("id")
    local = session.scalars(select(Subscription).where(Subscription.seat_addon_subscription_id == seat_sub_id)).first()
    if local is None:
        logger.info("Seat add-on event %s for unknown seat sub %s — acknowledged", event_name, seat_sub_id)
        return f"Seat add-on event {event_name} (no local sub)"

    included = int((local.plan.included_operator_seats if local.plan else 1) or 1)

    if event_name in ("subscription.activated", "subscription.charged"):
        # Authorization confirmed → promote the pending count to authorized and
        # grant entitlement. ``pending`` is None on a plain renewal charge, in
        # which case the already-authorized seat_addon_quantity stands.
        pending = local.seat_addon_pending_quantity
        if pending is not None:
            local.seat_addon_quantity = int(pending)
            local.seat_addon_pending_quantity = None
        local.operator_quantity = included + int(local.seat_addon_quantity or 0)
        if event_name == "subscription.charged":
            _record_seat_invoice(session, local, payload)

    elif event_name in ("subscription.cancelled", "subscription.completed"):
        # Terminal — the add-on is gone. Drop to the plan's included seats.
        local.seat_addon_quantity = 0
        local.seat_addon_pending_quantity = None
        local.operator_quantity = included

    elif event_name == "subscription.halted":
        # Temporary (repeated payment failure). Suspend entitlement but KEEP the
        # authorized count (M1): a recovery ``charged`` re-derives operator_quantity
        # from it, so we never invoice a seat without restoring its entitlement.
        local.operator_quantity = included

    session.flush()
    return f"Seat add-on event {event_name} handled"


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

    # Seat add-on subscriptions (RAZORPAY_SEAT_PLAN_ID) are billed on their own
    # Razorpay subscription, stamped ``notes.purpose == "seat_addon"``. Their
    # lifecycle events (activated/charged/cancelled/...) must be ACKnowledged so
    # Razorpay stops retrying, but they carry NO plan entitlement — routing them
    # through the plan handlers would grant monthly plan credits for a seat
    # charge (P0-3). Record the event (idempotency already ran above) and return
    # before dispatch.
    if event_name.startswith("subscription."):
        sub_entity = _extract_subscription_entity(payload) or {}
        sub_notes = sub_entity.get("notes") or {}
        if (sub_notes.get("purpose") or "").lower() == "seat_addon":
            # Seat add-ons carry NO plan entitlement (routing them through the
            # plan handlers would grant monthly plan credits for a seat charge —
            # P0-3), but they DO gate seat entitlement and must invoice seat
            # revenue (finding A), so they get their own handler rather than an
            # ack-drop.
            return _handle_seat_addon_event(session, event_name, sub_entity, payload)

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
        # Refunds — the credit CLAWBACK runs on whichever event arrives first
        # (``refund.created`` fires at initiation, so the customer can't spend
        # during settlement), but the Section 34 CREDIT NOTE is only issued on
        # ``refund.processed`` — a bank refund can still FAIL after creation,
        # and a legal document for a refund that never happened is a GST audit
        # defect that cannot be quietly deleted.
        "refund.created": _handle_refund_created,
        "refund.processed": _handle_refund_processed,
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


def _capture_paid_at(pay: dict[str, Any] | None) -> datetime:
    """The true capture instant of a Razorpay payment (finding G).

    Razorpay stamps epoch-seconds ``created_at`` on the payment entity. Dating the
    invoice from this — not from webhook-processing ``now()`` — keeps a payment
    captured just before a month/FY boundary in the correct GSTR period even when
    the webhook is processed after the boundary. Falls back to ``now()`` when the
    timestamp is missing or unparseable.
    """
    captured = (pay or {}).get("created_at")
    try:
        if captured is not None:
            return datetime.fromtimestamp(int(captured), tz=UTC)
    except (TypeError, ValueError, OSError, OverflowError):
        logger.warning("unparseable payment created_at=%r; falling back to now()", captured)
    return datetime.now(UTC)


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

    ORDERING (important): the subscription is fetched and its status checked
    BEFORE the idempotency key is recorded. A first verify call can race ahead
    of Razorpay's mandate authorisation and see a non-billable state
    (``created``/``pending``/``halted``); recording the key there would burn it,
    and a later verify — once the mandate is ``authenticated``/``active`` —
    would short-circuit on the already-recorded key and never materialise the
    row. On localhost (no webhook to fall back on) that permanently strands the
    customer on their old plan after a successful payment. So we only record the
    key once we've confirmed a billable state and are about to grant — that
    keeps the grant-once guarantee while letting an early call retry.

    Returns the local ``Subscription`` if reconcile succeeded (now or
    previously), or ``None`` if Razorpay reports the subscription in a
    non-billable state we shouldn't materialise yet — let a later call (or the
    webhook) handle those.
    """
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
        # Non-billable yet. Return WITHOUT recording the idempotency key so a
        # later verify (once the mandate clears) can retry and materialise.
        logger.info(
            "Razorpay subscription %s in non-billable state '%s' — deferring local upsert (key not burned)",
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
    # Done before recording the key so a mismatched caller can't burn it either.
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

    # Billable + owned — NOW gate the grant. If the webhook or a concurrent
    # verify already materialised it, this is a no-op re-query (grant-once).
    synthetic_event_id = f"reconcile:{razorpay_subscription_id}"
    if not _record_or_skip_event(session, synthetic_event_id):
        return _resolve_local_subscription(session, razorpay_subscription_id)

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

    Thin delegate to :func:`credit_service.grant_subscription_period_once` — the
    shared, per-scope + per-period-idempotent helper also used by the renewal
    cron (BL-5 / NB-8). Behaviour is unchanged: idempotent on
    ``last_granted_period_end == period_end`` (remediation H4), reset + grant
    scoped to ``subscription.bot_id``, marker advanced only when ``period_end``
    is present.
    """
    return credit_service.grant_subscription_period_once(session, subscription, period_end, invoice_id=invoice_id)


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
            # Account-level (legacy) flow: cancel any existing subscription
            # this new one is replacing.
            #
            # ``trial_expired`` is included alongside the active-set because a
            # customer who lets their trial lapse and *then* subscribes must
            # have the old trial row canceled here — otherwise
            # ``task_delete_expired_trial_data`` (which filters purely on
            # ``status == 'trial_expired' AND data_retention_until < now``)
            # will hard-delete the paying customer's workspace when the 15-day
            # retention window elapses. Canceling flips the row out of the
            # cron's filter; nulling ``data_retention_until`` is belt-and-
            # braces in case the filter is ever broadened.
            existing = (
                session.execute(
                    select(Subscription).where(
                        Subscription.client_id == client_id,
                        Subscription.status.in_(("active", "trialing", "past_due", "trial_expired")),
                        Subscription.bot_id.is_(None),
                    )
                )
                .scalars()
                .all()
            )
            carried_extra_seats = 0
            # (old_row, seat_addon_id) pairs whose Razorpay mandates must be
            # cancelled — but only AFTER every fail-prone local write below has
            # committed. Finding I: cancelling at the gateway inline (as this used
            # to) is irreversible, so if a later statement rolled back we'd strand
            # a mandate cancelled at Razorpay while its local row stayed active.
            # We do the LOCAL flip here (needed before the new-sub INSERT — the
            # partial unique index allows only one active client-level sub) and
            # defer the gateway cancels to the end of the handler, mirroring how
            # the seat-carry below is already ordered "last, after every fail-prone
            # DB write".
            superseded_gateway_cancels: list[tuple[Subscription, str | None]] = []
            for old in existing:
                seat_addon_id = old.seat_addon_subscription_id
                if seat_addon_id:
                    # Carry the seat count onto the new sub (below) and clear the
                    # local pointer now so the carry re-homes it; the old seat sub
                    # is gateway-cancelled at the end.
                    carried_extra_seats = max(carried_extra_seats, int(old.seat_addon_quantity or 0))
                    old.seat_addon_subscription_id = None
                    old.seat_addon_quantity = 0
                # Flip out of the active set immediately (entitlement stops here).
                # cancel_reason is left as-is on a clean cancel; the deferred
                # gateway cancel below stamps the reconcile marker only on failure.
                old.status = "canceled"
                old.canceled_at = datetime.now(UTC)
                # If this is a trial_expired row we're superseding, null the
                # retention marker so the hard-delete cron can never see the
                # row again even if the status flip is somehow reverted.
                old.data_retention_until = None
                superseded_gateway_cancels.append((old, seat_addon_id))

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
            # Finding H-A: grant through the period-marker helper (not the raw
            # ``grant_for_subscription``) so ``last_granted_period_end`` is set
            # exactly like the account-level path below. A UPI ``activated`` can
            # land BEFORE the first charge with no ``current_end``; without the
            # marker the first ``subscription.charged`` re-runs
            # reset + grant for the SAME period, wiping the customer's
            # first-cycle consumption and handing out a second full allowance
            # (up to 72,000 credits on an annual per-bot plan). Derive the first
            # period end from current_start + the plan interval (which equals
            # the current_end Razorpay sends on that first charge) so the marker
            # advances now and the charged correctly no-ops.
            grant_period_end = current_period_end
            if grant_period_end is None and current_period_start is not None:
                cycle = local.billing_cycle or notes.get("billing_cycle") or "monthly"
                grant_period_end = add_months(current_period_start, 12 if cycle == "annual" else 1)
            _grant_subscription_period(session, local, grant_period_end)
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
        # by the change-plan path and ``start_trial_subscription``.
        # Sets the period marker so the first subscription.charged for this
        # period is a no-op (H4).
        from app.services import transition_service

        # Finding F: capture the customer's ACTUAL unused plan credits BEFORE the
        # reset below zeroes them, so the pending rollover (snapshotted at click
        # time) is clamped to what's really left — not re-granted in full after
        # they've spent some between click and authorization.
        live_remaining_before_reset = transition_service.remaining_plan_credits(session, local.client_id)

        # Finding N: a UPI ``activated`` can land BEFORE the first charge with no
        # ``current_end``. Granting then without advancing the period marker means
        # the first ``subscription.charged`` (which DOES carry current_end) grants
        # a SECOND time for the same period — refunding the customer's first-cycle
        # consumption. Derive the first period end from current_start + the plan
        # interval (which equals the current_end Razorpay will send on that first
        # charge) so the marker advances now and the charged correctly no-ops.
        grant_period_end = current_period_end
        if grant_period_end is None and current_period_start is not None:
            cycle = (local.billing_cycle if local else None) or notes.get("billing_cycle") or "monthly"
            grant_period_end = add_months(current_period_start, 12 if cycle == "annual" else 1)
        _grant_subscription_period(session, local, grant_period_end)

        # Apply any pending upgrade proration as a top-up credit. Idempotent —
        # the old sub's column is zeroed the first time this runs, so webhook
        # replays don't double-credit.
        transition_service.apply_pending_proration(
            session, local, prev_rzp_sub_id, live_remaining=live_remaining_before_reset
        )

        # Carry the operator-seat add-on across the cutover — done LAST, after
        # every fail-prone DB write above, because ``edit_seat_addon_quantity``
        # mints a REAL Razorpay subscription. If it ran earlier (before the
        # grant/proration writes) and a later write raised, the transaction
        # would roll back the local pointer while leaving the add-on live at
        # the gateway — a fresh orphan of exactly the kind this cutover exists
        # to prevent. Placed here, the only thing after it is the best-effort
        # notification (which never raises), so a rollback can no longer strand
        # a just-minted add-on. ``carried_extra_seats`` comes from the
        # sibling-cancel loop above (immediate-upgrade / resume path, where the
        # old row is still in ``existing``); ``carried_seat_count`` in notes
        # comes from the scheduled-downgrade promotion path
        # (``promote_scheduled_change``), where the old row was already flipped
        # out of the active set before this webhook fires. At most one of the
        # two is ever non-zero for a given cutover. Any residual orphan (e.g. a
        # commit-time failure) is swept by ``task_reconcile_orphaned_seat_addons``.
        total_carried_seats = max(carried_extra_seats, int(notes.get("carried_seat_count") or 0))
        if total_carried_seats > 0:
            try:
                # The carried seats move to a NEW seat add-on sub with a NEW UPI
                # mandate that must be re-authorized before it charges (finding A).
                # Gate entitlement (require_authorization=True stashes the pending
                # count + returns the checkout) — activating uncharged seats here
                # would be free, unbilled seats — and email the customer the hosted
                # re-auth link so their seats aren't silently suspended with no
                # path back. A failed email never rolls back the activation.
                seat_checkout = edit_seat_addon_quantity(
                    session, local, total_carried_seats, require_authorization=True
                )
                reauth_url = (seat_checkout or {}).get("short_url")
                client_row = session.get(Client, client_id)
                if reauth_url and client_row and client_row.email:
                    try:
                        email_service.send_seat_reauth_email(
                            client_row.email,
                            name=client_row.name,
                            seat_count=total_carried_seats,
                            reauth_url=reauth_url,
                        )
                    except Exception:
                        logger.exception(
                            "Seat re-auth email failed for client %s after cutover (carry stands)", client_id
                        )
            except Exception:
                logger.error(
                    "Failed to re-create seat add-on (%d seats) on new subscription "
                    "%s (client %s) after a plan cutover — the customer's purchased "
                    "seats were not carried over. Needs manual reconciliation.",
                    total_carried_seats,
                    razorpay_sub_id,
                    client_id,
                    exc_info=True,
                )

        # Finding I: NOW — after every fail-prone local write above (new-sub
        # INSERT, grant, proration, seat carry) — retire the superseded mandate(s)
        # at the gateway. Placed here so a rollback of any of those can never leave
        # a mandate cancelled at Razorpay while its local row is active. The local
        # rows are already flipped to ``canceled``; if a gateway cancel fails the
        # old UPI mandate is STILL LIVE, so we re-stamp a distinct reason
        # (queryable for reconcile) and log at ERROR. Residual commit-time orphans
        # are swept by the reconcile jobs, same as the seat carry above.
        for old, seat_addon_id in superseded_gateway_cancels:
            if old.razorpay_subscription_id and old.razorpay_subscription_id != razorpay_sub_id:
                try:
                    cancel_subscription(old, at_period_end=False)
                except Exception:
                    old.cancel_reason = "gateway_cancel_failed_mandate_live"
                    logger.error(
                        "Gateway-cancel FAILED for superseded subscription %s at activation of %s "
                        "(client %s) — the old UPI mandate is STILL LIVE at Razorpay and will keep "
                        "debiting the customer. cancel_reason=gateway_cancel_failed_mandate_live for "
                        "reconciliation.",
                        old.razorpay_subscription_id,
                        razorpay_sub_id,
                        client_id,
                        exc_info=True,
                    )
            if seat_addon_id:
                try:
                    cancel_seat_addon_by_id(seat_addon_id)
                except Exception:
                    logger.error(
                        "Seat add-on cancel FAILED for superseded subscription %s (seat add-on %s, "
                        "client %s) at activation of %s — the old seat add-on mandate is STILL LIVE "
                        "at Razorpay. Needs manual reconciliation.",
                        old.razorpay_subscription_id,
                        seat_addon_id,
                        client_id,
                        razorpay_sub_id,
                        exc_info=True,
                    )

        logger.info(
            "Activated Razorpay subscription %s → local %s (client %s)",
            razorpay_sub_id,
            local.id,
            client_id,
        )
        _emit_plan_purchased_notification(session, client_id, plan_id, notes.get("billing_cycle", "monthly"))
        return f"Subscription activated for client {client_id}"

    # A subscription already flipped canceled/expired (by us or by Razorpay)
    # must never be silently resurrected by a stray/out-of-order/redelivered
    # activated event — this branch is also reached via the ``subscription.
    # resumed`` alias, and Razorpay-native pause/resume only ever moves a LOCAL
    # row through "past_due" (see subscription.paused -> _handle_subscription_
    # halted), never through "canceled"/"expired". A customer who explicitly
    # cancelled must stay cancelled; the only path back to active is a fresh
    # subscription via /resume (a new razorpay_subscription_id, handled above
    # as a "local is None" activation, not this branch).
    if local.status in ("canceled", "expired"):
        logger.warning(
            "subscription.activated/resumed for %s ignored — local subscription %s "
            "(client %s) is already %s; refusing to resurrect it",
            razorpay_sub_id,
            local.id,
            local.client_id,
            local.status,
        )
        return f"Subscription {razorpay_sub_id} is {local.status} — activation ignored"

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
    # ``quantity`` is the MAIN plan's Razorpay quantity (always 1 — seats bill on
    # a separate add-on sub, P0-3). Since finding A makes operator_quantity the
    # authoritative seat-entitlement mirror maintained by the seat webhooks,
    # writing the bare main-plan quantity here would clobber a seat-holder down to
    # 1 until their next seat charge. Re-derive from included + authorized seats.
    included = int((local.plan.included_operator_seats if local.plan else 1) or 1)
    local.operator_quantity = included + int(local.seat_addon_quantity or 0)
    session.flush()
    return f"Subscription {razorpay_sub_id} re-activated"


def _ensure_subscription_charge_invoice(
    session: Session,
    local: Subscription,
    *,
    payment_id: str | None,
    amount_minor: int | None,
    currency: str | None,
    period_start: datetime | None,
    period_end: datetime | None,
    razorpay_invoice_id: str | None = None,
    paid_at: datetime | None = None,
) -> Invoice | None:
    """Create + finalize the payment-history invoice for a subscription charge.

    Idempotent on ``payment_id`` (unique-indexed) so it is safe to call from
    BOTH the ``subscription.charged`` webhook and the synchronous verify path
    that stands in for webhooks the box can't receive (local dev, webhook lag).
    Whichever runs first creates the row; the other finds it and no-ops — no
    duplicate invoice. Returns the invoice (new or existing), or ``None`` when
    there is no payment id.
    """
    if not payment_id:
        return None
    existing = session.execute(select(Invoice).where(Invoice.razorpay_payment_id == payment_id)).scalars().first()
    if existing:
        return existing
    invoice = Invoice(
        client_id=local.client_id,
        subscription_id=local.id,
        bot_id=local.bot_id,  # records ledger scope for refund clawback (C2)
        amount_cents=int(amount_minor or 0),
        currency=str(currency or "INR").lower(),
        status="paid",
        razorpay_payment_id=payment_id,
        # Razorpay's own invoice entity for this cycle — payment evidence
        # linking our document to theirs, not the tax doc.
        razorpay_invoice_id=razorpay_invoice_id,
        period_start=period_start,
        period_end=period_end,
        description=(f"{local.plan.name if local.plan else 'Plan'} — {local.billing_cycle}"),
        # Finding G: date from the real capture instant so the FY serial + doc
        # date land in the correct GST period at a month/FY boundary.
        paid_at=paid_at or datetime.now(UTC),
    )
    session.add(invoice)
    session.flush()
    # Enrich into a numbered GST tax invoice when invoicing v2 is on (no-op
    # otherwise — leaves the legacy payment-history row). The _safely wrapper
    # savepoints any finalize failure so shadow-mode invoicing never blocks the
    # money path.
    invoice_service.finalize_invoice_safely(session, invoice)
    return invoice


def record_verified_subscription_charge(
    session: Session, local: Subscription, razorpay_payment_id: str | None
) -> Invoice | None:
    """Record a subscription's first-charge invoice from a verified checkout.

    The ``subscription.charged`` webhook is the canonical invoice creator, but
    it can't reach a local dev box and may lag in prod. The verify endpoint has
    the captured ``razorpay_payment_id`` in hand, so we fetch the payment and
    create the invoice synchronously — idempotent on the payment id, so the
    eventual webhook never duplicates it. Never raises into the caller: a
    failure here must not fail checkout verification.
    """
    if not razorpay_payment_id or local is None or not local.razorpay_subscription_id:
        return None
    try:
        pay = _get_razorpay().payment.fetch(razorpay_payment_id)
    except Exception:  # noqa: BLE001 — best-effort; the webhook remains the canonical path
        logger.exception("verify: could not fetch payment %s for first-charge invoice", razorpay_payment_id)
        return None
    if str(pay.get("status") or "").lower() != "captured":
        return None  # authorised-but-not-captured → wait for the charge webhook
    try:
        return _ensure_subscription_charge_invoice(
            session,
            local,
            payment_id=razorpay_payment_id,
            amount_minor=pay.get("amount", 0),
            currency=pay.get("currency", "INR"),
            period_start=local.current_period_start,
            period_end=local.current_period_end,
            razorpay_invoice_id=pay.get("invoice_id"),
            paid_at=_capture_paid_at(pay),
        )
    except Exception:  # noqa: BLE001
        logger.exception("verify: failed to record first-charge invoice for payment %s", razorpay_payment_id)
        return None


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
        # First-charge race: ``charged`` can arrive before ``activated`` links
        # the razorpay id. Raise (never ack) so the event is dead-lettered and
        # Razorpay redelivers once activation has landed — otherwise the
        # period's invoice is silently lost forever. A genuinely foreign sub id
        # exhausts Razorpay's retries and stays visible in failed_webhooks.
        logger.warning("subscription.charged for unknown razorpay_subscription_id %s — will retry", razorpay_sub_id)
        raise WebhookOutOfOrder(
            f"subscription.charged arrived before {razorpay_sub_id} was linked locally; retry after activation"
        )

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
        period_invoice = _ensure_subscription_charge_invoice(
            session,
            local,
            payment_id=pay_entity["id"],
            amount_minor=pay_entity.get("amount", 0),
            currency=pay_entity.get("currency", "INR"),
            period_start=new_period_start,
            period_end=new_period_end,
            razorpay_invoice_id=pay_entity.get("invoice_id"),
            paid_at=_capture_paid_at(pay_entity),
        )
        period_invoice_id = period_invoice.id if period_invoice else None

    # A subscription already canceled/expired locally must not be silently
    # resurrected by a charged event for it — out-of-order/redelivered
    # webhooks, or a charge that was already in flight at Razorpay the moment
    # the customer cancelled, can land here after the fact. Razorpay still
    # captured real money (the invoice above records it for reconciliation
    # and, if needed, a refund), but the customer explicitly does not want
    # this subscription running: no fresh credits, no un-cancelling.
    if local.status in ("canceled", "expired"):
        logger.warning(
            "subscription.charged for %s (client %s) arrived after local subscription "
            "%s was already %s — invoice recorded for reconciliation, but NOT granting "
            "credits or reactivating.",
            razorpay_sub_id,
            local.client_id,
            local.id,
            local.status,
        )
        session.flush()
        return f"Subscription {razorpay_sub_id} charged after cancellation — invoice recorded, not reactivated"

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


def _promote_scheduled_if_pending(session: Session, local: Subscription) -> str | None:
    """Promote a queued scheduled downgrade if the row carries one.

    Shared by both ``subscription.completed`` and ``subscription.cancelled``
    so the two cutover paths can't drift. Under a ``cancel_at_cycle_end``
    mandate (which is how a scheduled paid downgrade is set up) Razorpay fires
    ``subscription.cancelled`` at the cutover — NOT ``subscription.completed``
    — so the cancelled handler MUST run this before its terminal cancel or the
    queued downgrade is lost (BL-1).

    Returns a status message when a promotion happened, or ``None`` when there
    was nothing to promote (no queued change, or already promoted). Delegates
    to ``transition_service.promote_scheduled_change``, which is idempotent
    and also notifies the customer of the re-auth link (NB-3).
    """
    if not local.scheduled_plan_id:
        return None

    from app.services import transition_service

    new_payload = transition_service.promote_scheduled_change(session, local)
    session.flush()
    if new_payload is None:
        # Race or stale state (e.g. scheduled plan vanished) — the promotion
        # helper already cleared the trio. Let the caller apply its terminal
        # status.
        return None
    return "promoted scheduled change"


def _handle_subscription_cancelled(session: Session, payload: dict[str, Any]) -> str:
    sub_entity = _extract_subscription_entity(payload)
    if not sub_entity:
        return "subscription entity missing"
    local = _resolve_local_subscription(session, sub_entity.get("id", ""))
    if not local:
        return "Subscription not found"

    # A ``cancel_at_cycle_end`` mandate fires this event at the cutover of a
    # scheduled downgrade. Promote the queued change BEFORE the terminal flip
    # so the customer transitions into the lower tier instead of dropping to
    # no-subscription (BL-1). ``promote_scheduled_change`` marks the old row
    # terminal itself and notifies the customer.
    if _promote_scheduled_if_pending(session, local) is not None:
        return f"Subscription {sub_entity.get('id')} cancelled → promoted scheduled change"

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

    if _promote_scheduled_if_pending(session, local) is not None:
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


def _revoke_unpaid_activation_grant(session: Session, local: Subscription) -> bool:
    """Reverse the FIRST period's activation grant if its charge never paid (#2).

    A UPI ``subscription.activated`` grants the first period's credits BEFORE the
    first debit. If that debit then fails — ``subscription.pending`` /
    ``subscription.halted`` with no successful ``subscription.charged`` — the
    customer would keep a full period of credits they never paid for.

    The activation grant is the ONLY grant that precedes its payment: every later
    period grants atomically WITH ``subscription.charged`` (renewals never
    pre-grant). So "this subscription has zero paid invoices" cleanly identifies
    an unpaid activation grant, without any fragile period-timestamp matching —
    a later-cycle failure has ≥1 paid invoice and never pre-granted, so it is
    correctly left alone.

    Revoke = reset the period's UNUSED plan credits (scoped to the sub's bot, so
    the client pool / other bots and any rollover top-up are untouched) and roll
    the period marker back to ``current_period_start``. The rollback lets a later
    successful retry (``period_end > start``) re-grant the period, while every
    prior period (``end <= start``) still no-ops under the monotonic guard.

    Idempotent: after a revoke the marker equals ``current_period_start``, so a
    redelivered pending/halted short-circuits on the marker guard below. Returns
    ``True`` when a grant was revoked.

    Concurrency: ``subscription.charged`` and ``subscription.halted`` for the
    same sub can be delivered in overlapping transactions. Without a lock, this
    revoke could read "no paid invoice", the charged handler could then commit
    its grant + paid invoice, and our reset would zero a PAID customer's fresh
    credits. We take a ``SELECT ... FOR UPDATE`` row lock (the same guard
    ``grant_subscription_period_once`` uses) so revoke and grant serialize:
    whoever locks first commits, the loser re-reads and sees the other's effect
    (an advanced marker + paid invoice → skip, or a rolled-back marker → grant).
    ``flush`` first so the caller's just-set ``_enter_past_due`` write is pushed
    before the re-read (read-your-own-writes under ``autoflush=False``).
    """
    session.flush()
    session.refresh(local, with_for_update=True)

    marker = local.last_granted_period_end
    start = local.current_period_start
    # Nothing granted for the current period, no period anchor to roll back to,
    # or already revoked (marker sits at/below the period start).
    if marker is None or start is None or marker <= start:
        return False

    # Any successful charge on THIS subscription writes a paid Invoice; its
    # absence means the activation grant was never paid. Scoped to this sub so a
    # client's other (per-bot) subscriptions can't mask an unpaid first charge.
    has_paid_charge = (
        session.execute(
            select(Invoice.id).where(Invoice.subscription_id == local.id, Invoice.status == "paid").limit(1)
        )
        .scalars()
        .first()
    )
    if has_paid_charge is not None:
        return False

    credit_service.reset_monthly_plan_credits(session, local.client_id, bot_id=local.bot_id)
    local.last_granted_period_end = start
    logger.info(
        "Revoked unpaid activation grant for subscription %s (client %s, bot %s) — "
        "first charge never paid; rolled marker back to period start for a clean re-grant on retry",
        local.razorpay_subscription_id,
        local.client_id,
        local.bot_id,
    )
    return True


def _handle_subscription_halted(session: Session, payload: dict[str, Any]) -> str:
    sub_entity = _extract_subscription_entity(payload)
    if not sub_entity:
        return "subscription entity missing"
    local = _resolve_local_subscription(session, sub_entity.get("id", ""))
    if not local:
        return "Subscription not found"
    _enter_past_due(local)
    # Reverse an unpaid first-period activation grant (#2) so a customer whose
    # UPI first charge fails doesn't keep a free period of credits.
    _revoke_unpaid_activation_grant(session, local)
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
    _revoke_unpaid_activation_grant(session, local)
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
        except Exception as exc:
            # Finding C: we do NOT know whether this was a top-up. Swallowing here
            # acked the event and burned the dedup row, permanently losing a paid
            # top-up. Raise so the event dead-letters and Razorpay retries; the
            # Invoice/credit idempotency below makes the eventual success a no-op.
            logger.warning(
                "order.fetch failed for %s; raising to force webhook retry: %s",
                order_id_for_notes,
                exc,
            )
            raise RazorpayTransientError(f"could not fetch order {order_id_for_notes} for top-up notes") from exc

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

    # Name the pack the way the customer bought it ($-display when the order
    # notes carry it, INR otherwise) plus the credits it grants. Legal amounts
    # on the document remain INR regardless.
    display_price = str(notes.get("display_price") or "").strip()
    pack_label = f"{display_price} pack" if display_price else f"₹{amount_inr} pack"
    topup_description = f"Credits top-up — {pack_label} ({credits:,} credits)"

    invoice = Invoice(
        client_id=client_id,
        subscription_id=None,
        bot_id=target_bot_id,
        amount_cents=amount_paise,
        currency=str((pay_entity or {}).get("currency", "INR")).lower(),
        status="paid",
        razorpay_payment_id=rzp_payment_id,
        description=topup_description,
        paid_at=_capture_paid_at(pay_entity),  # finding G: real capture instant
    )
    session.add(invoice)
    session.flush()
    # Numbered tax invoice for the top-up when invoicing v2 is on (no-op
    # otherwise). The _safely wrapper savepoints any finalize failure so it can
    # never block the credit grant below, while a clean finalize commits its
    # serial atomically with this transaction.
    invoice_service.finalize_invoice_safely(session, invoice)

    credit_service.grant_topup(
        session,
        client_id,
        credits,
        note=f"{topup_description} (Razorpay {rzp_order_id or rzp_payment_id})",
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
    the cumulative-vs-delta bookkeeping that other gateways'
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

    # Razorpay refunds may be partial; keep the full/partial distinction so the
    # billing UI can render the right copy. The Section 34 credit note is NOT
    # issued here — refund.created only means "initiated", and a bank refund
    # can still fail; the note is issued by _handle_refund_processed once the
    # settlement actually clears.
    #
    # Finding #5: compare the CUMULATIVE refunded amount to the charge, not just
    # this event's amount — otherwise an invoice fully refunded via several
    # partial refunds stays "partially_refunded" forever. Each refund event is
    # deduped on its refund id above, so accumulating here counts each exactly
    # once.
    inv.refunded_minor = int(inv.refunded_minor or 0) + refund_minor
    inv.status = "refunded" if inv.refunded_minor >= charge_minor else "partially_refunded"
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


def _handle_refund_processed(session: Session, payload: dict[str, Any]) -> str:
    """Refund SETTLED — run the clawback path (a no-op when ``refund.created``
    already clawed, via the ``refund:{id}`` dedup) and then issue the Section 34
    credit note. Issuing only on settlement means a bank-failed refund can never
    leave behind a legal document for money that was never returned (the CN's
    own idempotency rides on ``provider_ref`` = the refund id).
    """
    result = _handle_refund_created(session, payload)

    refund_entity = (payload.get("refund") or {}).get("entity") or {}
    refund_id = refund_entity.get("id")
    payment_id = refund_entity.get("payment_id")
    refund_minor = int(refund_entity.get("amount") or 0)
    if not refund_id or not payment_id or refund_minor <= 0:
        return result
    inv = session.execute(select(Invoice).where(Invoice.razorpay_payment_id == payment_id)).scalars().first()
    if inv is None:
        return result
    # Savepoint-isolated: a note failure must never undo the clawback — a
    # missed note surfaces in reconciliation and is re-issuable from admin.
    note = invoice_service.create_credit_note_safely(session, inv, refund_minor, provider_ref=refund_id)
    if note is not None:
        return f"{result}; credit note {note.invoice_number} issued"
    return result


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
    # Chargeback = funds withdrawn → same Section 34 credit note as a refund.
    if dispute_id:
        invoice_service.create_credit_note_safely(session, inv, dispute_minor, provider_ref=dispute_id)
    else:
        # No dispute id → no idempotency key → no note. Reconciliation catches
        # the dispute_lost invoice without a linked credit note.
        logger.warning("dispute.lost without id on invoice %s — credit note skipped for reconciliation", inv.id)
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
