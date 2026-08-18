"""INTL_PAYMENTS_ENABLED must be enforced in the SERVICE layer (P1-2 / F8).

The flag previously gated only ``/checkout`` and the quote at the route layer.
``/change-plan``, ``/resume`` and ``/seats`` all reach
``create_subscription`` / ``create_seat_addon_subscription`` directly, so a
client with a stored non-IN ``billing_country`` could mint a USD mandate with
the kill switch OFF (or get an opaque 400 when the USD plan ids were unset).
The service now raises the typed ``IntlPaymentsDisabled``, which the app maps
to the same 409 ``intl_usd_pending`` contract the quote already renders.
"""

from __future__ import annotations

import os

import pytest

from app import config
from app.db.models import Client, Plan
from app.services import razorpay_service as rzp

pytestmark = pytest.mark.skipif(
    not os.getenv("DB_URL"),
    reason="intl kill-switch tests need a reachable Postgres at DB_URL",
)


class _ExplodingGateway:
    """Any attribute access means a gateway call was attempted. Fail loudly."""

    def __getattr__(self, name):  # noqa: ANN001
        raise AssertionError(f"gateway must not be reached (accessed .{name})")


def _usd_client(db) -> Client:
    client = Client(
        name="intl",
        email="intl@e.com",
        api_key="intl-key",
        hashed_password="h",
        billing_country="US",
    )
    db.add(client)
    db.flush()
    return client


def _usd_plan(db) -> Plan:
    plan = Plan(
        name="Pro",
        slug="pro-intl",
        monthly_price_cents=44900,
        monthly_price_usd_cents=900,
        annual_price_usd_cents=9000,
        credits_per_month=10000,
        razorpay_plan_id_monthly="plan_inr_m",
        razorpay_plan_id_monthly_usd="plan_usd_m",
        razorpay_plan_id_annual_usd="plan_usd_a",
    )
    db.add(plan)
    db.flush()
    return plan


def test_create_subscription_refuses_usd_with_flag_off(db, monkeypatch):
    client = _usd_client(db)
    plan = _usd_plan(db)
    db.commit()

    monkeypatch.setattr(config, "INTL_PAYMENTS_ENABLED", False)
    monkeypatch.setattr(rzp, "_get_razorpay", lambda: _ExplodingGateway())

    with pytest.raises(rzp.IntlPaymentsDisabled):
        rzp.create_subscription(db, client, plan, "monthly")


def test_create_subscription_allows_usd_with_flag_on(db, monkeypatch):
    """With the flag ON the same call must proceed to the gateway. Asserted by
    reaching the (faked) subscription.create with the USD plan id."""
    client = _usd_client(db)
    plan = _usd_plan(db)
    db.commit()

    created: dict = {}

    class _FakeGateway:
        class subscription:
            @staticmethod
            def create(data):
                created.update(data)
                return {"id": "sub_usd_1", "short_url": "https://rzp.io/x", "status": "created"}

    monkeypatch.setattr(config, "INTL_PAYMENTS_ENABLED", True)
    monkeypatch.setattr(rzp, "_get_razorpay", lambda: _FakeGateway())

    payload = rzp.create_subscription(db, client, plan, "monthly")
    assert payload["subscription_id"] == "sub_usd_1"
    assert created["plan_id"] == "plan_usd_m"


def test_inr_rail_unaffected_by_flag(db, monkeypatch):
    """The kill switch must never touch domestic (INR) checkout."""
    client = Client(
        name="dom",
        email="dom@e.com",
        api_key="dom-key",
        hashed_password="h",
        billing_country="IN",
    )
    db.add(client)
    plan = _usd_plan(db)
    db.commit()

    created: dict = {}

    class _FakeGateway:
        class subscription:
            @staticmethod
            def create(data):
                created.update(data)
                return {"id": "sub_inr_1", "short_url": "https://rzp.io/y", "status": "created"}

    monkeypatch.setattr(config, "INTL_PAYMENTS_ENABLED", False)
    monkeypatch.setattr(rzp, "_get_razorpay", lambda: _FakeGateway())

    payload = rzp.create_subscription(db, client, plan, "monthly")
    assert payload["subscription_id"] == "sub_inr_1"
    assert created["plan_id"] == "plan_inr_m"


def test_seat_addon_refuses_usd_with_flag_off(db, monkeypatch):
    client = _usd_client(db)
    db.commit()

    monkeypatch.setattr(config, "INTL_PAYMENTS_ENABLED", False)
    monkeypatch.setattr(rzp, "RAZORPAY_SEAT_PLAN_ID_USD", "plan_seat_usd")
    monkeypatch.setattr(rzp, "_get_razorpay", lambda: _ExplodingGateway())

    with pytest.raises(rzp.IntlPaymentsDisabled):
        rzp.create_seat_addon_subscription(db, client, extra_seats=1)


def test_handler_maps_to_intl_usd_pending_409():
    """The app-level handler must emit the exact contract the frontend already
    renders for the quote's coming-soon state."""
    import asyncio

    from app.core.middleware import intl_payments_disabled_handler

    response = asyncio.run(intl_payments_disabled_handler(None, rzp.IntlPaymentsDisabled("client 1 USD, flag off")))
    assert response.status_code == 409
    body = bytes(response.body).decode()
    assert "intl_usd_pending" in body


def test_handler_is_registered_on_the_app():
    from app.main import app

    assert rzp.IntlPaymentsDisabled in app.exception_handlers
