"""Affiliate/referral financial mutations must land an AuditLog row.

Commission and discount splits move real money (affiliate payouts, customer
discounts on live Razorpay subscriptions). Every code create/edit and every
super-admin override or deletion must be traceable — who, when, old -> new —
same bar as the other audited super-admin mutations (see
test_seller_profile_routes.py for the established pattern).
"""

import os
from contextlib import contextmanager

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.api import affiliate_routes
from app.api.auth import get_current_affiliate, get_superadmin
from app.db.models import Affiliate, AuditLog, Client

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")


@contextmanager
def _ctx(session):
    yield session


def _make_client(db, email="affiliate@example.com") -> Client:
    client = Client(
        name="Affiliate Owner",
        email=email,
        hashed_password="$2b$12$notarealhash",
        api_key=f"test-api-key-{email}",
    )
    db.add(client)
    db.commit()
    return client


def _make_affiliate(db, client: Client, *, commission_bps: int = 5000) -> Affiliate:
    affiliate = Affiliate(client_id=client.id, max_active_codes=10, commission_bps=commission_bps)
    db.add(affiliate)
    db.commit()
    return affiliate


def _app_with_client_auth(db, monkeypatch, affiliate: Affiliate) -> TestClient:
    monkeypatch.setattr(affiliate_routes, "get_session", lambda: _ctx(db))
    app = FastAPI()
    app.include_router(affiliate_routes.router)
    app.dependency_overrides[get_current_affiliate] = lambda: affiliate
    return TestClient(app)


def _app_with_superadmin_auth(db, monkeypatch, admin: Client) -> TestClient:
    monkeypatch.setattr(affiliate_routes, "get_session", lambda: _ctx(db))
    app = FastAPI()
    app.include_router(affiliate_routes.superadmin_router)
    app.dependency_overrides[get_superadmin] = lambda: admin
    return TestClient(app)


def test_create_code_writes_audit_row(db, monkeypatch):
    client = _make_client(db)
    affiliate = _make_affiliate(db, client)
    c = _app_with_client_auth(db, monkeypatch, affiliate)

    res = c.post(
        "/affiliate/codes",
        json={"code": "AUDITME1", "affiliate_commission_pct": 10, "customer_discount_pct": 15},
    )
    assert res.status_code == 201, res.text

    rows = db.execute(select(AuditLog).where(AuditLog.action == "affiliate.code.create")).scalars().all()
    assert len(rows) == 1
    row = rows[0]
    assert row.actor_id == client.id
    assert row.target_type == "referral_code"
    assert row.after["code"] == "AUDITME1"
    assert row.after["affiliate_commission_bps"] == 1000
    assert row.after["customer_discount_bps"] == 1500


def test_update_code_writes_audit_row_with_before_and_after(db, monkeypatch):
    client = _make_client(db)
    affiliate = _make_affiliate(db, client)
    c = _app_with_client_auth(db, monkeypatch, affiliate)

    created = c.post(
        "/affiliate/codes",
        json={"code": "AUDITME2", "affiliate_commission_pct": 5, "customer_discount_pct": 5},
    ).json()
    code_id = created["id"]

    res = c.patch(
        f"/affiliate/codes/{code_id}",
        json={"affiliate_commission_pct": 20, "customer_discount_pct": 25},
    )
    assert res.status_code == 200, res.text

    row = db.execute(select(AuditLog).where(AuditLog.action == "affiliate.code.update")).scalars().one()
    assert row.before["affiliate_commission_bps"] == 500
    assert row.before["customer_discount_bps"] == 500
    assert row.after["affiliate_commission_bps"] == 2000
    assert row.after["customer_discount_bps"] == 2500


def test_superadmin_update_affiliate_writes_audit_row(db, monkeypatch):
    owner = _make_client(db, email="owner@example.com")
    affiliate = _make_affiliate(db, owner, commission_bps=2000)
    admin = _make_client(db, email="admin@example.com")

    c = _app_with_superadmin_auth(db, monkeypatch, admin)
    res = c.patch(f"/superadmin/affiliates/{affiliate.id}", json={"commission_pct": 30})
    assert res.status_code == 200, res.text

    row = db.execute(select(AuditLog).where(AuditLog.action == "affiliate.update")).scalars().one()
    assert row.actor_id == admin.id
    assert row.target_type == "affiliate"
    assert row.target_id == str(affiliate.id)
    assert row.before["commission_pct"] == pytest.approx(20.0)
    assert row.after["commission_pct"] == pytest.approx(30.0)


def test_superadmin_delete_affiliate_writes_audit_row(db, monkeypatch):
    owner = _make_client(db, email="owner2@example.com")
    affiliate = _make_affiliate(db, owner)
    admin = _make_client(db, email="admin2@example.com")

    c = _app_with_superadmin_auth(db, monkeypatch, admin)
    res = c.delete(f"/superadmin/affiliates/{affiliate.id}")
    assert res.status_code == 204, res.text

    row = db.execute(select(AuditLog).where(AuditLog.action == "affiliate.delete")).scalars().one()
    assert row.actor_id == admin.id
    assert row.target_type == "affiliate"
    assert row.target_id == str(affiliate.id)
    assert row.before["client_id"] == owner.id
