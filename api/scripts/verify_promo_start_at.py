#!/usr/bin/env python3
"""Verify Razorpay ``start_at`` (deferred-charge) behaviour for the launch promo.

WHY THIS EXISTS
---------------
The "sign up this month, 3 months free" offer defers a subscription's first
charge with a future ``start_at``. Two things must be true for the design in
``docs/launch-offer-3-months-free-plan.md`` (§4) to hold, and both depend on
Razorpay behaviour we can only confirm live:

  1. **Which event fires at authorisation?** Entitlements are granted in
     ``_handle_subscription_activated`` (``subscription.activated``). If a
     deferred sub only fires ``subscription.authenticated`` at auth and delays
     ``activated`` until ``start_at``, we must grant on ``authenticated`` too.
     Otherwise a customer gets *no access* for the whole free period.

  2. **What period does Razorpay report?** ``current_start`` / ``current_end`` /
     ``charge_at`` on a deferred sub decide how the credit-refresh cadence
     during the free months must be built (there are no ``subscription.charged``
     events until ``start_at``).

KEY INSIGHT, no webhook tunnel needed
--------------------------------------
Razorpay subscription ``status`` transitions map 1:1 to the webhooks:
    created        -> (awaiting auth)
    authenticated  -> fires ``subscription.authenticated``
    active         -> fires ``subscription.activated``
So polling ``subscription.fetch`` and watching ``status`` tells us exactly which
event the app would receive, and when. This script creates one deferred test
subscription, prints the authorise link, and polls the entity. Printing every
field the design decision turns on, plus a plain-English verdict.

SAFETY
------
* Refuses to run against a **live** key (``rzp_live_...``) unless ``--force``.
* Only creates a subscription in Razorpay **test** mode, no real money moves.
* Read-only after creation (fetch + list invoices). Does not touch the app DB.

USAGE
-----
    cd api
    # Card rail:
    uv run python scripts/verify_promo_start_at.py --free-minutes 10
    # then open the printed authorise URL and pay with a Razorpay TEST card.

    # UPI Autopay rail (repeat separately):
    uv run python scripts/verify_promo_start_at.py --free-minutes 10
    # then authorise with a Razorpay TEST UPI id in the hosted page.

Run it once per rail (card, then UPI) and record, for each:
  * the status observed immediately after you authorise (authenticated vs active),
  * whether current_start / current_end / charge_at are populated,
  * whether any invoice was created at auth (a ₹1-ish validation debit),
  * the status flip when start_at is reached (the deferred first charge).
"""

from __future__ import annotations

import argparse
import sys
import time
from datetime import UTC, datetime, timedelta, timezone

# Best-effort .env load so RAZORPAY_* are populated exactly as the app sees them.
try:  # python-dotenv is a dev dependency; tolerate its absence.
    from dotenv import load_dotenv

    load_dotenv()
except Exception:  # Env may already be exported; never fail here.  # noqa: BLE001
    pass

from app.config import RAZORPAY_KEY_ID, RAZORPAY_TEST_PLAN_ID  # noqa: E402
from app.services.razorpay_service import _get_razorpay  # noqa: E402

IST = timezone(timedelta(hours=5, minutes=30), name="IST")

# Fields whose values drive the §4 design decisions. Printed every poll.
_WATCH_FIELDS = (
    "status",
    "current_start",
    "current_end",
    "charge_at",
    "start_at",
    "paid_count",
    "remaining_count",
)

# status -> the webhook the app would receive on entering that status.
_STATUS_TO_EVENT = {
    "created": "(none. Created, awaiting authorisation)",
    "authenticated": "subscription.authenticated  ← NOT currently handled by the app",
    "active": "subscription.activated  ← grants entitlements today",
    "pending": "subscription.pending  (mandate pending / retry)",
    "halted": "subscription.halted",
    "completed": "subscription.completed",
    "cancelled": "subscription.cancelled",
    "expired": "(expired)",
}


def _fmt_epoch(value: object) -> str:
    """Render a Razorpay epoch-seconds field as UTC + IST, or '-' when unset."""
    if not value:
        return "-"
    try:
        dt = datetime.fromtimestamp(int(value), tz=UTC)
    except (TypeError, ValueError, OverflowError):
        return f"?({value!r})"
    return f"{dt.isoformat()}  /  {dt.astimezone(IST).strftime('%Y-%m-%d %H:%M IST')}"


def _row(sub: dict) -> str:
    parts = []
    for field in _WATCH_FIELDS:
        raw = sub.get(field)
        if field in ("current_start", "current_end", "charge_at", "start_at"):
            parts.append(f"{field}={_fmt_epoch(raw)}")
        else:
            parts.append(f"{field}={raw}")
    return "\n    ".join(parts)


def _list_invoice_summaries(client, sub_id: str) -> list[str]:
    """Return short summaries of any invoices raised for the subscription.

    An invoice appearing at authorisation time (before ``start_at``) is the
    signal that Razorpay took a validation debit, the UI copy must then say
    "you may see a ₹1 verification charge that's refunded", not "₹0 today".
    """
    try:
        resp = client.invoice.all({"subscription_id": sub_id, "count": 20})
    except Exception as exc:  # Invoice listing is diagnostic only.  # noqa: BLE001
        return [f"(could not list invoices: {exc})"]
    out = []
    for inv in resp.get("items", []):
        out.append(
            f"invoice {inv.get('id')}: status={inv.get('status')} "
            f"amount={inv.get('amount')} {inv.get('currency')} "
            f"paid_at={_fmt_epoch(inv.get('paid_at'))} issued_at={_fmt_epoch(inv.get('issued_at'))}"
        )
    return out or ["(no invoices raised yet)"]


def _guard_test_mode(force: bool) -> None:
    key = RAZORPAY_KEY_ID or ""
    if key.startswith("rzp_live_") and not force:
        sys.exit(
            "REFUSING to run against a LIVE Razorpay key "
            f"({key[:12]}…). This script creates a subscription. "
            "Use test keys, or pass --force if you truly mean to."
        )
    if not key:
        sys.exit("RAZORPAY_KEY_ID is not set. Configure test keys in .env first.")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument(
        "--plan",
        default=RAZORPAY_TEST_PLAN_ID,
        help="Razorpay TEST plan id (defaults to RAZORPAY_TEST_PLAN_ID). Use a ₹1/month recurring plan.",
    )
    parser.add_argument(
        "--free-minutes",
        type=int,
        default=10,
        help="Minutes until the first charge (stand-in for the 3-month free period). Default 10.",
    )
    parser.add_argument("--cycles", type=int, default=5, help="total_count (billing cycles). Default 5.")
    parser.add_argument("--interval", type=int, default=15, help="Poll interval seconds. Default 15.")
    parser.add_argument("--duration", type=int, default=20, help="Total polling window minutes. Default 20.")
    parser.add_argument("--no-poll", action="store_true", help="Create + print the authorise link, then exit.")
    parser.add_argument("--force", action="store_true", help="Allow running against a live key (dangerous).")
    args = parser.parse_args()

    _guard_test_mode(args.force)
    if not args.plan:
        sys.exit("No plan id. Pass --plan <rzp_plan_id> or set RAZORPAY_TEST_PLAN_ID (a ₹1/month recurring plan).")

    client = _get_razorpay()
    start_at = int((datetime.now(UTC) + timedelta(minutes=args.free_minutes)).timestamp())

    print("=" * 78)
    print("Razorpay start_at (deferred-charge) verification")
    print("=" * 78)
    print(
        f"key            : {RAZORPAY_KEY_ID[:12]}… (mode: {'TEST' if '_test_' in (RAZORPAY_KEY_ID or '') else 'LIVE'})"
    )
    print(f"plan           : {args.plan}")
    print(f"start_at       : {_fmt_epoch(start_at)}  (+{args.free_minutes} min)")
    print(f"total_count    : {args.cycles}")

    try:
        sub = client.subscription.create(
            {
                "plan_id": args.plan,
                "total_count": args.cycles,
                "customer_notify": 1,
                "quantity": 1,
                "start_at": start_at,
                "notes": {"purpose": "promo_start_at_verification", "oyechats_env": "verification"},
            }
        )
    except Exception as exc:  # Surface the gateway error verbatim.  # noqa: BLE001
        sys.exit(f"subscription.create failed: {exc}")

    sub_id = sub["id"]
    print(f"\nsubscription   : {sub_id}")
    print(f"AUTHORISE HERE : {sub.get('short_url')}")
    print("\nInitial entity:")
    print("    " + _row(sub))
    print("\n→ Open the AUTHORISE link and complete the mandate (TEST card, then re-run for TEST UPI).")
    print("→ Watch the 'status' below the moment you finish authorising:")
    print("      status=authenticated  → app would need to grant on subscription.authenticated")
    print("      status=active         → the existing subscription.activated grant already fires")

    if args.no_poll:
        print("\n--no-poll set; exiting. Re-fetch later with the id above.")
        return 0

    print("\n" + "-" * 78)
    print(f"Polling every {args.interval}s for up to {args.duration} min (Ctrl-C to stop)…")
    print("-" * 78)

    deadline = datetime.now(UTC) + timedelta(minutes=args.duration)
    last_status: str | None = sub.get("status")
    while datetime.now(UTC) < deadline:
        time.sleep(args.interval)
        try:
            sub = client.subscription.fetch(sub_id)
        except Exception as exc:  # Keep polling through transient errors.  # noqa: BLE001
            print(f"  [{datetime.now(IST):%H:%M:%S}] fetch error: {exc}")
            continue

        stamp = datetime.now(IST).strftime("%H:%M:%S")
        status = sub.get("status")
        print(f"\n[{stamp}]\n    " + _row(sub))

        if status != last_status:
            print(f"  ►► STATUS CHANGED: {last_status} → {status}")
            print(f"     webhook the app would receive: {_STATUS_TO_EVENT.get(status, '(unknown)')}")
            for line in _list_invoice_summaries(client, sub_id):
                print(f"     {line}")
            last_status = status

        # Terminal-ish states worth stopping on once start_at has passed.
        if status in ("active", "completed", "cancelled", "expired") and int(time.time()) >= start_at:
            print(f"\nReached '{status}' at/after start_at, the deferred first charge has resolved. Done.")
            break

    print("\n" + "=" * 78)
    print("RECORD FOR THE PLAN (§4), per rail (card / UPI):")
    print("  1. status immediately AFTER you authorised (authenticated vs active)")
    print("  2. were current_start / current_end / charge_at populated at auth?")
    print("  3. any invoice raised at auth? (validation debit → adjust checkout copy)")
    print("  4. status flip when start_at hit (the deferred first charge)")
    print("=" * 78)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
