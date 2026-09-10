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

from app.api import subscription_routes
from app.api.auth import get_current_client_strict
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


def test_billing_events_requires_auth(db, monkeypatch):
    # No dependency override: the real get_current_client chain runs and must
    # refuse an unauthenticated caller before any row is written.
    monkeypatch.setattr(subscription_routes, "get_session", lambda: _ctx(db))
    app = FastAPI()
    app.include_router(subscription_routes.router)
    api = TestClient(app)
    res = api.post("/subscriptions/billing-events", json={"event": "checkout_abandoned", "surface": "plan"})
    assert res.status_code in (401, 403), res.text
    assert db.query(BillingFunnelEvent).count() == 0
