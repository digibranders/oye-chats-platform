"""reconcile_subscription_from_razorpay must not burn its idempotency key when
the Razorpay subscription is still in a non-billable state — otherwise a too-
early verify call permanently strands the customer on their old plan (localhost
has no webhook to fall back on)."""

import os
from types import SimpleNamespace

import pytest
from sqlalchemy import select

from app.db.models import Client, Plan, ProcessedWebhook, Subscription
from app.services import razorpay_service as rzp

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")

RZP_SUB = "sub_reconcile_1"


def _setup(db, email="reconcile@test.example"):
    client = Client(name="C", email=email, api_key=f"key-{email}")
    db.add(client)
    db.flush()
    plan = Plan(name="Standard", slug=f"std-{email}", monthly_price_cents=459900, credits_per_month=10000)
    db.add(plan)
    db.flush()
    return client, plan


def _fake_rzp(status_holder, client_id, plan_id):
    def fetch(sub_id):
        return {
            "id": sub_id,
            "status": status_holder["status"],
            "current_start": 1_780_000_000,
            "current_end": 1_782_600_000,
            "quantity": 1,
            "customer_id": "cust_x",
            "notes": {
                "oyechats_client_id": str(client_id),
                "oyechats_plan_id": str(plan_id),
                "billing_cycle": "monthly",
            },
        }

    return SimpleNamespace(subscription=SimpleNamespace(fetch=fetch))


def _key_recorded(db) -> bool:
    return (
        db.execute(select(ProcessedWebhook).where(ProcessedWebhook.event_id == f"reconcile:{RZP_SUB}"))
        .scalars()
        .first()
        is not None
    )


def test_early_created_state_does_not_burn_key_then_later_succeeds(db, monkeypatch):
    client, plan = _setup(db)
    status = {"status": "created"}  # mandate not yet authorised
    monkeypatch.setattr(rzp, "_get_razorpay", lambda: _fake_rzp(status, client.id, plan.id))

    # First verify — Razorpay still 'created'. No row, and crucially no key burned.
    assert rzp.reconcile_subscription_from_razorpay(db, RZP_SUB, expected_client_id=client.id) is None
    assert rzp._resolve_local_subscription(db, RZP_SUB) is None
    assert _key_recorded(db) is False  # the fix: key NOT burned

    # Mandate clears; second verify materialises the subscription.
    status["status"] = "authenticated"
    sub = rzp.reconcile_subscription_from_razorpay(db, RZP_SUB, expected_client_id=client.id)
    assert sub is not None
    assert sub.plan_id == plan.id
    assert sub.status == "active"
    assert _key_recorded(db) is True


def test_second_billable_call_is_noop_no_double_grant(db, monkeypatch):
    client, plan = _setup(db, "reconcile-idem@test.example")
    status = {"status": "active"}
    monkeypatch.setattr(rzp, "_get_razorpay", lambda: _fake_rzp(status, client.id, plan.id))

    first = rzp.reconcile_subscription_from_razorpay(db, RZP_SUB, expected_client_id=client.id)
    assert first is not None
    # A concurrent/duplicate verify with the key already recorded → re-query only.
    again = rzp.reconcile_subscription_from_razorpay(db, RZP_SUB, expected_client_id=client.id)
    assert again.id == first.id
    subs = db.execute(select(Subscription).where(Subscription.razorpay_subscription_id == RZP_SUB)).scalars().all()
    assert len(subs) == 1  # no duplicate materialisation
