"""The dunning queue's money column is what the customer actually pays.

``GET /superadmin/billing/dunning`` is the save-call queue: who is failing
payment, how long they have left, and what the ONE cycle they are about to lose
is worth. ``_cycle_at_risk_minor`` was careful about two axes — annual vs
monthly, and the INR vs USD rail — and silent about a third.

A standing referral discount is applied by swapping in a DISCOUNTED Razorpay
plan (``razorpay_service.resolve_discounted_plan``), so it recurs on every
cycle, while entitlements — and this figure — follow the BASE plan. A customer
on a 50%-off code (``affiliate_service.MAX_CUSTOMER_DISCOUNT_BPS``) was
therefore shown, and counted into ``at_risk_by_currency`` as, twice what their
cycle is worth.
"""

from __future__ import annotations

import os
from contextlib import contextmanager

import pytest

from app.api import superadmin_routes_v2
from app.db.models import Affiliate, Client, Plan, ReferralCode, Subscription

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")


@contextmanager
def _ctx(session):
    yield session


@pytest.fixture()
def dunning(db, monkeypatch):
    monkeypatch.setattr(superadmin_routes_v2, "get_session", lambda: _ctx(db))

    plan = Plan(
        name="Standard",
        slug="standard",
        monthly_price_cents=200_000,  # ₹2,000
        annual_price_cents=2_000_000,  # ₹20,000
        monthly_price_usd_cents=2_500,
        annual_price_usd_cents=25_000,
    )
    db.add(plan)
    db.flush()

    codes = iter(range(1, 100))

    def _make(email: str, *, discount_bps: int | None, cycle: str = "monthly", country: str = "IN") -> Client:
        client = Client(name=email, email=email, api_key=f"key-{email}", billing_country=country)
        db.add(client)
        db.flush()
        if discount_bps is not None:
            affiliate = Affiliate(client_id=client.id, commission_bps=1000)
            db.add(affiliate)
            db.flush()
            code = ReferralCode(
                affiliate_id=affiliate.id,
                # ``chk_referral_code_format``: 3-20 of [A-Za-z0-9_-].
                code=f"CODE{next(codes)}",
                active=True,
                affiliate_commission_bps=1000,
                customer_discount_bps=discount_bps,
            )
            db.add(code)
            db.flush()
            client.referral_code_id = code.id
        db.add(
            Subscription(
                client_id=client.id,
                plan_id=plan.id,
                status="past_due",
                billing_cycle=cycle,
                operator_quantity=1,
            )
        )
        db.commit()
        return client

    return {"plan": plan, "make": _make}


def _item_for(email: str) -> dict:
    payload = superadmin_routes_v2.dunning_overview(_admin=None)
    return next(item for item in payload["items"] if item["client_email"] == email)


def test_a_discounted_customer_is_not_counted_at_list_price(db, dunning):
    """50% off is the platform's cap, so this is the worst case: a 2x overstate."""
    dunning["make"]("half@off.test", discount_bps=5000)
    item = _item_for("half@off.test")
    assert item["cycle_at_risk_minor"] == 100_000, "₹1,000 is what this mandate charges, not ₹2,000"
    assert item["discount_bps"] == 5000


def test_an_undiscounted_customer_is_unchanged(db, dunning):
    dunning["make"]("full@price.test", discount_bps=None)
    item = _item_for("full@price.test")
    assert item["cycle_at_risk_minor"] == 200_000
    assert item["discount_bps"] == 0


def test_a_deactivated_code_stops_discounting(db, dunning):
    """``resolve_customer_discount_bps`` is the charge path's own resolver."""
    client = dunning["make"]("stale@code.test", discount_bps=2500)
    code = db.get(ReferralCode, client.referral_code_id)
    code.active = False
    db.commit()
    assert _item_for("stale@code.test")["cycle_at_risk_minor"] == 200_000


def test_the_discount_applies_to_the_annual_cycle_too(db, dunning):
    dunning["make"]("annual@off.test", discount_bps=2000, cycle="annual")
    assert _item_for("annual@off.test")["cycle_at_risk_minor"] == 1_600_000


def test_the_discount_applies_on_the_usd_rail(db, dunning):
    """The rail picks the price column; the discount is a percentage of it."""
    dunning["make"]("usd@off.test", discount_bps=2000, country="US")
    item = _item_for("usd@off.test")
    assert item["currency"] == "USD"
    assert item["cycle_at_risk_minor"] == 2_000  # $25.00 less 20%


def test_the_currency_totals_use_the_discounted_figures(db, dunning):
    """``at_risk_by_currency`` is what a super admin reads as money at risk."""
    dunning["make"]("a@off.test", discount_bps=5000)
    dunning["make"]("b@full.test", discount_bps=None)
    payload = superadmin_routes_v2.dunning_overview(_admin=None)
    totals = {row["currency"]: row["minor"] for row in payload["at_risk_by_currency"]}
    assert totals == {"INR": 100_000 + 200_000}


def test_rounding_is_in_the_customers_favour(db, dunning):
    """Same integer floor as ``resolve_discounted_plan``, so the two agree."""
    dunning["make"]("odd@off.test", discount_bps=3333)
    # floor(200000 * 3333 / 10000) = 66660 off.
    assert _item_for("odd@off.test")["cycle_at_risk_minor"] == 200_000 - 66_660
