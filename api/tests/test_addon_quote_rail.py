"""What the billing surfaces QUOTE must be what the mandate actually mints.

``Plan.currency`` is "INR" on every row: the USD rail lives in the
``*_price_usd_cents`` columns, and which rail a customer is charged on is
decided by ``charge_currency(client.billing_country)``. The seat, branding and
plan prices on ``GET /subscriptions/current`` and ``POST /subscriptions/seats``
were derived from ``Plan.currency``, so an international customer was quoted the
rupee price plus 18% GST while ``create_seat_addon_subscription`` minted a USD
plan for the dollar price with no GST (a USD sale is a zero-rated export). The
customer read one number on the card and was debited a different one, in a
different currency.

These tests pin the quote against the charge path itself: the assertion is not
"the number equals a constant" but "the number equals what Razorpay was told to
bill".

Real Postgres via the shared ``db`` fixture. Skips without DB_URL.
"""

from __future__ import annotations

import os
from contextlib import contextmanager
from datetime import UTC, datetime
from unittest.mock import MagicMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import config as app_config
from app.db.models import Client, Plan, Subscription
from app.services import razorpay_service
from app.services.seller_profile_service import charge_tax_rate_bps

pytestmark = pytest.mark.skipif(
    not os.getenv("DB_URL"),
    reason="rail-quote tests need a reachable Postgres at DB_URL",
)

MONTHLY_INR_CENTS = 119900
ANNUAL_INR_CENTS = 1199000
MONTHLY_USD_CENTS = 4900
ANNUAL_USD_CENTS = 49000


@contextmanager
def _session_cm(session):
    yield session


@pytest.fixture()
def gst_registered(db):
    """A GSTIN on the seller profile is what turns the domestic uplift on.

    Without it ``charge_tax_rate_bps`` answers 0 by design (do not collect a tax
    you are not registered for), and every INR assertion here would pass for the
    wrong reason.
    """
    from app.db.models import PricingConfig
    from app.services.seller_profile_service import SELLER_PROFILE_KEY

    db.add(
        PricingConfig(
            key=SELLER_PROFILE_KEY,
            value={"legal_name": "OyeChats", "gstin": "27AAAAA0000A1Z5", "state_code": "27", "tax_rate_bps": 1800},
        )
    )
    db.flush()
    return db


def _client(db, *, email: str, billing_country: str | None) -> Client:
    row = Client(
        name="c",
        email=email,
        api_key=email,
        hashed_password="h",
        billing_country=billing_country,
    )
    db.add(row)
    db.flush()
    return row


def _plan(db, *, slug: str) -> Plan:
    plan = Plan(
        name=slug.title(),
        slug=slug,
        currency="INR",
        monthly_price_cents=MONTHLY_INR_CENTS,
        annual_price_cents=ANNUAL_INR_CENTS,
        monthly_price_usd_cents=MONTHLY_USD_CENTS,
        annual_price_usd_cents=ANNUAL_USD_CENTS,
        credits_per_month=1000,
        included_operator_seats=1,
        is_active=True,
    )
    db.add(plan)
    db.flush()
    return plan


def _subscription(db, client: Client, plan: Plan) -> Subscription:
    sub = Subscription(
        client_id=client.id,
        plan_id=plan.id,
        bot_id=None,
        status="active",
        payment_provider="razorpay",
        billing_cycle="monthly",
        razorpay_subscription_id=f"sub_{client.email}",
        current_period_start=datetime(2026, 1, 1, tzinfo=UTC),
        current_period_end=datetime(2026, 1, 31, tzinfo=UTC),
    )
    sub.plan = plan
    db.add(sub)
    db.flush()
    return sub


def _current_response(db, client: Client):
    from app.api import auth, subscription_routes

    app = FastAPI()
    app.include_router(subscription_routes.router)
    app.dependency_overrides[auth.get_current_client_or_operator] = lambda: {"client_id": client.id}
    api = TestClient(app, raise_server_exceptions=False)
    with patch.object(subscription_routes, "get_session", lambda: _session_cm(db)):
        return api.get("/subscriptions/current")


def _seats_response(db, client: Client, sub: Subscription) -> dict:
    """Drive POST /subscriptions/seats for a +1 seat change against an add-on
    mandate that already exists, so the response is the pure quote."""
    from app.api import subscription_routes

    with (
        patch.object(subscription_routes, "get_session", lambda: _session_cm(db)),
        patch.object(subscription_routes, "lock_client_for_billing", lambda *_a, **_k: None),
        patch.object(subscription_routes, "_resolve_target_subscription", lambda *_a, **_k: sub),
        patch.object(subscription_routes, "_require_precharge_gates", lambda *_a, **_k: "IN"),
        patch("app.services.razorpay_service.edit_seat_addon_quantity", return_value=None),
    ):
        return subscription_routes.change_seat_count(
            request=subscription_routes.SeatChangeRequest(delta=1),
            http_request=MagicMock(),
            client=client,
            _verified=client,
        )


def _minted_seat_plan(db, client: Client) -> tuple[int, str]:
    """Drive the real charge path and report the (amount, currency) Razorpay was
    told to bill for one seat."""
    rzp = MagicMock()
    rzp.plan.create.return_value = {"id": "plan_seat_minted"}
    rzp.subscription.create.return_value = {"id": "sub_seat_minted", "status": "created"}
    with (
        patch.object(razorpay_service, "_get_razorpay", return_value=rzp),
        patch.object(razorpay_service.config, "INTL_PAYMENTS_ENABLED", True),
    ):
        razorpay_service.create_seat_addon_subscription(db, client, extra_seats=1)
    item = rzp.plan.create.call_args.kwargs["data"]["item"]
    return int(item["amount"]), str(item["currency"])


# ── The international rail ───────────────────────────────────────────────────


def test_current_quotes_a_us_client_on_the_usd_rail(db):
    client = _client(db, email="us-current@e.com", billing_country="US")
    plan = _plan(db, slug="rail-us")
    _subscription(db, client, plan)
    db.commit()

    body = _current_response(db, client).json()

    # An export carries no Indian GST, so gross == base on every line.
    assert body["charge_currency"] == "USD"
    assert body["gross_extra_seat_price_cents"] == app_config.EXTRA_SEAT_PRICE_USD_CENTS
    assert body["gross_branding_addon_price_cents"] == app_config.BRANDING_ADDON_PRICE_USD_CENTS
    assert body["gross_monthly_price_cents"] == MONTHLY_USD_CENTS
    assert body["gross_annual_price_cents"] == ANNUAL_USD_CENTS


def test_the_quoted_seat_gross_equals_what_the_seat_mandate_mints_for_a_us_client(db):
    client = _client(db, email="us-seat@e.com", billing_country="US")
    plan = _plan(db, slug="rail-us-seat")
    _subscription(db, client, plan)
    db.commit()

    quoted = _current_response(db, client).json()
    minted_amount, minted_currency = _minted_seat_plan(db, client)

    assert (quoted["gross_extra_seat_price_cents"], quoted["charge_currency"]) == (minted_amount, minted_currency)


def test_the_seats_route_quotes_a_us_client_in_usd(db):
    client = _client(db, email="us-seats-route@e.com", billing_country="US")
    plan = _plan(db, slug="rail-us-route")
    sub = _subscription(db, client, plan)
    sub.operator_quantity = 1
    sub.seat_addon_subscription_id = "sub_seat_existing"
    db.commit()

    body = _seats_response(db, client, sub)
    minted_amount, minted_currency = _minted_seat_plan(db, client)

    assert body["currency"] == minted_currency == "USD"
    assert body["extra_seat_price_cents"] == app_config.EXTRA_SEAT_PRICE_USD_CENTS
    assert body["gross_extra_seat_price_cents"] == minted_amount


# ── The domestic rail is unchanged ───────────────────────────────────────────


def test_current_quotes_an_indian_client_on_the_inr_rail_with_gst(db, gst_registered):
    client = _client(db, email="in-current@e.com", billing_country="IN")
    plan = _plan(db, slug="rail-in")
    _subscription(db, client, plan)
    db.commit()

    rate_bps = charge_tax_rate_bps(db)
    body = _current_response(db, client).json()

    assert body["charge_currency"] == "INR"
    assert body["tax_rate_bps"] == rate_bps
    # GST is ADDED to the published base, so the gross must exceed it.
    assert body["gross_monthly_price_cents"] > MONTHLY_INR_CENTS
    assert body["gross_extra_seat_price_cents"] > app_config.RAZORPAY_SEAT_PLAN_PRICE_CENTS


def test_the_quoted_seat_gross_equals_what_the_seat_mandate_mints_for_an_indian_client(db, gst_registered):
    client = _client(db, email="in-seat@e.com", billing_country="IN")
    plan = _plan(db, slug="rail-in-seat")
    _subscription(db, client, plan)
    db.commit()

    quoted = _current_response(db, client).json()
    minted_amount, minted_currency = _minted_seat_plan(db, client)

    assert (quoted["gross_extra_seat_price_cents"], quoted["charge_currency"]) == (minted_amount, minted_currency)


def test_the_seats_route_quotes_an_indian_client_in_inr_with_gst(db, gst_registered):
    client = _client(db, email="in-seats-route@e.com", billing_country="IN")
    plan = _plan(db, slug="rail-in-route")
    sub = _subscription(db, client, plan)
    sub.operator_quantity = 1
    sub.seat_addon_subscription_id = "sub_seat_existing_in"
    db.commit()

    body = _seats_response(db, client, sub)
    minted_amount, minted_currency = _minted_seat_plan(db, client)

    assert body["currency"] == minted_currency == "INR"
    assert body["extra_seat_price_cents"] == app_config.RAZORPAY_SEAT_PLAN_PRICE_CENTS
    assert body["gross_extra_seat_price_cents"] == minted_amount


def test_an_unconfirmed_billing_country_stays_on_the_domestic_rail(db, gst_registered):
    """``charge_currency`` treats "not confirmed" as domestic. Every account
    predating country confirmation holds an INR mandate."""
    client = _client(db, email="null-country@e.com", billing_country=None)
    plan = _plan(db, slug="rail-null")
    _subscription(db, client, plan)
    db.commit()

    body = _current_response(db, client).json()

    assert body["charge_currency"] == "INR"
    assert body["gross_monthly_price_cents"] > MONTHLY_INR_CENTS
