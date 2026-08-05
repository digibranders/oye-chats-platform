"""Currency routing for /geo and /checkout/quote — geo-split billing model.

Indian buyers (country == "IN") see and pay INR; everyone else sees USD. The
confirmed ``billing_country`` (from the checkout country-confirmation step)
overrides IP geo so an Indian resident mis-detected abroad is never routed to
USD, and vice-versa (FEMA-safe).

Real-Postgres route tests via the shared ``db`` fixture (conftest). They build
the app inline, override client auth, and patch ``get_session`` /
``resolve_country`` — mirroring tests/test_billing_bl2_bl4.py. Skips without
DB_URL.
"""

from __future__ import annotations

import os
from contextlib import contextmanager
from unittest.mock import patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.db.models import Client, Plan

pytestmark = pytest.mark.skipif(
    not os.getenv("DB_URL"),
    reason="currency-routing route tests need a reachable Postgres at DB_URL",
)


@contextmanager
def _session_cm(session):
    yield session


def _make_client(db, *, email: str) -> Client:
    client = Client(name="c", email=email, api_key=email, hashed_password="h")
    db.add(client)
    db.flush()
    return client


def _make_plan(db, *, slug: str, monthly_price_cents: int, monthly_price_usd_cents: int = 0, **extra) -> Plan:
    plan = Plan(
        name=slug.title(),
        slug=slug,
        monthly_price_cents=monthly_price_cents,
        annual_price_cents=monthly_price_cents * 10,
        monthly_price_usd_cents=monthly_price_usd_cents,
        annual_price_usd_cents=(monthly_price_usd_cents or 0) * 10,
        credits_per_month=1000,
        included_operator_seats=1,
        is_active=True,
        razorpay_plan_id_monthly=f"plan_{slug}_inr_m",
        razorpay_plan_id_annual=f"plan_{slug}_inr_a",
        **extra,
    )
    db.add(plan)
    db.flush()
    return plan


def _api(db, client) -> TestClient:
    from app.api import auth, subscription_routes

    app = FastAPI()
    app.include_router(subscription_routes.router)
    # subscription_routes aliases get_current_client_strict as get_current_client
    # (module line 18), so the real dependency to override is the strict one.
    app.dependency_overrides[auth.get_current_client_strict] = lambda: client
    return TestClient(app, raise_server_exceptions=False)


# ── Task 1: /geo display currency ─────────────────────────────────────────────


def test_geo_returns_inr_for_indian_buyer(db, monkeypatch):
    from app.api import subscription_routes

    client = _make_client(db, email="geo-in@e.com")
    db.commit()
    monkeypatch.setattr(subscription_routes, "resolve_country", lambda request: "IN")

    api = _api(db, client)
    res = api.get("/subscriptions/geo")

    assert res.status_code == 200, res.text
    assert res.json()["display_currency"] == "INR"
    assert res.json()["country"] == "IN"


def test_geo_returns_usd_for_foreign_buyer(db, monkeypatch):
    from app.api import subscription_routes

    client = _make_client(db, email="geo-us@e.com")
    db.commit()
    monkeypatch.setattr(subscription_routes, "resolve_country", lambda request: "US")

    api = _api(db, client)
    res = api.get("/subscriptions/geo")

    assert res.status_code == 200, res.text
    assert res.json()["display_currency"] == "USD"
    assert res.json()["country"] == "US"


def test_geo_prefers_stored_billing_country_over_ip(db, monkeypatch):
    # A saved billing_country is authoritative: an Indian who set IN stays on
    # INR even when the IP geo mis-detects them abroad (and vice-versa).
    from app.api import subscription_routes

    client = _make_client(db, email="geo-stored@e.com")
    client.billing_country = "IN"
    db.commit()
    monkeypatch.setattr(subscription_routes, "resolve_country", lambda request: "US")

    api = _api(db, client)
    res = api.get("/subscriptions/geo")

    assert res.status_code == 200, res.text
    assert res.json()["country"] == "IN"
    assert res.json()["display_currency"] == "INR"


# ── Task 2: /checkout/quote currency routing ──────────────────────────────────


def test_checkout_quote_inr_for_indian_buyer(db, monkeypatch):
    from app.api import subscription_routes

    client = _make_client(db, email="quote-in@e.com")
    plan = _make_plan(db, slug="starter-in", monthly_price_cents=179900, monthly_price_usd_cents=1900)
    db.commit()
    monkeypatch.setattr(subscription_routes, "resolve_country", lambda request: "IN")

    api = _api(db, client)
    with patch.object(subscription_routes, "get_session", lambda: _session_cm(db)):
        res = api.get(f"/subscriptions/checkout/quote?plan_id={plan.id}&billing_cycle=monthly")

    body = res.json()
    assert res.status_code == 200, res.text
    assert body["country"] == "IN"
    assert body["currency"] == "INR"
    assert body["amount_minor"] == 179900
    assert body["amount_display"] == "₹1,799"
    assert body["methods"] == ["card", "upi"]
    assert body["checkout_supported"] is True


def test_checkout_quote_usd_pending_for_foreign_buyer(db, monkeypatch):
    from app.api import subscription_routes

    client = _make_client(db, email="quote-us@e.com")
    plan = _make_plan(db, slug="starter-us", monthly_price_cents=179900, monthly_price_usd_cents=1900)
    db.commit()
    monkeypatch.setattr(subscription_routes, "resolve_country", lambda request: "US")

    api = _api(db, client)
    with patch.object(subscription_routes, "get_session", lambda: _session_cm(db)):
        res = api.get(f"/subscriptions/checkout/quote?plan_id={plan.id}&billing_cycle=monthly&billing_country=US")

    body = res.json()
    assert res.status_code == 200, res.text
    assert body["currency"] == "USD"
    assert body["amount_minor"] == 1900
    assert body["methods"] == []
    assert body["checkout_supported"] is False
    assert body["reason"] == "intl_usd_pending"


def test_checkout_quote_confirmed_country_overrides_ip(db, monkeypatch):
    from app.api import subscription_routes

    client = _make_client(db, email="quote-override@e.com")
    plan = _make_plan(db, slug="starter-ov", monthly_price_cents=179900, monthly_price_usd_cents=1900)
    db.commit()
    # IP mis-detects as US, but the buyer confirms IN — INR must win (FEMA-safe).
    monkeypatch.setattr(subscription_routes, "resolve_country", lambda request: "US")

    api = _api(db, client)
    with patch.object(subscription_routes, "get_session", lambda: _session_cm(db)):
        res = api.get(f"/subscriptions/checkout/quote?plan_id={plan.id}&billing_cycle=monthly&billing_country=IN")

    body = res.json()
    assert res.status_code == 200, res.text
    assert body["currency"] == "INR"
    assert body["checkout_supported"] is True


def test_checkout_quote_never_advertises_zero_dollar_checkout(db, monkeypatch):
    """F6 — a wired USD Razorpay plan id with a NULL/0 *_usd_cents column must
    NOT produce amount_display '$0' with checkout_supported=true: the immutable
    gateway plan bills its real amount. An unpriced USD tier is intl-pending."""
    from app.api import subscription_routes

    client = _make_client(db, email="quote-zero-usd@e.com")
    plan = _make_plan(
        db,
        slug="starter-zero-usd",
        monthly_price_cents=179900,
        monthly_price_usd_cents=0,  # USD price never configured
        razorpay_plan_id_monthly_usd="plan_usd_wired",
    )
    db.commit()
    monkeypatch.setattr(subscription_routes, "resolve_country", lambda request: "US")
    monkeypatch.setattr(subscription_routes, "INTL_PAYMENTS_ENABLED", True)

    api = _api(db, client)
    with patch.object(subscription_routes, "get_session", lambda: _session_cm(db)):
        res = api.get(f"/subscriptions/checkout/quote?plan_id={plan.id}&billing_cycle=monthly&billing_country=US")

    body = res.json()
    assert res.status_code == 200, res.text
    assert body["checkout_supported"] is False
    assert body["reason"] == "intl_usd_pending"


def test_checkout_quote_supports_priced_usd_tier_with_flag_on(db, monkeypatch):
    """Control for the F6 guard: a properly priced + wired USD tier stays a
    supported checkout."""
    from app.api import subscription_routes

    client = _make_client(db, email="quote-usd-ok@e.com")
    plan = _make_plan(
        db,
        slug="starter-usd-ok",
        monthly_price_cents=179900,
        monthly_price_usd_cents=1900,
        razorpay_plan_id_monthly_usd="plan_usd_ok",
    )
    db.commit()
    monkeypatch.setattr(subscription_routes, "resolve_country", lambda request: "US")
    monkeypatch.setattr(subscription_routes, "INTL_PAYMENTS_ENABLED", True)

    api = _api(db, client)
    with patch.object(subscription_routes, "get_session", lambda: _session_cm(db)):
        res = api.get(f"/subscriptions/checkout/quote?plan_id={plan.id}&billing_cycle=monthly&billing_country=US")

    body = res.json()
    assert res.status_code == 200, res.text
    assert body["currency"] == "USD"
    assert body["amount_minor"] == 1900
    assert body["checkout_supported"] is True
