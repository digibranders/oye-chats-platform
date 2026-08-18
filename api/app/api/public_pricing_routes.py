"""Public, unauthenticated pricing catalog for the marketing website.

Single source the website renders against: active plans (structured + marketing
copy) plus the editable site-content blobs. Mirrors GET /subscriptions/plans but
adds marketing copy + FAQ/matrix/top-ups so the website is fully DB-driven.
"""

from fastapi import APIRouter

from app.core.pricing import annual_saving_percent
from app.db.session import get_session
from app.services.plan_service import get_active_plans, get_pricing_content

router = APIRouter(prefix="/public", tags=["public-pricing"])


@router.get("/pricing-catalog")
def pricing_catalog():
    with get_session() as session:
        plans = get_active_plans(session)
        content = get_pricing_content(session)
        return {
            "currency": "USD",
            "plans": [
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
                    "extra_seat_price_usd_cents": p.extra_seat_price_usd_cents,
                    "extra_seat_price_cents": p.extra_seat_price_cents,
                    # Derived from the prices in the same payload, NOT the stored
                    # column. See core.pricing.annual_saving_percent. Same key,
                    # same type, so the website needs no deploy to stop showing
                    # Professional's stale 22% for a 21% saving.
                    "annual_discount_percent": annual_saving_percent(p.monthly_price_cents, p.annual_price_cents),
                    "trial_days": p.trial_days,
                    "credits_per_month": p.credits_per_month,
                    "included_operator_seats": p.included_operator_seats,
                    "limits": p.limits,
                    "features": p.features,
                    "marketing": p.marketing or {},
                    "sort_order": p.sort_order,
                }
                for p in plans
            ],
            "feature_matrix": content["feature_matrix"],
            "faq": content["faq"],
            "topup_packs": content["topup_packs"],
            "credit_costs": content["credit_costs"],
        }
