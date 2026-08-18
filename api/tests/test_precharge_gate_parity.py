"""Wave 1.3 (P1-1): every route that mints a NEW Razorpay mandate runs the SAME
pre-charge gates as /checkout.

The identity requirement follows the CGST Rule 46 matrix (see
``_missing_billing_fields``): a REGISTERED buyer (GSTIN) must carry the
registered legal name + address; an EXPORT buyer must carry an address; an
unregistered domestic B2C buyer below ₹50,000 owes NOTHING. Payment stays
open to everyone.

``/change-plan`` Branch 3 (trial/Free → paid, or a lapsed bot returning to
paid) and ``/resume`` Mode 2 (dead mandate → fresh subscription) created real
gateway mandates with none of /checkout's gates: no Rule 46 billing-identity
check (so the activation webhook issued an invoice with no buyer identity), no
country trust rules. The intl kill switch alone was covered, at the service
layer (Wave 2.1).

``_require_precharge_gates`` is now the shared gate; these tests pin each
refusal firing BEFORE the gateway mint (the mock must not be called, a 409
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


# A GST-registered buyer with an incomplete record: the gate must refuse until
# the registered legal name + address are on file (their ITC depends on it).
_REGISTERED_INCOMPLETE = {
    "gstin": "27AAPFU0939F1ZV",
    "billing_state_code": "27",
    "billing_country": "IN",
}

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
    # CI has no Razorpay keys (local .env does): pin the provider gate ON so
    # these tests exercise the billing logic, not the deploy environment.
    monkeypatch.setattr(subscription_routes, "RAZORPAY_ENABLED", True)
    monkeypatch.setattr(subscription_routes, "resolve_country", lambda request: detected)
    app = FastAPI()
    app.include_router(subscription_routes.router)
    app.dependency_overrides[get_current_client_strict] = lambda: client
    app.dependency_overrides[require_verified_email] = lambda: client
    return TestClient(app, raise_server_exceptions=True), client


_CHECKOUT_PAYLOAD = {"subscription_id": "sub_gate_new", "key_id": "rzp_test", "provider": "razorpay"}


# ── /change-plan Branch 3 ────────────────────────────────────────────────────


def test_change_plan_registered_buyer_requires_full_identity(db, monkeypatch):
    # GSTIN on record but no legal name / address: refuse before the mint,
    # the invoice this mandate produces would break the buyer's ITC claim.
    api, _ = _mk(db, monkeypatch, **_REGISTERED_INCOMPLETE)
    plan = _plan(db)
    with patch("app.services.razorpay_service.create_subscription", return_value=dict(_CHECKOUT_PAYLOAD)) as mint:
        res = api.post("/subscriptions/change-plan", json={"plan_id": plan.id, "billing_cycle": "monthly"})
    assert res.status_code == 409, res.text
    assert res.json()["detail"]["code"] == "billing_details_required"
    assert set(res.json()["detail"]["missing"]) == {"legal_name", "billing_address"}
    assert not mint.called  # refused BEFORE any gateway mandate exists


def test_change_plan_b2c_without_details_proceeds(db, monkeypatch):
    # Unregistered domestic buyer below ₹50k: Rule 46(f) requires nothing.
    # Asking anyway was blocking legitimate payments. The account name and the
    # supplier-state fallback (Circular 242) make the invoice valid.
    api, _ = _mk(db, monkeypatch)  # bare account: no GSTIN, no address, no name
    plan = _plan(db)
    with patch("app.services.razorpay_service.create_subscription", return_value=dict(_CHECKOUT_PAYLOAD)) as mint:
        res = api.post("/subscriptions/change-plan", json={"plan_id": plan.id, "billing_cycle": "monthly"})
    assert res.status_code == 200, res.text
    assert mint.called


def test_change_plan_intl_pending_for_stored_foreign_country(db, monkeypatch):
    # Stored foreign country + intl rail off → the same intl_usd_pending 409
    # contract as /checkout, raised at the route gate before the mint.
    # Pin the flag OFF: this asserts the flag-off contract and must not
    # inherit whatever the local .env / CI environment says.
    monkeypatch.setattr(subscription_routes, "INTL_PAYMENTS_ENABLED", False)
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


def test_resume_mode2_registered_buyer_requires_full_identity(db, monkeypatch):
    api, client = _mk(db, monkeypatch, **_REGISTERED_INCOMPLETE)
    plan = _plan(db)
    _dead_mandate_sub(db, client, plan)
    with patch("app.services.razorpay_service.create_subscription", return_value=dict(_CHECKOUT_PAYLOAD)) as mint:
        res = api.post("/subscriptions/resume", json={})
    assert res.status_code == 409, res.text
    assert res.json()["detail"]["code"] == "billing_details_required"
    assert not mint.called


def test_resume_mode2_b2c_without_details_proceeds(db, monkeypatch):
    api, client = _mk(db, monkeypatch)  # bare B2C account
    plan = _plan(db)
    _dead_mandate_sub(db, client, plan)
    with patch("app.services.razorpay_service.create_subscription", return_value=dict(_CHECKOUT_PAYLOAD)) as mint:
        res = api.post("/subscriptions/resume", json={})
    assert res.status_code == 200, res.text
    assert mint.called


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
    # Mode 1 mints NOTHING (it clears a flag on a live mandate), an identity
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


def test_upgrade_now_branch_2a_requires_registered_identity(db, monkeypatch):
    # Branch 2a (paid → higher paid, upgrade-now) mints a replacement mandate;
    # identity fields are freely clearable after the original checkout, so the
    # gate must re-check here too, for the registered buyer it applies to.
    api, client = _mk(db, monkeypatch, **_REGISTERED_INCOMPLETE)
    lower = _plan(db, slug="std-gate-lower", monthly=44900)
    higher = _plan(db, slug="std-gate-higher", monthly=94900)
    sub = Subscription(
        client_id=client.id,
        plan_id=lower.id,
        status="active",
        billing_cycle="monthly",
        operator_quantity=1,
        payment_provider="razorpay",
        razorpay_subscription_id="sub_gate_upgrade",
        current_period_end=datetime.now(UTC) + timedelta(days=20),
    )
    db.add(sub)
    db.flush()
    with patch("app.services.transition_service.execute_paid_upgrade") as upgrade:
        res = api.post("/subscriptions/change-plan", json={"plan_id": higher.id, "billing_cycle": "monthly"})
    assert res.status_code == 409, res.text
    assert res.json()["detail"]["code"] == "billing_details_required"
    assert not upgrade.called


def test_seat_addition_requires_registered_identity(db, monkeypatch):
    api, client = _mk(db, monkeypatch, **_REGISTERED_INCOMPLETE)
    plan = _plan(db, slug="std-gate-seats")
    sub = Subscription(
        client_id=client.id,
        plan_id=plan.id,
        status="active",
        billing_cycle="monthly",
        operator_quantity=2,
        payment_provider="razorpay",
        razorpay_subscription_id="sub_gate_seats",
    )
    db.add(sub)
    db.flush()
    res = api.post("/subscriptions/seats", json={"delta": 1})
    assert res.status_code == 409, res.text
    assert res.json()["detail"]["code"] == "billing_details_required"


def test_seat_removal_skips_the_gate(db, monkeypatch):
    # Removing seats charges nothing, an identity gap must not block it.
    api, client = _mk(db, monkeypatch)  # no identity
    plan = _plan(db, slug="std-gate-seatrm")
    sub = Subscription(
        client_id=client.id,
        plan_id=plan.id,
        status="active",
        billing_cycle="monthly",
        operator_quantity=3,
        payment_provider="razorpay",
        razorpay_subscription_id="sub_gate_seatrm",
    )
    db.add(sub)
    db.flush()
    with patch("app.services.razorpay_service.cancel_seat_addon"):
        res = api.post("/subscriptions/seats", json={"delta": -1})
    # Anything but the identity 409 proves the gate did not fire; the exact
    # status depends on seat-addon state, which is not this test's concern.
    assert res.status_code != 409 or res.json().get("detail", {}).get("code") != "billing_details_required"


def test_foreign_buyer_needs_address_for_the_export_invoice(db, monkeypatch):
    # Rule 46's export proviso wants recipient name + address + destination
    # country on the document. Country routed them here, name falls back to
    # the account name. Only the address is asked for.
    monkeypatch.setattr(subscription_routes, "INTL_PAYMENTS_ENABLED", True)
    api, _ = _mk(db, monkeypatch, billing_country="US")  # no address
    plan = _plan(db)
    with patch("app.services.razorpay_service.create_subscription", return_value=dict(_CHECKOUT_PAYLOAD)) as mint:
        res = api.post("/subscriptions/change-plan", json={"plan_id": plan.id, "billing_cycle": "monthly"})
    assert res.status_code == 409, res.text
    assert res.json()["detail"]["missing"] == ["billing_address"]
    assert not mint.called


def test_rule_46f_threshold_asks_for_details_on_big_b2c_invoices(db):
    # Direct unit check of the ₹50,000 boundary for unregistered buyers.
    from app.api.subscription_routes import _missing_billing_fields

    bare = Client(name="Big", email="big@t.example", api_key="k-big")
    assert _missing_billing_fields(bare, amount_minor=49_999_00) == []
    assert set(_missing_billing_fields(bare, amount_minor=50_000_00)) == {
        "billing_address",
        "billing_state_code",
    }
