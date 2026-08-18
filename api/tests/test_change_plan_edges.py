"""Wave 4a: the change-plan/checkout edges that silently misbehaved.

* ``coupon_code`` was accepted at checkout and silently IGNORED, the customer
  believed a discount applied and was charged full price. Unknown/inactive
  codes now 400; valid codes 400 with an honest "not redeemable online"
  message until a redemption realiser exists (product default: kill, not wire).
* An equal-price plan change matched neither the upgrade (``>``) nor the
  downgrade (``<``) branch and fell through to Branch 3, a FRESH checkout
  that minted a second mandate and immediately gateway-cancelled the old one,
  eating the customer's remaining paid days. Now an explicit 409.
* A monthly↔annual switch on the SAME plan was rejected as "You are already on
  this plan" (plan-id equality). Now routed by cycle: monthly→annual is an
  upgrade-now, annual→monthly schedules at period end.
* A cancel-pending customer re-picking their own plan (trying to STAY) got the
  same 400. Now a 409 ``resume_required`` hand-off to the Reactivate flow.
"""

import os
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from unittest.mock import patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api import subscription_routes
from app.api.auth import get_current_client_strict, require_verified_email
from app.db.models import Client, Coupon, Plan, Subscription

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")


@contextmanager
def _ctx(session):
    yield session


def _plan(db, slug="std-edges", monthly=94900) -> Plan:
    plan = Plan(
        name=slug.title(),
        slug=slug,
        monthly_price_cents=monthly,
        annual_price_cents=monthly * 10,
        credits_per_month=10_000,
        included_operator_seats=2,
        is_active=True,
        razorpay_plan_id_monthly=f"plan_{slug}_m",
        razorpay_plan_id_annual=f"plan_{slug}_a",
    )
    db.add(plan)
    db.flush()
    return plan


_IDENTITY = {
    "legal_name": "Acme Pvt Ltd",
    "billing_address": {"line1": "1 Lane", "city": "Mumbai", "postal_code": "400001"},
    "billing_state_code": "27",
    "billing_country": "IN",
}


def _mk(db, monkeypatch, **client_kw):
    defaults = {"name": "E", "email": "edges@test.example", "api_key": "key-edges", **_IDENTITY}
    defaults.update(client_kw)
    client = Client(**defaults)
    db.add(client)
    db.flush()
    monkeypatch.setattr(subscription_routes, "get_session", lambda: _ctx(db))
    monkeypatch.setattr(subscription_routes, "resolve_country", lambda request: None)
    monkeypatch.setattr(subscription_routes, "RAZORPAY_ENABLED", True)
    app = FastAPI()
    app.include_router(subscription_routes.router)
    app.dependency_overrides[get_current_client_strict] = lambda: client
    app.dependency_overrides[require_verified_email] = lambda: client
    return TestClient(app, raise_server_exceptions=True), client


def _active_sub(db, client, plan, *, cycle="monthly", cancel_pending=False) -> Subscription:
    sub = Subscription(
        client_id=client.id,
        plan_id=plan.id,
        status="active",
        billing_cycle=cycle,
        operator_quantity=1,
        payment_provider="razorpay",
        razorpay_subscription_id=f"sub_edges_{plan.slug}_{cycle}",
        cancel_at_period_end=cancel_pending,
        current_period_end=datetime.now(UTC) + timedelta(days=20),
    )
    db.add(sub)
    db.flush()
    return sub


# ── Coupons: never silently ignored ──────────────────────────────────────────


def test_unknown_coupon_code_is_a_400(db, monkeypatch):
    api, _ = _mk(db, monkeypatch)
    plan = _plan(db)
    with patch("app.services.razorpay_service.create_subscription") as mint:
        res = api.post(
            "/subscriptions/checkout",
            json={"plan_id": plan.id, "billing_cycle": "monthly", "coupon_code": "NOTREAL"},
        )
    assert res.status_code == 400, res.text
    assert "coupon" in res.json()["detail"].lower()
    assert not mint.called  # never charge full price behind a believed discount


def test_valid_coupon_is_still_refused_honestly(db, monkeypatch):
    # A code that exists but has no online redemption realiser must refuse
    # loudly, not silently charge full price.
    api, _ = _mk(db, monkeypatch)
    plan = _plan(db)
    db.add(Coupon(code="REAL10", percent_off=10, is_active=True))
    db.flush()
    with patch("app.services.razorpay_service.create_subscription") as mint:
        res = api.post(
            "/subscriptions/checkout",
            json={"plan_id": plan.id, "billing_cycle": "monthly", "coupon_code": "REAL10"},
        )
    assert res.status_code == 400, res.text
    assert not mint.called


def test_inactive_or_expired_coupon_is_a_400(db, monkeypatch):
    api, _ = _mk(db, monkeypatch)
    plan = _plan(db)
    db.add(Coupon(code="OLD10", percent_off=10, is_active=False))
    db.add(Coupon(code="EXP10", percent_off=10, is_active=True, expires_at=datetime.now(UTC) - timedelta(days=1)))
    db.flush()
    for code in ("OLD10", "EXP10"):
        res = api.post(
            "/subscriptions/checkout",
            json={"plan_id": plan.id, "billing_cycle": "monthly", "coupon_code": code},
        )
        assert res.status_code == 400, (code, res.text)


def test_no_coupon_checks_out_normally(db, monkeypatch):
    api, _ = _mk(db, monkeypatch)
    plan = _plan(db)
    with patch(
        "app.services.razorpay_service.create_subscription",
        return_value={"subscription_id": "sub_edges_ok", "key_id": "rzp_test", "provider": "razorpay"},
    ):
        res = api.post("/subscriptions/checkout", json={"plan_id": plan.id, "billing_cycle": "monthly"})
    assert res.status_code == 200, res.text


# ── Equal-price plan change ──────────────────────────────────────────────────


def test_equal_price_plan_change_is_an_explicit_409(db, monkeypatch):
    api, client = _mk(db, monkeypatch)
    current = _plan(db, slug="edges-a", monthly=94900)
    target = _plan(db, slug="edges-b", monthly=94900)  # same price, different plan
    _active_sub(db, client, current)
    with patch("app.services.razorpay_service.create_subscription") as mint:
        res = api.post("/subscriptions/change-plan", json={"plan_id": target.id})
    assert res.status_code == 409, res.text
    assert res.json()["detail"]["code"] == "plans_equal_price"
    assert not mint.called  # the old fall-through minted a SECOND mandate


# ── Same-plan cycle switch ───────────────────────────────────────────────────


def test_monthly_to_annual_on_same_plan_routes_to_upgrade(db, monkeypatch):
    api, client = _mk(db, monkeypatch)
    plan = _plan(db, slug="edges-cycle")
    _active_sub(db, client, plan, cycle="monthly")
    with patch(
        "app.services.transition_service.execute_paid_upgrade",
        return_value={"subscription_id": "sub_edges_annual", "key_id": "rzp_test"},
    ) as upgrade:
        res = api.post("/subscriptions/change-plan", json={"plan_id": plan.id, "billing_cycle": "annual"})
    assert res.status_code == 200, res.text
    assert upgrade.called
    assert upgrade.call_args.args[-1] == "annual"  # billing_cycle threaded through


def test_annual_to_monthly_on_same_plan_schedules_downgrade(db, monkeypatch):
    api, client = _mk(db, monkeypatch)
    plan = _plan(db, slug="edges-cycle2")
    _active_sub(db, client, plan, cycle="annual")
    cutover = datetime.now(UTC) + timedelta(days=20)
    with patch("app.services.transition_service.schedule_paid_downgrade", return_value=cutover) as schedule:
        res = api.post("/subscriptions/change-plan", json={"plan_id": plan.id, "billing_cycle": "monthly"})
    assert res.status_code == 200, res.text
    assert res.json()["status"] == "downgrade_scheduled"
    assert schedule.called


def test_same_plan_same_cycle_still_a_friendly_400(db, monkeypatch):
    api, client = _mk(db, monkeypatch)
    plan = _plan(db, slug="edges-same")
    _active_sub(db, client, plan, cycle="monthly")
    res = api.post("/subscriptions/change-plan", json={"plan_id": plan.id, "billing_cycle": "monthly"})
    assert res.status_code == 400, res.text
    assert "already on this plan" in res.json()["detail"].lower()


# ── Cancel-pending re-pick ───────────────────────────────────────────────────


def test_cancel_pending_repick_hands_off_to_resume(db, monkeypatch):
    # The customer is trying to STAY on their plan. "already on this plan" was
    # a dead end. Hand off to the Reactivate flow instead.
    api, client = _mk(db, monkeypatch)
    plan = _plan(db, slug="edges-resume")
    _active_sub(db, client, plan, cycle="monthly", cancel_pending=True)
    res = api.post("/subscriptions/change-plan", json={"plan_id": plan.id, "billing_cycle": "monthly"})
    assert res.status_code == 409, res.text
    assert res.json()["detail"]["code"] == "resume_required"


# ── Wave 4 review findings ───────────────────────────────────────────────────


def test_per_bot_upgrade_threads_bot_notes_to_the_mint(db, monkeypatch):
    # P1-1: without purpose/oyechats_bot_id in the notes, the activation
    # handler sweeps the ACCOUNT row and leaves the old per-bot mandate live.
    # Double billing.
    from app.db.models import Bot
    from app.services import transition_service

    api, client = _mk(db, monkeypatch)
    lower = _plan(db, slug="edges-bot-low", monthly=44900)
    higher = _plan(db, slug="edges-bot-high", monthly=94900)
    bot = Bot(client_id=client.id, name="B", bot_key="bot-edges-up")
    db.add(bot)
    db.flush()
    sub = _active_sub(db, client, lower)
    sub.bot_id = bot.id
    db.flush()

    with patch(
        "app.services.razorpay_service.create_subscription",
        return_value={"subscription_id": "sub_edges_botup", "key_id": "rzp_test"},
    ) as mint:
        payload = transition_service.execute_paid_upgrade(db, client, sub, higher, "monthly")
    assert payload["subscription_id"] == "sub_edges_botup"
    notes = mint.call_args.kwargs["extra_notes"]
    assert notes["purpose"] == "per_bot_subscription"
    assert notes["oyechats_bot_id"] == str(bot.id)


def test_pending_upgrade_reuse_refuses_a_wrong_cycle_sub(db, monkeypatch):
    # P1-2: an abandoned ANNUAL checkout must never be handed to a customer
    # who asked for MONTHLY, the rail check treats it as dead and re-mints.
    from types import SimpleNamespace

    from app.services import razorpay_service

    plan = _plan(db, slug="edges-rail")
    client = Client(name="R", email="edges-rail@test.example", api_key="key-edges-rail", billing_country="IN")
    db.add(client)
    db.flush()

    fake = SimpleNamespace(
        subscription=SimpleNamespace(
            fetch=lambda sub_id: {"id": sub_id, "status": "created", "plan_id": "plan_edges-rail_a"}
        )
    )
    monkeypatch.setattr(razorpay_service, "_get_razorpay", lambda: fake)

    # Same rail → reusable.
    assert razorpay_service.rebuild_upgrade_checkout("sub_pending_rail", client, plan, "annual") is not None
    # Requested monthly, pending bills annual → refuse reuse.
    assert razorpay_service.rebuild_upgrade_checkout("sub_pending_rail", client, plan, "monthly") is None


def test_scheduled_downgrade_repick_points_at_cancel_scheduled_change(db, monkeypatch):
    # P2-1: schedule_paid_downgrade also sets cancel_at_period_end, so the
    # resume hand-off would resurrect the mandate while the promotion cron
    # STILL executes the abandoned downgrade. The right verb is
    # cancel-scheduled-change.
    api, client = _mk(db, monkeypatch)
    plan = _plan(db, slug="edges-sched")
    target = _plan(db, slug="edges-sched-low", monthly=44900)
    sub = _active_sub(db, client, plan, cancel_pending=True)
    sub.scheduled_plan_id = target.id
    db.flush()
    res = api.post("/subscriptions/change-plan", json={"plan_id": plan.id, "billing_cycle": "monthly"})
    assert res.status_code == 409, res.text
    assert res.json()["detail"]["code"] == "scheduled_change_pending"


def test_cancel_pending_blocks_cycle_switch_too(db, monkeypatch):
    # P2-4: a cycle switch on a sub the customer explicitly cancelled would
    # silently resurrect it. Reactivation must be its own deliberate step.
    api, client = _mk(db, monkeypatch)
    plan = _plan(db, slug="edges-ccs")
    _active_sub(db, client, plan, cycle="monthly", cancel_pending=True)
    with patch("app.services.transition_service.execute_paid_upgrade") as upgrade:
        res = api.post("/subscriptions/change-plan", json={"plan_id": plan.id, "billing_cycle": "annual"})
    assert res.status_code == 409, res.text
    assert res.json()["detail"]["code"] == "resume_required"
    assert not upgrade.called


def test_coupon_lookup_is_case_insensitive(db, monkeypatch):
    api, _ = _mk(db, monkeypatch)
    plan = _plan(db, slug="edges-coupon-case")
    db.add(Coupon(code="MixedCase10", percent_off=10, is_active=True))
    db.flush()
    res = api.post(
        "/subscriptions/checkout",
        json={"plan_id": plan.id, "billing_cycle": "monthly", "coupon_code": "mixedcase10"},
    )
    # Recognised as the REAL coupon (honest not-redeemable message), not as a typo.
    assert res.status_code == 400, res.text
    assert "redeemed online" in res.json()["detail"]
