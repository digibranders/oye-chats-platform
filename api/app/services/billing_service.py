"""Stripe and Razorpay billing integration.

Handles customer creation, checkout sessions, subscription lifecycle
(upgrades, downgrades, cancellations), and webhook event processing.

Stripe is the primary provider for international customers.
Razorpay is used for Indian customers (UPI, domestic cards).
"""

import logging
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import FRONTEND_URL, STRIPE_ENABLED, STRIPE_SECRET_KEY
from app.db.models import Client, Invoice, Plan, ProcessedWebhook, Subscription
from app.services import credit_service

logger = logging.getLogger(__name__)


# ── Webhook idempotency ──


def _record_or_skip_webhook(session: Session, event_id: str | None, provider: str) -> bool:
    """Return True if this is the first time we've seen this event (caller should process it).

    Stripe and Razorpay both retry on 5xx, so duplicate deliveries are common.
    We persist event IDs to ``processed_webhooks`` so the second delivery is a
    no-op. Returns False if the event was already processed (or another worker
    won the race to record it).

    Concurrency note: the previous ``SELECT`` + ``INSERT`` pattern had a race
    window — two workers handling the same retry could both pass the ``SELECT``,
    both flush, and only ``COMMIT`` would catch the duplicate (via the unique
    constraint) by which point both had already granted credits, written
    invoices, etc. We now use an atomic ``INSERT … ON CONFLICT DO NOTHING``
    and key off the row count: the worker whose insert won proceeds; the
    loser sees ``rowcount == 0`` and bails. Postgres-only — but every
    deployment is Postgres + pgvector, so no portability cost.
    """
    if not event_id:
        logger.warning("Webhook missing event ID — rejecting to prevent duplicate processing (provider=%s)", provider)
        return False
    from sqlalchemy.dialects.postgresql import insert

    stmt = (
        insert(ProcessedWebhook)
        .values(event_id=event_id, provider=provider)
        .on_conflict_do_nothing(index_elements=["event_id"])
    )
    result = session.execute(stmt)
    session.flush()
    # ``rowcount`` is 1 when our INSERT actually wrote a row, 0 when the
    # ON CONFLICT clause swallowed it because somebody else got there first.
    return (result.rowcount or 0) > 0


def _get_stripe():
    """Lazily import and configure Stripe SDK."""
    if not STRIPE_ENABLED:
        raise RuntimeError("Stripe is not configured. Set STRIPE_SECRET_KEY env var.")
    import stripe

    stripe.api_key = STRIPE_SECRET_KEY
    return stripe


# ── Stripe Customer Management ──


def get_or_create_stripe_customer(session: Session, client: Client) -> str:
    """Ensure a Stripe customer exists for this client. Returns the Stripe customer ID."""
    # Check if client already has a Stripe customer via an existing subscription
    sub = (
        session.execute(
            select(Subscription).where(
                Subscription.client_id == client.id,
                Subscription.stripe_customer_id.isnot(None),
            )
        )
        .scalars()
        .first()
    )
    if sub and sub.stripe_customer_id:
        return sub.stripe_customer_id

    stripe = _get_stripe()
    customer = stripe.Customer.create(
        email=client.email,
        name=client.name or client.company_name or client.email,
        metadata={"oyechats_client_id": str(client.id)},
    )
    logger.info(f"Created Stripe customer {customer.id} for client {client.id}")
    return customer.id


# ── Checkout Session ──


def _ensure_referral_coupon(stripe_module, *, code: str, bps: int) -> str:
    """Return a Stripe Coupon id for the ``(code, bps)`` pair, creating it idempotently.

    The id format ``oye_ref_<code>_<bps>`` is a pure function of the inputs so
    repeat calls with the same referral code + same discount percentage
    converge on the same coupon — no duplicate-coupon storms even under
    concurrent first-time-checkout pressure.

    Duration is ``forever``: the customer keeps the discount on every renewal,
    matching how the discount is advertised in the modal ("10% off Standard
    plan"). If the percentage on the affiliate's code is later edited the
    coupon id changes, so existing subscriptions stay pinned to whatever
    percentage they signed up for — historical fairness baked in.
    """
    bps_int = max(1, min(10_000, int(bps)))
    safe_code = "".join(ch for ch in (code or "").lower() if ch.isalnum() or ch in {"-", "_"})[:18]
    coupon_id = f"oye_ref_{safe_code}_{bps_int}"
    try:
        return stripe_module.Coupon.retrieve(coupon_id)["id"]
    except stripe_module.error.InvalidRequestError:
        pass
    coupon = stripe_module.Coupon.create(
        id=coupon_id,
        percent_off=bps_int / 100,
        duration="forever",
        name=f"Referral discount {code}",
        metadata={"referral_code": code, "discount_bps": str(bps_int), "source": "oyechats_affiliate"},
    )
    return coupon["id"]


def create_checkout_session(
    session: Session,
    client: Client,
    plan: Plan,
    billing_cycle: str = "monthly",
    success_url: str | None = None,
    cancel_url: str | None = None,
    discount_bps: int = 0,
    extra_metadata: dict[str, str] | None = None,
) -> dict:
    """Create a Stripe Checkout session for subscribing to a plan.

    ``discount_bps`` is the customer-facing referral discount in basis
    points (1000 = 10%). We materialise it as an idempotent Stripe Coupon
    + attach via ``discounts=[{coupon}]`` so the price actually charged
    matches the strikethrough the modal advertises — and the customer
    keeps the discount on every renewal (``duration='forever'``).

    Returns a dict with 'checkout_url' and 'session_id' for the frontend to redirect to.
    """
    stripe = _get_stripe()
    customer_id = get_or_create_stripe_customer(session, client)

    # Select the correct Stripe price ID based on billing cycle
    price_id = plan.stripe_annual_price_id if billing_cycle == "annual" else plan.stripe_monthly_price_id

    if not price_id:
        raise ValueError(
            f"Plan '{plan.name}' does not have a Stripe price configured for {billing_cycle} billing. "
            "Configure it in the super admin panel first."
        )

    metadata: dict[str, str] = {
        "oyechats_client_id": str(client.id),
        "oyechats_plan_id": str(plan.id),
        "billing_cycle": billing_cycle,
    }
    if extra_metadata:
        metadata.update({str(k): str(v) for k, v in extra_metadata.items()})

    # Route through the shared helper so the quote and the eventual Stripe
    # coupon agree to the exact bps. Bare ``int()`` truncation here used to
    # round 12.345% one way while ``pct_to_bps`` rounded it the other —
    # rare in practice (the input is already int bps from the DB) but
    # eliminated outright by sharing the same normaliser.
    from app.core.money import normalize_bps

    discount_bps_int = normalize_bps(discount_bps)
    discounts_arg: list[dict] = []
    if discount_bps_int and extra_metadata and extra_metadata.get("referral_code"):
        coupon_id = _ensure_referral_coupon(stripe, code=str(extra_metadata["referral_code"]), bps=discount_bps_int)
        discounts_arg = [{"coupon": coupon_id}]
        metadata["referral_coupon_id"] = coupon_id

    # Enforce "one trial per (client, plan)" lifetime gate. Without this, a
    # customer who already used and exhausted their Starter trial could re-enter
    # checkout for Starter and get ANOTHER 14-day trial — bypassing the gate
    # that ``plan_service.start_trial`` enforces for the in-app trial flow.
    # ``plan_service`` covers the dedicated /start-trial path; this guard
    # covers the direct /checkout path that historically didn't check.
    prior_sub_exists = (
        session.execute(
            select(Subscription.id).where(Subscription.client_id == client.id, Subscription.plan_id == plan.id).limit(1)
        ).first()
        is not None
    )
    effective_trial_days = plan.trial_days if (plan.trial_days > 0 and not prior_sub_exists) else None
    if prior_sub_exists and plan.trial_days > 0:
        logger.info(
            "Stripe checkout for client %s plan %s: skipping trial (prior subscription on this plan exists)",
            client.id,
            plan.slug,
        )

    create_kwargs: dict = {
        "customer": customer_id,
        "mode": "subscription",
        "line_items": [{"price": price_id, "quantity": 1}],
        # Land on /billing directly (not /subscription) so the React Router
        # redirect doesn't strip the session_id query param before our
        # success handler can read it.
        "success_url": success_url or f"{FRONTEND_URL}/billing?subscription=success&session_id={{CHECKOUT_SESSION_ID}}",
        "cancel_url": cancel_url or f"{FRONTEND_URL}/billing?subscription=cancel",
        "metadata": metadata,
        "subscription_data": {
            "metadata": {
                "oyechats_client_id": str(client.id),
                "oyechats_plan_id": str(plan.id),
            },
            "trial_period_days": effective_trial_days,
        },
    }
    # Stripe rejects sessions that mix ``allow_promotion_codes`` with a
    # pre-applied ``discounts``: pick exactly one. Referral discount wins
    # when present so the customer can't double-stack a coupon on top.
    if discounts_arg:
        create_kwargs["discounts"] = discounts_arg
    else:
        create_kwargs["allow_promotion_codes"] = True

    checkout_session = stripe.checkout.Session.create(**create_kwargs)

    logger.info(
        "Created Stripe checkout session %s for client %s, plan %s%s",
        checkout_session.id,
        client.id,
        plan.slug,
        f" (referral discount {discount_bps_int / 100:g}% via {metadata.get('referral_coupon_id')})"
        if discount_bps_int
        else "",
    )

    return {
        "checkout_url": checkout_session.url,
        "session_id": checkout_session.id,
    }


# ── Customer Portal ──


def create_billing_portal_session(session: Session, client: Client) -> str:
    """Create a Stripe Billing Portal session URL for self-service billing management."""
    stripe = _get_stripe()
    customer_id = get_or_create_stripe_customer(session, client)

    portal_session = stripe.billing_portal.Session.create(
        customer=customer_id,
        return_url=f"{FRONTEND_URL}/subscription",
    )
    return portal_session.url


# ── Subscription Lifecycle ──


def cancel_stripe_subscription(subscription: Subscription, at_period_end: bool = True) -> None:
    """Cancel a Stripe subscription (at period end by default)."""
    if not subscription.stripe_subscription_id:
        logger.warning(f"Subscription {subscription.id} has no Stripe ID — skipping Stripe cancellation")
        return

    stripe = _get_stripe()
    if at_period_end:
        stripe.Subscription.modify(
            subscription.stripe_subscription_id,
            cancel_at_period_end=True,
        )
    else:
        stripe.Subscription.cancel(subscription.stripe_subscription_id)

    logger.info(f"Canceled Stripe subscription {subscription.stripe_subscription_id} (at_period_end={at_period_end})")


def resume_stripe_subscription(subscription: Subscription) -> None:
    """Resume a Stripe subscription that was scheduled for cancellation."""
    if not subscription.stripe_subscription_id:
        return

    stripe = _get_stripe()
    stripe.Subscription.modify(
        subscription.stripe_subscription_id,
        cancel_at_period_end=False,
    )
    logger.info(f"Resumed Stripe subscription {subscription.stripe_subscription_id}")


def change_stripe_plan(subscription: Subscription, new_plan: Plan, billing_cycle: str) -> None:
    """Change the plan on an existing Stripe subscription (proration applied automatically)."""
    if not subscription.stripe_subscription_id:
        raise ValueError("Cannot change plan — subscription has no Stripe ID")

    stripe = _get_stripe()
    price_id = new_plan.stripe_annual_price_id if billing_cycle == "annual" else new_plan.stripe_monthly_price_id
    if not price_id:
        raise ValueError(f"Plan '{new_plan.name}' has no Stripe price for {billing_cycle} billing")

    # Get the current subscription to find the subscription item ID
    stripe_sub = stripe.Subscription.retrieve(subscription.stripe_subscription_id)
    if not stripe_sub.get("items", {}).get("data"):
        raise ValueError("Stripe subscription has no line items")

    item_id = stripe_sub["items"]["data"][0]["id"]

    stripe.Subscription.modify(
        subscription.stripe_subscription_id,
        items=[{"id": item_id, "price": price_id}],
        proration_behavior="create_prorations",
        metadata={
            "oyechats_plan_id": str(new_plan.id),
        },
    )
    logger.info(
        f"Changed Stripe subscription {subscription.stripe_subscription_id} to plan {new_plan.slug} ({billing_cycle})"
    )


# ── Webhook Event Processing ──


def handle_stripe_webhook_event(session: Session, event: dict) -> str:
    """Process a verified Stripe webhook event. Returns a status message.

    Key events handled:
    - checkout.session.completed → create subscription + grant initial plan credits
    - customer.subscription.updated → sync status / period changes
    - customer.subscription.deleted → mark subscription as canceled
    - invoice.paid → record payment + (subscription) reset & grant monthly credits
                                       + (topup invoice) grant top-up credits
    - invoice.payment_failed → mark subscription as past_due
    - payment_intent.succeeded → grant top-up credits (direct PaymentIntent path)
    """
    event_type = event.get("type", "")
    event_id = event.get("id")
    data = event.get("data", {}).get("object", {})

    if not _record_or_skip_webhook(session, event_id, "stripe"):
        return f"Duplicate {event_type} ({event_id}) skipped"

    if event_type == "checkout.session.completed":
        return _handle_checkout_completed(session, data)
    elif event_type == "customer.subscription.updated":
        return _handle_subscription_updated(session, data)
    elif event_type == "customer.subscription.deleted":
        return _handle_subscription_deleted(session, data)
    elif event_type == "invoice.paid":
        return _handle_invoice_paid(session, data)
    elif event_type == "invoice.payment_failed":
        return _handle_invoice_failed(session, data)
    elif event_type == "payment_intent.succeeded":
        return _handle_payment_intent_succeeded(session, data)
    elif event_type == "charge.refunded":
        return _handle_charge_refunded(session, data)
    else:
        return f"Unhandled event type: {event_type}"


def _handle_checkout_completed(session: Session, data: dict) -> str:
    """Process a completed Stripe checkout — create or update the subscription."""
    metadata = data.get("metadata", {})
    client_id = metadata.get("oyechats_client_id")
    plan_id = metadata.get("oyechats_plan_id")
    billing_cycle = metadata.get("billing_cycle", "monthly")
    stripe_subscription_id = data.get("subscription")
    stripe_customer_id = data.get("customer")

    if not client_id or not plan_id:
        logger.warning(f"Checkout completed but missing metadata: {metadata}")
        return "Missing metadata"

    client_id = int(client_id)
    plan_id = int(plan_id)

    # Deactivate any existing active subscription for this client
    existing_subs = (
        session.execute(
            select(Subscription).where(
                Subscription.client_id == client_id,
                Subscription.status.in_(("active", "trialing")),
            )
        )
        .scalars()
        .all()
    )
    for old_sub in existing_subs:
        old_sub.status = "canceled"
        old_sub.canceled_at = datetime.now(UTC)

    # Retrieve Stripe subscription details for period info
    stripe = _get_stripe()
    stripe_sub = stripe.Subscription.retrieve(stripe_subscription_id)

    period_start = datetime.fromtimestamp(stripe_sub["current_period_start"], tz=UTC)
    period_end = datetime.fromtimestamp(stripe_sub["current_period_end"], tz=UTC)

    trial_start = None
    trial_end = None
    status = stripe_sub.get("status", "active")
    if stripe_sub.get("trial_start"):
        trial_start = datetime.fromtimestamp(stripe_sub["trial_start"], tz=UTC)
    if stripe_sub.get("trial_end"):
        trial_end = datetime.fromtimestamp(stripe_sub["trial_end"], tz=UTC)

    plan = session.get(Plan, plan_id)
    included_seats = int(plan.included_operator_seats) if plan and plan.included_operator_seats else 1
    new_sub = Subscription(
        client_id=client_id,
        plan_id=plan_id,
        status=status,
        billing_cycle=billing_cycle,
        operator_quantity=included_seats,
        current_period_start=period_start,
        current_period_end=period_end,
        trial_start=trial_start,
        trial_end=trial_end,
        payment_provider="stripe",
        stripe_subscription_id=stripe_subscription_id,
        stripe_customer_id=stripe_customer_id,
    )
    session.add(new_sub)
    session.flush()

    # Grant the first month's plan credits immediately so the customer can
    # start using the product. Subsequent renewals come via invoice.paid.
    #
    # BUT: when ``status == "trialing"``, the conversion-to-paid event
    # (``invoice.paid``) will arrive at trial-end with ``period_start`` >>
    # ``new_sub.created_at`` — the first-invoice guard in ``_handle_invoice_paid``
    # uses ``abs(period_start - created_at) < 86400`` to skip a redundant
    # grant and that diff is *days* on a trialing sub, so the guard misses
    # and we'd grant credits a second time on conversion. Skip the inline
    # grant here and let ``invoice.paid`` do it exactly once on conversion.
    is_trialing = (status or "").lower() == "trialing"
    if plan is not None and not is_trialing:
        credit_service.grant_for_subscription(session, new_sub)

    logger.info(
        "Subscription created from checkout: client=%s, plan=%s, stripe=%s, trialing=%s",
        client_id,
        plan_id,
        stripe_subscription_id,
        is_trialing,
    )
    return f"Subscription created for client {client_id}"


def _handle_subscription_updated(session: Session, data: dict) -> str:
    """Sync subscription status/period from Stripe."""
    stripe_sub_id = data.get("id")
    if not stripe_sub_id:
        return "No subscription ID"

    sub = (
        session.execute(select(Subscription).where(Subscription.stripe_subscription_id == stripe_sub_id))
        .scalars()
        .first()
    )

    if not sub:
        logger.warning(f"Stripe subscription {stripe_sub_id} not found in DB")
        return "Subscription not found"

    new_status = data.get("status", sub.status)
    # Card rescued — clear the dunning anchor so a future failure starts
    # its own grace window instead of inheriting the previous one.
    if sub.status == "past_due" and new_status == "active":
        sub.past_due_since = None
    sub.status = new_status
    sub.cancel_at_period_end = data.get("cancel_at_period_end", False)

    if data.get("current_period_start"):
        sub.current_period_start = datetime.fromtimestamp(data["current_period_start"], tz=UTC)
    if data.get("current_period_end"):
        sub.current_period_end = datetime.fromtimestamp(data["current_period_end"], tz=UTC)

    # Update plan if changed via Stripe dashboard
    plan_metadata = data.get("metadata", {})
    if plan_metadata.get("oyechats_plan_id"):
        sub.plan_id = int(plan_metadata["oyechats_plan_id"])

    session.flush()
    logger.info(f"Subscription {stripe_sub_id} updated: status={sub.status}")
    return f"Subscription {stripe_sub_id} updated"


def _handle_subscription_deleted(session: Session, data: dict) -> str:
    """Mark a subscription as canceled when Stripe confirms deletion."""
    stripe_sub_id = data.get("id")
    sub = (
        session.execute(select(Subscription).where(Subscription.stripe_subscription_id == stripe_sub_id))
        .scalars()
        .first()
    )

    if not sub:
        return "Subscription not found"

    sub.status = "canceled"
    sub.canceled_at = datetime.now(UTC)
    session.flush()

    logger.info(f"Subscription {stripe_sub_id} canceled via Stripe")
    return f"Subscription {stripe_sub_id} canceled"


def _handle_invoice_paid(session: Session, data: dict) -> str:
    """Record a paid invoice from Stripe and grant credits.

    Two distinct flows arrive here:
      1. Subscription renewal — invoice.subscription is set. Resets the
         monthly plan-credit bucket and grants the new month's allowance.
      2. One-off top-up purchase — invoice.metadata.purpose == 'topup'. Grants
         top-up credits with 12-month expiry. (Stripe Checkout in payment mode
         can deliver via either invoice.paid or payment_intent.succeeded; both
         paths are handled idempotently.)
    """
    stripe_invoice_id = data.get("id")
    metadata = data.get("metadata") or {}
    is_topup = metadata.get("purpose") == "topup"

    # Avoid duplicate Invoice rows (first delivery may have created it).
    existing = session.execute(select(Invoice).where(Invoice.stripe_invoice_id == stripe_invoice_id)).scalars().first()
    if existing and existing.status == "paid":
        return f"Invoice {stripe_invoice_id} already recorded"

    # Resolve client either via metadata (topup) or via Stripe customer (renewal).
    sub: Subscription | None = None
    client_id: int | None = None
    if is_topup and metadata.get("client_id"):
        client_id = int(metadata["client_id"])
    else:
        stripe_customer_id = data.get("customer")
        sub = (
            session.execute(select(Subscription).where(Subscription.stripe_customer_id == stripe_customer_id))
            .scalars()
            .first()
        )
        if sub:
            client_id = sub.client_id

    if client_id is None:
        logger.warning(f"No client resolved for Stripe invoice {stripe_invoice_id}")
        return "Client not found for invoice"

    period_start = datetime.fromtimestamp(data["period_start"], tz=UTC) if data.get("period_start") else None
    period_end = datetime.fromtimestamp(data["period_end"], tz=UTC) if data.get("period_end") else None

    if existing:
        existing.status = "paid"
        existing.paid_at = datetime.now(UTC)
    else:
        invoice = Invoice(
            client_id=client_id,
            subscription_id=sub.id if sub else None,
            amount_cents=data.get("amount_paid", 0),
            currency=data.get("currency", "usd"),
            status="paid",
            stripe_invoice_id=stripe_invoice_id,
            invoice_url=data.get("hosted_invoice_url"),
            pdf_url=data.get("invoice_pdf"),
            period_start=period_start,
            period_end=period_end,
            description=(
                f"Top-up ${int(data.get('amount_paid', 0)) / 100:.0f} pack"
                if is_topup
                else f"{sub.plan.name if sub and sub.plan else 'Plan'} - {sub.billing_cycle if sub else 'monthly'}"
            ),
            paid_at=datetime.now(UTC),
        )
        session.add(invoice)
    session.flush()

    # ── Credit grants ──
    if is_topup:
        credits = int(metadata.get("credits", 0))
        pack_usd = int(metadata.get("pack_usd", 0))
        if credits > 0:
            credit_service.grant_topup(
                session,
                client_id,
                credits,
                note=f"Top-up ${pack_usd} pack" if pack_usd else "Top-up",
            )
            logger.info(f"Granted {credits} top-up credits to client {client_id} (invoice {stripe_invoice_id})")
    elif sub is not None:
        # Subscription renewal: reset prior plan credits, grant new month's.
        # On the very first invoice (initial subscription), checkout already
        # granted credits — but reset_monthly is a no-op when balance is 0,
        # and grant duplicates would cause double-issue. We detect "first
        # invoice" via period_start matching subscription.created_at.
        if period_start and sub.created_at and abs((period_start - sub.created_at).total_seconds()) < 86400:
            logger.info(f"Skipping grant for first invoice on sub {sub.id} (already granted at checkout)")
        else:
            credit_service.reset_monthly_plan_credits(session, sub.client_id, bot_id=sub.bot_id)
            credit_service.grant_for_subscription(session, sub)
            logger.info(f"Renewed monthly credits for client {sub.client_id} from invoice {stripe_invoice_id}")

    return f"Invoice {stripe_invoice_id} recorded ({'topup' if is_topup else 'subscription'})"


def _handle_payment_intent_succeeded(session: Session, data: dict) -> str:
    """Grant top-up credits when a PaymentIntent for purpose=topup succeeds.

    This complements ``invoice.paid``: Stripe Checkout in ``payment`` mode (not
    subscription) emits a PaymentIntent rather than an Invoice. The webhook
    idempotency guard at the dispatcher level prevents double-grants when both
    events are delivered.
    """
    metadata = data.get("metadata") or {}
    if metadata.get("purpose") != "topup":
        return "PaymentIntent not a topup; ignored"

    client_id_str = metadata.get("client_id")
    credits = int(metadata.get("credits", 0))
    pack_usd = int(metadata.get("pack_usd", 0))
    if not client_id_str or credits <= 0:
        logger.warning(f"Topup PaymentIntent missing metadata: {metadata}")
        return "Missing topup metadata"

    client_id = int(client_id_str)
    credit_service.grant_topup(
        session,
        client_id,
        credits,
        note=f"Top-up ${pack_usd} pack" if pack_usd else "Top-up",
    )
    logger.info(f"Granted {credits} top-up credits to client {client_id} via PaymentIntent {data.get('id')}")
    return f"Top-up credits granted to client {client_id}"


def _handle_invoice_failed(session: Session, data: dict) -> str:
    """Mark subscription as past_due when payment fails."""
    stripe_sub_id = data.get("subscription")
    if not stripe_sub_id:
        return "No subscription on failed invoice"

    sub = (
        session.execute(select(Subscription).where(Subscription.stripe_subscription_id == stripe_sub_id))
        .scalars()
        .first()
    )

    if sub:
        # Preserve the FIRST entry into past_due so the dunning grace clock
        # doesn't reset on every retry — repeat failures keep the same
        # anchor, only a successful payment (status → active) clears it.
        if sub.status != "past_due":
            sub.past_due_since = datetime.now(UTC)
        sub.status = "past_due"
        session.flush()
        logger.warning(f"Payment failed for subscription {stripe_sub_id}, marked as past_due")

    # Record the failed invoice
    stripe_invoice_id = data.get("id")
    existing = session.execute(select(Invoice).where(Invoice.stripe_invoice_id == stripe_invoice_id)).scalars().first()

    if not existing and sub:
        invoice = Invoice(
            client_id=sub.client_id,
            subscription_id=sub.id,
            amount_cents=data.get("amount_due", 0),
            currency=data.get("currency", "usd"),
            status="failed",
            stripe_invoice_id=stripe_invoice_id,
            invoice_url=data.get("hosted_invoice_url"),
            description="Payment failed",
        )
        session.add(invoice)
        session.flush()

    return f"Invoice {stripe_invoice_id} failed"


# ── Top-up checkout ──


def create_topup_checkout_session(
    session: Session,
    client: Client,
    pack: dict[str, Any],
    success_url: str | None = None,
    cancel_url: str | None = None,
) -> dict:
    """Create a Stripe Checkout session for a one-off top-up purchase.

    ``pack`` must be one of the entries from ``pricing_config.topup_packs``
    (validated by the caller). Metadata is set so the webhook handler can
    grant the right number of credits when the payment succeeds.

    Top-ups intentionally do NOT honour referral discounts — that incentive
    lives on the subscription side only. See subscription_routes.create_checkout.
    """
    stripe = _get_stripe()
    customer_id = get_or_create_stripe_customer(session, client)

    # Pack schema: new packs use ``amount`` + ``currency``; older Stripe-era
    # packs used a bare ``usd`` key. Accept either so cached configs and
    # in-flight checkouts keep working through the cutover.
    pack_amount = int(pack.get("amount") or pack.get("usd") or 0)
    pack_currency = str(pack.get("currency", "USD")).lower()
    if pack_amount <= 0:
        raise ValueError("Top-up pack is missing 'amount'")
    credits = int(pack["credits"])
    bonus_pct = int(pack.get("bonus_pct", 0) or 0)

    unit_amount_cents = pack_amount * 100

    metadata = {
        "purpose": "topup",
        "client_id": str(client.id),
        "credits": str(credits),
        "pack_amount": str(pack_amount),
        "pack_currency": pack_currency.upper(),
        # Legacy key kept for the webhook handler that still reads pack_usd.
        # Safe because USD is the dominant currency for Stripe flows.
        "pack_usd": str(pack_amount) if pack_currency == "usd" else "0",
        "bonus_pct": str(bonus_pct),
    }

    line_item: dict[str, Any]
    if pack.get("stripe_price_id"):
        line_item = {"price": pack["stripe_price_id"], "quantity": 1}
    else:
        bonus_suffix = f" (includes {bonus_pct}% bonus)" if bonus_pct else ""
        line_item = {
            "price_data": {
                "currency": pack_currency,
                "product_data": {
                    "name": f"{credits:,} OyeChats credits",
                    "description": f"Top-up pack — {credits:,} credits{bonus_suffix}",
                },
                "unit_amount": unit_amount_cents,
            },
            "quantity": 1,
        }

    checkout_session = stripe.checkout.Session.create(
        customer=customer_id,
        mode="payment",
        line_items=[line_item],
        success_url=success_url or f"{FRONTEND_URL}/credits?topup=success&session_id={{CHECKOUT_SESSION_ID}}",
        cancel_url=cancel_url or f"{FRONTEND_URL}/credits?topup=cancel",
        metadata=metadata,
        payment_intent_data={"metadata": metadata},
    )

    sym = "$" if pack_currency == "usd" else pack_currency.upper() + " "
    logger.info(
        f"Created Stripe top-up checkout {checkout_session.id} for client {client.id}: "
        f"{sym}{unit_amount_cents / 100:.2f} → {credits} credits"
    )

    return {
        "checkout_url": checkout_session.url,
        "session_id": checkout_session.id,
    }


# ── Operator-seat add-on ──


def update_seat_quantity(session: Session, sub: Subscription, new_total: int) -> int:
    """Set the customer's total operator-seat count to ``new_total``.

    The included seats are part of the base subscription price; only seats
    above ``plan.included_operator_seats`` are billed as a separate Stripe
    quantity-based subscription item. For now we just store the total on the
    Subscription row. Hooking the seat add-on item to a Stripe price is left
    as a follow-up — this keeps the API stable so the admin UI can ship
    without blocking on Stripe price-id provisioning.
    """
    new_total = max(int(new_total), 0)
    plan = sub.plan
    floor = int(plan.included_operator_seats) if plan and plan.included_operator_seats else 1
    if new_total < floor:
        raise ValueError(f"Cannot set seats below included floor of {floor}")
    sub.operator_quantity = new_total
    session.flush()
    logger.info(f"Updated seat count for subscription {sub.id} to {new_total}")
    return new_total


# ── Stripe Plan Sync ──


def sync_plan_to_stripe(session: Session, plan: Plan) -> dict:
    """Create or update a Stripe Product + Prices for this plan.

    Returns a dict with the Stripe IDs that should be saved on the Plan model.
    """
    stripe = _get_stripe()

    # Create or update the Product
    if plan.stripe_product_id:
        stripe.Product.modify(
            plan.stripe_product_id,
            name=plan.name,
            description=plan.description or f"OyeChats {plan.name} Plan",
            active=plan.is_active,
            metadata={"oyechats_plan_id": str(plan.id), "slug": plan.slug},
        )
        product_id = plan.stripe_product_id
    else:
        product = stripe.Product.create(
            name=plan.name,
            description=plan.description or f"OyeChats {plan.name} Plan",
            metadata={"oyechats_plan_id": str(plan.id), "slug": plan.slug},
        )
        product_id = product.id
        plan.stripe_product_id = product_id

    result = {"stripe_product_id": product_id}

    # Create monthly price if plan has monthly pricing and no existing price
    if plan.monthly_price_cents > 0 and not plan.stripe_monthly_price_id:
        monthly_price = stripe.Price.create(
            product=product_id,
            unit_amount=plan.monthly_price_cents,
            currency="usd",
            recurring={"interval": "month"},
            metadata={"oyechats_plan_id": str(plan.id), "cycle": "monthly"},
        )
        plan.stripe_monthly_price_id = monthly_price.id
        result["stripe_monthly_price_id"] = monthly_price.id

    # Create annual price if plan has annual pricing and no existing price
    if plan.annual_price_cents > 0 and not plan.stripe_annual_price_id:
        annual_price = stripe.Price.create(
            product=product_id,
            unit_amount=plan.annual_price_cents,
            currency="usd",
            recurring={"interval": "year"},
            metadata={"oyechats_plan_id": str(plan.id), "cycle": "annual"},
        )
        plan.stripe_annual_price_id = annual_price.id
        result["stripe_annual_price_id"] = annual_price.id

    session.flush()
    logger.info(f"Synced plan '{plan.name}' to Stripe: {result}")
    return result


# ── Refund handling ─────────────────────────────────────────────────────────


def _handle_charge_refunded(session: Session, data: dict) -> str:
    """Reverse credits when Stripe reports a charge refund.

    Fires on ``charge.refunded`` (full and partial both land here). The
    Charge object carries ``amount`` (originally charged, minor units)
    and ``amount_refunded`` (cumulative refunded to date). The cumulative
    field is important: if a customer gets two ₹500 partial refunds on a
    ₹2000 charge, we receive two events with ``amount_refunded`` = 500
    then 1000 — we have to claw back only the delta on the second event,
    not 1000 credits worth again.

    The ``ProcessedWebhook`` row written upstream already prevents the
    SAME event id from being applied twice, so we lean on that for retry
    idempotency and treat each event's cumulative amount as the new
    target state.
    """
    invoice_id = data.get("invoice")
    if not invoice_id:
        # Refunds against ad-hoc PaymentIntents (no invoice — e.g. legacy
        # top-up flow) don't map cleanly to a grant on our side.
        return "Refund event has no invoice — skipping clawback"

    inv = session.execute(select(Invoice).where(Invoice.stripe_invoice_id == invoice_id)).scalars().first()
    if inv is None:
        logger.warning("charge.refunded for unknown stripe invoice %s", invoice_id)
        return f"Invoice {invoice_id} not found"

    charge_minor = int(data.get("amount") or 0)
    cumulative_refund_minor = int(data.get("amount_refunded") or 0)
    if cumulative_refund_minor <= 0 or charge_minor <= 0:
        return "Refund event with zero amount"

    # ``Invoice.amount_cents`` is the originally-charged amount. We track
    # the running total of what we've already clawed back via the same
    # field's mismatch with the cumulative refund; net delta is what's
    # outstanding for this event.
    already_clawed_minor = max(0, charge_minor - int(inv.amount_cents or charge_minor))
    delta_minor = cumulative_refund_minor - already_clawed_minor
    if delta_minor <= 0:
        return f"Refund already applied to invoice {inv.id}"

    clawed, entry_id = credit_service.clawback_refund(
        session,
        client_id=inv.client_id,
        charge_minor=charge_minor,
        refund_minor=delta_minor,
        note=f"Refund clawback for Stripe charge {data.get('id', '?')}",
    )

    # Mark the invoice. We use "refunded" for a full refund and
    # "partially_refunded" otherwise so support / analytics can tell them
    # apart without re-querying Stripe.
    if cumulative_refund_minor >= charge_minor:
        inv.status = "refunded"
    else:
        inv.status = "partially_refunded"
    session.flush()

    logger.info(
        "Stripe charge refund: invoice=%s charge=%s refund_minor=%s clawed=%s entry=%s",
        inv.id,
        data.get("id"),
        delta_minor,
        clawed,
        entry_id,
    )
    return f"Refund processed: {clawed} credit(s) clawed back from invoice {inv.id}"
