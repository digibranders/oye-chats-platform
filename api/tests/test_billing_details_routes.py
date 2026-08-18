"""Customer billing-details endpoints. Read, update, validation."""

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
    # A GSTIN now requires a registered legal name (it must match the GST
    # certificate or the buyer's GSTR-2B reconciliation fails), so the
    # fixture carries one -- these tests exercise the GSTIN/state/country
    # interactions, not the name rule.
    client = Client(
        name="Acme",
        email="billing-details@test.example",
        api_key="key-billing-details",
        legal_name="Acme Pvt Ltd",
    )
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
    body = res.json()
    assert body["gstin"] is None
    # The invoice-recipient default (billing_email or account email) is
    # surfaced read-only so the UI can show where invoices actually go.
    assert body["account_email"] == "billing-details@test.example"


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


def test_put_rejects_overlong_country(db, monkeypatch):
    c, _ = _mk(db, monkeypatch)
    res = c.put("/subscriptions/billing-details", json={"billing_country": "India"})
    assert res.status_code == 422


def test_partial_put_preserves_other_fields(db, monkeypatch):
    c, _ = _mk(db, monkeypatch)
    c.put(
        "/subscriptions/billing-details",
        json={
            "legal_name": "Acme Industries Pvt Ltd",
            "billing_address": {"line1": "1 Test Lane", "city": "Mumbai"},
            "billing_email": "accounts@acme.example",
        },
    )
    # A partial edit that only sets gstin must not wipe the earlier fields.
    res = c.put("/subscriptions/billing-details", json={"gstin": "29AAGCB7383J1Z4"})
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["gstin"] == "29AAGCB7383J1Z4"
    assert body["legal_name"] == "Acme Industries Pvt Ltd"
    assert body["billing_address"] == {"line1": "1 Test Lane", "city": "Mumbai"}
    assert body["billing_email"] == "accounts@acme.example"


def test_gstin_with_foreign_country_rejected_both_directions(db, monkeypatch):
    c, _ = _mk(db, monkeypatch)
    # Direction 1: country US already stored, then GSTIN arrives.
    assert c.put("/subscriptions/billing-details", json={"billing_country": "US"}).status_code == 200
    res = c.put("/subscriptions/billing-details", json={"gstin": "27AAPFU0939F1ZV"})
    assert res.status_code == 422
    assert "billing_country" in res.json()["detail"]
    # Direction 2: GSTIN stored (with country cleared), then country flips to US.
    assert c.put("/subscriptions/billing-details", json={"billing_country": "IN"}).status_code == 200
    assert c.put("/subscriptions/billing-details", json={"gstin": "27AAPFU0939F1ZV"}).status_code == 200
    res = c.put("/subscriptions/billing-details", json={"billing_country": "US"})
    assert res.status_code == 422


def test_cross_request_state_gstin_mismatch_rejected(db, monkeypatch):
    c, _ = _mk(db, monkeypatch)
    c.put("/subscriptions/billing-details", json={"gstin": "27AAPFU0939F1ZV"})
    # A later request changing only the state must still be checked against
    # the STORED GSTIN's digits.
    res = c.put("/subscriptions/billing-details", json={"billing_state_code": "29"})
    assert res.status_code == 422
    assert "GSTIN" in res.json()["detail"]


def test_nonalpha_country_rejected(db, monkeypatch):
    c, _ = _mk(db, monkeypatch)
    res = c.put("/subscriptions/billing-details", json={"billing_country": "1N"})
    assert res.status_code == 422


def test_empty_string_state_clears_to_null(db, monkeypatch):
    c, client = _mk(db, monkeypatch)
    c.put("/subscriptions/billing-details", json={"billing_state_code": "27"})
    res = c.put("/subscriptions/billing-details", json={"billing_state_code": ""})
    assert res.status_code == 200, res.text
    assert res.json()["billing_state_code"] is None
    assert client.billing_state_code is None  # NULL, not ""
