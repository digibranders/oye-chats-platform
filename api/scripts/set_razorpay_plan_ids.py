"""Populate Razorpay plan IDs on plan rows after dashboard setup.

After creating plans in the Razorpay dashboard, run this script to store
the plan IDs on the matching plan rows. Checkout will fail with a clear
error until every paid plan has its IDs set.

Usage (dry-run — shows what would be written):
    cd platform/api
    uv run python scripts/set_razorpay_plan_ids.py \\
        --starter-monthly  plan_XXXXXXXXXXXXXXXX \\
        --starter-annual   plan_XXXXXXXXXXXXXXXX \\
        --standard-monthly plan_XXXXXXXXXXXXXXXX \\
        --standard-annual  plan_XXXXXXXXXXXXXXXX

Add --apply to commit:
    uv run python scripts/set_razorpay_plan_ids.py \\
        --starter-monthly  plan_XXXXXXXXXXXXXXXX \\
        --starter-annual   plan_XXXXXXXXXXXXXXXX \\
        --standard-monthly plan_XXXXXXXXXXXXXXXX \\
        --standard-annual  plan_XXXXXXXXXXXXXXXX \\
        --apply

Optional extras:
    --enterprise-monthly plan_XXXXXXXXXXXXXXXX
    --enterprise-annual  plan_XXXXXXXXXXXXXXXX
    --seat-monthly       plan_XXXXXXXXXXXXXXXX  (extra seat add-on)

To clear a plan ID (set it back to NULL), pass the literal string 'null'.

Verification:
    After --apply, run with no plan-ID flags to print the current DB state:
        uv run python scripts/set_razorpay_plan_ids.py
"""

from __future__ import annotations

import argparse
import os
import sys

sys.path.append(os.path.join(os.path.dirname(__file__), ".."))

from sqlalchemy import select

from app.db.models import Plan
from app.db.session import get_session

_SLUG_TO_ARGS: dict[str, tuple[str, str]] = {
    "starter":    ("starter_monthly", "starter_annual"),
    "standard":   ("standard_monthly", "standard_annual"),
    "enterprise": ("enterprise_monthly", "enterprise_annual"),
}


def _coerce(val: str | None) -> str | None:
    """Return None if val is falsy or the literal string 'null'."""
    if val is None or val.strip().lower() == "null":
        return None
    return val.strip()


def run(args: argparse.Namespace, *, apply: bool) -> int:
    updates: dict[str, dict[str, str | None]] = {}

    for slug, (mo_attr, yr_attr) in _SLUG_TO_ARGS.items():
        mo = _coerce(getattr(args, mo_attr, None))
        yr = _coerce(getattr(args, yr_attr, None))
        if mo is not None or yr is not None:
            updates[slug] = {
                "razorpay_plan_id_monthly": mo,
                "razorpay_plan_id_annual": yr,
            }

    with get_session() as session:
        plans = session.scalars(
            select(Plan).where(Plan.slug.in_(list(_SLUG_TO_ARGS.keys())))
        ).all()
        plan_map = {p.slug: p for p in plans}

        if not updates:
            print("Current Razorpay plan IDs in DB:")
            print(f"{'Slug':<12} {'Monthly':<32} {'Annual':<32}")
            print("-" * 76)
            for slug in ("starter", "standard", "enterprise"):
                p = plan_map.get(slug)
                if p:
                    mo = p.razorpay_plan_id_monthly or "(none)"
                    yr = p.razorpay_plan_id_annual or "(none)"
                    print(f"{slug:<12} {mo:<32} {yr:<32}")
            return 0

        print(f"Mode: {'APPLY' if apply else 'DRY-RUN'}")
        print()
        for slug, ids in updates.items():
            p = plan_map.get(slug)
            if p is None:
                print(f"  WARNING: plan slug='{slug}' not found in DB — skipping")
                continue
            mo = ids.get("razorpay_plan_id_monthly")
            yr = ids.get("razorpay_plan_id_annual")
            print(f"  {slug}:")
            if mo is not None:
                print(f"    monthly: {p.razorpay_plan_id_monthly or '(none)'!r} → {mo!r}")
            if yr is not None:
                print(f"    annual:  {p.razorpay_plan_id_annual or '(none)'!r} → {yr!r}")
            if apply:
                if mo is not None:
                    p.razorpay_plan_id_monthly = mo
                if yr is not None:
                    p.razorpay_plan_id_annual = yr

        if apply:
            session.commit()
            print("\nCommitted.")
        else:
            session.rollback()
            print("\nDry-run — re-run with --apply to commit.")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--apply", action="store_true", help="Commit changes (default: dry-run).")
    parser.add_argument("--starter-monthly",   metavar="PLAN_ID", help="plan_XXX for Starter monthly")
    parser.add_argument("--starter-annual",    metavar="PLAN_ID", help="plan_XXX for Starter annual")
    parser.add_argument("--standard-monthly",  metavar="PLAN_ID", help="plan_XXX for Standard monthly")
    parser.add_argument("--standard-annual",   metavar="PLAN_ID", help="plan_XXX for Standard annual")
    parser.add_argument("--enterprise-monthly", metavar="PLAN_ID", help="plan_XXX for Enterprise monthly")
    parser.add_argument("--enterprise-annual",  metavar="PLAN_ID", help="plan_XXX for Enterprise annual")

    args = parser.parse_args()
    return run(args, apply=args.apply)


if __name__ == "__main__":
    raise SystemExit(main())
