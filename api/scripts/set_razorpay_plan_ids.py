"""Populate Razorpay plan IDs on plan rows after dashboard setup.

After creating plans in the Razorpay dashboard, run this script to store
the plan IDs on the matching plan rows. Checkout will fail with a clear
error until every paid plan has its IDs set.

Two rails are stored side by side: the INR rail (``--<tier>-<cycle>``, charged
to Indian customers) and the USD rail (``--<tier>-<cycle>-usd``, charged to
international customers). They are separate Razorpay plan objects because a
plan's currency is fixed at creation, so an INR plan id can never serve a USD
charge. Either rail may be left unset; USD checkout fails loudly when its ids
are missing rather than falling back to INR.

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
    --professional-monthly plan_XXXXXXXXXXXXXXXX
    --professional-annual  plan_XXXXXXXXXXXXXXXX

USD rail (international customers):
    --starter-monthly-usd      plan_XXXXXXXXXXXXXXXX
    --starter-annual-usd       plan_XXXXXXXXXXXXXXXX
    --standard-monthly-usd     plan_XXXXXXXXXXXXXXXX
    --standard-annual-usd      plan_XXXXXXXXXXXXXXXX
    --professional-monthly-usd plan_XXXXXXXXXXXXXXXX
    --professional-annual-usd  plan_XXXXXXXXXXXXXXXX

The extra-seat add-on plans are NOT stored on a plan row — they are configured
via the ``RAZORPAY_SEAT_PLAN_ID`` (INR) and ``RAZORPAY_SEAT_PLAN_ID_USD``
environment variables (per Razorpay account/mode).

To clear a plan ID (set it back to NULL), pass the literal string 'null'.

Verification:
    After --apply, run with no plan-ID flags to print the current DB state:
        uv run python scripts/set_razorpay_plan_ids.py
"""

from __future__ import annotations

import argparse
import os
import sys
from typing import Any

sys.path.append(os.path.join(os.path.dirname(__file__), ".."))

from sqlalchemy import select

from app.db.models import Plan
from app.db.session import get_session

_SLUGS: tuple[str, ...] = ("starter", "standard", "professional")

# CLI flag suffix → Plan column, per rail. The flag for a given tier is
# ``--<slug>-<suffix>`` and its argparse attribute is ``<slug>_<suffix>``.
_INR_COLUMNS: dict[str, str] = {
    "monthly": "razorpay_plan_id_monthly",
    "annual": "razorpay_plan_id_annual",
}
_USD_COLUMNS: dict[str, str] = {
    "monthly-usd": "razorpay_plan_id_monthly_usd",
    "annual-usd": "razorpay_plan_id_annual_usd",
}
_ALL_COLUMNS: dict[str, str] = {**_INR_COLUMNS, **_USD_COLUMNS}

# Sentinel distinguishing "--flag null" (write NULL) from an absent flag
# (leave the column untouched). Without it, clearing an id is indistinguishable
# from not passing the flag at all.
_CLEAR = object()


def _coerce(val: str | None) -> Any:
    """Return None if the flag was absent, ``_CLEAR`` for 'null', else the id."""
    if val is None:
        return None
    stripped = val.strip()
    if stripped.lower() == "null":
        return _CLEAR
    return stripped


def _render(value: Any) -> str:
    """Human-readable form of a parsed flag value for the diff output."""
    return "(cleared)" if value is _CLEAR else repr(value)


def _print_rail(title: str, plan_map: dict[str, Plan], columns: dict[str, str]) -> None:
    monthly_col, annual_col = columns.values()
    print(f"\n{title}:")
    print(f"{'Slug':<12} {'Monthly':<32} {'Annual':<32}")
    print("-" * 76)
    for slug in _SLUGS:
        p = plan_map.get(slug)
        if p:
            mo = getattr(p, monthly_col) or "(none)"
            yr = getattr(p, annual_col) or "(none)"
            print(f"{slug:<12} {mo:<32} {yr:<32}")


def run(args: argparse.Namespace, *, apply: bool) -> int:
    updates: dict[str, dict[str, Any]] = {}

    for slug in _SLUGS:
        ids = {}
        for suffix, column in _ALL_COLUMNS.items():
            value = _coerce(getattr(args, f"{slug}_{suffix.replace('-', '_')}", None))
            if value is not None:
                ids[column] = value
        if ids:
            updates[slug] = ids

    with get_session() as session:
        plans = session.scalars(select(Plan).where(Plan.slug.in_(_SLUGS))).all()
        plan_map = {p.slug: p for p in plans}

        if not updates:
            print("Current Razorpay plan IDs in DB:")
            _print_rail("INR rail", plan_map, _INR_COLUMNS)
            _print_rail("USD rail", plan_map, _USD_COLUMNS)
            return 0

        print(f"Mode: {'APPLY' if apply else 'DRY-RUN'}")
        print()
        for slug, ids in updates.items():
            p = plan_map.get(slug)
            if p is None:
                print(f"  WARNING: plan slug='{slug}' not found in DB — skipping")
                continue
            print(f"  {slug}:")
            for column, value in ids.items():
                label = column.removeprefix("razorpay_plan_id_")
                print(f"    {label + ':':<14} {getattr(p, column) or '(none)'!r} → {_render(value)}")
                if apply:
                    setattr(p, column, None if value is _CLEAR else value)

        if apply:
            session.commit()
            print("\nCommitted.")
        else:
            session.rollback()
            print("\nDry-run — re-run with --apply to commit.")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--apply", action="store_true", help="Commit changes (default: dry-run).")
    for slug in _SLUGS:
        for suffix in _ALL_COLUMNS:
            cycle, _, rail = suffix.partition("-")
            currency = "USD" if rail else "INR"
            parser.add_argument(
                f"--{slug}-{suffix}",
                metavar="PLAN_ID",
                help=f"plan_XXX for {slug.capitalize()} {cycle} ({currency})",
            )

    args = parser.parse_args()
    return run(args, apply=args.apply)


if __name__ == "__main__":
    raise SystemExit(main())
