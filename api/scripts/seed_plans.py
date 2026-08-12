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
        "annual_price_cents": 598800,  # ₹5,988 (₹499/mo × 12)
        "monthly_price_usd_cents": 1900,  # $19
        "annual_price_usd_cents": 18000,  # $180 ($15/mo × 12)
        "annual_discount_percent": 17,
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
        "annual_price_cents": 1198800,  # ₹11,988 (₹999/mo × 12)
        "monthly_price_usd_cents": 3100,  # $31
        "annual_price_usd_cents": 30000,  # $300 ($25/mo × 12)
        "annual_discount_percent": 17,
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
        "monthly_price_cents": 359900,  # ₹3,599
        "annual_price_cents": 3598800,  # ₹35,988 (₹2,999/mo × 12)
        "monthly_price_usd_cents": 3900,  # $39
        "annual_price_usd_cents": 37200,  # $372 ($31/mo × 12)
        "annual_discount_percent": 17,
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
        "credits_per_month": 13000,
        "monthly_price_cents": 479900,  # ₹4,799
        "annual_price_cents": 4606800,  # ₹46,068 (₹3,839/mo × 12)
        "monthly_price_usd_cents": 9199,  # $91.99
        "annual_price_usd_cents": 91188,  # $911.88 ($75.99/mo × 12)
        "annual_discount_percent": 20,
        "trial_days": 0,
        "included_operator_seats": -1,
        "extra_seat_price_cents": 0,
        "extra_seat_price_usd_cents": 0,
        "is_default": False,
        "sort_order": 5,
        "limits": {
            "credits": 13000,
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


def run(*, apply: bool) -> int:
    with get_session() as session:
        existing = {p.slug: p for p in session.scalars(select(Plan)).all()}

        print(f"Mode: {'APPLY' if apply else 'DRY-RUN'}\n")
        for data in _PLANS:
            slug = data["slug"]
            plan = existing.get(slug)
            verb = "update" if plan else "insert"
            price = data["monthly_price_cents"] / 100
            print(f"  {verb:<6} {slug:<13} ₹{price:>8,.0f}/mo  {data['credits_per_month']:>6} credits")

            if not apply:
                continue

            if plan is None:
                plan = Plan(slug=slug, currency="INR", pricing_model="per_operator", is_active=True)
                session.add(plan)
            plan.currency = "INR"
            plan.is_active = True
            for field in _SCALAR_FIELDS:
                setattr(plan, field, data[field])

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
