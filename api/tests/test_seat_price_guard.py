"""Unit tests for the plan-edit seat-price drift guard (finding H3).

Extra seats always bill the single global seat add-on at the canonical price
(₹499 INR / $5 USD), so a plan row must never advertise a seat price it won't
actually charge. ``_reject_seat_price_drift`` enforces that at write time:
allow 0 (no paid seats) or the canonical value, reject anything else. Pure
function over a dict, no DB, no auth.
"""

from __future__ import annotations

import pytest
from fastapi import HTTPException

from app.api.superadmin_plan_routes import _reject_seat_price_drift
from app.config import EXTRA_SEAT_PRICE_USD_CENTS, RAZORPAY_SEAT_PLAN_PRICE_CENTS


def test_canonical_inr_and_usd_are_accepted():
    _reject_seat_price_drift(
        {
            "extra_seat_price_cents": RAZORPAY_SEAT_PLAN_PRICE_CENTS,
            "extra_seat_price_usd_cents": EXTRA_SEAT_PRICE_USD_CENTS,
        }
    )


def test_zero_is_accepted_for_no_seat_plans():
    _reject_seat_price_drift({"extra_seat_price_cents": 0, "extra_seat_price_usd_cents": 0})


def test_omitted_fields_are_untouched():
    # A partial update that never mentions seat pricing must pass.
    _reject_seat_price_drift({"name": "Pro", "monthly_price_cents": 99900})


def test_divergent_inr_seat_price_is_rejected():
    with pytest.raises(HTTPException) as exc:
        _reject_seat_price_drift({"extra_seat_price_cents": 39900})
    assert exc.value.status_code == 422
    assert "seat add-on" in exc.value.detail


def test_divergent_usd_seat_price_is_rejected():
    with pytest.raises(HTTPException) as exc:
        _reject_seat_price_drift({"extra_seat_price_usd_cents": 700})
    assert exc.value.status_code == 422
    assert "International seat price" in exc.value.detail


def test_canonical_values_match_the_expected_499_and_5():
    # Lock the actual configured price so a drift in config is caught here too.
    #
    # This figure is HALF of a pair. The Razorpay seat plan is immutable and its
    # amount IS the debit, so the plan behind ``RAZORPAY_SEAT_PLAN_ID`` must be
    # minted at base + GST (₹588.82 at 18%) whenever this base moves. Changing
    # this constant without repointing that id bills the old price while every
    # surface quotes the new one.
    assert RAZORPAY_SEAT_PLAN_PRICE_CENTS == 49900  # ₹499 base, exclusive of GST
    assert EXTRA_SEAT_PRICE_USD_CENTS == 500  # $5, an export, no GST uplift
