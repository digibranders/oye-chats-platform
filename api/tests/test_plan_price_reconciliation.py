"""Super-admin plan↔Razorpay price-integrity diagnostic.

Every rupee figure the UI shows is read from ``plan.monthly_price_cents``; if it
drifts from the live Razorpay plan amount, the UI truthfully-but-wrongly quotes
a number the mandate does not debit. This diagnostic makes drift observable. The
Razorpay client is mocked, no live calls in tests.

Real-Postgres route test via the shared ``db`` fixture. Skips without DB_URL.
"""

from __future__ import annotations

import os
from contextlib import contextmanager
from unittest.mock import MagicMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.db.models import Client, Plan

pytestmark = pytest.mark.skipif(
    not os.getenv("DB_URL"),
    reason="plan price-reconciliation test needs a reachable Postgres at DB_URL",
)


@contextmanager
def _session_cm(session):
    yield session


def _make_admin(db, *, email: str) -> Client:
    client = Client(name="admin", email=email, api_key=email, hashed_password="h", is_superadmin=True)
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


def test_plan_price_reconciliation_flags_drift(db):
    from app.api import auth, subscription_routes

    admin = _make_admin(db, email="pricecheck-admin@e.com")
    plan = _make_plan(db, slug="starter-rec", monthly_price_cents=179900)
    db.commit()

    fake_rzp = MagicMock()
    # Razorpay returns the plan amount in paise under item.amount. Drifted here.
    fake_rzp.plan.fetch.return_value = {"item": {"amount": 149900, "currency": "INR"}}

    app = FastAPI()
    app.include_router(subscription_routes.router)
    app.dependency_overrides[auth.get_current_client_strict] = lambda: admin
    api = TestClient(app, raise_server_exceptions=False)

    with (
        patch.object(subscription_routes, "get_session", lambda: _session_cm(db)),
        patch("app.services.razorpay_service._get_razorpay", return_value=fake_rzp),
    ):
        res = api.get("/subscriptions/admin/plan-price-check")

    assert res.status_code == 200, res.text
    row = {r["plan_id"]: r for r in res.json()["plans"]}[plan.id]
    assert row["monthly"]["local_minor"] == 179900
    assert row["monthly"]["razorpay_minor"] == 149900
    assert row["monthly"]["in_sync"] is False


def test_plan_price_reconciliation_rejects_non_superadmin(db):
    from app.api import auth, subscription_routes

    non_admin = Client(name="c", email="notadmin@e.com", api_key="notadmin@e.com", hashed_password="h")
    db.add(non_admin)
    db.commit()

    app = FastAPI()
    app.include_router(subscription_routes.router)
    app.dependency_overrides[auth.get_current_client_strict] = lambda: non_admin
    api = TestClient(app, raise_server_exceptions=False)

    with patch.object(subscription_routes, "get_session", lambda: _session_cm(db)):
        res = api.get("/subscriptions/admin/plan-price-check")

    assert res.status_code == 403, res.text
