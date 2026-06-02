"""Audit and (optionally) repair every client's credit ledger.

Detects the orphan-reset corruption (negative ``plan_grant`` rows with
``grant_id = NULL``) that the original ``reset_monthly_plan_credits``
implementation produced. Those orphan rows are invisible to
``get_balance_breakdown`` — which only counts negatives via their
``grant_id`` — so prior-month unused credits silently rolled into the new
month's bucket.

The bug itself is fixed in ``app/services/credit_service.py`` so new
renewals are safe. This script repairs ledgers corrupted by the old code
path *before* the fix landed.

Usage (read-only audit):
    uv run python scripts/audit_credit_ledger.py

Usage (audit + repair, writes to DB):
    uv run python scripts/audit_credit_ledger.py --repair

Idempotent: only mutates rows where ``grant_id IS NULL AND delta < 0 AND
reason = 'plan_grant'``. Reattaches each orphan to the oldest still-positive
plan_grant with capacity. Never deletes or edits values.
"""

import argparse
import sys

from sqlalchemy import and_, select

from app.db.models import Client, CreditLedger
from app.db.session import get_session
from app.services import credit_service


def audit_and_repair(repair: bool) -> int:
    """Walk every client, report mismatches, optionally repair them.

    Returns the number of clients whose breakdown total still doesn't match
    the raw ledger sum after the pass (0 means everything is consistent).
    """
    repaired = 0
    still_broken = 0
    clean = 0
    with get_session() as session:
        clients = session.execute(select(Client)).scalars().all()
        for client in clients:
            breakdown = credit_service.get_balance_breakdown(session, client.id)
            raw = credit_service.get_balance(session, client.id)
            mismatch = breakdown["total"] - raw

            if mismatch == 0:
                clean += 1
                continue

            print(
                f"client {client.id} ({client.email}): "
                f"breakdown total {breakdown['total']} vs raw {raw} (off by {mismatch})"
            )

            orphans = (
                session.execute(
                    select(CreditLedger)
                    .where(
                        and_(
                            CreditLedger.client_id == client.id,
                            CreditLedger.reason == "plan_grant",
                            CreditLedger.delta < 0,
                            CreditLedger.grant_id.is_(None),
                        )
                    )
                    .order_by(CreditLedger.created_at)
                )
                .scalars()
                .all()
            )

            if not orphans:
                print("  no orphan negative plan_grant rows — needs manual review")
                still_broken += 1
                continue

            if not repair:
                print(f"  {len(orphans)} orphan reset row(s) — re-run with --repair to fix")
                still_broken += 1
                continue

            plan_grants = [g for g in credit_service._grants_for(session, client.id) if g.reason == "plan_grant"]
            attached = 0
            for orphan in orphans:
                for grant in plan_grants:
                    consumed = credit_service._consumed_against(session, grant.id)
                    room = int(grant.delta) - consumed
                    if room >= -int(orphan.delta):
                        orphan.grant_id = grant.id
                        attached += 1
                        break
            session.flush()

            new_breakdown = credit_service.get_balance_breakdown(session, client.id)
            new_raw = credit_service.get_balance(session, client.id)
            new_mismatch = new_breakdown["total"] - new_raw
            print(f"  attached {attached}/{len(orphans)} orphan rows; new mismatch: {new_mismatch}")
            if new_mismatch == 0:
                repaired += 1
            else:
                still_broken += 1

        if repair:
            session.commit()

    print()
    print(f"Summary: clean={clean}  repaired={repaired}  still_broken={still_broken}")
    return still_broken


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--repair",
        action="store_true",
        help="Write fixes back to the DB. Without this flag, runs in read-only audit mode.",
    )
    args = parser.parse_args()

    return audit_and_repair(repair=args.repair)


if __name__ == "__main__":
    sys.exit(main())
