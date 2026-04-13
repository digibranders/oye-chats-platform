"""Stripe and Razorpay billing integration.

Handles customer creation, checkout sessions, subscription lifecycle
(upgrades, downgrades, cancellations), and webhook event processing.

Stripe is the primary provider for international customers.
Razorpay is used for Indian customers (UPI, domestic cards).
"""

import logging
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import FRONTEND_URL, STRIPE_ENABLED, STRIPE_SECRET_KEY
from app.db.models import Client, Invoice, Plan, Subscription

logger = logging.getLogger(__name__)


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


def create_checkout_session(
    session: Session,
    client: Client,
    plan: Plan,
    billing_cycle: str = "monthly",
    success_url: str | None = None,
    cancel_url: str | None = None,
) -> dict:
    """Create a Stripe Checkout session for subscribing to a plan.

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

    checkout_session = stripe.checkout.Session.create(
        customer=customer_id,
        mode="subscription",
        line_items=[
            {
                "price": price_id,
                "quantity": 1,  # Will be updated for per-operator model
            }
        ],
        success_url=success_url or f"{FRONTEND_URL}/subscription?status=success&session_id={{CHECKOUT_SESSION_ID}}",
        cancel_url=cancel_url or f"{FRONTEND_URL}/subscription?status=canceled",
        metadata={
            "oyechats_client_id": str(client.id),
            "oyechats_plan_id": str(plan.id),
            "billing_cycle": billing_cycle,
        },
        subscription_data={
            "metadata": {
                "oyechats_client_id": str(client.id),
                "oyechats_plan_id": str(plan.id),
            },
            "trial_period_days": plan.trial_days if plan.trial_days > 0 else None,
        },
        allow_promotion_codes=True,
    )

    logger.info(f"Created Stripe checkout session {checkout_session.id} for client {client.id}, plan {plan.slug}")

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
    - checkout.session.completed → create/update subscription
    - customer.subscription.updated → sync status changes
    - customer.subscription.deleted → mark subscription as canceled
    - invoice.paid → record payment
    - invoice.payment_failed → mark subscription as past_due
    """
    event_type = event.get("type", "")
    data = event.get("data", {}).get("object", {})

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

    new_sub = Subscription(
        client_id=client_id,
        plan_id=plan_id,
        status=status,
        billing_cycle=billing_cycle,
        operator_quantity=1,
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

    logger.info(
        f"Subscription created from checkout: client={client_id}, plan={plan_id}, stripe={stripe_subscription_id}"
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

    sub.status = data.get("status", sub.status)
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
    """Record a paid invoice from Stripe."""
    stripe_invoice_id = data.get("id")

    # Avoid duplicates
    existing = session.execute(select(Invoice).where(Invoice.stripe_invoice_id == stripe_invoice_id)).scalars().first()
    if existing:
        existing.status = "paid"
        existing.paid_at = datetime.now(UTC)
        session.flush()
        return f"Invoice {stripe_invoice_id} updated to paid"

    # Resolve client from Stripe customer metadata
    stripe_customer_id = data.get("customer")
    sub = (
        session.execute(select(Subscription).where(Subscription.stripe_customer_id == stripe_customer_id))
        .scalars()
        .first()
    )

    if not sub:
        logger.warning(f"No subscription found for Stripe customer {stripe_customer_id}")
        return "Subscription not found for invoice"

    period_start = None
    period_end = None
    if data.get("period_start"):
        period_start = datetime.fromtimestamp(data["period_start"], tz=UTC)
    if data.get("period_end"):
        period_end = datetime.fromtimestamp(data["period_end"], tz=UTC)

    invoice = Invoice(
        client_id=sub.client_id,
        subscription_id=sub.id,
        amount_cents=data.get("amount_paid", 0),
        currency=data.get("currency", "usd"),
        status="paid",
        stripe_invoice_id=stripe_invoice_id,
        invoice_url=data.get("hosted_invoice_url"),
        pdf_url=data.get("invoice_pdf"),
        period_start=period_start,
        period_end=period_end,
        description=f"{sub.plan.name if sub.plan else 'Plan'} - {sub.billing_cycle}",
        paid_at=datetime.now(UTC),
    )
    session.add(invoice)
    session.flush()

    logger.info(f"Invoice {stripe_invoice_id} recorded: {data.get('amount_paid', 0)} cents for client {sub.client_id}")
    return f"Invoice {stripe_invoice_id} recorded"


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
