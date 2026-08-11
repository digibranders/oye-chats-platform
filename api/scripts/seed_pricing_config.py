"""Seed the pricing_config key/value store (idempotent).

The super-admin-tunable credit economics for a fresh database: per-action credit
costs, the extra-seat price, top-up packs, and the kill switch. Values are JSONB.

Aligned with the marketing site (oyechats.com/pricing):
* 1 AI reply = 1 credit, 1 crawled page = 5, 1 document = 3, customer emails free.
* 1 email verification = 10 credits, 1 company-name lookup = 10 credits.
* Extra seat = ₹499 (49900 paise).
* Top-up packs are one-time, lifetime (topup_expiry_months=0); INR + USD headline.

Idempotent: every key is upserted (insert or update-in-place). Keys not listed
here are left untouched so a super admin can add tunables without this script
clobbering them.

Usage:
    cd platform/api
    uv run python scripts/seed_pricing_config.py            # dry-run
    uv run python scripts/seed_pricing_config.py --apply     # commit
"""

from __future__ import annotations

import argparse
import os
import sys

sys.path.append(os.path.join(os.path.dirname(__file__), ".."))

from sqlalchemy import select

from app.db.models import PricingConfig
from app.db.session import get_session

# ── Canonical pricing_config — single source of truth ──────────────────────
_CONFIG: dict[str, object] = {
    # Per-action credit costs (credits deducted per event).
    "credit_cost.ai_chat": 1,
    "credit_cost.url_scan": 5,
    "credit_cost.document_upload": 3,
    "credit_cost.email_send": 0,  # customer-facing emails are free
    "credit_cost.email_verification": 10,  # Reoon power-mode check, once per lead enrichment
    "credit_cost.company_name": 10,  # IP → company lookup (Visitor Intelligence)
    # Extra-seat add-on price (INR paise). The actual charge is governed by the
    # Razorpay seat plan (RAZORPAY_SEAT_PLAN_ID); this is the displayed price.
    "seat_price_cents": 49900,  # ₹499
    # Credit / balance behaviour. topup_expiry_months=0 → lifetime top-ups
    # (one-time purchase, credits never expire).
    "topup_expiry_months": 0,
    "low_balance_warn_pct": 20,
    "kill_switch": False,
    # Master on/off switches for the two metered enrichment features. When
    # False the feature is skipped platform-wide (no lookup, no charge).
    "feature.email_verification_enabled": True,
    "feature.company_name_enabled": True,
    # One-time top-up packs, lifetime credits (headline INR + USD; provider ids
    # resolved lazily at purchase). bonus_pct/badge are marketing metadata.
    "topup_packs": [
        {"inr": 3999, "usd": 49, "credits": 6000, "bonus_pct": 0, "stripe_price_id": None, "razorpay_plan_id": None},
        {
            "inr": 10000,
            "usd": 119,
            "credits": 36000,
            "bonus_pct": 140,
            "stripe_price_id": None,
            "razorpay_plan_id": None,
        },
        {
            "inr": 20000,
            "usd": 239,
            "credits": 75000,
            "bonus_pct": 150,
            "badge": "Best value",
            "stripe_price_id": None,
            "razorpay_plan_id": None,
        },
        {
            "inr": 30000,
            "usd": 359,
            "credits": 100000,
            "bonus_pct": 120,
            "stripe_price_id": None,
            "razorpay_plan_id": None,
        },
    ],
}


def run(*, apply: bool) -> int:
    with get_session() as session:
        existing = {c.key: c for c in session.scalars(select(PricingConfig)).all()}

        print(f"Mode: {'APPLY' if apply else 'DRY-RUN'}\n")
        for key, value in _CONFIG.items():
            row = existing.get(key)
            verb = "update" if row else "insert"
            shown = value if not isinstance(value, list) else f"[{len(value)} packs]"
            print(f"  {verb:<6} {key:<28} = {shown}")

            if not apply:
                continue

            if row is None:
                session.add(PricingConfig(key=key, value=value))
            else:
                row.value = value

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
