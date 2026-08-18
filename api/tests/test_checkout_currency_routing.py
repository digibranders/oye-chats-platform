"""Currency routing for /geo and /checkout/quote. Geo-split billing model.

Indian buyers (country == "IN") see and pay INR; everyone else sees USD. The
confirmed ``billing_country`` (from the checkout country-confirmation step)
overrides IP geo so an Indian resident mis-detected abroad is never routed to
USD, and vice-versa (FEMA-safe).

Real-Postgres route tests via the shared ``db`` fixture (conftest). They build
the app inline, override client auth, and patch ``get_session`` /
``resolve_country``. Mirroring tests/test_billing_bl2_bl4.py. Skips without
DB_URL.
"""

from __future__ import annotations

import os
from contextlib import contextmanager
from unittest.mock import patch

import pytest
from fastapi import FastAPI, HTTPException, Request
from fastapi.testclient import TestClient

from app.db.models import Client, Plan

pytestmark = pytest.mark.skipif(
    not os.getenv("DB_URL"),
    reason="currency-routing route tests need a reachable Postgres at DB_URL",
)


@contextmanager
def _session_cm(session):
    yield session


def _bare_request() -> Request:
    """A header-less GET Request, for calling the charge gate directly.

    The gate reads geo only through ``subscription_routes.resolve_country``,
    which these tests monkeypatch. This just satisfies its signature with a
    real object instead of ``None``.
    """
    return Request({"type": "http", "method": "GET", "path": "/", "headers": [], "query_string": b""})


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


def test_geo_unresolved_country_reports_the_currency_the_charge_path_uses(db, monkeypatch):
    """No stored country and no resolvable IP → /geo must report INR.

    This is the ONE case where /geo's answer is unguarded: a *detected* foreign
    country 409s at ``_resolve_confirmed_billing_country_or_409``, and a stored
    non-IN one 409s too, but an unresolved country is waved through as domestic
    and charged in rupees. /geo used to map it to USD, so the top-up modal
    rendered $13/$50/$125 while Razorpay debited ₹1,000/₹4,000/₹10,000.

    Asserted against what the top-up gate actually confirms for the same client
    rather than a transcribed "INR", so the two cannot drift apart again.
    """
    from app.api import subscription_routes
    from app.core.pricing import charge_currency

    client = _make_client(db, email="geo-unresolved@e.com")
    assert client.billing_country is None
    db.commit()
    monkeypatch.setattr(subscription_routes, "resolve_country", lambda request: None)

    api = _api(db, client)
    res = api.get("/subscriptions/geo")

    assert res.status_code == 200, res.text
    body = res.json()
    assert body["country"] is None
    assert body["country_source"] is None

    # The country the INR-only top-up rail would actually charge this client on.
    charged_country = subscription_routes._resolve_confirmed_billing_country_or_409(
        request_country=None,
        client=client,
        http_request=_bare_request(),
        allow_usd=False,
    )
    assert body["display_currency"] == charge_currency(charged_country) == "INR"


def test_geo_keeps_usd_display_for_a_detected_foreign_country(db, monkeypatch):
    """The detected-country divergence is intentional and must survive the fix.

    IP geo is display-grade: it shows USD even though the charge path would
    confirm IN, and is safe only because the frontend never echoes it back as
    ``billing_country`` and the gate 409s ``billing_country_required`` when a
    foreign IP is the only signal. Pins ``country_source`` so a future
    "unify display with charge" change can't silently downgrade that signal.
    """
    from app.api import subscription_routes

    client = _make_client(db, email="geo-detected-foreign@e.com")
    assert client.billing_country is None
    db.commit()
    monkeypatch.setattr(subscription_routes, "resolve_country", lambda request: "US")

    api = _api(db, client)
    res = api.get("/subscriptions/geo")

    assert res.status_code == 200, res.text
    body = res.json()
    assert body["country"] == "US"
    assert body["country_source"] == "detected"
    assert body["display_currency"] == "USD"

    # ...and the gate that stops it becoming an INR debit.
    with pytest.raises(HTTPException) as exc:
        subscription_routes._resolve_confirmed_billing_country_or_409(
            request_country=None,
            client=client,
            http_request=_bare_request(),
            allow_usd=False,
        )
    assert exc.value.status_code == 409
    assert exc.value.detail["reason"] == "billing_country_required"


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
    # IP mis-detects as US, but the buyer confirms IN. INR must win (FEMA-safe).
    monkeypatch.setattr(subscription_routes, "resolve_country", lambda request: "US")

    api = _api(db, client)
    with patch.object(subscription_routes, "get_session", lambda: _session_cm(db)):
        res = api.get(f"/subscriptions/checkout/quote?plan_id={plan.id}&billing_cycle=monthly&billing_country=IN")

    body = res.json()
    assert res.status_code == 200, res.text
    assert body["currency"] == "INR"
    assert body["checkout_supported"] is True


def test_checkout_quote_never_advertises_zero_dollar_checkout(db, monkeypatch):
    """F6, a wired USD Razorpay plan id with a NULL/0 *_usd_cents column must
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


def test_domestic_quote_without_an_inr_plan_id_offers_contact_sales(db, monkeypatch):
    """The INR branch owes the buyer the same honesty as the USD one.

    ``razorpay_service.create_subscription`` rejects a missing INR plan id with
    a ValueError that ``/subscriptions/checkout`` renders verbatim as a 400, an
    internal "create the plan in the Razorpay dashboard" instruction shown to a
    customer who just clicked Subscribe on a quoted price. Quote the CTA instead.
    """
    from app.api import subscription_routes

    client = _make_client(db, email="quote-no-inr@e.com")
    plan = _make_plan(db, slug="starter-no-inr", monthly_price_cents=179900)
    plan.razorpay_plan_id_monthly = None  # tier priced but never wired for monthly
    db.commit()
    monkeypatch.setattr(subscription_routes, "resolve_country", lambda request: "IN")

    api = _api(db, client)
    with patch.object(subscription_routes, "get_session", lambda: _session_cm(db)):
        res = api.get(f"/subscriptions/checkout/quote?plan_id={plan.id}&billing_cycle=monthly")

    body = res.json()
    assert res.status_code == 200, res.text
    assert body["currency"] == "INR"
    assert body["amount_display"] == "₹1,799"  # still quoted. Only the CTA changes
    assert body["checkout_supported"] is False
    assert body["reason"] == "inr_plan_unconfigured"
    assert body["contact_sales"] == "developer@oyechats.com"
    assert body["provider"] is None


def test_domestic_quote_is_cycle_specific_about_the_missing_plan_id(db, monkeypatch):
    """Monthly unwired must not block the annual cycle the tier IS wired for."""
    from app.api import subscription_routes

    client = _make_client(db, email="quote-annual-inr@e.com")
    plan = _make_plan(db, slug="starter-annual-inr", monthly_price_cents=179900)
    plan.razorpay_plan_id_monthly = None
    db.commit()
    monkeypatch.setattr(subscription_routes, "resolve_country", lambda request: "IN")

    api = _api(db, client)
    with patch.object(subscription_routes, "get_session", lambda: _session_cm(db)):
        res = api.get(f"/subscriptions/checkout/quote?plan_id={plan.id}&billing_cycle=annual")

    body = res.json()
    assert res.status_code == 200, res.text
    assert body["checkout_supported"] is True
    assert body["provider"] == "razorpay"
    assert body["methods"] == ["card", "upi"]
