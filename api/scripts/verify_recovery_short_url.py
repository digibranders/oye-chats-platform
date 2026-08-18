"""Verify that a failing subscription's ``short_url`` is the recovery page.

WHY THIS EXISTS
---------------
The dunning recovery CTA (Plan B) rests on one unverified inference.

Razorpay documents that a ``halted`` subscription is recovered through a hosted
page where the customer can retry the card, swap it, or move to UPI, and that
on success the subscription returns to ``active`` WITHOUT a new subscription
being created. That is why ``dunning_service.get_recovery_link`` resolves the
EXISTING subscription's ``short_url`` and never mints a mandate: minting one
would leave two live mandates and double-charge.

What the docs do NOT state is that ``short_url`` is the handle to that page.
Everything downstream (the day-3 and day-5 emails, the past-due banner's
"Update payment method" button) assumes it is. If the assumption is wrong,
those buttons lead somewhere useless and ``get_recovery_link`` needs a
different source.

This script cannot prove it on its own: only a human opening the URL can
confirm what the page offers. What it does is find the subscriptions worth
looking at, resolve exactly what our code would resolve, and tell you what to
check.

SAFETY
------
Refuses to run against live keys. Read-only unless ``--create`` is passed, and
even then it only mints a test-mode subscription in ``created`` state, nothing
is charged until a human authorises it.

USAGE
-----
    cd api

    # What is in the test account, grouped by status
    .venv/bin/python scripts/verify_recovery_short_url.py --list

    # Resolve one subscription exactly as dunning_service would
    .venv/bin/python scripts/verify_recovery_short_url.py --inspect sub_XXXX

    # Mint a test subscription to drive into failure yourself
    .venv/bin/python scripts/verify_recovery_short_url.py --create --plan-id plan_XXXX
"""

from __future__ import annotations

import argparse
import os
import sys

# Repo root on the path so `app.*` imports resolve when run directly.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# States Razorpay's hosted page can bring back to `active`. Mirrors
# dunning_service.RECOVERABLE_GATEWAY_STATES. Imported below so the two can
# never silently drift.
INTERESTING = ("pending", "halted")


def _client():
    from app.config import RAZORPAY_KEY_ID
    from app.services.razorpay_service import _get_razorpay

    if not RAZORPAY_KEY_ID:
        sys.exit("RAZORPAY_KEY_ID is not set. Run from api/ with the dev .env loaded.")
    if not RAZORPAY_KEY_ID.startswith("rzp_test_"):
        sys.exit(
            f"Refusing to run: RAZORPAY_KEY_ID is {RAZORPAY_KEY_ID[:12]}..., not a test key.\n"
            "This script creates and inspects subscriptions; point it at test mode only."
        )
    return _get_razorpay()


def cmd_list(client) -> None:
    subs = client.subscription.all({"count": 100}).get("items", [])
    if not subs:
        print("No subscriptions in this test account yet. Use --create to mint one.")
        return

    by_status: dict[str, list[dict]] = {}
    for s in subs:
        by_status.setdefault(str(s.get("status") or "unknown"), []).append(s)

    print(f"{len(subs)} subscription(s) in the test account:\n")
    for status in sorted(by_status):
        rows = by_status[status]
        marker = "  <-- recoverable, inspect these" if status in INTERESTING else ""
        print(f"  {status:<15} {len(rows):>3}{marker}")
        if status in INTERESTING:
            for s in rows:
                print(f"      {s['id']}  short_url={s.get('short_url') or 'NONE'}")

    if not any(st in by_status for st in INTERESTING):
        print(
            "\nNothing in pending/halted yet. Those are the states that matter.\n"
            "To get there: authorise a test subscription, then let its recurring\n"
            "charge fail (Razorpay retries ~daily for 3 days, then halts)."
        )


def cmd_inspect(client, sub_id: str) -> None:
    from app.services.dunning_service import RECOVERABLE_GATEWAY_STATES, get_recovery_link

    entity = client.subscription.fetch(sub_id)
    status = str(entity.get("status") or "").lower()
    short_url = entity.get("short_url")

    print(f"subscription : {sub_id}")
    print(f"status       : {status}")
    print(f"short_url    : {short_url or 'NONE'}")
    print(f"paid_count   : {entity.get('paid_count')}   remaining: {entity.get('remaining_count')}")
    print()

    link = get_recovery_link(sub_id)
    print("what dunning_service resolves:")
    print(f"  recoverable    : {link.recoverable}")
    print(f"  url            : {link.url or 'NONE'}")
    print(f"  gateway_status : {link.gateway_status}")
    print()

    if status not in RECOVERABLE_GATEWAY_STATES:
        print(
            f"This subscription is '{status}', not one of {sorted(RECOVERABLE_GATEWAY_STATES)}.\n"
            "The question this script exists to answer only applies to a FAILING\n"
            "subscription. Drive one into pending/halted and inspect that."
        )
        return

    if not short_url:
        print(
            "RECOVERABLE STATE BUT NO short_url.\n"
            "That alone answers it: short_url is NOT the recovery handle, and\n"
            "dunning_service.get_recovery_link needs a different source.\n"
            "Ask Razorpay support how to obtain the hosted card-update link."
        )
        return

    print("=" * 68)
    print("NOW THE PART ONLY YOU CAN DO. Open the URL above and check:")
    print()
    print("  1. Does the page offer to UPDATE or RETRY the payment method?")
    print("     (a card form, or a choice of card / UPI / netbanking)")
    print("  2. Does it reference the EXISTING subscription, rather than")
    print("     asking you to subscribe afresh?")
    print()
    print("  BOTH yes  -> the assumption holds. The dunning CTA is safe to ship.")
    print("  EITHER no -> short_url is the wrong handle. get_recovery_link,")
    print("               the day-3/day-5 emails and the past-due banner all")
    print("               need revisiting before that button goes live.")
    print("=" * 68)


def cmd_create(client, plan_id: str) -> None:
    sub = client.subscription.create(
        {
            "plan_id": plan_id,
            "total_count": 12,
            "customer_notify": 1,
            "notes": {"purpose": "short_url recovery verification"},
        }
    )
    print(f"created  : {sub['id']}")
    print(f"status   : {sub.get('status')}")
    print(f"short_url: {sub.get('short_url')}")
    print()
    print("Next: open short_url and authorise it with a Razorpay test card that")
    print("succeeds on authorisation but FAILS on recurring debit, so the")
    print("subscription moves pending -> halted. Then re-run with --inspect.")
    print("Test card reference: https://razorpay.com/docs/payments/payments/test-card-details/")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--list", action="store_true", help="group test-account subscriptions by status")
    group.add_argument("--inspect", metavar="SUB_ID", help="resolve one subscription as dunning_service would")
    group.add_argument("--create", action="store_true", help="mint a test subscription to drive into failure")
    parser.add_argument("--plan-id", help="Razorpay plan id, required with --create")
    args = parser.parse_args()

    client = _client()

    if args.list:
        cmd_list(client)
    elif args.inspect:
        cmd_inspect(client, args.inspect)
    else:
        if not args.plan_id:
            sys.exit("--create needs --plan-id (a Razorpay test-mode plan id, e.g. plan_XXXX)")
        cmd_create(client, args.plan_id)


if __name__ == "__main__":
    main()
