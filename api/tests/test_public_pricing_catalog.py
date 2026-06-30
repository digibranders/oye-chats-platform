"""Tests for GET /public/pricing-catalog (unauthenticated marketing endpoint)."""

from contextlib import contextmanager

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api import public_pricing_routes
from app.db.models import Plan


@contextmanager
def _ctx(session):
    yield session


def _client(db, monkeypatch):
    monkeypatch.setattr(public_pricing_routes, "get_session", lambda: _ctx(db))
    app = FastAPI()
    app.include_router(public_pricing_routes.router)
    return TestClient(app)


def _seed_plan(db, slug="starter", is_active=True):
    plan = Plan(
        name=slug.title(),
        slug=slug,
        is_active=is_active,
        limits={"ai_messages": 100},
        features={"live_chat": True},
        marketing={"tagline": "Hi"},
        monthly_price_usd_cents=1900,
    )
    db.add(plan)
    db.commit()
    return plan


def test_pricing_catalog_is_public_and_shaped(db, monkeypatch):
    _seed_plan(db, "starter")
    c = _client(db, monkeypatch)
    res = c.get("/public/pricing-catalog")  # no auth header
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["currency"] == "USD"
    assert isinstance(body["plans"], list) and len(body["plans"]) >= 1
    plan = body["plans"][0]
    for key in ("slug", "monthly_price_usd_cents", "limits", "features", "marketing"):
        assert key in plan
    for key in ("feature_matrix", "faq", "topup_packs", "credit_costs"):
        assert key in body


def test_pricing_catalog_excludes_inactive_plans(db, monkeypatch):
    _seed_plan(db, "active-one", is_active=True)
    _seed_plan(db, "hidden-one", is_active=False)
    c = _client(db, monkeypatch)
    slugs = {p["slug"] for p in c.get("/public/pricing-catalog").json()["plans"]}
    assert "active-one" in slugs
    assert "hidden-one" not in slugs
