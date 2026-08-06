"""Wave 1.3 (P1-1): every route that mints a NEW Razorpay mandate runs the SAME
pre-charge gates as /checkout.

``/change-plan`` Branch 3 (trial/Free → paid, or a lapsed bot returning to
paid) and ``/resume`` Mode 2 (dead mandate → fresh subscription) created real
gateway mandates with none of /checkout's gates: no Rule 46 billing-identity
check (so the activation webhook issued an invoice with no buyer identity), no
country trust rules. The intl kill switch alone was covered — at the service
layer (Wave 2.1).

``_require_precharge_gates`` is now the shared gate; these tests pin each
refusal firing BEFORE the gateway mint (the mock must not be called — a 409
after ``subscription.create`` would strand an authorizable mandate).
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
from app.db.models import Client, Plan, Subscription

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")


@contextmanager
def _ctx(session):
    yield session


def _plan(db, slug="std-gate-parity", monthly=94900) -> Plan:
    plan = Plan(
        name="Standard",
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


_COMPLETE_IDENTITY = {
    "legal_name": "Acme Pvt Ltd",
    "billing_address": {"line1": "1 Lane", "city": "Mumbai", "postal_code": "400001"},
    "billing_state_code": "27",
    "billing_country": "IN",
}


def _mk(db, monkeypatch, *, detected=None, **client_kw):
    defaults = {"name": "Acme", "email": "gate-parity@test.example", "api_key": "key-gate-parity"}
    defaults.update(client_kw)
    client = Client(**defaults)
    db.add(client)
    db.flush()
    monkeypatch.setattr(subscription_routes, "get_session", lambda: _ctx(db))
    monkeypatch.setattr(subscription_routes, "resolve_country", lambda request: detected)
    app = FastAPI()
    app.include_router(subscription_routes.router)
    app.dependency_overrides[get_current_client_strict] = lambda: client
    app.dependency_overrides[require_verified_email] = lambda: client
    return TestClient(app, raise_server_exceptions=True), client


_CHECKOUT_PAYLOAD = {"subscription_id": "sub_gate_new", "key_id": "rzp_test", "provider": "razorpay"}


# ── /change-plan Branch 3 ────────────────────────────────────────────────────


def test_change_plan_to_paid_requires_billing_identity(db, monkeypatch):
    api, _ = _mk(db, monkeypatch)  # no identity at all
    plan = _plan(db)
    with patch("app.services.razorpay_service.create_subscription", return_value=dict(_CHECKOUT_PAYLOAD)) as mint:
        res = api.post("/subscriptions/change-plan", json={"plan_id": plan.id, "billing_cycle": "monthly"})
    assert res.status_code == 409, res.text
    assert res.json()["detail"]["code"] == "billing_details_required"
    assert not mint.called  # refused BEFORE any gateway mandate exists


def test_change_plan_intl_pending_for_stored_foreign_country(db, monkeypatch):
    # Stored foreign country + intl rail off → the same intl_usd_pending 409
    # contract as /checkout, raised at the route gate before the mint.
    identity = dict(_COMPLETE_IDENTITY, billing_country="US", billing_state_code=None)
    api, _ = _mk(db, monkeypatch, **identity)
    plan = _plan(db)
    with patch("app.services.razorpay_service.create_subscription", return_value=dict(_CHECKOUT_PAYLOAD)) as mint:
        res = api.post("/subscriptions/change-plan", json={"plan_id": plan.id, "billing_cycle": "monthly"})
    assert res.status_code == 409, res.text
    assert res.json()["detail"]["reason"] == "intl_usd_pending"
    assert not mint.called


def test_change_plan_409s_when_only_signal_is_foreign_ip(db, monkeypatch):
    api, _ = _mk(
        db, monkeypatch, detected="US", **{k: v for k, v in _COMPLETE_IDENTITY.items() if k != "billing_country"}
    )
    plan = _plan(db)
    with patch("app.services.razorpay_service.create_subscription", return_value=dict(_CHECKOUT_PAYLOAD)) as mint:
        res = api.post("/subscriptions/change-plan", json={"plan_id": plan.id, "billing_cycle": "monthly"})
    assert res.status_code == 409, res.text
    assert res.json()["detail"]["reason"] == "billing_country_required"
    assert not mint.called


def test_change_plan_with_identity_proceeds_to_checkout(db, monkeypatch):
    api, _ = _mk(db, monkeypatch, **_COMPLETE_IDENTITY)
    plan = _plan(db)
    with patch("app.services.razorpay_service.create_subscription", return_value=dict(_CHECKOUT_PAYLOAD)) as mint:
        res = api.post("/subscriptions/change-plan", json={"plan_id": plan.id, "billing_cycle": "monthly"})
    assert res.status_code == 200, res.text
    assert res.json()["status"] == "checkout_required"
    assert mint.called


# ── /resume Mode 2 ───────────────────────────────────────────────────────────


def _dead_mandate_sub(db, client, plan) -> Subscription:
    sub = Subscription(
        client_id=client.id,
        plan_id=plan.id,
        status="active",
        billing_cycle="monthly",
        operator_quantity=1,
        payment_provider="razorpay",
        razorpay_subscription_id="sub_gate_dead",
        cancel_at_period_end=True,
        canceled_at=datetime.now(UTC) - timedelta(days=1),
        gateway_cancel_executed_at=datetime.now(UTC) - timedelta(days=1),
        current_period_start=datetime.now(UTC) - timedelta(days=10),
        current_period_end=datetime.now(UTC) + timedelta(days=20),
    )
    db.add(sub)
    db.flush()
    return sub


def test_resume_mode2_requires_billing_identity(db, monkeypatch):
    api, client = _mk(db, monkeypatch)  # no identity
    plan = _plan(db)
    _dead_mandate_sub(db, client, plan)
    with patch("app.services.razorpay_service.create_subscription", return_value=dict(_CHECKOUT_PAYLOAD)) as mint:
        res = api.post("/subscriptions/resume", json={})
    assert res.status_code == 409, res.text
    assert res.json()["detail"]["code"] == "billing_details_required"
    assert not mint.called


def test_resume_mode2_with_identity_reauthorises(db, monkeypatch):
    api, client = _mk(db, monkeypatch, **_COMPLETE_IDENTITY)
    plan = _plan(db)
    _dead_mandate_sub(db, client, plan)
    with patch("app.services.razorpay_service.create_subscription", return_value=dict(_CHECKOUT_PAYLOAD)) as mint:
        res = api.post("/subscriptions/resume", json={})
    assert res.status_code == 200, res.text
    assert res.json()["mandate_action"] == "reauthorise_required"
    assert mint.called


def test_resume_mode1_skips_precharge_gates(db, monkeypatch):
    # Mode 1 mints NOTHING (it clears a flag on a live mandate) — an identity
    # gap must not block a customer from un-cancelling their own subscription.
    api, client = _mk(db, monkeypatch)  # no identity
    plan = _plan(db)
    sub = Subscription(
        client_id=client.id,
        plan_id=plan.id,
        status="active",
        billing_cycle="monthly",
        operator_quantity=1,
        payment_provider="razorpay",
        razorpay_subscription_id="sub_gate_live",
        cancel_at_period_end=True,
        canceled_at=datetime.now(UTC) - timedelta(days=1),
        gateway_cancel_executed_at=None,
        current_period_end=datetime.now(UTC) + timedelta(days=20),
    )
    db.add(sub)
    db.flush()
    with patch("app.services.razorpay_service.is_subscription_live", return_value=True):
        res = api.post("/subscriptions/resume", json={})
    assert res.status_code == 200, res.text
    assert res.json()["status"] == "resumed"
