"""Wave 4b: topup plan-gating + pack rounding + status-based cancel terminality.

* ``topup_allowed`` was frontend-only (a hidden button), a Free account
  calling the API directly could buy credits its plan matrix forbids.
* Pack matching used ``int()`` truncation on operator-edited float prices,
  a "1599.99" pack silently never matched anything.
* The gateway-cancel error paths sniffed English substrings out of SDK
  exceptions to decide "already terminal" (F8). Razorpay rewording a
  description would turn every terminal-state no-op into a raised 502. Now:
  ask the gateway for the subscription's ACTUAL status.
"""

import os
from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api import subscription_routes
from app.api.auth import get_current_client_strict, require_verified_email
from app.api.subscription_routes import _match_topup_pack
from app.db.models import Client, Plan, Subscription
from app.services import razorpay_service

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")


@contextmanager
def _ctx(session):
    yield session


# ── Pack matching: rounding, not truncation ──────────────────────────────────


def test_float_pack_prices_match_after_rounding():
    assert _match_topup_pack([{"inr": 1599.99}], 1600) == {"inr": 1599.99}
    assert _match_topup_pack([{"inr": 1599.0}], 1599) == {"inr": 1599.0}
    assert _match_topup_pack([{"inr": 1599.99}], 1599) is None  # rounds to 1600, not truncates


# ── topup_allowed enforcement ────────────────────────────────────────────────


def _mk(db, monkeypatch, *, features):
    plan = Plan(
        name="P",
        slug=f"plan-topup-{'paid' if features.get('topup_allowed') else 'free'}",
        monthly_price_cents=0 if not features.get("topup_allowed") else 44900,
        annual_price_cents=0 if not features.get("topup_allowed") else 449000,
        credits_per_month=500,
        included_operator_seats=1,
        is_active=True,
        features=features,
    )
    db.add(plan)
    db.flush()
    client = Client(
        name="T",
        email=f"topup-{plan.slug}@test.example",
        api_key=f"key-topup-{plan.slug}",
        legal_name="T Pvt Ltd",
        billing_address={"line1": "1 Lane", "city": "Mumbai", "postal_code": "400001"},
        billing_state_code="27",
        billing_country="IN",
    )
    db.add(client)
    db.flush()
    sub = Subscription(
        client_id=client.id,
        plan_id=plan.id,
        status="active",
        billing_cycle="monthly",
        operator_quantity=1,
        payment_provider="manual" if not features.get("topup_allowed") else "razorpay",
        razorpay_subscription_id=None if not features.get("topup_allowed") else f"sub_{plan.slug}",
    )
    db.add(sub)
    db.flush()

    monkeypatch.setattr(subscription_routes, "get_session", lambda: _ctx(db))
    monkeypatch.setattr(subscription_routes, "resolve_country", lambda request: None)
    monkeypatch.setattr(subscription_routes, "RAZORPAY_ENABLED", True)
    # Entitlements cache would serve a stale plan across tests. Bypass it.
    from app.services import plan_entitlements_service

    monkeypatch.setattr(plan_entitlements_service, "_read_cache", lambda *a, **k: None)
    app = FastAPI()
    app.include_router(subscription_routes.credits_router)
    app.dependency_overrides[get_current_client_strict] = lambda: client
    app.dependency_overrides[require_verified_email] = lambda: client
    return TestClient(app, raise_server_exceptions=True), client


def test_free_plan_topup_is_403(db, monkeypatch):
    api, _ = _mk(db, monkeypatch, features={"topup_allowed": False})
    with patch("app.services.razorpay_service.create_topup_order") as order:
        res = api.post("/credits/topup", json={"amount": 1599})
    assert res.status_code == 403, res.text
    assert res.json()["detail"]["code"] == "topup_not_allowed"
    assert not order.called


def test_paid_plan_topup_proceeds(db, monkeypatch):
    api, _ = _mk(db, monkeypatch, features={"topup_allowed": True})
    with (
        patch.object(
            subscription_routes.credit_service,
            "get_pricing",
            return_value={"topup_packs": [{"inr": 1599, "credits": 2000}]},
        ),
        patch(
            "app.services.razorpay_service.create_topup_order",
            return_value={
                "provider": "razorpay",
                "order_id": "order_t",
                "amount": 159900,
                "currency": "INR",
                "key_id": "k",
            },
        ) as order,
    ):
        res = api.post("/credits/topup", json={"amount": 1599})
    assert res.status_code == 200, res.text
    assert order.called


# ── Cancel terminality: status fetch, not prose ──────────────────────────────


def _fake_rzp(cancel_exc, fetch_result=None, fetch_exc=None):
    def _cancel(sub_id, data=None):
        raise cancel_exc

    def _fetch(sub_id):
        if fetch_exc:
            raise fetch_exc
        return fetch_result

    return SimpleNamespace(subscription=SimpleNamespace(cancel=_cancel, fetch=_fetch))


def test_terminal_gateway_status_makes_cancel_a_noop(monkeypatch):
    fake = _fake_rzp(Exception("some rewritten SDK prose"), fetch_result={"status": "cancelled"})
    monkeypatch.setattr(razorpay_service, "_get_razorpay", lambda: fake)
    # Must NOT raise: the desired outcome (stop charging) already holds.
    razorpay_service.cancel_subscription_by_id("sub_term_1")


def test_live_gateway_status_means_the_failure_is_real(monkeypatch):
    fake = _fake_rzp(Exception("network blip"), fetch_result={"status": "active"})
    monkeypatch.setattr(razorpay_service, "_get_razorpay", lambda: fake)
    with pytest.raises(razorpay_service.RazorpayBillingError):
        razorpay_service.cancel_subscription_by_id("sub_term_2")


def test_unreachable_gateway_never_swallows_the_failure(monkeypatch):
    fake = _fake_rzp(Exception("timeout"), fetch_exc=Exception("timeout again"))
    monkeypatch.setattr(razorpay_service, "_get_razorpay", lambda: fake)
    with pytest.raises(razorpay_service.RazorpayBillingError):
        razorpay_service.cancel_subscription_by_id("sub_term_3")
