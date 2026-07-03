"""Confirm-country gate on /checkout — Phase 1 charges INR (IN) only.

The confirmed billing_country decides currency, plan set, and invoice type, so
it is captured and gated *before* the mandate is authorised: a confirmed non-IN
country returns a structured ``intl_usd_pending`` (409) so the UI shows
Contact-sales instead of a broken payment, and a confirmed IN country is
persisted on the client for invoice place-of-supply.

Real-Postgres route tests via the shared ``db`` fixture; mirrors
tests/test_billing_bl2_bl4.py. Skips without DB_URL.
"""

from __future__ import annotations

import os
from contextlib import contextmanager
from unittest.mock import patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.db.models import Client, Plan

pytestmark = pytest.mark.skipif(
    not os.getenv("DB_URL"),
    reason="checkout country-gate tests need a reachable Postgres at DB_URL",
)


@contextmanager
def _session_cm(session):
    yield session


def _make_client(db, *, email: str) -> Client:
    client = Client(name="c", email=email, api_key=email, hashed_password="h")
    db.add(client)
    db.flush()
    return client


def _make_plan(db, *, slug: str, monthly_price_cents: int) -> Plan:
    plan = Plan(
        name=slug.title(),
        slug=slug,
        monthly_price_cents=monthly_price_cents,
        annual_price_cents=monthly_price_cents * 10,
        monthly_price_usd_cents=monthly_price_cents,
        credits_per_month=1000,
        included_operator_seats=1,
        is_active=True,
        razorpay_plan_id_monthly=f"plan_{slug}_inr_m",
        razorpay_plan_id_annual=f"plan_{slug}_inr_a",
    )
    db.add(plan)
    db.flush()
    return plan


def _api(db, client) -> TestClient:
    from app.api import auth, subscription_routes

    app = FastAPI()
    app.include_router(subscription_routes.router)
    app.dependency_overrides[auth.get_current_client_strict] = lambda: client
    return TestClient(app, raise_server_exceptions=False)


def test_checkout_rejects_foreign_country_in_phase1(db):
    from app.api import subscription_routes

    client = _make_client(db, email="gate-us@e.com")
    plan = _make_plan(db, slug="starter-gate-us", monthly_price_cents=179900)
    db.commit()

    api = _api(db, client)
    with patch.object(subscription_routes, "get_session", lambda: _session_cm(db)):
        res = api.post(
            "/subscriptions/checkout",
            json={"plan_id": plan.id, "billing_cycle": "monthly", "billing_country": "US"},
        )

    assert res.status_code == 409, res.text
    assert res.json()["detail"]["reason"] == "intl_usd_pending"


def test_checkout_persists_confirmed_country(db):
    from app.api import subscription_routes

    client = _make_client(db, email="gate-in@e.com")
    plan = _make_plan(db, slug="starter-gate-in", monthly_price_cents=179900)
    db.commit()

    api = _api(db, client)
    with (
        patch.object(subscription_routes, "get_session", lambda: _session_cm(db)),
        patch.object(subscription_routes, "lock_client_for_billing", lambda *a, **k: None),
        patch.object(subscription_routes, "RAZORPAY_ENABLED", True),
        patch(
            "app.services.razorpay_service.create_subscription",
            return_value={"provider": "razorpay", "subscription_id": "sub_gate_in"},
        ),
    ):
        res = api.post(
            "/subscriptions/checkout",
            json={"plan_id": plan.id, "billing_cycle": "monthly", "billing_country": "IN"},
        )

    assert res.status_code == 200, res.text
    db.refresh(client)
    assert client.billing_country == "IN"
