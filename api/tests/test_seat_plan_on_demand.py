"""Seat plans are minted on demand and reused, instead of pinned in the env.

The old arrangement billed every extra seat against one plan id in
``RAZORPAY_SEAT_PLAN_ID``. Razorpay plans are immutable and a plan's amount IS
the debit, so a price change needed a plan minted by hand in the dashboard and
the variable repointed in the same breath. Doing one without the other left the
console quoting one figure while the mandate collected another. A discounted
seat could not be billed at all, because the pinned plan had exactly one amount.

What is pinned here is the arithmetic and the cache key, because those are what
make a wrong charge possible:

* the mint is uplifted for GST on the domestic rail and NOT on the export rail;
* a discount comes off the BASE and the tax is computed on what remains;
* the cache is keyed on the CHARGED amount, so a base-price change, a discount
  and a GST-rate change each mint their own plan rather than silently reusing a
  plan minted at yesterday's number.
"""

from __future__ import annotations

import os
from unittest.mock import patch

import pytest

from app.db.models import SeatPlanCache
from app.services import razorpay_service as rs

pytestmark = pytest.mark.skipif(
    not os.getenv("DB_URL"),
    reason="seat-plan cache test needs a reachable Postgres at DB_URL",
)


@pytest.fixture
def mint():
    """Stand in for the Razorpay mint, recording the base it was asked for."""
    calls: list[dict] = []

    def _fake(*, name, amount_paise, period, currency, rate_bps=None):
        calls.append(
            {
                "name": name,
                "amount_paise": amount_paise,
                "period": period,
                "currency": currency,
                "rate_bps": rate_bps,
            }
        )
        return f"plan_minted_{len(calls)}"

    with patch.object(rs, "create_plan_for_price", side_effect=_fake):
        yield calls


def test_the_domestic_rail_is_minted_at_base_plus_gst(db, mint):
    plan_id = rs.resolve_seat_plan_id(db, currency="INR", base_minor=49900, rate_bps=1800)

    assert plan_id == "plan_minted_1"
    # The BASE is handed to the minter, which does the uplift itself. Passing a
    # pre-uplifted figure would double-tax it.
    assert mint[0]["amount_paise"] == 49900
    assert mint[0]["currency"] == "INR"
    assert mint[0]["period"] == "monthly"

    # The row records what Razorpay will actually debit: ₹499 + 18% = ₹588.82.
    row = db.query(SeatPlanCache).one()
    assert row.amount_minor == 58882
    assert row.currency == "INR"


def test_the_export_rail_carries_no_indian_gst(db, mint):
    rs.resolve_seat_plan_id(db, currency="USD", base_minor=500, rate_bps=1800)

    row = db.query(SeatPlanCache).filter_by(currency="USD").one()
    assert row.amount_minor == 500  # $5, not $5.90


def test_the_same_price_is_minted_once_and_reused(db, mint):
    first = rs.resolve_seat_plan_id(db, currency="INR", base_minor=49900, rate_bps=1800)
    second = rs.resolve_seat_plan_id(db, currency="INR", base_minor=49900, rate_bps=1800)

    assert first == second
    assert len(mint) == 1, "a cache hit must not mint a second plan"
    assert db.query(SeatPlanCache).count() == 1


def test_a_new_price_mints_its_own_plan(db, mint):
    old = rs.resolve_seat_plan_id(db, currency="INR", base_minor=44900, rate_bps=1800)
    new = rs.resolve_seat_plan_id(db, currency="INR", base_minor=49900, rate_bps=1800)

    # The whole point: raising the price needs no dashboard visit and no env
    # repoint, and it cannot reuse the plan minted at the old amount.
    assert old != new
    assert len(mint) == 2
    assert {r.amount_minor for r in db.query(SeatPlanCache)} == {52982, 58882}


def test_a_gst_change_mints_a_fresh_plan_even_though_the_base_is_unmoved(db, mint):
    # Keyed on the charge, not the base. Keyed on the base, this would hand back
    # a plan collecting the old rate.
    at_18 = rs.resolve_seat_plan_id(db, currency="INR", base_minor=49900, rate_bps=1800)
    at_12 = rs.resolve_seat_plan_id(db, currency="INR", base_minor=49900, rate_bps=1200)

    assert at_18 != at_12
    assert len(mint) == 2


def test_a_discount_comes_off_the_base_before_tax(db, mint):
    # ₹499 less 20% is ₹399.20, and the GST is charged on that, not on ₹499.
    # Tax on the undiscounted base is the expensive direction of this mistake.
    rs.resolve_seat_plan_id(db, currency="INR", base_minor=39920, rate_bps=1800)

    row = db.query(SeatPlanCache).one()
    assert row.amount_minor == 47106  # 39920 * 1.18
    assert mint[0]["amount_paise"] == 39920


def test_the_two_rails_never_share_a_row(db, mint):
    # A Razorpay plan's currency is fixed at creation. Sharing one row across
    # rails would bill an international customer in rupees.
    inr = rs.resolve_seat_plan_id(db, currency="INR", base_minor=500, rate_bps=0)
    usd = rs.resolve_seat_plan_id(db, currency="USD", base_minor=500, rate_bps=0)

    assert inr != usd
    assert db.query(SeatPlanCache).count() == 2


def test_a_zero_price_is_refused_rather_than_minted(db, mint):
    # Free, the trial and Enterprise all carry a seat price of 0. None of them
    # sells seats, so reaching the mint with one is a bug upstream, and a
    # zero-amount Razorpay plan would be rejected by the gateway anyway.
    with pytest.raises(ValueError):
        rs.resolve_seat_plan_id(db, currency="INR", base_minor=0, rate_bps=1800)
    assert mint == []
