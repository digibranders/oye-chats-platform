"""Seed the canonical plan matrix (idempotent).

Single source of truth for the customer-facing plans on a fresh database:
Free / Starter / Standard / Professional / Enterprise. Matches the pricing on
the marketing site (oyechats.com/pricing).

Prices are stored in minor units: ``*_cents`` is INR paise (``currency='INR'``),
``*_usd_cents`` is US cents (deliberate USD headline, not FX-converted).

Razorpay plan IDs are intentionally NOT set here — they differ per environment
(test vs live) and are configured separately with ``set_razorpay_plan_ids.py``
so no plan ID is hardcoded in the repo. The extra-seat add-on plan is likewise
env-config (``RAZORPAY_SEAT_PLAN_ID``), not a plan row.

``is_active`` is DERIVED, never asserted: a tier goes on sale only once this
environment has the gateway plan ids that can charge for it (see
``plan_service.plan_is_sellable``). This file is the catalogue — prices,
entitlements, ordering — not the sales lifecycle, and it has no way to know
which plans a given Razorpay account actually holds. Forcing ``is_active =
True`` here is what silently re-published Enterprise on a prod reseed: migration
``f1a2b3c4d5e6`` deactivates it, the baseline schema seeds no plan rows, so on a
wiped database that migration matches nothing and this seed had the last word —
listing a tier with no Live plan id, whose checkout 400s.

Idempotent: each plan is matched by ``slug`` and updated in place; a new row is
inserted if the slug is missing. Unknown slugs (custom tiers added by a super
admin) are left untouched.

Usage:
    cd platform/api
    uv run python scripts/seed_plans.py            # dry-run (prints a diff)
    uv run python scripts/seed_plans.py --apply     # commit
"""

from __future__ import annotations

import argparse
import os
import sys

sys.path.append(os.path.join(os.path.dirname(__file__), ".."))

from sqlalchemy import select

from app.db.models import Plan
from app.db.session import get_session
from app.services.plan_service import plan_is_sellable

# ── Canonical matrix — single source of truth ──────────────────────────────
# INR paise for *_cents; US cents for *_usd_cents. -1 in limits means unlimited.
_PLANS: list[dict] = [
    {
        "slug": "free",
        "name": "Free",
        "description": "A grounded AI bot, free forever.",
        "credits_per_month": 200,
        "monthly_price_cents": 0,
        "annual_price_cents": 0,
        "monthly_price_usd_cents": 0,
        "annual_price_usd_cents": 0,
        "annual_discount_percent": 0,
        "trial_days": 0,
        "included_operator_seats": 0,
        "extra_seat_price_cents": 0,
        "extra_seat_price_usd_cents": 0,
        "is_default": True,
        "sort_order": 1,
        "limits": {
            "credits": 200,
            "bots": 1,
            "operators": 0,
            "leads": 15,
            "page_scraping": 20,
            "documents": 3,
            "knowledge_characters": 2_500,  # ~500 words — tiny KB, real product try
            "chat_history_days": 7,
            "max_crawl_depth": 2,
            "max_crawl_pages": 20,
            "max_crawl_js_pages": 10,
            "max_crawl_concurrency": 2,
        },
        "features": {
            "live_chat": False,
            "bant": False,
            "branding_removable": False,
            "webhooks": False,
            "api_access": False,
            "online_support": False,
            "topup_allowed": False,
            "auto_recrawl": False,
            "integrations": "reply_to_only",
        },
        "marketing": {"tagline": "A grounded AI bot, free forever."},
    },
    {
        "slug": "starter",
        "name": "Starter",
        "description": "For a solo site that wants live chat + a real AI agent.",
        "credits_per_month": 1000,
        "monthly_price_cents": 59900,  # ₹599
        "annual_price_cents": 574800,  # ₹5,748 (₹479/mo × 12)
        "monthly_price_usd_cents": 799,  # $7.99
        "annual_price_usd_cents": 7788,  # $77.88 ($6.49/mo × 12)
        "annual_discount_percent": 20,  # ₹5,748 vs ₹7,188 (12 × monthly)
        "trial_days": 0,  # trials are the Standard-only 7-day offer
        "included_operator_seats": 1,
        "extra_seat_price_cents": 44900,  # ₹449
        "extra_seat_price_usd_cents": 500,  # $5
        "is_default": False,
        "sort_order": 2,
        "limits": {
            "credits": 1000,
            "bots": 1,
            "operators": 1,
            "leads": -1,
            "page_scraping": 500,
            "documents": 20,
            "knowledge_characters": 50_000,  # ~10k words — small help center
            "chat_history_days": 30,
            "max_crawl_depth": 3,
            "max_crawl_pages": -1,
            "max_crawl_js_pages": 60,
            "max_crawl_concurrency": 3,
        },
        "features": {
            "live_chat": True,
            "bant": False,
            "branding_removable": False,
            "webhooks": False,
            "api_access": False,
            "online_support": True,
            "topup_allowed": True,
            "auto_recrawl": False,
            "integrations": "all",
        },
        "marketing": {"tagline": "For a solo site that wants live chat + a real AI agent."},
    },
    {
        "slug": "standard",
        "name": "Standard",
        "description": "The lead-machine — grounded AI plus BANT qualification.",
        "credits_per_month": 2500,
        "monthly_price_cents": 119900,  # ₹1,199
        "annual_price_cents": 1150800,  # ₹11,508 (₹959/mo × 12)
        "monthly_price_usd_cents": 1599,  # $15.99
        "annual_price_usd_cents": 15588,  # $155.88 ($12.99/mo × 12)
        "annual_discount_percent": 20,  # ₹11,508 vs ₹14,388 (12 × monthly)
        "trial_days": 7,  # the 7-day full-Standard trial
        "included_operator_seats": 2,
        "extra_seat_price_cents": 44900,  # ₹449
        "extra_seat_price_usd_cents": 500,
        "is_default": False,
        "sort_order": 3,
        "limits": {
            "credits": 2500,
            "bots": 1,
            "operators": 2,
            "leads": -1,
            "page_scraping": 2000,
            "documents": -1,  # unlimited — Standard trusts the char cap + credit gate
            "knowledge_characters": 500_000,  # ~100k words — full product docs
            "chat_history_days": 90,
            "max_crawl_depth": 4,
            "max_crawl_pages": -1,
            "max_crawl_js_pages": 150,
            "max_crawl_concurrency": 4,
        },
        "features": {
            "live_chat": True,
            "bant": True,
            "branding_removable": True,
            "webhooks": True,
            "api_access": True,
            "online_support": True,
            "topup_allowed": True,
            "auto_recrawl": True,
            "integrations": "all",
        },
        "marketing": {
            "tagline": "The lead-machine — grounded AI plus BANT qualification.",
            "badge": "Most Popular",
        },
    },
    {
        "slug": "professional",
        "name": "Professional",
        "description": "For teams scaling qualified pipeline with deeper frameworks.",
        "credits_per_month": 10000,
        "monthly_price_cents": 299900,  # ₹2,999
        "annual_price_cents": 2818800,  # ₹28,188 (₹2,349/mo × 12)
        "monthly_price_usd_cents": 4599,  # $45.99
        "annual_price_usd_cents": 45588,  # $455.88 ($37.99/mo × 12)
        "annual_discount_percent": 22,  # ₹28,188 vs ₹35,988 (12 × monthly)
        "trial_days": 0,  # trials are the Standard-only 7-day offer
        "included_operator_seats": 3,
        "extra_seat_price_cents": 44900,  # ₹449
        "extra_seat_price_usd_cents": 500,
        "is_default": False,
        "sort_order": 4,
        "limits": {
            "credits": 10000,
            "bots": 1,
            "operators": 3,
            "leads": -1,
            "page_scraping": 5000,
            "documents": -1,  # unlimited (Professional)
            "knowledge_characters": -1,  # unlimited (Professional)
            "chat_history_days": 365,
            "max_crawl_depth": 5,
            "max_crawl_pages": -1,
            "max_crawl_js_pages": 300,
            "max_crawl_concurrency": 6,
        },
        "features": {
            "live_chat": True,
            "bant": True,
            "branding_removable": True,
            "webhooks": True,
            "api_access": True,
            "online_support": True,
            "topup_allowed": True,
            "auto_recrawl": True,
            "integrations": "all",
        },
        "marketing": {"tagline": "For teams scaling qualified pipeline with deeper frameworks."},
    },
    {
        "slug": "enterprise",
        "name": "Enterprise",
        "description": "For agencies running many client sites from one account.",
        "credits_per_month": 10000,
        "monthly_price_cents": 599900,  # ₹5,999
        "annual_price_cents": 5758800,  # ₹57,588 (₹4,799/mo × 12)
        "monthly_price_usd_cents": 8999,  # $89.99
        "annual_price_usd_cents": 86388,  # $863.88 ($71.99/mo × 12)
        "annual_discount_percent": 20,  # ₹57,588 vs ₹71,988 (12 × monthly)
        "trial_days": 0,
        "included_operator_seats": -1,
        "extra_seat_price_cents": 0,
        "extra_seat_price_usd_cents": 0,
        "is_default": False,
        "sort_order": 5,
        "limits": {
            # Mirrors ``credits_per_month`` — every other rung does the same, and
            # this copy is what ``/subscriptions/plans`` and the public pricing
            # catalog serialize as ``limits.credits``. Enterprise sells pooling
            # (unlimited agents/seats/domains on ONE pool), not a bigger
            # allowance, so the pooled figure stays at Professional's 10,000 and
            # heavy accounts top up.
            "credits": 10000,
            # Unlimited bots is the whole point of this tier. Credits still
            # meter real cost (5 per page, 1 per 250 words), so uncapped
            # ingestion is self-limiting — no separate knowledge cap needed.
            "bots": -1,
            "operators": -1,
            "leads": -1,
            "page_scraping": -1,
            "documents": -1,
            "knowledge_characters": -1,
            "chat_history_days": 365,
            "max_crawl_depth": 5,
            "max_crawl_pages": -1,
            "max_crawl_js_pages": -1,
            "max_crawl_concurrency": 8,
        },
        "features": {
            "live_chat": True,
            "bant": True,
            "branding_removable": True,
            "webhooks": True,
            "api_access": True,
            "online_support": True,
            "topup_allowed": True,
            "auto_recrawl": True,
            "integrations": "all",
        },
        "marketing": {"tagline": "For agencies running many client sites from one account."},
    },
]

# Columns copied verbatim from the matrix dict onto the Plan row.
_SCALAR_FIELDS = (
    "name",
    "description",
    "credits_per_month",
    "monthly_price_cents",
    "annual_price_cents",
    "monthly_price_usd_cents",
    "annual_price_usd_cents",
    "annual_discount_percent",
    "trial_days",
    "included_operator_seats",
    "extra_seat_price_cents",
    "extra_seat_price_usd_cents",
    "is_default",
    "sort_order",
    "limits",
    "features",
    "marketing",
)


def _would_be_sellable(data: dict, plan: Plan | None) -> bool:
    """Sellability of the row this run will leave behind.

    Gateway plan ids live on the existing row — this script never writes them —
    so a brand-new paid row is by definition not yet sellable. It goes on sale
    when ``set_razorpay_plan_ids.py`` attaches this environment's ids.
    """
    return plan_is_sellable(
        is_free=not data["monthly_price_cents"] and not data["annual_price_cents"],
        razorpay_plan_id_monthly=getattr(plan, "razorpay_plan_id_monthly", None),
        razorpay_plan_id_annual=getattr(plan, "razorpay_plan_id_annual", None),
    )


def run(*, apply: bool) -> int:
    with get_session() as session:
        existing = {p.slug: p for p in session.scalars(select(Plan)).all()}

        print(f"Mode: {'APPLY' if apply else 'DRY-RUN'}\n")
        off_sale: list[str] = []
        for data in _PLANS:
            slug = data["slug"]
            plan = existing.get(slug)
            verb = "update" if plan else "insert"
            price = data["monthly_price_cents"] / 100
            sellable = _would_be_sellable(data, plan)
            if not sellable:
                off_sale.append(slug)
            state = "on sale" if sellable else "OFF SALE — no Razorpay plan id"
            print(f"  {verb:<6} {slug:<13} ₹{price:>8,.0f}/mo  {data['credits_per_month']:>6} credits  {state}")

            if not apply:
                continue

            if plan is None:
                plan = Plan(slug=slug, currency="INR", pricing_model="per_operator")
                session.add(plan)
            plan.currency = "INR"
            plan.is_active = sellable
            for field in _SCALAR_FIELDS:
                setattr(plan, field, data[field])

        if off_sale:
            print(
                f"\nNot on sale in this environment: {', '.join(off_sale)}. "
                "A tier without both INR Razorpay plan ids cannot complete a checkout, so it is\n"
                "left deactivated rather than listed. Attach this environment's ids with\n"
                "scripts/set_razorpay_plan_ids.py --apply — that puts each tier on sale as its ids land."
            )

        if apply:
            session.commit()
            print("\nCommitted.")
        else:
            print("\nDry-run — re-run with --apply to commit.")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--apply", action="store_true", help="Commit changes (default: dry-run).")
    args = parser.parse_args()
    return run(apply=args.apply)


if __name__ == "__main__":
    raise SystemExit(main())
