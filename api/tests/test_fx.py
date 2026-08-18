"""Foreign-exchange conversion for export invoices. Pure, integer-only.

Rule 34(2) CGST: the value of a taxable SERVICE supplied in foreign currency
is converted at the GAAP rate for the date of the time of supply. Razorpay's
``base_amount`` is the processing bank's realised conversion on the payment
date, which is that rate, so these tests pin the arithmetic that turns it into
a stored rate, and the guard that refuses an implausible one.
"""

import pytest

from app.core.fx import (
    MAX_PLAUSIBLE_RATE_MICROS,
    MIN_PLAUSIBLE_RATE_MICROS,
    FxError,
    convert_minor,
    implied_rate_micros,
)

# ── rate derivation ───────────────────────────────────────────────────────────


def test_implied_rate_from_razorpays_documented_example():
    # Razorpay's own currency-conversion doc: $1 (amount=100 cents) came back
    # with base_amount=7129 paise, i.e. ₹71.29 per USD.
    assert implied_rate_micros(100, 7129) == 71_290_000


def test_implied_rate_is_rounded_half_up_not_truncated():
    # 900 cents -> 80507 paise is 89.4522…; half-up to 6dp.
    assert implied_rate_micros(900, 80_507) == 89_452_222


def test_implied_rate_rejects_zero_foreign_amount():
    # A zero-amount charge has no meaningful rate; dividing by it would raise
    # deep inside finalize instead of at the boundary.
    with pytest.raises(FxError):
        implied_rate_micros(0, 7129)


@pytest.mark.parametrize("foreign_minor, inr_minor", [(-100, 7129), (100, -7129)])
def test_implied_rate_rejects_negative_amounts(foreign_minor, inr_minor):
    with pytest.raises(FxError):
        implied_rate_micros(foreign_minor, inr_minor)


# ── plausibility band ─────────────────────────────────────────────────────────
#
# The band exists for ONE failure mode: a unit mix-up. If base_amount ever
# arrives in rupees rather than paise (or the currency's minor-unit exponent
# differs, e.g. JPY), the implied rate lands 100x off. Minting a statutory
# document off by 100x is far worse than not minting one, so the band refuses.


def test_band_accepts_a_realistic_usd_rate():
    rate = implied_rate_micros(900, 80_507)  # ~89.45 INR/USD
    assert MIN_PLAUSIBLE_RATE_MICROS <= rate <= MAX_PLAUSIBLE_RATE_MICROS


def test_band_accepts_the_low_and_high_real_world_currencies():
    # AED ~23 INR and GBP ~113 INR must both sit inside the band, or a
    # legitimate supply would be refused.
    assert MIN_PLAUSIBLE_RATE_MICROS <= 23_000_000 <= MAX_PLAUSIBLE_RATE_MICROS
    assert MIN_PLAUSIBLE_RATE_MICROS <= 113_000_000 <= MAX_PLAUSIBLE_RATE_MICROS


def test_band_rejects_a_rate_100x_too_high():
    # base_amount delivered in rupees instead of paise.
    assert implied_rate_micros(900, 8_050_700) > MAX_PLAUSIBLE_RATE_MICROS


def test_band_rejects_a_rate_100x_too_low():
    assert implied_rate_micros(900, 805) < MIN_PLAUSIBLE_RATE_MICROS


# ── conversion ────────────────────────────────────────────────────────────────


def test_convert_minor_round_trips_the_captured_total():
    # The INR total must be the amount Razorpay actually converted, exactly,
    # not a re-derivation through the rounded rate, which would drift by a
    # paisa and break reconciliation against the settlement.
    rate = implied_rate_micros(900, 80_507)
    assert convert_minor(900, rate) == 80_507


def test_convert_minor_rounds_half_up():
    # 1 cent at 89.4522 -> 89.45 paise -> 89.
    assert convert_minor(1, 89_452_222) == 89


def test_convert_minor_of_zero_is_zero():
    # A zero-rated export has zero tax; converting it must not raise.
    assert convert_minor(0, 89_452_222) == 0


def test_convert_minor_rejects_a_negative_amount():
    with pytest.raises(FxError):
        convert_minor(-1, 89_452_222)


def test_convert_minor_rejects_a_non_positive_rate():
    with pytest.raises(FxError):
        convert_minor(900, 0)
