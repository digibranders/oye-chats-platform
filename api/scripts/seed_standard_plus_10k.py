"""Seed all existing clients with the Standard plan + a 10,000-credit top-up.

One-off operational script: gives every existing client an active Standard
subscription (only if they don't already have a non-cancelled one) and a
10,000-credit top-up via the credit ledger.

Idempotent: ledger entries are tagged with a fixed ``--note`` and re-runs skip
clients that already have an entry with that note.

Usage (run inside the conda ``oye`` env on the server):

    cd platform/api
    uv run python scripts/seed_standard_plus_10k.py            # dry-run
    uv run python scripts/seed_standard_plus_10k.py --apply    # commit
"""

from __future__ import annotations

import argparse
import os
import sys
from datetime import UTC, datetime, timedelta

# Allow running as a top-level script (``scripts/...``) without installing the
# package: prepend the parent ``platform/api`` directory so ``app...`` imports
# resolve.
sys.path.append(os.path.join(os.path.dirname(__file__), ".."))

from sqlalchemy import select  # noqa: E402

from app.db.models import Client, CreditLedger, Plan, Subscription  # noqa: E402
from app.db.session import get_session  # noqa: E402
from app.services import credit_service  # noqa: E402

DEFAULT_NOTE = "seed_grant_2026_04_28_standard_plus_10k"
DEFAULT_PLAN_SLUG = "standard"
DEFAULT_TOPUP = 10_000
ACTIVE_SUB_STATUSES = ("active", "trialing", "past_due", "paused")


def _existing_active_sub(session, client_id: int) -> Subscription | None:
    return session.scalars(
        select(Subscription)
        .where(Subscription.client_id == client_id)
        .where(Subscription.status.in_(ACTIVE_SUB_STATUSES))
        .order_by(Subscription.id.desc())
    ).first()


def _existing_seed_grant(session, client_id: int, note: str) -> CreditLedger | None:
    return session.scalars(
        select(CreditLedger).where(CreditLedger.client_id == client_id).where(CreditLedger.note == note)
    ).first()


def _existing_plan_grant_in_period(session, sub: Subscription) -> CreditLedger | None:
    """Plan-grant entry already issued for this subscription's current period?

    A subscription activation should produce exactly one ``plan_grant`` ledger
    entry per period (mirrors what the Stripe / Razorpay webhooks do).
    """
    period_start = sub.current_period_start
    q = select(CreditLedger).where(CreditLedger.client_id == sub.client_id).where(CreditLedger.reason == "plan_grant")
    if period_start is not None:
        q = q.where(CreditLedger.created_at >= period_start)
    return session.scalars(q.order_by(CreditLedger.id.desc())).first()


def _create_standard_sub(session, client_id: int, plan: Plan) -> Subscription:
    now = datetime.now(UTC)
    sub = Subscription(
        client_id=client_id,
        plan_id=plan.id,
        status="active",
        billing_cycle="monthly",
        operator_quantity=plan.included_operator_seats or 1,
        current_period_start=now,
        current_period_end=now + timedelta(days=30),
        payment_provider="manual",
    )
    session.add(sub)
    session.flush()
    return sub


def run(*, apply: bool, plan_slug: str, topup_amount: int, note: str) -> int:
    if topup_amount <= 0:
        raise SystemExit("topup_amount must be positive")

    summary = {
        "clients_total": 0,
        "subs_created": 0,
        "subs_skipped_existing": 0,
        "plan_grants_issued": 0,
        "plan_grants_skipped_existing": 0,
        "topups_granted": 0,
        "topups_skipped_existing": 0,
    }

    with get_session() as session:
        plan = session.scalars(select(Plan).where(Plan.slug == plan_slug)).first()
        if plan is None:
            raise SystemExit(f"Plan with slug={plan_slug!r} not found")

        clients = session.scalars(select(Client).order_by(Client.id)).all()
        summary["clients_total"] = len(clients)

        print(
            f"Plan: {plan.name} (id={plan.id}, slug={plan.slug}, "
            f"credits/mo={plan.credits_per_month}, seats={plan.included_operator_seats})"
        )
        print(f"Top-up amount: {topup_amount} credits")
        print(f"Idempotency note: {note}")
        print(f"Mode: {'APPLY' if apply else 'DRY-RUN'}")
        print(f"Clients to process: {len(clients)}")
        print("-" * 72)

        for client in clients:
            existing_sub = _existing_active_sub(session, client.id)
            existing_grant = _existing_seed_grant(session, client.id, note)

            sub_action = "skip(existing-active-sub)"
            if existing_sub is None:
                sub = _create_standard_sub(session, client.id, plan) if apply else None
                sub_action = "create-standard-sub"
                summary["subs_created"] += 1
            else:
                sub = existing_sub
                summary["subs_skipped_existing"] += 1

            # Plan-credit grant: every active sub must have a plan_grant entry
            # for its current period — same call the Stripe / Razorpay webhooks
            # make on activation. Without it, ``used this period`` reads as
            # ``monthly_grant - 0 = 10,000`` and the UI shows "100% used".
            plan_action = "skip(no-sub-yet)"
            if sub is not None:
                existing_plan_grant = _existing_plan_grant_in_period(session, sub)
                if existing_plan_grant is None:
                    if apply:
                        credit_service.grant_for_subscription(session, sub)
                    plan_action = f"grant-plan({plan.credits_per_month})"
                    summary["plan_grants_issued"] += 1
                else:
                    plan_action = "skip(existing-plan-grant)"
                    summary["plan_grants_skipped_existing"] += 1
            elif not apply and summary["subs_created"]:
                # Dry-run with a freshly-"created" (uncommitted) sub: predict
                # that we'd issue the plan grant on apply.
                plan_action = f"grant-plan({plan.credits_per_month})"
                summary["plan_grants_issued"] += 1

            topup_action = "skip(existing-seed-grant)"
            if existing_grant is None:
                if apply:
                    credit_service.grant_topup(session, client.id, topup_amount, note=note)
                topup_action = f"grant-topup({topup_amount})"
                summary["topups_granted"] += 1
            else:
                summary["topups_skipped_existing"] += 1

            print(f"  client #{client.id} <{client.email}>: sub={sub_action}, plan={plan_action}, topup={topup_action}")

        print("-" * 72)
        for k, v in summary.items():
            print(f"  {k}: {v}")

        if apply:
            session.commit()
            print("Committed.")
        else:
            session.rollback()
            print("Rolled back (dry-run). Re-run with --apply to commit.")

    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="Commit changes. Default is dry-run.")
    parser.add_argument(
        "--plan-slug", default=DEFAULT_PLAN_SLUG, help=f"Plan slug to assign (default: {DEFAULT_PLAN_SLUG})"
    )
    parser.add_argument(
        "--topup-amount", type=int, default=DEFAULT_TOPUP, help=f"Credits to top up (default: {DEFAULT_TOPUP})"
    )
    parser.add_argument("--note", default=DEFAULT_NOTE, help="Ledger note used for idempotency.")
    args = parser.parse_args()

    return run(
        apply=args.apply,
        plan_slug=args.plan_slug,
        topup_amount=args.topup_amount,
        note=args.note,
    )


if __name__ == "__main__":
    raise SystemExit(main())
