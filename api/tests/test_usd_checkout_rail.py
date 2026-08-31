"""Currency-aware plan selection, the USD (international) rail.

A Razorpay plan's currency is fixed at creation, so an international customer
must be billed against a *different* plan object than an Indian one. These
tests lock down the routing rule end to end:

* which currency a billing country resolves to (``app.core.pricing``),
* which Razorpay plan id ``create_subscription`` / the seat add-on pick,
* that a missing USD id fails loudly instead of silently charging INR,
* that discounted (referral) plans never leak across the currency boundary,
* and that the ``INTL_PAYMENTS_ENABLED`` flag is what opens the gate, with
  top-ups deliberately staying closed, because ``create_topup_order`` is still
  INR-only.

Service-level tests stay fully offline (the Razorpay SDK is mocked); the gate
and cache tests use the shared ``db`` fixture and skip without ``DB_URL``.
"""

from __future__ import annotations

import os
from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest


@pytest.fixture(autouse=True)
def _razorpay_keys(monkeypatch):
    """Dummy keys so ``RAZORPAY_ENABLED`` flips on. Mirrors test_razorpay_service."""
    monkeypatch.setenv("RAZORPAY_KEY_ID", "rzp_test_dummy")
    monkeypatch.setenv("RAZORPAY_KEY_SECRET", "secret_dummy")
    monkeypatch.setenv("RAZORPAY_WEBHOOK_SECRET", "whsec_dummy")
    from importlib import reload

    import app.config

    reload(app.config)
    import app.services.razorpay_service as svc

    reload(svc)
    yield


def _make_client(client_id: int = 42, *, billing_country: str | None = None) -> SimpleNamespace:
    return SimpleNamespace(
        id=client_id,
        name="Acme Inc",
        email="ops@acme.example",
        billing_country=billing_country,
    )


def _make_plan(**overrides) -> SimpleNamespace:
    base = {
        "id": 7,
        "name": "Starter",
        "slug": "starter",
        "currency": "INR",
        "monthly_price_cents": 44900,
        "annual_price_cents": 430800,
        "monthly_price_usd_cents": 900,
        "annual_price_usd_cents": 8400,
        "credits_per_month": 2000,
        "included_operator_seats": 1,
        "extra_seat_price_cents": 44900,
        "razorpay_plan_id_monthly": "plan_starter_inr_monthly",
        "razorpay_plan_id_annual": "plan_starter_inr_annual",
        "razorpay_plan_id_monthly_usd": "plan_starter_usd_monthly",
        "razorpay_plan_id_annual_usd": "plan_starter_usd_annual",
    }
    base.update(overrides)
    return SimpleNamespace(**base)


def _fake_rzp(sub_id: str = "sub_test") -> MagicMock:
    fake = MagicMock()
    fake.subscription.create.return_value = {"id": sub_id, "short_url": "https://rzp.io/x"}
    return fake


# ── Currency resolution ───────────────────────────────────────────────────────


@pytest.mark.parametrize("country", [None, "", "IN", "in", " in "])
def test_charge_currency_defaults_to_inr(country):
    """Unknown/absent country must stay on the domestic rail, an existing
    customer with no confirmed country is an INR customer, never a USD one."""
    from app.core.pricing import charge_currency

    assert charge_currency(country) == "INR"


@pytest.mark.parametrize("country", ["US", "us", "GB", "AE"])
def test_charge_currency_selects_usd_for_foreign_country(country):
    from app.core.pricing import charge_currency

    assert charge_currency(country) == "USD"


# ── create_subscription: plan-id selection ────────────────────────────────────
# These test RAIL SELECTION with the gate open, so they pin
# INTL_PAYMENTS_ENABLED=True explicitly, the service now enforces the kill
# switch itself (test_intl_kill_switch.py owns the flag-off behavior), and
# without the pin these pass or fail based on the local .env's flag value
# (CI runs with the flag off; a dev box testing the USD rail runs it on).


@pytest.fixture()
def _intl_on(monkeypatch):
    from app import config

    monkeypatch.setattr(config, "INTL_PAYMENTS_ENABLED", True)


def test_create_subscription_uses_usd_plan_for_foreign_client(_intl_on):
    from app.services import razorpay_service

    fake = _fake_rzp("sub_usd")
    with patch.object(razorpay_service, "_get_razorpay", return_value=fake):
        result = razorpay_service.create_subscription(
            MagicMock(), _make_client(billing_country="US"), _make_plan(), "monthly", discount_bps=0
        )

    sent = fake.subscription.create.call_args.kwargs["data"]
    assert sent["plan_id"] == "plan_starter_usd_monthly"
    assert result["billing_plan_id"] == "plan_starter_usd_monthly"


def test_create_subscription_uses_usd_annual_plan_for_foreign_client(_intl_on):
    from app.services import razorpay_service

    fake = _fake_rzp("sub_usd_annual")
    with patch.object(razorpay_service, "_get_razorpay", return_value=fake):
        razorpay_service.create_subscription(
            MagicMock(), _make_client(billing_country="GB"), _make_plan(), "annual", discount_bps=0
        )

    assert fake.subscription.create.call_args.kwargs["data"]["plan_id"] == "plan_starter_usd_annual"


@pytest.mark.parametrize("country", ["IN", None])
def test_create_subscription_keeps_inr_plan_for_domestic_and_unknown(country):
    from app.services import razorpay_service

    fake = _fake_rzp("sub_inr")
    with patch.object(razorpay_service, "_get_razorpay", return_value=fake):
        razorpay_service.create_subscription(
            MagicMock(), _make_client(billing_country=country), _make_plan(), "monthly", discount_bps=0
        )

    assert fake.subscription.create.call_args.kwargs["data"]["plan_id"] == "plan_starter_inr_monthly"


def test_create_subscription_refuses_foreign_client_without_usd_plan(_intl_on):
    """The dangerous failure is a silent INR fallback: a US customer charged
    ₹449 instead of $9. A missing USD id must raise instead.

    It raises ``PlanNotCheckoutable`` carrying ``intl_usd_pending`` (the code
    the USD branch of ``/checkout/quote`` already returns for the same plan) so
    the quote and the charge agree. The rail is asserted on the exception's
    ``currency``, not on the message: the message is the customer-facing
    sentence and deliberately names no gateway internals.
    """
    from app.services import razorpay_service

    plan = _make_plan(razorpay_plan_id_monthly_usd=None)
    fake = _fake_rzp()
    with (
        patch.object(razorpay_service, "_get_razorpay", return_value=fake),
        pytest.raises(razorpay_service.PlanNotCheckoutable) as excinfo,
    ):
        razorpay_service.create_subscription(
            MagicMock(), _make_client(billing_country="US"), plan, "monthly", discount_bps=0
        )

    assert excinfo.value.currency == "USD"
    assert excinfo.value.reason == "intl_usd_pending"
    assert "USD" in excinfo.value.ops_detail
    fake.subscription.create.assert_not_called()


# ── Seat add-on ───────────────────────────────────────────────────────────────


def test_seat_addon_uses_usd_seat_plan_for_foreign_client(_intl_on):
    """The rail still decides the plan; it is minted per rail rather than pinned.

    The seat plan is no longer read from ``RAZORPAY_SEAT_PLAN_ID(_USD)``. It is
    minted on demand and cached by charged amount, so what this pins now is that
    the mint is asked for the CLIENT's rail — a Razorpay plan's currency is fixed
    at creation, so getting this wrong bills an international customer in rupees.
    """
    from app.services import razorpay_service

    fake = _fake_rzp("sub_seat_usd")
    with (
        patch.object(razorpay_service, "_get_razorpay", return_value=fake),
        patch.object(razorpay_service, "charge_tax_rate_bps", return_value=1800),
        patch.object(razorpay_service, "resolve_seat_plan_id", return_value="plan_seat_usd") as mint,
    ):
        payload = razorpay_service.create_seat_addon_subscription(
            MagicMock(), _make_client(billing_country="US"), extra_seats=2
        )

    assert mint.call_args.kwargs["currency"] == "USD"
    assert fake.subscription.create.call_args.kwargs["data"]["plan_id"] == "plan_seat_usd"
    assert "$5" in payload["description"]


# ``test_seat_addon_refuses_foreign_client_without_usd_seat_plan`` was removed
# with the configuration it guarded. There is no longer a pinned
# ``RAZORPAY_SEAT_PLAN_ID_USD`` that can be left unset, because the plan is
# minted on demand for whichever rail the client is on. The refusal that still
# matters on this path — international payments switched off — is covered by
# ``test_seat_addon_*`` above via ``IntlPaymentsDisabled``.


def test_seat_addon_keeps_inr_seat_plan_for_domestic_client():
    from app.services import razorpay_service

    fake = _fake_rzp("sub_seat_inr")
    with (
        patch.object(razorpay_service, "_get_razorpay", return_value=fake),
        patch.object(razorpay_service, "charge_tax_rate_bps", return_value=1800),
        patch.object(razorpay_service, "resolve_seat_plan_id", return_value="plan_seat_inr") as mint,
    ):
        payload = razorpay_service.create_seat_addon_subscription(
            MagicMock(), _make_client(billing_country="IN"), extra_seats=1
        )

    assert mint.call_args.kwargs["currency"] == "INR"
    assert fake.subscription.create.call_args.kwargs["data"]["plan_id"] == "plan_seat_inr"
    # The base is named in the description, but asserting only on it stopped
    # pinning anything once the sheet started quoting the gross: "₹529.82
    # (₹449 + GST)" contains "₹449" too. Pin the rail instead, which is what
    # this test is actually about, and leave the tax wording to
    # test_razorpay_service's charged_price_display coverage.
    assert payload["description"].startswith("1 extra seat(s) - ₹")
    assert "$" not in payload["description"]


# ── Discounted (referral) plans must not cross the currency boundary ──────────

_db_only = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")


@contextmanager
def _session_cm(session):
    yield session


def _persist_plan(db, *, slug: str):
    from app.db.models import Plan

    plan = Plan(
        name=slug.title(),
        slug=slug,
        monthly_price_cents=44900,
        annual_price_cents=430800,
        monthly_price_usd_cents=900,
        annual_price_usd_cents=8400,
        credits_per_month=2000,
        included_operator_seats=1,
        is_active=True,
        razorpay_plan_id_monthly=f"plan_{slug}_inr_m",
        razorpay_plan_id_annual=f"plan_{slug}_inr_a",
        razorpay_plan_id_monthly_usd=f"plan_{slug}_usd_m",
        razorpay_plan_id_annual_usd=f"plan_{slug}_usd_a",
    )
    db.add(plan)
    db.flush()
    return plan


@_db_only
def test_discounted_plan_is_minted_in_usd_for_the_usd_rail(db):
    """A 10% discount on the USD rail must mint a USD plan at $8.10, not a
    rupee plan, and not the INR discounted amount tagged as dollars."""
    from app.services import razorpay_service

    plan = _persist_plan(db, slug="disc-usd")
    db.commit()

    fake = MagicMock()
    fake.plan.create.return_value = {"id": "plan_disc_usd"}
    with patch.object(razorpay_service, "_get_razorpay", return_value=fake):
        plan_id = razorpay_service.resolve_discounted_plan(db, plan, "monthly", 1000, currency="USD")

    item = fake.plan.create.call_args.kwargs["data"]["item"]
    assert plan_id == "plan_disc_usd"
    assert item["currency"] == "USD"
    assert item["amount"] == 810  # $9.00 − 10%


@_db_only
def test_discounted_plan_cache_does_not_leak_across_currencies(db):
    """Same base plan, cycle and discount on both rails must resolve to two
    different Razorpay plans, a shared cache row would bill a US customer in
    rupees (or an Indian customer in dollars)."""
    from app.services import razorpay_service

    plan = _persist_plan(db, slug="disc-both")
    db.commit()

    fake = MagicMock()
    fake.plan.create.side_effect = [{"id": "plan_disc_inr"}, {"id": "plan_disc_usd"}]
    with patch.object(razorpay_service, "_get_razorpay", return_value=fake):
        inr_id = razorpay_service.resolve_discounted_plan(db, plan, "monthly", 1000, currency="INR")
        usd_id = razorpay_service.resolve_discounted_plan(db, plan, "monthly", 1000, currency="USD")

    assert inr_id == "plan_disc_inr"
    assert usd_id == "plan_disc_usd"
    assert fake.plan.create.call_count == 2

    # And each rail keeps hitting its own cache row on the next resolve.
    with patch.object(razorpay_service, "_get_razorpay", return_value=fake):
        assert razorpay_service.resolve_discounted_plan(db, plan, "monthly", 1000, currency="USD") == "plan_disc_usd"
    assert fake.plan.create.call_count == 2


# ── Route gate: INTL_PAYMENTS_ENABLED opens USD checkout, never top-ups ───────


def _make_db_client(db, *, email: str, billing_country: str | None = None):
    from app.db.models import Client

    client = Client(
        name="c",
        email=email,
        api_key=email,
        hashed_password="h",
        is_verified=True,
        billing_country=billing_country,
        # Billing identity is a precondition for paid checkout (Rule 46 buyer
        # fields must be on record before the charge -- the invoice is issued
        # from a webhook, so there is no second chance to ask).
        legal_name="Test Buyer Pvt Ltd",
        billing_address={"line1": "1 MG Road", "city": "Pune", "postal_code": "411001"},
        billing_state_code="27",
    )
    db.add(client)
    db.flush()
    return client


def _api(client):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from app.api import auth, subscription_routes

    app = FastAPI()
    app.include_router(subscription_routes.router)
    # Top-ups live on their own /credits router. Mounted here so the shared
    # billing-country gate can be exercised on both money paths.
    app.include_router(subscription_routes.credits_router)
    app.dependency_overrides[auth.get_current_client_strict] = lambda: client
    return TestClient(app, raise_server_exceptions=False)


@_db_only
def test_checkout_allows_foreign_country_when_intl_enabled(db):
    from app.api import subscription_routes

    client = _make_db_client(db, email="usd-open@e.com")
    plan = _persist_plan(db, slug="usd-open")
    db.commit()

    api = _api(client)
    with (
        patch.object(subscription_routes, "get_session", lambda: _session_cm(db)),
        patch.object(subscription_routes, "lock_client_for_billing", lambda *a, **k: None),
        patch.object(subscription_routes, "RAZORPAY_ENABLED", True),
        patch.object(subscription_routes, "INTL_PAYMENTS_ENABLED", True),
        patch(
            "app.services.razorpay_service.create_subscription",
            return_value={"provider": "razorpay", "subscription_id": "sub_usd"},
        ),
    ):
        res = api.post(
            "/subscriptions/checkout",
            json={"plan_id": plan.id, "billing_cycle": "monthly", "billing_country": "US"},
        )

    assert res.status_code == 200, res.text
    db.refresh(client)
    assert client.billing_country == "US"


@_db_only
def test_checkout_still_rejects_foreign_country_while_intl_disabled(db):
    from app.api import subscription_routes

    client = _make_db_client(db, email="usd-closed@e.com")
    plan = _persist_plan(db, slug="usd-closed")
    db.commit()

    api = _api(client)
    with (
        patch.object(subscription_routes, "get_session", lambda: _session_cm(db)),
        patch.object(subscription_routes, "INTL_PAYMENTS_ENABLED", False),
    ):
        res = api.post(
            "/subscriptions/checkout",
            json={"plan_id": plan.id, "billing_cycle": "monthly", "billing_country": "US"},
        )

    assert res.status_code == 409, res.text
    assert res.json()["detail"]["reason"] == "intl_usd_pending"


@_db_only
def test_topup_rejects_foreign_country_even_when_intl_enabled(db):
    """``create_topup_order`` is still INR-only, so opening the subscription
    rail must not open the top-up rail. That would charge a US buyer rupees
    and invoice it as an export (the GST mis-classification this gate exists
    to prevent)."""
    from app.api import subscription_routes

    client = _make_db_client(db, email="usd-topup@e.com", billing_country="US")
    db.commit()

    api = _api(client)
    with (
        patch.object(subscription_routes, "get_session", lambda: _session_cm(db)),
        patch.object(subscription_routes, "INTL_PAYMENTS_ENABLED", True),
    ):
        res = api.post("/credits/topup", json={"amount": 1599})

    assert res.status_code == 409, res.text
    assert res.json()["detail"]["reason"] == "intl_usd_pending"


# ── Quote ─────────────────────────────────────────────────────────────────────


@_db_only
def test_quote_supports_usd_checkout_when_intl_enabled(db):
    from app.api import subscription_routes

    client = _make_db_client(db, email="quote-usd@e.com")
    plan = _persist_plan(db, slug="quote-usd")
    db.commit()

    api = _api(client)
    with (
        patch.object(subscription_routes, "get_session", lambda: _session_cm(db)),
        patch.object(subscription_routes, "INTL_PAYMENTS_ENABLED", True),
    ):
        res = api.get(
            "/subscriptions/checkout/quote",
            params={"plan_id": plan.id, "billing_cycle": "monthly", "billing_country": "US"},
        )

    assert res.status_code == 200, res.text
    body = res.json()
    assert body["currency"] == "USD"
    assert body["amount_minor"] == 900
    assert body["amount_display"] == "$9"
    assert body["checkout_supported"] is True
    assert body["provider"] == "razorpay"
    # Foreign cards only. UPI is a domestic rail and cannot settle a USD charge.
    assert body["methods"] == ["card"]


@_db_only
def test_quote_falls_back_to_contact_sales_when_usd_plan_ids_missing(db):
    """Flag on but the tier has no USD plan wired: the quote must NOT promise a
    checkout the charge path would reject."""
    from app.api import subscription_routes

    client = _make_db_client(db, email="quote-nousd@e.com")
    plan = _persist_plan(db, slug="quote-nousd")
    plan.razorpay_plan_id_monthly_usd = None
    db.commit()

    api = _api(client)
    with (
        patch.object(subscription_routes, "get_session", lambda: _session_cm(db)),
        patch.object(subscription_routes, "INTL_PAYMENTS_ENABLED", True),
    ):
        res = api.get(
            "/subscriptions/checkout/quote",
            params={"plan_id": plan.id, "billing_cycle": "monthly", "billing_country": "US"},
        )

    assert res.status_code == 200, res.text
    body = res.json()
    assert body["checkout_supported"] is False
    assert body["reason"] == "intl_usd_pending"
