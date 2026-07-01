"""Super admin plan and subscription management routes.

Full CRUD for pricing plans + subscription overrides.  Plans are the core
configuration entity — all prices, limits, and features are stored here
and can be modified at runtime without code changes.
"""

import logging

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func, select

from app.api.auth import get_superadmin
from app.config import DISPLAY_USD_TO_INR
from app.core.pricing import display_price
from app.db.models import Client, Invoice, Plan, Subscription
from app.db.session import get_session
from app.services.plan_service import get_pricing_content, set_pricing_content

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/superadmin", tags=["superadmin-plans"])


def _to_usd_cents(amount_minor: int | None, currency: str | None) -> int:
    """Normalise a stored minor-unit amount to USD cents.

    Mirrors the customer-app display rule (``core.pricing.display_price``):
    INR-stored amounts are converted at the fixed ``DISPLAY_USD_TO_INR`` rate,
    USD amounts pass through unchanged. The super-admin dashboard reports a
    single canonical currency (USD), matching what international customers see.
    """
    minor = int(amount_minor or 0)
    if (currency or "usd").lower() == "inr":
        usd_cents, _ = display_price(inr_paise=minor, usd_cents=None, country=None, rate=DISPLAY_USD_TO_INR)
        return usd_cents
    return minor


def _plan_monthly_usd_cents(plan: Plan, billing_cycle: str) -> int:
    """Monthly-equivalent USD cents for a plan on a given billing cycle.

    Prefers the plan's stored USD column (the exact gateway price) and falls
    back to converting the INR column only for legacy rows with no USD price —
    identical precedence to ``PlanModal``'s ``PriceBlock`` on the frontend.
    """
    if billing_cycle == "annual" and (plan.annual_price_cents or plan.annual_price_usd_cents):
        annual_usd, _ = display_price(
            inr_paise=plan.annual_price_cents,
            usd_cents=plan.annual_price_usd_cents,
            country=None,
            rate=DISPLAY_USD_TO_INR,
        )
        return round(annual_usd / 12)  # round, not floor, so MRR isn't understated (M8)
    monthly_usd, _ = display_price(
        inr_paise=plan.monthly_price_cents,
        usd_cents=plan.monthly_price_usd_cents,
        country=None,
        rate=DISPLAY_USD_TO_INR,
    )
    return monthly_usd


# ── Request Models ──


class CreatePlanRequest(BaseModel):
    name: str
    slug: str
    description: str | None = None
    pricing_model: str = "per_operator"
    currency: str = "INR"
    monthly_price_cents: int = 0
    annual_price_cents: int = 0
    monthly_price_usd_cents: int | None = None
    annual_price_usd_cents: int | None = None
    extra_seat_price_usd_cents: int | None = None
    annual_discount_percent: int = 30
    trial_days: int = 14
    limits: dict | None = None
    features: dict | None = None
    marketing: dict | None = None
    overage_rate_cents: int = 0
    credits_per_month: int = 0
    included_operator_seats: int = 1
    extra_seat_price_cents: int = 1500
    razorpay_plan_id_monthly: str | None = None
    razorpay_plan_id_annual: str | None = None
    is_active: bool = True
    is_default: bool = False
    sort_order: int = 0


class UpdatePlanRequest(BaseModel):
    name: str | None = None
    description: str | None = None
    pricing_model: str | None = None
    currency: str | None = None
    monthly_price_cents: int | None = None
    annual_price_cents: int | None = None
    monthly_price_usd_cents: int | None = None
    annual_price_usd_cents: int | None = None
    extra_seat_price_usd_cents: int | None = None
    annual_discount_percent: int | None = None
    trial_days: int | None = None
    limits: dict | None = None
    features: dict | None = None
    marketing: dict | None = None
    overage_rate_cents: int | None = None
    credits_per_month: int | None = None
    included_operator_seats: int | None = None
    extra_seat_price_cents: int | None = None
    is_active: bool | None = None
    is_default: bool | None = None
    sort_order: int | None = None
    razorpay_plan_id_monthly: str | None = None
    razorpay_plan_id_annual: str | None = None


class UpdateSubscriptionRequest(BaseModel):
    plan_id: int | None = None
    status: str | None = None
    # Bounds (M8): a negative quantity yields negative MRR; a negative
    # extend_trial_days silently back-dates/shortens the trial.
    operator_quantity: int | None = Field(default=None, ge=0, le=1000)
    billing_cycle: str | None = None
    extend_trial_days: int | None = Field(default=None, ge=0, le=365)


class PricingContentRequest(BaseModel):
    faq: list | None = None
    feature_matrix: list | None = None
    topup_packs: list | None = None
    credit_costs: list | None = None


# ── Plan CRUD ──


@router.get("/plans")
def list_all_plans(superadmin: Client = Depends(get_superadmin)):
    """List all plans including inactive ones (for admin management)."""
    with get_session() as session:
        stmt = select(Plan).order_by(Plan.sort_order)
        plans = session.execute(stmt).scalars().all()

        # Count active subscriptions per plan
        sub_counts = dict(
            session.execute(
                select(Subscription.plan_id, func.count(Subscription.id))
                .where(Subscription.status.in_(("active", "trialing", "past_due")))
                .group_by(Subscription.plan_id)
            ).all()
        )

        return [
            {
                "id": p.id,
                "name": p.name,
                "slug": p.slug,
                "description": p.description,
                "pricing_model": p.pricing_model,
                "currency": p.currency,
                "monthly_price_cents": p.monthly_price_cents,
                "annual_price_cents": p.annual_price_cents,
                "monthly_price_usd_cents": p.monthly_price_usd_cents,
                "annual_price_usd_cents": p.annual_price_usd_cents,
                "annual_discount_percent": p.annual_discount_percent,
                "trial_days": p.trial_days,
                "limits": p.limits,
                "features": p.features,
                "overage_rate_cents": p.overage_rate_cents,
                "marketing": p.marketing,
                "credits_per_month": p.credits_per_month,
                "included_operator_seats": p.included_operator_seats,
                "extra_seat_price_cents": p.extra_seat_price_cents,
                "extra_seat_price_usd_cents": p.extra_seat_price_usd_cents,
                "is_active": p.is_active,
                "is_default": p.is_default,
                "sort_order": p.sort_order,
                "razorpay_plan_id_monthly": p.razorpay_plan_id_monthly,
                "razorpay_plan_id_annual": p.razorpay_plan_id_annual,
                "active_subscriptions": sub_counts.get(p.id, 0),
                "created_at": p.created_at.isoformat() if p.created_at else None,
                "updated_at": p.updated_at.isoformat() if p.updated_at else None,
            }
            for p in plans
        ]


@router.post("/plans")
def create_plan(request: CreatePlanRequest, superadmin: Client = Depends(get_superadmin)):
    """Create a new pricing plan."""
    with get_session() as session:
        # Check slug uniqueness
        existing = session.execute(select(Plan).where(Plan.slug == request.slug)).scalars().first()
        if existing:
            raise HTTPException(status_code=400, detail=f"A plan with slug '{request.slug}' already exists.")

        # If this plan is marked as default, unset current default
        if request.is_default:
            for p in session.execute(select(Plan).where(Plan.is_default.is_(True))).scalars().all():
                p.is_default = False

        plan = Plan(
            name=request.name,
            slug=request.slug,
            description=request.description,
            pricing_model=request.pricing_model,
            currency=request.currency,
            monthly_price_cents=request.monthly_price_cents,
            annual_price_cents=request.annual_price_cents,
            monthly_price_usd_cents=request.monthly_price_usd_cents,
            annual_price_usd_cents=request.annual_price_usd_cents,
            extra_seat_price_usd_cents=request.extra_seat_price_usd_cents,
            annual_discount_percent=request.annual_discount_percent,
            trial_days=request.trial_days,
            # Explicit literals (N5): reaching into the SQLAlchemy Column.default
            # internals (``Plan.limits.default.arg``) breaks if the default is a
            # callable or server_default — ``or {}`` is correct and safe.
            limits=request.limits or {},
            features=request.features or {},
            marketing=request.marketing or {},
            overage_rate_cents=request.overage_rate_cents,
            credits_per_month=request.credits_per_month,
            included_operator_seats=request.included_operator_seats,
            extra_seat_price_cents=request.extra_seat_price_cents,
            razorpay_plan_id_monthly=request.razorpay_plan_id_monthly,
            razorpay_plan_id_annual=request.razorpay_plan_id_annual,
            is_active=request.is_active,
            is_default=request.is_default,
            sort_order=request.sort_order,
        )
        session.add(plan)
        session.commit()
        session.refresh(plan)

        logger.info(f"Superadmin {superadmin.id} created plan '{plan.name}' (id={plan.id})")

        return {"message": f"Plan '{plan.name}' created successfully.", "plan_id": plan.id}


@router.put("/plans/{plan_id}")
def update_plan(plan_id: int, request: UpdatePlanRequest, superadmin: Client = Depends(get_superadmin)):
    """Update an existing plan. Only provided fields are modified."""
    with get_session() as session:
        plan = session.execute(select(Plan).where(Plan.id == plan_id)).scalars().first()
        if not plan:
            raise HTTPException(status_code=404, detail="Plan not found.")

        update_data = request.model_dump(exclude_unset=True)

        # If setting this as default, unset current default
        if update_data.get("is_default"):
            for p in session.execute(select(Plan).where(Plan.is_default.is_(True), Plan.id != plan_id)).scalars().all():
                p.is_default = False

        for field, value in update_data.items():
            setattr(plan, field, value)

        session.commit()

        logger.info(f"Superadmin {superadmin.id} updated plan {plan_id} ({plan.name})")

        return {"message": f"Plan '{plan.name}' updated successfully."}


@router.delete("/plans/{plan_id}")
def delete_plan(plan_id: int, superadmin: Client = Depends(get_superadmin)):
    """Soft-delete a plan (set is_active=False). Cannot delete plans with active subscriptions."""
    with get_session() as session:
        plan = session.execute(select(Plan).where(Plan.id == plan_id)).scalars().first()
        if not plan:
            raise HTTPException(status_code=404, detail="Plan not found.")

        # Check for active subscriptions
        active_subs = session.execute(
            select(func.count(Subscription.id)).where(
                Subscription.plan_id == plan_id,
                Subscription.status.in_(("active", "trialing", "past_due")),
            )
        ).scalar()

        if active_subs and active_subs > 0:
            raise HTTPException(
                status_code=400,
                detail=f"Cannot delete plan with {active_subs} active subscription(s). "
                "Move subscribers to another plan first.",
            )

        plan.is_active = False
        session.commit()

        logger.info(f"Superadmin {superadmin.id} deactivated plan {plan_id} ({plan.name})")

        return {"message": f"Plan '{plan.name}' deactivated successfully."}


# ── Pricing Content ──


@router.get("/pricing-content")
def read_pricing_content(superadmin: Client = Depends(get_superadmin)):
    """Editable website pricing copy (FAQ, comparison matrix, top-ups, costs)."""
    with get_session() as session:
        return get_pricing_content(session)


@router.put("/pricing-content")
def write_pricing_content(request: PricingContentRequest, superadmin: Client = Depends(get_superadmin)):
    """Upsert any subset of the website pricing-content blobs."""
    with get_session() as session:
        set_pricing_content(session, request.model_dump(exclude_none=True))
        logger.info(f"Superadmin {superadmin.id} updated pricing content")
        return {"message": "Pricing content updated successfully."}


# ── Subscription Management ──


@router.get("/subscriptions")
def list_subscriptions(
    status: str | None = None,
    plan_id: int | None = None,
    superadmin: Client = Depends(get_superadmin),
):
    """List all subscriptions with optional status/plan filters."""
    with get_session() as session:
        stmt = select(Subscription).order_by(Subscription.created_at.desc())
        if status:
            stmt = stmt.where(Subscription.status == status)
        if plan_id:
            stmt = stmt.where(Subscription.plan_id == plan_id)

        subs = session.execute(stmt.limit(200)).scalars().all()

        # Batch-load client names and plan names
        client_ids = {s.client_id for s in subs}
        plan_ids = {s.plan_id for s in subs}

        client_rows = (
            session.execute(select(Client).where(Client.id.in_(client_ids))).scalars().all() if client_ids else []
        )
        clients = {c.id: {"name": c.name, "email": c.email} for c in client_rows}

        plans = (
            {p.id: p.name for p in session.execute(select(Plan).where(Plan.id.in_(plan_ids))).scalars().all()}
            if plan_ids
            else {}
        )

        return [
            {
                "id": s.id,
                "client_id": s.client_id,
                "client_name": clients.get(s.client_id, {}).get("name", "Unknown"),
                "client_email": clients.get(s.client_id, {}).get("email"),
                "plan_id": s.plan_id,
                "plan_name": plans.get(s.plan_id, "Unknown"),
                "status": s.status,
                "billing_cycle": s.billing_cycle,
                "operator_quantity": s.operator_quantity,
                "payment_provider": s.payment_provider,
                "current_period_start": s.current_period_start.isoformat() if s.current_period_start else None,
                "current_period_end": s.current_period_end.isoformat() if s.current_period_end else None,
                "trial_end": s.trial_end.isoformat() if s.trial_end else None,
                "canceled_at": s.canceled_at.isoformat() if s.canceled_at else None,
                "created_at": s.created_at.isoformat() if s.created_at else None,
            }
            for s in subs
        ]


@router.put("/subscriptions/{subscription_id}")
def update_subscription(
    subscription_id: int,
    request: UpdateSubscriptionRequest,
    superadmin: Client = Depends(get_superadmin),
):
    """Manual override: change plan, status, extend trial, etc."""
    with get_session() as session:
        sub = session.execute(select(Subscription).where(Subscription.id == subscription_id)).scalars().first()
        if not sub:
            raise HTTPException(status_code=404, detail="Subscription not found.")

        if request.plan_id is not None:
            plan = session.execute(select(Plan).where(Plan.id == request.plan_id)).scalars().first()
            if not plan:
                raise HTTPException(status_code=400, detail="Target plan not found.")
            sub.plan_id = request.plan_id

        if request.status is not None:
            valid_statuses = {"active", "trialing", "past_due", "canceled", "paused", "expired"}
            if request.status not in valid_statuses:
                raise HTTPException(status_code=400, detail=f"Invalid status. Must be one of: {valid_statuses}")
            sub.status = request.status

        if request.operator_quantity is not None:
            sub.operator_quantity = request.operator_quantity

        if request.billing_cycle is not None:
            sub.billing_cycle = request.billing_cycle

        if request.extend_trial_days is not None and sub.trial_end:
            from datetime import timedelta

            sub.trial_end = sub.trial_end + timedelta(days=request.extend_trial_days)

        session.commit()

        logger.info(f"Superadmin {superadmin.id} updated subscription {subscription_id}")

        return {"message": "Subscription updated successfully."}


# ── Revenue Metrics ──


@router.get("/revenue")
def get_revenue_metrics(superadmin: Client = Depends(get_superadmin)):
    """Calculate MRR, total revenue, and subscription counts.

    All monetary figures are reported in **USD cents** (the dashboard's
    canonical currency). Plan prices and invoices stored in INR are converted
    via the same fixed-rate rule the customer app uses for non-Indian visitors.
    """
    with get_session() as session:
        # Active subscriptions breakdown
        active_subs = (
            session.execute(select(Subscription).where(Subscription.status.in_(("active", "trialing")))).scalars().all()
        )

        plan_cache: dict[int, Plan] = {}
        mrr_cents = 0
        for sub in active_subs:
            if sub.plan_id not in plan_cache:
                plan = session.execute(select(Plan).where(Plan.id == sub.plan_id)).scalars().first()
                if plan:
                    plan_cache[sub.plan_id] = plan

            plan = plan_cache.get(sub.plan_id)
            if plan:
                mrr_cents += _plan_monthly_usd_cents(plan, sub.billing_cycle) * sub.operator_quantity

        # Total paid invoices, normalised to USD cents.
        paid_invoices = session.execute(
            select(Invoice.amount_cents, Invoice.currency).where(Invoice.status == "paid")
        ).all()
        total_revenue_cents = sum(_to_usd_cents(amount, currency) for amount, currency in paid_invoices)

        # Subscription status counts
        status_counts = dict(
            session.execute(
                select(Subscription.status, func.count(Subscription.id)).group_by(Subscription.status)
            ).all()
        )

        return {
            "currency": "USD",
            "mrr_cents": mrr_cents,
            "arr_cents": mrr_cents * 12,
            "total_revenue_cents": total_revenue_cents,
            "subscription_counts": {
                "active": status_counts.get("active", 0),
                "trialing": status_counts.get("trialing", 0),
                "past_due": status_counts.get("past_due", 0),
                "canceled": status_counts.get("canceled", 0),
                "paused": status_counts.get("paused", 0),
                "expired": status_counts.get("expired", 0),
            },
            "total_paying_customers": sum(status_counts.get(s, 0) for s in ("active", "past_due")),
        }
