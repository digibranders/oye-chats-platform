"""Seed the pricing_config key/value store (idempotent).

The super-admin-tunable credit economics for a fresh database: per-action credit
costs, the extra-seat price, top-up packs, and the kill switch. Values are JSONB.

Aligned with the marketing site (oyechats.com/pricing):
* 1 AI reply = 1 credit, 1 crawled page = 5, 1 document = 3, emails are free.
* Extra seat = ₹499 (49900 paise).
* Top-up packs carry both INR and USD headline prices.

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
    # Extra-seat add-on price (INR paise). The actual charge is governed by the
    # Razorpay seat plan (RAZORPAY_SEAT_PLAN_ID); this is the displayed price.
    "seat_price_cents": 49900,  # ₹499
    # Credit / balance behaviour.
    "topup_expiry_months": 12,
    "low_balance_warn_pct": 20,
    "kill_switch": False,
    # Top-up packs (headline INR + USD; provider ids resolved lazily at purchase).
    "topup_packs": [
        {"inr": 1599, "usd": 19, "credits": 2000, "bonus_pct": 0, "stripe_price_id": None, "razorpay_plan_id": None},
        {"inr": 3999, "usd": 49, "credits": 5500, "bonus_pct": 10, "stripe_price_id": None, "razorpay_plan_id": None},
        {
            "inr": 7999,
            "usd": 99,
            "credits": 12000,
            "bonus_pct": 20,
            "badge": "Best value",
            "stripe_price_id": None,
            "razorpay_plan_id": None,
        },
        {
            "inr": 19999,
            "usd": 249,
            "credits": 32500,
            "bonus_pct": 30,
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
