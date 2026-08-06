"""Wave 3.0: checkout-abandonment funnel events.

The app detects "customer closed the Razorpay sheet" and "gateway declined"
but the operator saw nothing. POST /subscriptions/billing-events records the
signal (fire-and-forget from the app); GET /superadmin/billing-funnel
aggregates it per surface for the funnel view.
"""

import os
from contextlib import contextmanager

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api import subscription_routes, superadmin_routes_v2
from app.api.auth import get_current_client_strict, get_superadmin
from app.db.models import BillingFunnelEvent, Client

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")


@contextmanager
def _ctx(session):
    yield session


def _mk(db, monkeypatch):
    client = Client(name="F", email="funnel@test.example", api_key="key-funnel")
    db.add(client)
    db.flush()
    monkeypatch.setattr(subscription_routes, "get_session", lambda: _ctx(db))
    app = FastAPI()
    app.include_router(subscription_routes.router)
    app.dependency_overrides[get_current_client_strict] = lambda: client
    return TestClient(app), client


def test_abandonment_event_is_recorded(db, monkeypatch):
    api, client = _mk(db, monkeypatch)
    res = api.post(
        "/subscriptions/billing-events",
        json={"event": "checkout_abandoned", "surface": "topup", "meta": {"amount": 1599}},
    )
    assert res.status_code == 204, res.text
    row = db.query(BillingFunnelEvent).filter_by(client_id=client.id).one()
    assert row.event == "checkout_abandoned"
    assert row.surface == "topup"
    assert row.meta == {"amount": 1599}


def test_unknown_event_or_surface_rejected(db, monkeypatch):
    api, _ = _mk(db, monkeypatch)
    assert api.post("/subscriptions/billing-events", json={"event": "made_up", "surface": "plan"}).status_code == 422
    assert (
        api.post("/subscriptions/billing-events", json={"event": "checkout_abandoned", "surface": "nope"}).status_code
        == 422
    )


def test_meta_is_size_bounded(db, monkeypatch):
    # Fire-and-forget telemetry must not become an unbounded JSONB dump.
    api, _ = _mk(db, monkeypatch)
    res = api.post(
        "/subscriptions/billing-events",
        json={"event": "checkout_abandoned", "surface": "plan", "meta": {"x": "y" * 5000}},
    )
    assert res.status_code == 422


def test_superadmin_funnel_summary_counts_by_surface(db, monkeypatch):
    customer = Client(name="C", email="funnel-c@test.example", api_key="key-funnel-c")
    admin = Client(name="A", email="funnel-a@test.example", api_key="key-funnel-a", is_superadmin=True)
    db.add_all([customer, admin])
    db.flush()
    db.add_all(
        [
            BillingFunnelEvent(client_id=customer.id, event="checkout_abandoned", surface="topup"),
            BillingFunnelEvent(client_id=customer.id, event="checkout_abandoned", surface="topup"),
            BillingFunnelEvent(client_id=customer.id, event="checkout_abandoned", surface="plan"),
            BillingFunnelEvent(client_id=customer.id, event="payment_failed", surface="plan"),
        ]
    )
    db.flush()

    monkeypatch.setattr(superadmin_routes_v2, "get_session", lambda: _ctx(db))
    app = FastAPI()
    app.include_router(superadmin_routes_v2.router)
    app.dependency_overrides[get_superadmin] = lambda: admin
    api = TestClient(app)

    res = api.get("/superadmin/billing-funnel?days=7")
    assert res.status_code == 200, res.text
    body = res.json()
    counts = {(c["surface"], c["event"]): c["count"] for c in body["counts"]}
    assert counts[("topup", "checkout_abandoned")] == 2
    assert counts[("plan", "checkout_abandoned")] == 1
    assert counts[("plan", "payment_failed")] == 1
    assert len(body["recent"]) == 4
    assert body["recent"][0]["client_email"] == "funnel-c@test.example"
