"""Tests for superadmin plan CRUD — verifies all fields are accepted and returned."""

from contextlib import contextmanager
from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api import superadmin_plan_routes
from app.api.auth import get_superadmin


@contextmanager
def _ctx(session):
    yield session


def _client(db, monkeypatch) -> TestClient:
    monkeypatch.setattr(superadmin_plan_routes, "get_session", lambda: _ctx(db))
    app = FastAPI()
    app.include_router(superadmin_plan_routes.router)
    app.dependency_overrides[get_superadmin] = lambda: SimpleNamespace(id=1, is_superadmin=True)
    return TestClient(app)


def test_create_plan_persists_all_fields(db, monkeypatch):
    c = _client(db, monkeypatch)
    body = {
        "name": "Growth",
        "slug": "growth",
        "currency": "USD",
        "monthly_price_usd_cents": 2900,
        "annual_price_usd_cents": 27800,
        "credits_per_month": 5000,
        "included_operator_seats": 2,
        "extra_seat_price_usd_cents": 500,
        "razorpay_plan_id_monthly": "plan_MONTHLY123",
        "razorpay_plan_id_annual": "plan_ANNUAL123",
        "limits": {"ai_messages": 5000},
        "features": {"live_chat": True},
        "marketing": {
            "tagline": "Scale up",
            "featured": True,
            "highlight_features": ["5,000 credits / month"],
        },
    }
    res = c.post("/superadmin/plans", json=body)
    assert res.status_code == 200, res.text
    plan_id = res.json()["plan_id"]

    listing = c.get("/superadmin/plans").json()
    created = next(p for p in listing if p["id"] == plan_id)

    assert created["credits_per_month"] == 5000
    assert created["included_operator_seats"] == 2
    assert created["extra_seat_price_usd_cents"] == 500
    assert created["razorpay_plan_id_monthly"] == "plan_MONTHLY123"
    assert created["razorpay_plan_id_annual"] == "plan_ANNUAL123"
    assert created["marketing"]["tagline"] == "Scale up"
    assert created["marketing"]["featured"] is True
    assert created["marketing"]["highlight_features"] == ["5,000 credits / month"]


def test_update_plan_marketing_and_credits(db, monkeypatch):
    c = _client(db, monkeypatch)
    create = c.post("/superadmin/plans", json={"name": "Base", "slug": "base"})
    assert create.status_code == 200, create.text
    plan_id = create.json()["plan_id"]

    res = c.put(
        f"/superadmin/plans/{plan_id}",
        json={"credits_per_month": 9999, "marketing": {"badge": "New"}},
    )
    assert res.status_code == 200, res.text

    listing = c.get("/superadmin/plans").json()
    updated = next(p for p in listing if p["id"] == plan_id)
    assert updated["credits_per_month"] == 9999
    assert updated["marketing"]["badge"] == "New"


def test_create_plan_extra_seat_price_cents(db, monkeypatch):
    """extra_seat_price_cents is correctly persisted and returned."""
    c = _client(db, monkeypatch)
    res = c.post(
        "/superadmin/plans",
        json={"name": "Pro", "slug": "pro", "extra_seat_price_cents": 2500},
    )
    assert res.status_code == 200, res.text
    plan_id = res.json()["plan_id"]

    listing = c.get("/superadmin/plans").json()
    plan = next(p for p in listing if p["id"] == plan_id)
    assert plan["extra_seat_price_cents"] == 2500


def test_create_plan_included_operator_seats_default(db, monkeypatch):
    """Default included_operator_seats is 1 when not specified."""
    c = _client(db, monkeypatch)
    res = c.post("/superadmin/plans", json={"name": "Starter", "slug": "starter"})
    assert res.status_code == 200, res.text
    plan_id = res.json()["plan_id"]

    listing = c.get("/superadmin/plans").json()
    plan = next(p for p in listing if p["id"] == plan_id)
    assert plan["included_operator_seats"] == 1
