"""Super-admin seller-profile routes. GET defaults, PUT validate + persist + audit."""

import os
from contextlib import contextmanager
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api import superadmin_routes_v2
from app.api.auth import get_superadmin

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")


@contextmanager
def _ctx(session):
    yield session


def _client(db, monkeypatch, role="owner", admin_id=1) -> TestClient:
    monkeypatch.setattr(superadmin_routes_v2, "get_session", lambda: _ctx(db))
    app = FastAPI()
    app.include_router(superadmin_routes_v2.router)
    app.dependency_overrides[get_superadmin] = lambda: SimpleNamespace(
        id=admin_id, name="Admin", is_superadmin=True, superadmin_role=role
    )
    return TestClient(app)


def test_get_returns_defaults_when_unconfigured(db, monkeypatch):
    c = _client(db, monkeypatch)
    res = c.get("/superadmin/billing/seller-profile")
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["configured"] is False
    assert body["gst_enabled"] is False
    assert body["invoice_prefix"] == "DB"


def test_put_persists_and_derives_state(db, monkeypatch):
    c = _client(db, monkeypatch, admin_id=None)
    res = c.put(
        "/superadmin/billing/seller-profile",
        json={
            "legal_name": "Digibranders Pvt Ltd",
            "gstin": "27AAPFU0939F1ZV",
            "address_lines": ["1 Example Road", "Mumbai 400001"],
        },
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["configured"] is True
    assert body["gst_enabled"] is True
    assert body["state_code"] == "27"


def test_put_rejects_bad_gstin_as_422(db, monkeypatch):
    c = _client(db, monkeypatch, admin_id=None)
    res = c.put("/superadmin/billing/seller-profile", json={"legal_name": "X Ltd", "gstin": "BAD"})
    assert res.status_code == 422
    assert "GSTIN" in res.json()["detail"]


def test_readonly_admin_cannot_write(db, monkeypatch):
    c = _client(db, monkeypatch, role="readonly", admin_id=2)
    res = c.put("/superadmin/billing/seller-profile", json={"legal_name": "X Ltd"})
    assert res.status_code == 403


def test_put_writes_audit_row(db, monkeypatch):
    from sqlalchemy import select

    from app.db.models import AuditLog

    c = _client(db, monkeypatch, admin_id=None)
    res = c.put(
        "/superadmin/billing/seller-profile", json={"legal_name": "Digibranders Pvt Ltd", "gstin": "27AAPFU0939F1ZV"}
    )
    assert res.status_code == 200, res.text
    rows = db.execute(select(AuditLog).where(AuditLog.action == "billing.seller_profile.update")).scalars().all()
    assert len(rows) == 1
    assert rows[0].target_id == "billing.seller_profile"


def test_partial_put_preserves_gstin(db, monkeypatch):
    c = _client(db, monkeypatch, admin_id=None)
    c.put("/superadmin/billing/seller-profile", json={"legal_name": "Digibranders Pvt Ltd", "gstin": "27AAPFU0939F1ZV"})
    res = c.put("/superadmin/billing/seller-profile", json={"legal_name": "Digibranders Private Limited"})
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["gstin"] == "27AAPFU0939F1ZV"
    assert body["gst_enabled"] is True


def test_pricing_config_route_rejects_seller_key(db, monkeypatch):
    monkeypatch.setattr(superadmin_routes_v2, "get_session", lambda: _ctx(db))
    app = FastAPI()
    app.include_router(superadmin_routes_v2.router)
    app.dependency_overrides[get_superadmin] = lambda: SimpleNamespace(
        id=None, name="Admin", is_superadmin=True, superadmin_role="owner"
    )
    c = TestClient(app)
    res = c.put(
        "/superadmin/pricing-config/billing.seller_profile", json={"value": {"legal_name": "evil", "gstin": "BAD"}}
    )
    assert res.status_code == 422
