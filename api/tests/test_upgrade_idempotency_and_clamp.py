"""Phase 5 — findings D and F.

D: a sequential double-submit of a paid→paid upgrade must reuse the in-flight
   checkout, not mint a second Razorpay subscription (double first-cycle charge).
F: the rollover credit re-granted at activation must be clamped to what the
   customer ACTUALLY had left, not the click-time snapshot.
"""

import os

import pytest

from app.db.models import Client, Plan, Subscription
from app.services import credit_service, transition_service

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")


def _setup(db, credits=0):
    client = Client(name="Up", email=f"up-{credits}@test.local", hashed_password="x", api_key=f"k-up-{credits}")
    db.add(client)
    db.flush()
    old = Plan(name="Starter", slug="starter", monthly_price_cents=179900, currency="INR", is_active=True)
    new = Plan(name="Standard", slug="standard", monthly_price_cents=459900, currency="INR", is_active=True)
    db.add_all([old, new])
    db.flush()
    if credits:
        credit_service.grant_plan_credits(db, client.id, credits)
    sub = Subscription(client_id=client.id, plan_id=old.id, status="active", razorpay_subscription_id="sub_old")
    db.add(sub)
    db.flush()
    return client, sub, new


# ── D: upgrade double-submit idempotency ─────────────────────────────────────


def test_second_upgrade_reuses_pending_checkout(db, monkeypatch):
    client, sub, new = _setup(db)
    created = []

    def fake_create(session, c, plan, cycle, extra_notes=None):
        sub_id = f"sub_new_{len(created) + 1}"
        created.append(sub_id)
        return {"subscription_id": sub_id, "key_id": "k"}

    def fake_rebuild(subscription_id, c, plan, cycle):
        return {"subscription_id": subscription_id, "reused": True}

    monkeypatch.setattr("app.services.razorpay_service.create_subscription", fake_create)
    monkeypatch.setattr("app.services.razorpay_service.rebuild_upgrade_checkout", fake_rebuild)

    p1 = transition_service.execute_paid_upgrade(db, client, sub, new, "monthly")
    db.commit()
    p2 = transition_service.execute_paid_upgrade(db, client, sub, new, "monthly")
    db.commit()

    assert len(created) == 1, "second upgrade must NOT mint a second Razorpay subscription"
    assert p1["subscription_id"] == "sub_new_1"
    assert p2 == {"subscription_id": "sub_new_1", "reused": True}
    assert sub.upgrade_pending_subscription_id == "sub_new_1"
    assert sub.upgrade_pending_plan_id == new.id


def test_upgrade_to_different_plan_supersedes(db, monkeypatch):
    client, sub, new = _setup(db)
    third = Plan(name="Pro", slug="pro", monthly_price_cents=999900, currency="INR", is_active=True)
    db.add(third)
    db.flush()
    created = []

    def fake_create(session, c, plan, cycle, extra_notes=None):
        sub_id = f"sub_{plan.slug}"
        created.append(sub_id)
        return {"subscription_id": sub_id}

    monkeypatch.setattr("app.services.razorpay_service.create_subscription", fake_create)
    monkeypatch.setattr(
        "app.services.razorpay_service.rebuild_upgrade_checkout",
        lambda *a, **k: pytest.fail("must not reuse for a different target plan"),
    )

    transition_service.execute_paid_upgrade(db, client, sub, new, "monthly")
    db.commit()
    transition_service.execute_paid_upgrade(db, client, sub, third, "monthly")  # different target
    db.commit()

    assert created == ["sub_standard", "sub_pro"]
    assert sub.upgrade_pending_plan_id == third.id


def test_dead_pending_checkout_is_reminted(db, monkeypatch):
    """M3: if the pending checkout is abandoned/expired (rebuild returns None),
    execute_paid_upgrade must clear the stale marker and mint a fresh one instead
    of handing back a dead checkout."""
    client, sub, new = _setup(db)
    sub.upgrade_pending_subscription_id = "sub_dead"
    sub.upgrade_pending_plan_id = new.id
    db.flush()
    created = []

    def fake_create(session, c, plan, cycle, extra_notes=None):
        created.append(f"sub_fresh_{len(created) + 1}")
        return {"subscription_id": created[-1]}

    monkeypatch.setattr("app.services.razorpay_service.create_subscription", fake_create)
    monkeypatch.setattr("app.services.razorpay_service.rebuild_upgrade_checkout", lambda *a, **k: None)  # dead

    result = transition_service.execute_paid_upgrade(db, client, sub, new, "monthly")
    db.commit()

    assert created == ["sub_fresh_1"]  # re-minted
    assert result["subscription_id"] == "sub_fresh_1"
    assert sub.upgrade_pending_subscription_id == "sub_fresh_1"  # marker refreshed


def test_activation_clears_pending_marker(db):
    client, sub, new = _setup(db)
    sub.upgrade_pending_subscription_id = "sub_new_1"
    sub.upgrade_pending_plan_id = new.id
    sub.upgrade_credit_pending_cents = 0
    db.flush()
    sub.status = "canceled"  # retired as the new sub activates
    db.flush()
    new_sub = Subscription(client_id=client.id, plan_id=new.id, status="active", razorpay_subscription_id="sub_new_1")
    db.add(new_sub)
    db.flush()

    transition_service.apply_pending_proration(db, new_sub, prev_razorpay_subscription_id="sub_old")
    assert sub.upgrade_pending_subscription_id is None
    assert sub.upgrade_pending_plan_id is None


# ── F: rollover clamp ────────────────────────────────────────────────────────


def test_rollover_clamped_to_live_remaining(db):
    client, sub, new = _setup(db, credits=5000)
    sub.upgrade_credit_pending_cents = 5000  # snapshot at click
    db.flush()
    # Customer spends 2000 between click and activation → 3000 live.
    credit_service.check_and_deduct(db, client.id, 2000, reason="ai_chat")
    sub.status = "canceled"  # retired as the new sub activates
    db.flush()
    new_sub = Subscription(client_id=client.id, plan_id=new.id, status="active", razorpay_subscription_id="sub_new_1")
    db.add(new_sub)
    db.flush()

    applied = transition_service.apply_pending_proration(
        db,
        new_sub,
        prev_razorpay_subscription_id="sub_old",
        live_remaining=transition_service.remaining_plan_credits(db, client.id),
    )
    assert applied == 3000, "must clamp to the 3000 actually remaining, not the 5000 snapshot"


def test_no_clamp_uses_full_snapshot(db):
    client, sub, new = _setup(db, credits=5000)
    sub.upgrade_credit_pending_cents = 5000  # old sub keeps razorpay_subscription_id="sub_old"
    sub.status = "canceled"  # retired as the new sub activates
    db.flush()
    new_sub = Subscription(client_id=client.id, plan_id=new.id, status="active", razorpay_subscription_id="sub_new2")
    db.add(new_sub)
    db.flush()
    # Legacy callers pass no live_remaining → full snapshot (prior behaviour).
    applied = transition_service.apply_pending_proration(db, new_sub, prev_razorpay_subscription_id="sub_old")
    assert applied == 5000
