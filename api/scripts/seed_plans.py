"""Seed the canonical plan matrix (idempotent).

Single source of truth for the customer-facing plans on a fresh database:
Free / Starter / Standard / Professional / Enterprise. Matches the pricing on
the marketing site (oyechats.com/pricing).

Plus one row that is not customer-facing: ``trial``, the 14-day plan every new
signup lands on. It is ``is_default`` so ``get_default_plan`` hands it to
registration, and ``is_public: False`` so it never reaches ``/plans`` or the
public pricing catalogue. Unlike ``is_active``, ``is_public`` IS upserted, the
listing decision it encodes is a property of the catalogue this file owns, not
a lifecycle state an operator sets by hand.

Prices are stored in minor units: ``*_cents`` is INR paise (``currency='INR'``),
``*_usd_cents`` is US cents (deliberate USD headline, not FX-converted).

Razorpay plan IDs are intentionally NOT set here. They differ per environment
(test vs live) and are configured separately with ``set_razorpay_plan_ids.py``
so no plan ID is hardcoded in the repo. The extra-seat add-on plan is likewise
env-config (``RAZORPAY_SEAT_PLAN_ID``), not a plan row.

``is_active`` is set on INSERT and NEVER on UPDATE. This file is the catalogue
(prices, entitlements, ordering) not the listing lifecycle, and the two writes
answer different questions:

* A row this run creates has no history to respect, so it is listed. Under the
  current policy that is right even with no gateway plan id: an unwired paid
  tier stays on the pricing page and degrades to contact-sales rather than
  vanishing from ``GET /public/pricing-catalog`` (see
  ``plan_service.plan_checkout_is_wired``).
* A row that already exists may have been deactivated ON PURPOSE, by migration
  ``f1a2b3c4d5e6``, by super-admin soft-delete, or by the plan editor. The seed
  cannot tell a deliberate deactivation from a stale one, so it does not touch
  the column at all. The blanket ``plan.is_active = True`` this replaces is
  exactly what silently undid that migration on every ``reset_and_seed.sh`` run.

What the seed DOES report is which tiers this environment can actually charge
for, so a fresh database tells you what is missing without turning that into a
listing decision.

Idempotent: each plan is matched by ``slug`` and updated in place; a new row is
inserted if the slug is missing. Unknown slugs (custom tiers added by a super
admin) are left untouched.

``annual_discount_percent`` is NOT in the matrix. It is derived from each tier's
two INR prices via ``core.pricing.annual_saving_percent`` (the same helper every
plan payload is served through) so the seed cannot store a headline the prices
do not back. It was hand-maintained until now, and it drifted: Professional
carried 22 for a 21.674% saving, which is what the marketing site advertised.

Every INR amount in the matrix is checked against the RBI e-mandate AFA ceiling
(``core.pricing.emandate_warning``, shared with the super-admin plan editor) in
BOTH modes. A breach is printed loudly and blocks nothing. See
``_print_emandate_warnings``.

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

from app.core.pricing import EMANDATE_AFA_CEILING_MINOR, annual_saving_percent, emandate_warning
from app.db.models import Plan
from app.db.session import get_session
from app.services.plan_service import plan_checkout_is_wired

# ── Canonical matrix. Single source of truth ──────────────────────────────
# INR paise for *_cents; US cents for *_usd_cents. -1 in limits means unlimited.
_PLANS: list[dict] = [
    {
        # NOT purchasable and NOT listed. ``is_public: False`` keeps it out of
        # ``get_active_plans``, which feeds /plans and the public pricing
        # catalogue, while ``is_active`` (set on insert) keeps it assignable so
        # ``get_default_plan`` can hand it to every new signup. Entitlements are
        # Professional's, minus the volume the paid tiers sell: one bot, one
        # seat, 500 credits, 100 crawl pages, and no top-ups.
        "slug": "trial",
        "name": "Free Trial",
        "description": "Fourteen days of everything, on one chatbot.",
        "credits_per_month": 500,
        "monthly_price_cents": 0,
        "annual_price_cents": 0,
        "monthly_price_usd_cents": 0,
        "annual_price_usd_cents": 0,
        "trial_days": 14,
        "included_operator_seats": 1,
        "extra_seat_price_cents": 0,
        "extra_seat_price_usd_cents": 0,
        "is_default": True,
        "is_public": False,
        "sort_order": 0,
        "limits": {
            "credits": 500,
            "bots": 1,
            "operators": 1,
            "leads": -1,
            "page_scraping": 100,
            "documents": -1,
            # = Standard. 100 pages at ~4k chars is ~400k, so the page cap binds
            # first and this stays a backstop, not a wall.
            # 100,000 characters, not the 500,000 this used to carry — the
            # same figure as Standard at ₹1,199 and ten times Starter at
            # ₹599, so a free trial out-gave a paid tier tenfold on
            # knowledge and made converting feel like a downgrade.
            #
            # Sized from the free-page allowance above rather than picked:
            # 104 real crawled pages in production average 5,243 cleaned
            # characters (median 4,732, p75 5,812), so 25 free pages is
            # roughly 131,000 at the mean. 100,000 covers about 20 pages at
            # p75 sizing, which is the working size of most small sites, and
            # anything past it is the customer's own decision to spend
            # credits on. Enforced per account by knowledge_quota_service.
            "knowledge_characters": 100_000,
            "chat_history_days": 90,
            "max_crawl_depth": 4,
            "max_crawl_pages": 100,
            # Pages the account may crawl at zero credits. Not a free
            # first crawl: at 5 credits a page a 100-page site would have
            # been handed the entire 500-credit grant, while a small site
            # got a fraction of the same offer. A fixed allowance gives
            # every trial the same deal and leaves the credits for
            # actually evaluating the product.
            "free_training_pages": 25,
            "max_crawl_js_pages": 50,
            "max_crawl_concurrency": 4,
        },
        # Professional's flags verbatim, with two deliberate differences:
        # top-ups are closed (buying volume is what the paid tiers are for) and
        # ``first_training_free`` opens the first website crawl at zero credits.
        # Plan behaviour stays in plan data, like every other flag here.
        "features": {
            "live_chat": True,
            "bant": True,
            "branding_removable": False,
            "webhooks": True,
            "api_access": True,
            "online_support": True,
            "topup_allowed": False,
            "auto_recrawl": True,
            "integrations": "all",
            "first_training_free": True,  # kept: surfaced in entitlements/UI copy
        },
        "marketing": {"tagline": "Fourteen days of everything, on one chatbot."},
    },
    {
        "slug": "free",
        "name": "Free",
        "description": "A grounded AI bot, free forever.",
        "credits_per_month": 100,
        "monthly_price_cents": 0,
        "annual_price_cents": 0,
        "monthly_price_usd_cents": 0,
        "annual_price_usd_cents": 0,
        "trial_days": 0,
        "included_operator_seats": 0,
        "extra_seat_price_cents": 0,
        "extra_seat_price_usd_cents": 0,
        "is_default": False,  # the signup default is the trial row above
        "is_public": True,
        "sort_order": 1,
        "limits": {
            "credits": 100,
            "bots": 1,
            "operators": 0,
            "leads": 15,
            "page_scraping": 20,
            "documents": 3,
            "knowledge_characters": 2_500,  # ~500 words. Tiny KB, real product try
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
        "trial_days": 0,  # the only trial is the signup trial row
        "included_operator_seats": 1,
        "extra_seat_price_cents": 49900,  # ₹499
        "extra_seat_price_usd_cents": 500,  # $5
        "is_default": False,
        "is_public": True,
        "sort_order": 2,
        "limits": {
            "credits": 1000,
            "bots": 1,
            "operators": 5,
            "leads": -1,
            "page_scraping": 500,
            "documents": 20,
            "knowledge_characters": 50_000,  # ~10k words. Small help center
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
        "description": "The lead-machine. Grounded AI plus BANT qualification.",
        "credits_per_month": 2500,
        "monthly_price_cents": 119900,  # ₹1,199
        "annual_price_cents": 1150800,  # ₹11,508 (₹959/mo × 12)
        "monthly_price_usd_cents": 1599,  # $15.99
        "annual_price_usd_cents": 15588,  # $155.88 ($12.99/mo × 12)
        "trial_days": 0,  # the signup trial replaced the Standard-only offer
        "included_operator_seats": 2,
        "extra_seat_price_cents": 49900,  # ₹499
        "extra_seat_price_usd_cents": 500,
        "is_default": False,
        "is_public": True,
        "sort_order": 3,
        "limits": {
            "credits": 2500,
            "bots": 1,
            "operators": 10,
            "leads": -1,
            "page_scraping": 2000,
            "documents": -1,  # unlimited. Standard trusts the char cap + credit gate
            "knowledge_characters": 500_000,  # ~100k words. Full product docs
            "chat_history_days": 90,
            "max_crawl_depth": 4,
            "max_crawl_pages": -1,
            "max_crawl_js_pages": 150,
            "max_crawl_concurrency": 4,
        },
        "features": {
            "live_chat": True,
            "bant": True,
            "branding_removable": False,
            "webhooks": True,
            "api_access": True,
            "online_support": True,
            "topup_allowed": True,
            "auto_recrawl": True,
            "integrations": "all",
        },
        "marketing": {
            "tagline": "The lead-machine. Grounded AI plus BANT qualification.",
            "badge": "Most Popular",
        },
    },
    {
        "slug": "professional",
        "name": "Professional",
        "description": "For teams scaling qualified pipeline with deeper frameworks.",
        "credits_per_month": 8000,
        "monthly_price_cents": 299900,  # ₹2,999
        "annual_price_cents": 2818800,  # ₹28,188 (₹2,349/mo × 12)
        "monthly_price_usd_cents": 4599,  # $45.99
        "annual_price_usd_cents": 45588,  # $455.88 ($37.99/mo × 12)
        "trial_days": 0,  # the only trial is the signup trial row
        "included_operator_seats": 3,
        "extra_seat_price_cents": 49900,  # ₹499
        "extra_seat_price_usd_cents": 500,
        "is_default": False,
        "is_public": True,
        "sort_order": 4,
        "limits": {
            "credits": 8000,
            "bots": 1,
            "operators": 25,
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
            "branding_removable": False,
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
        "trial_days": 0,
        "included_operator_seats": -1,
        "extra_seat_price_cents": 0,
        "extra_seat_price_usd_cents": 0,
        "is_default": False,
        "is_public": True,
        "sort_order": 5,
        "limits": {
            # Mirrors ``credits_per_month``. Every other rung does the same, and
            # this copy is what ``/subscriptions/plans`` and the public pricing
            # catalog serialize as ``limits.credits``. Enterprise sells pooling
            # (unlimited agents/seats/domains on ONE pool), not a bigger
            # allowance, so the pooled figure is a flat 10,000 and heavy
            # accounts top up.
            "credits": 10000,
            # Unlimited bots is the whole point of this tier. Credits still
            # meter real cost (5 per page, 1 per 250 words), so uncapped
            # ingestion is self-limiting, no separate knowledge cap needed.
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
            "branding_removable": False,
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
    "trial_days",
    "included_operator_seats",
    "extra_seat_price_cents",
    "extra_seat_price_usd_cents",
    "is_default",
    "is_public",
    "sort_order",
    "limits",
    "features",
    "marketing",
)


def _would_be_wired(data: dict, plan: Plan | None) -> bool:
    """Whether the row this run leaves behind can take a self-serve checkout.

    Gateway plan ids live on the existing row (this script never writes them)
    so a brand-new paid row is by definition not yet wired. It becomes
    checkoutable when ``set_razorpay_plan_ids.py`` attaches this environment's
    ids. Reported only: it does NOT decide ``is_active``.
    """
    return plan_checkout_is_wired(
        is_free=not data["monthly_price_cents"] and not data["annual_price_cents"],
        razorpay_plan_id_monthly=getattr(plan, "razorpay_plan_id_monthly", None),
        razorpay_plan_id_annual=getattr(plan, "razorpay_plan_id_annual", None),
    )


def _emandate_warnings(data: dict, rate_bps: int) -> list[str]:
    """Warnings for every amount this catalogue entry can debit in one charge.

    ``run`` writes ``currency="INR"`` on every row it touches, so the paise
    ceiling always applies and the currency is passed as a literal rather than
    read back off a row that may not exist yet.

    Labelled by slug and cycle because the amounts are printed together at the
    end of the run: "professional annual" says which price to move, where a
    bare rupee figure would not.
    """
    return [
        f"{data['slug']} {cycle}: {warning}"
        for cycle, warning in (
            ("monthly", emandate_warning(data["monthly_price_cents"], "INR", rate_bps=rate_bps)),
            ("annual", emandate_warning(data["annual_price_cents"], "INR", rate_bps=rate_bps)),
        )
        if warning
    ]


def _print_emandate_warnings(warnings: list[str]) -> None:
    """Report ceiling breaches loudly, and do nothing else.

    Explicitly NOT a failure: the exit code stays 0 and the seed still writes.
    Pricing above the ceiling is a deliberate business decision (both annual
    tiers are already there), and a seed that refused to run because of one
    would be unusable, the whole catalogue would be hostage to a pricing
    argument. The value is that the NEXT price change gets flagged before it
    ships, so this is sized to be unmissable in a wall of seed output instead.
    """
    if not warnings:
        return
    plural = "" if len(warnings) == 1 else "s"
    ceiling = EMANDATE_AFA_CEILING_MINOR / 100
    print("\n" + "!" * 100)
    print(f"RBI E-MANDATE CEILING - {len(warnings)} plan-cycle{plural} above ₹{ceiling:,.0f} in a single charge:\n")
    for warning in warnings:
        print(f"  {warning}")
    print(
        "\nNot a blocker: the seed still ran and exits 0. What it costs is silent renewal. "
        "each of those\ncharges needs the customer to complete Additional Factor of Authentication, "
        "every cycle. Price\nbelow the ceiling, bill those tiers monthly, or invoice them instead."
    )
    print("!" * 100)


def run(*, apply: bool) -> int:
    with get_session() as session:
        # The RBI e-mandate ceiling applies to what is DEBITED, and prices are
        # stored exclusive of GST, so the ceiling check needs the tax rate.
        from app.services.seller_profile_service import charge_tax_rate_bps

        seller_rate_bps = charge_tax_rate_bps(session)
        existing = {p.slug: p for p in session.scalars(select(Plan)).all()}

        print(f"Mode: {'APPLY' if apply else 'DRY-RUN'}\n")
        contact_sales_only: list[str] = []
        # Collected in BOTH modes. A dry-run exists so someone can see what a
        # change would do before committing it; a ceiling warning that only
        # appeared under --apply would arrive after the price was already
        # written, which is exactly the moment it stops being actionable.
        ceiling_warnings: list[str] = []
        for data in _PLANS:
            slug = data["slug"]
            plan = existing.get(slug)
            verb = "update" if plan else "insert"
            price = data["monthly_price_cents"] / 100
            wired = _would_be_wired(data, plan)
            if not data["is_public"]:
                # Delisted rows are not a checkout question at all. Printing
                # "self-serve" for the one row this flag exists to make
                # un-buyable is the exact opposite of what the operator needs
                # to read, and a zero price makes _would_be_wired say yes.
                state = "NOT FOR SALE, delisted (is_public false)"
            elif wired:
                state = "self-serve"
            else:
                contact_sales_only.append(slug)
                state = "CONTACT SALES, no Razorpay plan id"
            print(f"  {verb:<6} {slug:<13} ₹{price:>8,.0f}/mo  {data['credits_per_month']:>6} credits  {state}")
            ceiling_warnings.extend(_emandate_warnings(data, seller_rate_bps))

            if not apply:
                continue

            if plan is None:
                # is_active ONLY here. A row this run creates has no deliberate
                # deactivation to override; an existing one may, so the update
                # below leaves the column alone. See the module docstring.
                plan = Plan(slug=slug, currency="INR", pricing_model="per_operator", is_active=True)
                session.add(plan)
            plan.currency = "INR"
            for field in _SCALAR_FIELDS:
                setattr(plan, field, data[field])
            # Derived, never authored. See the module docstring. Uses the same
            # helper every read route serves, so the row and the payload agree.
            plan.annual_discount_percent = annual_saving_percent(
                data["monthly_price_cents"], data["annual_price_cents"]
            )

        if contact_sales_only:
            print(
                f"\nNot self-serve in this environment: {', '.join(contact_sales_only)}. "
                "A tier without both INR Razorpay\nplan ids stays LISTED, the quote answers "
                "'inr_plan_unconfigured' with a contact-sales address and\ncheckout refuses in the "
                "same shape, but nobody can buy it without leaving the site. Attach this\n"
                "environment's ids with scripts/set_razorpay_plan_ids.py --apply to open self-serve "
                "checkout."
            )

        if apply:
            session.commit()
            print("\nCommitted.")
        else:
            print("\nDry-run. Re-run with --apply to commit.")

        # Last, so it is the block still on screen when the run ends.
        _print_emandate_warnings(ceiling_warnings)
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--apply", action="store_true", help="Commit changes (default: dry-run).")
    args = parser.parse_args()
    return run(apply=args.apply)


if __name__ == "__main__":
    raise SystemExit(main())
