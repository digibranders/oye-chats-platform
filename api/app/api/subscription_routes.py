"""Client-facing subscription and billing endpoints.

These routes power the admin dashboard's subscription/billing page.
Stripe/Razorpay checkout and webhook handling will be added in Phase 2.
"""

import logging

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select

from app.api.auth import get_current_client_strict as get_current_client
from app.db.models import Client, Invoice
from app.db.session import get_session
from app.services.plan_service import get_active_plans, get_client_plan, get_client_subscription
from app.services.usage_service import get_usage_summary

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/subscriptions", tags=["subscriptions"])


# ── Public: Pricing page ──


@router.get("/plans")
def list_plans():
    """Return all active plans for the pricing page. No auth required."""
    with get_session() as session:
        plans = get_active_plans(session)
        return [
            {
                "id": p.id,
                "name": p.name,
                "slug": p.slug,
                "description": p.description,
                "pricing_model": p.pricing_model,
                "monthly_price_cents": p.monthly_price_cents,
                "annual_price_cents": p.annual_price_cents,
                "annual_discount_percent": p.annual_discount_percent,
                "trial_days": p.trial_days,
                "limits": p.limits,
                "features": p.features,
                "overage_rate_cents": p.overage_rate_cents,
                "sort_order": p.sort_order,
            }
            for p in plans
        ]


# ── Authenticated: Current subscription ──


@router.get("/current")
def get_current_subscription(client: Client = Depends(get_current_client)):
    """Return the client's current subscription details + plan info."""
    with get_session() as session:
        sub = get_client_subscription(session, client.id)
        plan = get_client_plan(session, client.id)

        sub_data = None
        if sub:
            sub_data = {
                "id": sub.id,
                "status": sub.status,
                "billing_cycle": sub.billing_cycle,
                "operator_quantity": sub.operator_quantity,
                "current_period_start": sub.current_period_start.isoformat() if sub.current_period_start else None,
                "current_period_end": sub.current_period_end.isoformat() if sub.current_period_end else None,
                "trial_start": sub.trial_start.isoformat() if sub.trial_start else None,
                "trial_end": sub.trial_end.isoformat() if sub.trial_end else None,
                "canceled_at": sub.canceled_at.isoformat() if sub.canceled_at else None,
                "cancel_at_period_end": sub.cancel_at_period_end,
                "payment_provider": sub.payment_provider,
                "created_at": sub.created_at.isoformat() if sub.created_at else None,
            }

        return {
            "subscription": sub_data,
            "plan": {
                "id": plan.id,
                "name": plan.name,
                "slug": plan.slug,
                "description": plan.description,
                "pricing_model": plan.pricing_model,
                "monthly_price_cents": plan.monthly_price_cents,
                "annual_price_cents": plan.annual_price_cents,
                "limits": plan.limits,
                "features": plan.features,
                "overage_rate_cents": plan.overage_rate_cents,
            },
        }


@router.get("/usage")
def get_subscription_usage(client: Client = Depends(get_current_client)):
    """Return the client's current-period usage vs plan limits."""
    with get_session() as session:
        return get_usage_summary(session, client.id)


@router.get("/invoices")
def list_invoices(client: Client = Depends(get_current_client)):
    """Return the client's payment history (most recent first)."""
    with get_session() as session:
        stmt = select(Invoice).where(Invoice.client_id == client.id).order_by(Invoice.created_at.desc()).limit(50)
        invoices = session.execute(stmt).scalars().all()

        return [
            {
                "id": inv.id,
                "amount_cents": inv.amount_cents,
                "currency": inv.currency,
                "status": inv.status,
                "description": inv.description,
                "invoice_url": inv.invoice_url,
                "pdf_url": inv.pdf_url,
                "period_start": inv.period_start.isoformat() if inv.period_start else None,
                "period_end": inv.period_end.isoformat() if inv.period_end else None,
                "paid_at": inv.paid_at.isoformat() if inv.paid_at else None,
                "created_at": inv.created_at.isoformat() if inv.created_at else None,
            }
            for inv in invoices
        ]


# ── Checkout & Billing Portal ──


class CheckoutRequest(BaseModel):
    plan_id: int
    billing_cycle: str = "monthly"  # monthly|annual


@router.post("/checkout")
def create_checkout(request: CheckoutRequest, client: Client = Depends(get_current_client)):
    """Create a Stripe Checkout session and return the URL for frontend redirect."""
    from app.config import STRIPE_ENABLED

    if not STRIPE_ENABLED:
        raise HTTPException(status_code=503, detail="Billing is not configured yet. Please contact support.")

    with get_session() as session:
        from app.services.plan_service import get_plan_by_id

        plan = get_plan_by_id(session, request.plan_id)
        if not plan:
            raise HTTPException(status_code=404, detail="Plan not found.")
        if not plan.is_active:
            raise HTTPException(status_code=400, detail="This plan is not available.")
        if plan.monthly_price_cents == 0 and plan.slug != "enterprise":
            raise HTTPException(status_code=400, detail="Cannot checkout for a free plan.")

        from app.services.billing_service import create_checkout_session

        result = create_checkout_session(session, client, plan, request.billing_cycle)
        session.commit()
        return result


@router.post("/portal")
def billing_portal(client: Client = Depends(get_current_client)):
    """Return a Stripe Billing Portal URL for self-service billing management."""
    from app.config import STRIPE_ENABLED

    if not STRIPE_ENABLED:
        raise HTTPException(status_code=503, detail="Billing is not configured yet.")

    with get_session() as session:
        from app.services.billing_service import create_billing_portal_session

        url = create_billing_portal_session(session, client)
        return {"portal_url": url}


class ChangePlanRequest(BaseModel):
    plan_id: int
    billing_cycle: str | None = None  # None = keep current cycle


@router.post("/change-plan")
def change_plan(request: ChangePlanRequest, client: Client = Depends(get_current_client)):
    """Upgrade or downgrade the client's subscription to a different plan."""
    with get_session() as session:
        from app.services.plan_service import get_client_subscription, get_plan_by_id

        sub = get_client_subscription(session, client.id)
        if not sub:
            raise HTTPException(status_code=404, detail="No active subscription found. Please subscribe first.")

        new_plan = get_plan_by_id(session, request.plan_id)
        if not new_plan or not new_plan.is_active:
            raise HTTPException(status_code=404, detail="Target plan not found or inactive.")

        if sub.plan_id == request.plan_id:
            raise HTTPException(status_code=400, detail="You are already on this plan.")

        billing_cycle = request.billing_cycle or sub.billing_cycle

        if sub.stripe_subscription_id:
            from app.services.billing_service import change_stripe_plan

            change_stripe_plan(sub, new_plan, billing_cycle)

        sub.plan_id = new_plan.id
        sub.billing_cycle = billing_cycle
        session.commit()

        logger.info(f"Client {client.id} changed plan to {new_plan.slug} ({billing_cycle})")
        return {"message": f"Plan changed to {new_plan.name} successfully."}


# ── Cancellation ──


class CancelSubscriptionRequest(BaseModel):
    reason: str | None = None


@router.post("/cancel")
def cancel_subscription(request: CancelSubscriptionRequest, client: Client = Depends(get_current_client)):
    """Cancel the client's subscription at the end of the current billing period."""
    with get_session() as session:
        sub = get_client_subscription(session, client.id)
        if not sub:
            raise HTTPException(status_code=404, detail="No active subscription found.")

        if sub.status == "canceled":
            raise HTTPException(status_code=400, detail="Subscription is already canceled.")

        # Mark for cancellation at period end (don't terminate immediately)
        from datetime import UTC, datetime

        sub.cancel_at_period_end = True
        sub.canceled_at = datetime.now(UTC)
        sub.cancel_reason = request.reason
        session.commit()

        logger.info(f"Client {client.id} canceled subscription {sub.id} (reason: {request.reason})")

        return {"message": "Subscription will be canceled at the end of the current billing period."}


@router.post("/resume")
def resume_subscription(client: Client = Depends(get_current_client)):
    """Resume a subscription that was scheduled for cancellation."""
    with get_session() as session:
        sub = get_client_subscription(session, client.id)
        if not sub:
            raise HTTPException(status_code=404, detail="No active subscription found.")

        if not sub.cancel_at_period_end:
            raise HTTPException(status_code=400, detail="Subscription is not scheduled for cancellation.")

        sub.cancel_at_period_end = False
        sub.canceled_at = None
        sub.cancel_reason = None
        session.commit()

        logger.info(f"Client {client.id} resumed subscription {sub.id}")

        return {"message": "Subscription resumed successfully."}
