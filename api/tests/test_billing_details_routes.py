"""Customer billing-details endpoints — read, update, validation."""

import os
from contextlib import contextmanager

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api import subscription_routes
from app.api.auth import get_current_client_strict
from app.db.models import Client

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")


@contextmanager
def _ctx(session):
    yield session


def _mk(db, monkeypatch):
    client = Client(name="Acme", email="billing-details@test.example", api_key="key-billing-details")
    db.add(client)
    db.flush()
    monkeypatch.setattr(subscription_routes, "get_session", lambda: _ctx(db))
    app = FastAPI()
    app.include_router(subscription_routes.router)
    app.dependency_overrides[get_current_client_strict] = lambda: client
    return TestClient(app), client


def test_get_returns_empty_details(db, monkeypatch):
    c, _ = _mk(db, monkeypatch)
    res = c.get("/subscriptions/billing-details")
    assert res.status_code == 200, res.text
    assert res.json()["gstin"] is None


def test_put_persists_and_derives_state_from_gstin(db, monkeypatch):
    c, client = _mk(db, monkeypatch)
    res = c.put(
        "/subscriptions/billing-details",
        json={
            "legal_name": "Acme Industries Pvt Ltd",
            "gstin": "27AAPFU0939F1ZV",
            "billing_address": {"line1": "1 Test Lane", "city": "Mumbai", "postal_code": "400001"},
            "billing_country": "IN",
        },
    )
    assert res.status_code == 200, res.text
    assert res.json()["billing_state_code"] == "27"
    assert client.gstin == "27AAPFU0939F1ZV"


def test_put_rejects_invalid_gstin(db, monkeypatch):
    c, _ = _mk(db, monkeypatch)
    res = c.put("/subscriptions/billing-details", json={"gstin": "NOTAGSTIN"})
    assert res.status_code == 422


def test_put_rejects_state_gstin_mismatch(db, monkeypatch):
    c, _ = _mk(db, monkeypatch)
    res = c.put(
        "/subscriptions/billing-details",
        json={"gstin": "27AAPFU0939F1ZV", "billing_state_code": "29"},
    )
    assert res.status_code == 422
    assert "state" in res.json()["detail"].lower()


def test_put_rejects_unknown_state_code(db, monkeypatch):
    c, _ = _mk(db, monkeypatch)
    res = c.put("/subscriptions/billing-details", json={"billing_state_code": "95"})
    assert res.status_code == 422


def test_put_clears_gstin_with_null(db, monkeypatch):
    c, client = _mk(db, monkeypatch)
    c.put("/subscriptions/billing-details", json={"gstin": "27AAPFU0939F1ZV"})
    res = c.put("/subscriptions/billing-details", json={"gstin": None})
    assert res.status_code == 200, res.text
    assert res.json()["gstin"] is None
