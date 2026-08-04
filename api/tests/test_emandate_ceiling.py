"""RBI E-mandate Framework 2026: recurring debit above Rs 15,000 per
transaction requires AFA on every charge, which breaks silent auto-renewal.

Professional annual is Rs 13,428 -- 10.5% below the ceiling. A routine price
rise would cross it and turn every annual renewal into a manual authentication
step, i.e. a churn event, with nothing in the code to say so.
"""

import pytest

from app.api.superadmin_plan_routes import EMANDATE_AFA_CEILING_MINOR, emandate_warning


def test_ceiling_is_fifteen_thousand_rupees_in_paise():
    assert EMANDATE_AFA_CEILING_MINOR == 1_500_000


@pytest.mark.parametrize("amount", [0, 94_900, 1_342_800, 1_499_999, 1_500_000])
def test_at_or_below_ceiling_is_clean(amount):
    assert emandate_warning(amount, "INR") is None


def test_above_ceiling_warns():
    warning = emandate_warning(1_500_100, "INR")
    assert warning is not None
    assert "15,000" in warning


def test_warning_reports_the_offending_amount():
    assert "20,000" in emandate_warning(2_000_000, "INR")


def test_non_inr_is_out_of_scope_for_the_paise_ceiling():
    # The framework covers cross-border too, but the threshold is expressed in
    # rupees; a USD amount cannot be compared against a paise figure. Plan C
    # resolves the FX-converted test once Razorpay confirms the treatment.
    assert emandate_warning(50_000, "USD") is None


def test_missing_currency_defaults_to_inr():
    """A NULL currency column must not silently skip the check."""
    assert emandate_warning(1_500_100, None) is not None


def test_none_amount_is_treated_as_zero():
    assert emandate_warning(None, "INR") is None
