"""Razorpay subscription smoke test — end-to-end with test keys.

Tests the full subscription lifecycle:
  1. Create a Razorpay subscription via razorpay_service
  2. Simulate a ``subscription.activated`` webhook → local DB row created
  3. Verify credits were granted
  4. Replay the same webhook → idempotent (credits granted exactly once)

Prerequisites:
  - RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET set to test (rzp_test_*) keys
  - RAZORPAY_WEBHOOK_SECRET set (any string; we compute the HMAC locally)
  - DATABASE_URL pointing at a running Postgres (with migrations applied)
  - A Plan row exists with a valid razorpay_monthly_plan_id (or pass --plan-id)
  - A Client row exists (or pass --client-id; defaults to id=1)

Usage:

    cd platform/api
    python scripts/razorpay_subscription_smoke_test.py
    python scripts/razorpay_subscription_smoke_test.py --client-id 3 --plan-id 2

This script is dev-only — never run against production keys.
"""

from __future__ import annotations

import argparse
import hashlib
import hmac as _hmac
import json
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from dotenv import load_dotenv  # noqa: E402

load_dotenv(ROOT / ".env")


def _ok(msg: str) -> None:
    print(f"\033[32m✓ {msg}\033[0m")


def _info(msg: str) -> None:
    print(f"\033[36m{msg}\033[0m")


def _bail(msg: str) -> None:
    print(f"\033[31m✗ {msg}\033[0m", file=sys.stderr)
    sys.exit(1)


def _require_env(name: str) -> str:
    val = os.getenv(name)
    if not val:
        _bail(f"{name} must be set in .env")
    return val


def _make_webhook_payload(sub: dict, *, event_id: str) -> tuple[bytes, str]:
    """Build a signed subscription.activated webhook payload from a live sub dict."""
    now = int(time.time())
    event = {
        "entity": "event",
        "event": "subscription.activated",
        "contains": ["subscription"],
        "payload": {
            "subscription": {
                "entity": {
                    "id": sub["id"],
                    "plan_id": sub["plan_id"],
                    "status": "active",
                    "quantity": sub.get("quantity", 1),
                    "total_count": sub.get("total_count", 12),
                    "paid_count": 1,
                    "customer_id": sub.get("customer_id") or "cust_smoke_test",
                    "current_start": now,
                    "current_end": now + 30 * 86400,
                    "notes": sub.get("notes", {}),
                }
            }
        },
    }
    raw = json.dumps(event, separators=(",", ":")).encode()
    secret = _require_env("RAZORPAY_WEBHOOK_SECRET")
    sig = _hmac.new(secret.encode(), raw, hashlib.sha256).hexdigest()
    return raw, sig


def main() -> None:
    parser = argparse.ArgumentParser(description="Razorpay subscription smoke test")
    parser.add_argument("--client-id", type=int, default=1)
    parser.add_argument("--plan-id", type=int, default=None, help="OyeChats Plan.id to subscribe to")
    args = parser.parse_args()

    key_id = _require_env("RAZORPAY_KEY_ID")
    key_secret = _require_env("RAZORPAY_KEY_SECRET")
    if not key_id.startswith("rzp_test_"):
        _bail(f"Refusing to run: {key_id!r} is not a test key (must start with 'rzp_test_')")

    import razorpay
    from sqlalchemy import create_engine
    from sqlalchemy.orm import Session

    from app.db.models import CreditLedger, Plan, Subscription

    db_url = _require_env("DATABASE_URL")
    engine = create_engine(db_url, echo=False)

    # ── Step 1: Resolve plan ─────────────────────────────────────────────────
    _info("\n[1/5] Resolving plan…")
    with Session(engine) as session:
        if args.plan_id:
            plan = session.get(Plan, args.plan_id)
        else:
            plan = session.query(Plan).filter(Plan.is_active.is_(True), Plan.monthly_price_cents > 0).first()

        if not plan:
            _bail("No active paid plan found. Seed one or pass --plan-id.")

        rzp_plan_id = plan.razorpay_monthly_plan_id
        if not rzp_plan_id:
            _bail(
                f"Plan '{plan.name}' (id={plan.id}) has no razorpay_monthly_plan_id. "
                "Run scripts/set_razorpay_plan_ids.py first, or pass --plan-id for a plan that already has one."
            )
        plan_db_id = plan.id
        plan_name = plan.name
        credits_per_month = int(plan.credits_per_month or 0)

    _ok(f"Plan: {plan_name} (id={plan_db_id}) → Razorpay plan {rzp_plan_id}")

    # ── Step 2: Create Razorpay subscription via SDK ─────────────────────────
    _info("\n[2/5] Creating Razorpay subscription…")
    rzp_client = razorpay.Client(auth=(key_id, key_secret))
    sub = rzp_client.subscription.create(
        data={
            "plan_id": rzp_plan_id,
            "total_count": 12,
            "quantity": 1,
            "customer_notify": 0,
            "notes": {
                "oyechats_client_id": str(args.client_id),
                "oyechats_plan_id": str(plan_db_id),
                "smoke_test": "true",
            },
        }
    )
    sub_id = sub["id"]
    _ok(f"Subscription created: {sub_id} (status={sub['status']})")

    # ── Step 3: Simulate subscription.activated webhook ──────────────────────
    _info("\n[3/5] Simulating subscription.activated webhook (first delivery)…")
    event_id = f"evt_smoke_{int(time.time())}"
    raw_payload, signature = _make_webhook_payload(sub, event_id=event_id)

    with Session(engine) as session:
        from app.services.razorpay_service import handle_webhook_event

        event = json.loads(raw_payload)
        result = handle_webhook_event(session, event, event_id)
        session.commit()
    _ok(f"Webhook result: {result}")

    # ── Step 4: Verify local DB row + credits ────────────────────────────────
    _info("\n[4/5] Verifying local subscription row and credit grant…")
    with Session(engine) as session:
        local_sub = session.query(Subscription).filter(Subscription.razorpay_subscription_id == sub_id).first()
        if not local_sub:
            _bail(f"No local Subscription row found for {sub_id}")
        _ok(f"Subscription row: id={local_sub.id}, status={local_sub.status}, client_id={local_sub.client_id}")

        credit_rows = (
            session.query(CreditLedger)
            .filter(
                CreditLedger.client_id == local_sub.client_id,
                CreditLedger.description.like(f"%{sub_id}%"),
            )
            .all()
        )
        total_granted = sum(r.delta for r in credit_rows)
        _ok(f"Credits granted: {total_granted} (expected {credits_per_month})")
        if total_granted != credits_per_month:
            print(f"\033[33m  ⚠ Mismatch — check plan.credits_per_month ({credits_per_month})\033[0m")

    # ── Step 5: Idempotency — replay the same webhook ────────────────────────
    _info("\n[5/5] Replaying the same webhook (must be a no-op)…")
    with Session(engine) as session:
        result2 = handle_webhook_event(session, event, event_id)
        session.commit()
    _ok(f"Replay result: {result2}")

    with Session(engine) as session:
        credit_rows2 = (
            session.query(CreditLedger)
            .filter(
                CreditLedger.client_id == args.client_id,
                CreditLedger.description.like(f"%{sub_id}%"),
            )
            .all()
        )
        total_after_replay = sum(r.delta for r in credit_rows2)
        if total_after_replay != total_granted:
            _bail(f"Idempotency FAILED — credits changed after replay: {total_granted} → {total_after_replay}")
        _ok(f"Idempotent — credits unchanged after replay ({total_after_replay})")

    print("\n\033[32m── Razorpay subscription smoke test PASSED ──\033[0m")
    print(f"  Subscription: {sub_id}")
    print(f"  Local sub id: {local_sub.id}")
    print(f"  Credits: {total_granted}")
    print("\nClean up: cancel this test subscription in your Razorpay dashboard (Test Mode → Subscriptions).")


if __name__ == "__main__":
    main()
