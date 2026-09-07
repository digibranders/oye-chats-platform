"""Repair bots whose denormalized ``Bot.plan_id`` disagrees with their own subscription.

DRY-RUN BY DEFAULT. Pass ``--execute`` to write.

Background: ``Bot.plan_id`` and ``Bot.subscription_id`` both point at the
Plan / Subscription funding one bot under per-bot billing. ``plan_id`` is a
denormalized copy of ``Subscription.plan_id`` for the row ``subscription_id``
already names, so the two must always agree. A plan change that updates the
subscription without restamping the bot leaves ``plan_id`` behind, and the row
then claims a tier the customer no longer holds (observed locally: bot 13
stamped ``standard`` while its subscription had moved to ``professional``).

**This is not an entitlement leak.** Nothing gates on ``Bot.plan_id``: both
``plan_entitlements_service.get_entitlements`` (account view) and
``get_bot_entitlements`` (per-bot view) resolve the governing plan from the
``subscriptions`` table via ``_compute``, never from this column. The only
reader is ``subscription_routes`` for display, so stale values misreport a plan
name in the dashboard rather than granting or denying anything.

Scope, deliberately minimal: this repairs the DENORMALIZATION ONLY. It copies
the plan from the subscription each bot already points at, and never re-decides
*which* subscription funds a bot. Bots with no ``subscription_id`` are skipped
untouched: NULL is the legitimate state for the single Free bot and for
legacy-pooled bots, so stamping them would invent funding that does not exist.

Usage:
    cd api && uv run python scripts/backfill_bot_plan_id.py
    cd api && uv run python scripts/backfill_bot_plan_id.py --bot-id 13
    cd api && uv run python scripts/backfill_bot_plan_id.py --bot-id 13 --execute
    cd api && uv run python scripts/backfill_bot_plan_id.py --execute
"""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.db.models import Bot, Plan, Subscription  # noqa: E402
from app.db.session import get_session  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--execute", action="store_true", help="Write the corrected plan ids (default: dry run).")
    parser.add_argument(
        "--bot-id",
        type=int,
        default=None,
        help="Restrict to a single bot id (pilot one row before a full pass).",
    )
    args = parser.parse_args()

    drifted: list[tuple[int, str, str, str]] = []
    with get_session() as session:
        query = session.query(Bot).filter(Bot.subscription_id.isnot(None))
        if args.bot_id is not None:
            query = query.filter(Bot.id == args.bot_id)
        bots = query.order_by(Bot.id).all()

        if args.bot_id is not None and not bots:
            print(f"Bot {args.bot_id} not found, or it has no subscription_id (nothing to sync).")
            return 1

        for bot in bots:
            subscription = session.get(Subscription, bot.subscription_id)
            if subscription is None or subscription.plan_id is None:
                # A SET NULL cascade can outrun this script; nothing to copy from.
                continue
            if bot.plan_id == subscription.plan_id:
                continue

            def _slug(plan_id: int | None) -> str:
                if plan_id is None:
                    return "NULL"
                plan = session.get(Plan, plan_id)
                return f"{plan.slug} ({plan_id})" if plan else f"?? ({plan_id})"

            drifted.append((bot.id, bot.name or "(unnamed)", _slug(bot.plan_id), _slug(subscription.plan_id)))
            if args.execute:
                bot.plan_id = subscription.plan_id

        if args.execute and drifted:
            session.commit()

    scope = f"bot {args.bot_id}" if args.bot_id is not None else f"{len(bots)} subscribed bots"
    if not drifted:
        print(f"Checked {scope}: already consistent, nothing to do.")
        return 0

    verb = "Corrected" if args.execute else "Would correct"
    print(f"{verb} {len(drifted)} of {scope}:\n")
    print(f"{'BOT':>6}  {'NAME':<28} {'STORED':<22} → {'SUBSCRIPTION':<22}")
    for bot_id, name, stored, actual in drifted:
        print(f"{bot_id:>6}  {name[:28]:<28} {stored:<22} → {actual:<22}")
    if not args.execute:
        print("\nDry run. Re-run with --execute to write these values.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
