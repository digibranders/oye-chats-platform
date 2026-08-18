"""Authorization gating for ``superadmin_plan_routes.py``.

Mirrors the pattern in ``test_superadmin_impersonation_revoke.py``: this module
had ZERO ``_require_write`` gating, so a ``readonly`` super-admin could create,
update, and delete pricing plans and override subscriptions/seats. Writes
that should be restricted to owner/admin roles. These tests pin down that a
``readonly`` actor is rejected with 403 on every mutating endpoint while a
write-capable actor (and read-only GETs for anyone) keep working.
"""

import os
from contextlib import contextmanager

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api import superadmin_plan_routes
from app.api.auth import get_superadmin
from app.db.models import Client, Plan, Subscription

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")


@contextmanager
def _ctx(session):
    yield session


def _mk_admin(db, email: str, role: str | None = "owner") -> Client:
    admin = Client(
        name=f"Admin-{email}",
        email=email,
        api_key=f"key-{email}",
        is_superadmin=True,
        superadmin_role=role,
    )
    db.add(admin)
    db.flush()
    return admin


def _mk_plan(db, slug: str) -> Plan:
    plan = Plan(
        name=f"Plan-{slug}",
        slug=slug,
        monthly_price_cents=1000,
        annual_price_cents=10000,
    )
    db.add(plan)
    db.flush()
    return plan


def _mk_client(db, email: str) -> Client:
    customer = Client(name=f"Customer-{email}", email=email, api_key=f"key-{email}")
    db.add(customer)
    db.flush()
    return customer


def _mk_subscription(db, client: Client, plan: Plan) -> Subscription:
    sub = Subscription(client_id=client.id, plan_id=plan.id, status="active", operator_quantity=1)
    db.add(sub)
    db.flush()
    return sub


def _client(db, monkeypatch, admin: Client) -> TestClient:
    monkeypatch.setattr(superadmin_plan_routes, "get_session", lambda: _ctx(db))
    app = FastAPI()
    app.include_router(superadmin_plan_routes.router)
    app.dependency_overrides[get_superadmin] = lambda: admin
    return TestClient(app)


def _plan_payload(slug: str) -> dict:
    return {
        "name": f"Plan-{slug}",
        "slug": slug,
        "monthly_price_cents": 1000,
        "annual_price_cents": 10000,
    }


# ── create plan ──────────────────────────────────────────────────────────────


def test_readonly_admin_cannot_create_plan(db, monkeypatch):
    readonly = _mk_admin(db, "plan-create-ro@test.example", role="readonly")
    c = _client(db, monkeypatch, readonly)

    res = c.post("/superadmin/plans", json=_plan_payload("ro-create-slug"))
    assert res.status_code == 403

    existing = db.query(Plan).filter(Plan.slug == "ro-create-slug").first()
    assert existing is None


def test_write_admin_can_create_plan(db, monkeypatch):
    owner = _mk_admin(db, "plan-create-owner@test.example", role="owner")
    c = _client(db, monkeypatch, owner)

    res = c.post("/superadmin/plans", json=_plan_payload("owner-create-slug"))
    assert res.status_code == 200, res.text

    created = db.query(Plan).filter(Plan.slug == "owner-create-slug").first()
    assert created is not None


# ── delete plan ──────────────────────────────────────────────────────────────


def test_readonly_admin_cannot_delete_plan(db, monkeypatch):
    readonly = _mk_admin(db, "plan-delete-ro@test.example", role="readonly")
    plan = _mk_plan(db, "ro-delete-slug")
    c = _client(db, monkeypatch, readonly)

    res = c.delete(f"/superadmin/plans/{plan.id}")
    assert res.status_code == 403

    db.refresh(plan)
    assert plan.is_active is True


def test_write_admin_can_delete_plan(db, monkeypatch):
    admin = _mk_admin(db, "plan-delete-admin@test.example", role="admin")
    plan = _mk_plan(db, "admin-delete-slug")
    c = _client(db, monkeypatch, admin)

    res = c.delete(f"/superadmin/plans/{plan.id}")
    assert res.status_code == 200, res.text

    db.refresh(plan)
    assert plan.is_active is False


# ── subscription / seat mutation ────────────────────────────────────────────


def test_readonly_admin_cannot_update_subscription(db, monkeypatch):
    readonly = _mk_admin(db, "sub-update-ro@test.example", role="readonly")
    plan = _mk_plan(db, "ro-sub-slug")
    customer = _mk_client(db, "sub-customer-ro@test.example")
    sub = _mk_subscription(db, customer, plan)
    c = _client(db, monkeypatch, readonly)

    res = c.put(f"/superadmin/subscriptions/{sub.id}", json={"operator_quantity": 5})
    assert res.status_code == 403

    db.refresh(sub)
    assert sub.operator_quantity == 1


def test_write_admin_can_update_subscription(db, monkeypatch):
    admin = _mk_admin(db, "sub-update-admin@test.example", role="admin")
    plan = _mk_plan(db, "admin-sub-slug")
    customer = _mk_client(db, "sub-customer-admin@test.example")
    sub = _mk_subscription(db, customer, plan)
    c = _client(db, monkeypatch, admin)

    res = c.put(f"/superadmin/subscriptions/{sub.id}", json={"operator_quantity": 5})
    assert res.status_code == 200, res.text

    db.refresh(sub)
    assert sub.operator_quantity == 5


# ── read-only GET stays open to readonly admins ─────────────────────────────


def test_readonly_admin_can_list_plans(db, monkeypatch):
    readonly = _mk_admin(db, "plan-list-ro@test.example", role="readonly")
    _mk_plan(db, "ro-list-slug")
    c = _client(db, monkeypatch, readonly)

    res = c.get("/superadmin/plans")
    assert res.status_code == 200, res.text
    assert any(p["slug"] == "ro-list-slug" for p in res.json())
