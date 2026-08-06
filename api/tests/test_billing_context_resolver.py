"""Wave 1.2: one country/currency resolution for every quote and charge surface.

Before this, three surfaces resolved the billing country three different ways:

* ``checkout_quote``: param → stored → **IP geo**, and treated *unknown* as
  foreign (a brand-new Indian customer behind a failed geo lookup got a
  Contact-sales dead end);
* the charge path: param → stored → **silent IN default** — so a session whose
  quote said USD could be silently charged INR;
* ``/credits/balance``: **IP only** — a failed lookup rendered $ for a rupee
  account.

``core.pricing.resolve_billing_context`` is now the single resolution order
(request-confirmed → stored → detected → unresolved) with one currency mapping,
and the charge path adds two explicit refusals instead of silent coercion:

* detected-foreign with nothing confirmed/stored → 409 ``billing_country_required``
  (never charge INR when our only signal says the buyer is foreign);
* GSTIN on record with a confirmed non-IN country → 422 (a domestic GST
  registration cannot bill on the export rail — clear it first).
"""

import os
from contextlib import contextmanager
from unittest.mock import patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import config
from app.api import subscription_routes
from app.api.auth import get_current_client_strict, require_verified_email
from app.core.pricing import resolve_billing_context
from app.db.models import Client, Plan

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")


# ── Unit: the resolver itself ────────────────────────────────────────────────


def test_request_confirmation_wins():
    ctx = resolve_billing_context(stored_country="IN", request_country="us", detected_country="GB")
    assert (ctx.country, ctx.currency, ctx.source) == ("US", "USD", "request")


def test_stored_beats_detected():
    ctx = resolve_billing_context(stored_country="IN", request_country=None, detected_country="US")
    assert (ctx.country, ctx.currency, ctx.source) == ("IN", "INR", "stored")


def test_detected_used_last():
    ctx = resolve_billing_context(stored_country=None, request_country=None, detected_country="US")
    assert (ctx.country, ctx.currency, ctx.source) == ("US", "USD", "detected")


def test_unresolved_is_domestic_not_foreign():
    # charge_currency's documented rule: unconfirmed = domestic (every legacy
    # account has a NULL country and an INR mandate). The quote must agree.
    ctx = resolve_billing_context(stored_country=None, request_country=None, detected_country=None)
    assert (ctx.country, ctx.currency, ctx.source) == (None, "INR", "unresolved")


def test_blank_strings_are_unset():
    ctx = resolve_billing_context(stored_country="  ", request_country="", detected_country=None)
    assert ctx.source == "unresolved"


# ── Route harness ────────────────────────────────────────────────────────────


@contextmanager
def _ctx(session):
    yield session


def _plan(db, **overrides) -> Plan:
    payload = {
        "name": "Standard",
        "slug": "std-resolver",
        "monthly_price_cents": 94900,
        "annual_price_cents": 910800,
        "credits_per_month": 10_000,
        "included_operator_seats": 2,
        "is_active": True,
        "razorpay_plan_id_monthly": "plan_resolver_m",
        "razorpay_plan_id_annual": "plan_resolver_a",
    }
    payload.update(overrides)
    plan = Plan(**payload)
    db.add(plan)
    db.flush()
    return plan


def _mk(db, monkeypatch, *, detected=None, **client_kw):
    defaults = {
        "name": "Acme",
        "email": "resolver@test.example",
        "api_key": "key-resolver",
        "legal_name": "Acme Pvt Ltd",
        "billing_address": {"line1": "1 Lane", "city": "Mumbai", "postal_code": "400001"},
        "billing_state_code": "27",  # satisfy the domestic billing-identity gate
    }
    defaults.update(client_kw)
    client = Client(**defaults)
    db.add(client)
    db.flush()
    monkeypatch.setattr(subscription_routes, "get_session", lambda: _ctx(db))
    monkeypatch.setattr(subscription_routes, "resolve_country", lambda request: detected)
    app = FastAPI()
    app.include_router(subscription_routes.router)
    app.include_router(subscription_routes.credits_router)
    app.dependency_overrides[get_current_client_strict] = lambda: client
    app.dependency_overrides[require_verified_email] = lambda: client
    return TestClient(app, raise_server_exceptions=True), client


# ── Quote: unknown-unknown is domestic, not a dead end ───────────────────────


def test_quote_unknown_everything_is_domestic_inr(db, monkeypatch):
    api, _ = _mk(db, monkeypatch, detected=None)
    plan = _plan(db)
    res = api.get(f"/subscriptions/checkout/quote?plan_id={plan.id}&billing_cycle=monthly")
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["currency"] == "INR"
    assert body["checkout_supported"] is True  # was: contact-sales dead end
    assert body["source"] == "unresolved"


def test_quote_detected_foreign_still_quotes_usd(db, monkeypatch):
    api, _ = _mk(db, monkeypatch, detected="US")
    plan = _plan(db)
    res = api.get(f"/subscriptions/checkout/quote?plan_id={plan.id}&billing_cycle=monthly")
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["currency"] == "USD"
    assert body["source"] == "detected"


def test_quote_stored_country_beats_ip(db, monkeypatch):
    api, _ = _mk(db, monkeypatch, detected="US", billing_country="IN")
    plan = _plan(db)
    res = api.get(f"/subscriptions/checkout/quote?plan_id={plan.id}&billing_cycle=monthly")
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["currency"] == "INR"
    assert body["source"] == "stored"


# ── Charge: refuse, don't coerce ─────────────────────────────────────────────


def test_checkout_409s_when_only_signal_is_foreign_ip(db, monkeypatch):
    # Quote said USD (detected US); nothing stored, nothing confirmed. The old
    # charge path silently defaulted to IN and minted an INR mandate — the
    # quoted-USD/charged-INR divergence. Now: ask the customer to confirm.
    api, _ = _mk(db, monkeypatch, detected="US")
    plan = _plan(db)
    res = api.post("/subscriptions/checkout", json={"plan_id": plan.id, "billing_cycle": "monthly"})
    assert res.status_code == 409, res.text
    assert res.json()["detail"]["reason"] == "billing_country_required"


def test_checkout_proceeds_domestic_when_nothing_says_foreign(db, monkeypatch):
    # Legacy-safe: NULL country + no confirmation + IN/unknown detection stays
    # on the INR rail exactly as before.
    api, _ = _mk(db, monkeypatch, detected=None)
    plan = _plan(db)
    with patch(
        "app.services.razorpay_service.create_subscription",
        return_value={"subscription_id": "sub_ctx_ok", "key_id": "rzp_test", "provider": "razorpay"},
    ) as create:
        res = api.post("/subscriptions/checkout", json={"plan_id": plan.id, "billing_cycle": "monthly"})
    assert res.status_code == 200, res.text
    assert create.called


def test_checkout_422s_for_gstin_with_confirmed_foreign_country(db, monkeypatch):
    # A domestic GST registration cannot bill on the export rail. Refuse
    # loudly instead of any silent rail coercion — and check it BEFORE the
    # intl kill switch so the flag being off can't mask the contradiction.
    monkeypatch.setattr(config, "INTL_PAYMENTS_ENABLED", True)
    api, _ = _mk(
        db,
        monkeypatch,
        detected="IN",
        billing_country="IN",
        gstin="27AAPFU0939F1ZV",
        billing_state_code="27",
    )
    plan = _plan(db)
    res = api.post(
        "/subscriptions/checkout",
        json={"plan_id": plan.id, "billing_cycle": "monthly", "billing_country": "US"},
    )
    assert res.status_code == 422, res.text
    assert "gstin" in str(res.json()["detail"]).lower()


# ── Balance: stored-first currency, not IP-first ─────────────────────────────


def test_balance_currency_prefers_stored_country(db, monkeypatch):
    api, _ = _mk(db, monkeypatch, detected="US", billing_country="IN")
    _plan(db, is_default=True)  # balance resolves the client's plan; test DB has no seed
    res = api.get("/credits/balance")
    assert res.status_code == 200, res.text
    assert res.json()["currency"] == "INR"


def test_balance_currency_unknown_defaults_inr(db, monkeypatch):
    api, _ = _mk(db, monkeypatch, detected=None)
    _plan(db, is_default=True)  # balance resolves the client's plan; test DB has no seed
    res = api.get("/credits/balance")
    assert res.status_code == 200, res.text
    assert res.json()["currency"] == "INR"
