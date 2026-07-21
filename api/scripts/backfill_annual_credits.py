"""One-time backfill for annual subscribers under-granted by the pre-bc5a5a7 bug.

Before commit ``bc5a5a7`` (``fix(billing): scale subscription credit grants by
billing cycle``), ``credit_service.grant_for_subscription`` granted a flat
``plan.credits_per_month`` regardless of ``subscription.billing_cycle``. Every
annual subscriber's CURRENT billing period was therefore granted only 1/12th
of what they paid for (e.g. Standard annual: 6,000 credits instead of the
72,000 the plan promises for a year).

This script finds every currently active/past_due annual subscription, works
out how short its current-period plan grant is, and tops it up by EXACTLY the
shortfall — never a full ``grant_for_subscription`` call, which would grant a
fresh 72,000 and double-credit the customer.

Idempotency: every grant this script writes is tagged with ``MARKER`` in the
ledger ``note``. A re-run finds that marker already present in the current
period and skips the subscription, so running with ``--execute`` twice grants
nothing extra the second time.

Usage (run inside the conda ``oye`` env, or via ``uv run``):

    cd api
    uv run python scripts/backfill_annual_credits.py             # dry-run (default, writes nothing)
    uv run python scripts/backfill_annual_credits.py --execute    # commit the grants
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
from typing import Any

# Allow running as a top-level script (``scripts/...``) without installing the
# package: prepend the parent ``api`` directory so ``app...`` imports resolve.
sys.path.append(os.path.join(os.path.dirname(__file__), ".."))

from sqlalchemy import func, select  # noqa: E402
from sqlalchemy.orm import Session  # noqa: E402

from app.db.models import CreditLedger, Subscription  # noqa: E402
from app.db.session import get_session  # noqa: E402
from app.services import credit_service  # noqa: E402

logger = logging.getLogger(__name__)

# Ledger `note` marker stamped on every grant this script writes. Also doubles
# as the idempotency check: a `plan_grant` row with this exact note already
# present in a subscription's current period means it was already backfilled.
MARKER = "annual-backfill-2026-07 correction"

# Only currently-billable subscriptions need their current period made whole.
# Canceled/expired/trialing subscriptions either never paid for annual credits
# in the affected way or are out of scope for a live-balance correction.
_TARGET_STATUSES = ("active", "past_due")


def _already_granted_this_period(session: Session, sub: Subscription) -> int:
    """Sum of positive ``plan_grant`` deltas for this sub's scope, this period.

    Scoped exactly like the subscription via ``credit_service._scope_clause``
    (client pool for account-level subs, isolated bot ledger for per-bot
    subs). Filtering ``delta > 0`` deliberately excludes the negative
    ``plan_grant`` rows ``reset_monthly_plan_credits`` writes at renewal, so a
    mid-period reset never understates what was actually granted.
    """
    total = session.scalar(
        select(func.coalesce(func.sum(CreditLedger.delta), 0)).where(
            *credit_service._scope_clause(sub.client_id, sub.bot_id),
            CreditLedger.reason == "plan_grant",
            CreditLedger.delta > 0,
            CreditLedger.created_at >= sub.current_period_start,
        )
    )
    return int(total or 0)


def _already_backfilled(session: Session, sub: Subscription) -> bool:
    """True if this subscription's current period already has a backfill grant."""
    existing = session.scalar(
        select(CreditLedger.id)
        .where(
            *credit_service._scope_clause(sub.client_id, sub.bot_id),
            CreditLedger.reason == "plan_grant",
            CreditLedger.note == MARKER,
            CreditLedger.created_at >= sub.current_period_start,
        )
        .limit(1)
    )
    return existing is not None


def _collect_candidates(session: Session) -> list[dict[str, Any]]:
    """Return one row per annual subscription that is short on this period's credits.

    Each row carries everything the CLI report needs plus the live
    ``Subscription`` object so the caller can grant against it without a
    second lookup. Subscriptions that are already correct, already
    backfilled, or whose period can't be safely bounded are omitted (and, for
    the last case, logged).
    """
    rows: list[dict[str, Any]] = []

    subs = (
        session.execute(
            select(Subscription)
            .where(Subscription.billing_cycle == "annual")
            .where(Subscription.status.in_(_TARGET_STATUSES))
            .order_by(Subscription.id)
        )
        .scalars()
        .all()
    )

    for sub in subs:
        plan = sub.plan
        if plan is None or int(plan.credits_per_month or 0) <= 0:
            continue

        if sub.current_period_start is None:
            logger.warning(
                "backfill_annual_credits: subscription %s has no current_period_start — "
                "skipping (can't bound the current period safely)",
                sub.id,
            )
            continue

        target = int(plan.credits_per_month) * 12
        already_granted = _already_granted_this_period(session, sub)
        shortfall = target - already_granted
        if shortfall <= 0:
            continue

        if _already_backfilled(session, sub):
            continue

        rows.append(
            {
                "subscription": sub,
                "subscription_id": sub.id,
                "client_id": sub.client_id,
                "plan_slug": plan.slug,
                "bot_id": sub.bot_id,
                "target": target,
                "already_granted": already_granted,
                "shortfall": shortfall,
            }
        )

    return rows


def run_backfill(session: Session, *, execute: bool) -> dict[int, int]:
    """Compute (and, when ``execute=True``, grant) shortfalls for annual subs.

    Returns ``{subscription_id: credits_granted}`` — only for subscriptions
    that had a positive, not-yet-backfilled shortfall. In dry-run mode
    (``execute=False``) nothing is written to the session; the returned dict
    still reports what WOULD be granted.

    Safe to call repeatedly with ``execute=True``: a subscription that was
    already topped up (marker present in its current period) is excluded by
    ``_collect_candidates`` and simply won't appear in the result.
    """
    results: dict[int, int] = {}
    for row in _collect_candidates(session):
        sub: Subscription = row["subscription"]
        shortfall: int = row["shortfall"]
        if execute:
            credit_service.grant_plan_credits(
                session,
                sub.client_id,
                shortfall,
                note=MARKER,
                bot_id=sub.bot_id,
            )
        results[sub.id] = shortfall
    return results


def _print_table(rows: list[dict[str, Any]]) -> None:
    if not rows:
        print("No under-granted annual subscriptions found.")
        return

    header = (
        f"{'client_id':>10} {'sub_id':>8} {'plan':<24} {'bot_id':>8} {'target':>10} {'granted':>10} {'shortfall':>10}"
    )
    print(header)
    print("-" * len(header))
    total_shortfall = 0
    for row in rows:
        bot_id_display = row["bot_id"] if row["bot_id"] is not None else "-"
        print(
            f"{row['client_id']:>10} {row['subscription_id']:>8} {row['plan_slug']:<24} "
            f"{str(bot_id_display):>8} {row['target']:>10} {row['already_granted']:>10} {row['shortfall']:>10}"
        )
        total_shortfall += row["shortfall"]
    print("-" * len(header))
    print(f"Subscriptions affected: {len(rows)}")
    print(f"Total credits to grant: {total_shortfall}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument(
        "--execute",
        action="store_true",
        help="Perform and commit the grants. Default is dry-run (prints the report, writes nothing).",
    )
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")

    mode = "EXECUTE" if args.execute else "DRY-RUN"
    print(f"Mode: {mode}")
    print(f"Idempotency marker: {MARKER!r}")
    print("-" * 72)

    with get_session() as session:
        rows = _collect_candidates(session)
        _print_table(rows)

        if args.execute:
            result = run_backfill(session, execute=True)
            session.commit()
            print("-" * 72)
            print(f"Committed. Granted {sum(result.values())} credits across {len(result)} subscription(s).")
        else:
            session.rollback()
            print("-" * 72)
            print("Dry-run — no changes written. Re-run with --execute to commit.")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
