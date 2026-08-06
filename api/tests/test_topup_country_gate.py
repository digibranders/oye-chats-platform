"""Confirm-country gate on /credits/topup — must match /checkout's gate.

``/checkout`` requires a confirmed billing_country and rejects a non-IN buyer
with a structured ``intl_usd_pending`` (409) so Phase-1 INR-only charging
never lands on a foreign buyer's card. ``/credits/topup`` creates a Razorpay
*Order* (not a Subscription) via ``razorpay_service.create_topup_order``, but
that function hard-codes the INR rail too — so a non-IN buyer's top-up would
otherwise be silently processed as INR and later invoiced as an export by
``invoice_service`` (which classifies supply from ``buyer.billing_country``),
mis-classifying / short-paying GST. This test asserts the top-up path applies
the identical gate as checkout.

Real-Postgres route tests via the shared ``db`` fixture; mirrors
tests/test_checkout_country_gate.py. Skips without DB_URL.
"""

from __future__ import annotations

import os
from contextlib import contextmanager
from unittest.mock import patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.db.models import Client

pytestmark = pytest.mark.skipif(
    not os.getenv("DB_URL"),
    reason="topup country-gate tests need a reachable Postgres at DB_URL",
)

# Matches the default INR topup pack in credit_service._DEFAULT_PRICING —
# amount=1599 (rupees), credits=2000. Using the real default keeps this test
# honest against pricing_config drift rather than faking a pack.
_PACK_AMOUNT = 1599


@contextmanager
def _session_cm(session):
    yield session


def _make_client(db, *, email: str, billing_country: str | None = None) -> Client:
    client = Client(
        name="c",
        email=email,
        api_key=email,
        hashed_password="h",
        is_verified=True,
        billing_country=billing_country,
        # Billing identity is now a precondition for any paid checkout
        # (Rule 46 buyer fields must be on record before the charge, since
        # the invoice is issued from a webhook). A customer reaching these
        # endpoints in production always has them.
        legal_name="Test Buyer Pvt Ltd",
        billing_address={"line1": "1 MG Road", "city": "Pune", "postal_code": "411001"},
        billing_state_code="27",
    )
    db.add(client)
    db.flush()
    return client


def _api(db, client) -> TestClient:
    from app.api import auth, subscription_routes

    app = FastAPI()
    app.include_router(subscription_routes.credits_router)
    app.dependency_overrides[auth.get_current_client_strict] = lambda: client
    return TestClient(app, raise_server_exceptions=False)


def test_topup_rejects_foreign_billing_country(db):
    """A confirmed non-IN billing country must 409 with the same contract as
    /checkout's intl_usd_pending — not silently create an INR order."""
    from app.api import subscription_routes

    client = _make_client(db, email="topup-gate-us@e.com")
    db.commit()

    api = _api(db, client)
    with patch.object(subscription_routes, "get_session", lambda: _session_cm(db)):
        res = api.post(
            "/credits/topup",
            json={"amount": _PACK_AMOUNT, "billing_country": "US"},
        )

    assert res.status_code == 409, res.text
    assert res.json()["detail"]["reason"] == "intl_usd_pending"


def test_topup_rejects_stored_foreign_billing_country(db):
    """Same gate applies when the foreign country is already stored on the
    client (not just re-confirmed on this request) — mirrors checkout's
    fallback-to-stored-country behaviour."""
    from app.api import subscription_routes

    client = _make_client(db, email="topup-gate-stored-us@e.com", billing_country="US")
    db.commit()

    api = _api(db, client)
    with patch.object(subscription_routes, "get_session", lambda: _session_cm(db)):
        res = api.post("/credits/topup", json={"amount": _PACK_AMOUNT})

    assert res.status_code == 409, res.text
    assert res.json()["detail"]["reason"] == "intl_usd_pending"


def test_topup_proceeds_for_domestic_billing_country(db):
    """An IN (or unconfirmed, defaulting to IN) buyer must still be able to
    top up on the live INR rail — the gate must not block domestic traffic."""
    from app.api import subscription_routes

    client = _make_client(db, email="topup-gate-in@e.com")
    # Wave 4b: topups are plan-gated (topup_allowed). This test is about the
    # COUNTRY gate, so give the buyer a paid plan that allows topups.
    from app.db.models import Plan, Subscription

    plan = Plan(
        name="Starter",
        slug="starter-topup-gate",
        monthly_price_cents=44900,
        annual_price_cents=449000,
        credits_per_month=3000,
        included_operator_seats=1,
        is_active=True,
        features={"topup_allowed": True},
    )
    db.add(plan)
    db.flush()
    db.add(
        Subscription(
            client_id=client.id,
            plan_id=plan.id,
            status="active",
            billing_cycle="monthly",
            operator_quantity=1,
            payment_provider="razorpay",
            razorpay_subscription_id="sub_topup_gate_in",
        )
    )
    db.commit()

    api = _api(db, client)
    with (
        patch.object(subscription_routes, "get_session", lambda: _session_cm(db)),
        # CI has no Razorpay keys, so the endpoint's ``if not RAZORPAY_ENABLED``
        # guard (subscription_routes.py:109) would 503 before reaching the
        # patched order call. Force it enabled — same as test_checkout_country_gate.
        patch.object(subscription_routes, "RAZORPAY_ENABLED", True),
        patch(
            "app.services.razorpay_service.create_topup_order",
            return_value={
                "provider": "razorpay",
                "order_id": "order_gate_in",
                "amount": _PACK_AMOUNT * 100,
                "currency": "INR",
                "credits": 2000,
                "bonus_pct": 0,
                "key_id": "rzp_test_key",
                "name": "OyeChats credits",
                "description": "2,000 credits",
                "prefill": {"name": "c", "email": "topup-gate-in@e.com"},
                "theme": {"color": "#6366f1"},
                "receipt": "topup_test",
            },
        ),
    ):
        res = api.post(
            "/credits/topup",
            json={"amount": _PACK_AMOUNT, "billing_country": "IN"},
        )

    assert res.status_code == 200, res.text
    body = res.json()
    assert body["currency"] == "INR"
    assert body["order_id"] == "order_gate_in"
