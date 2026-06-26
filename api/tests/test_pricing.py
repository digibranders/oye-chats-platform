"""Unit tests for the pure currency-display helper.

These lock the dual-currency display rule (billing ADR D2/D3): Indian
visitors read the INR column untouched; everyone else reads the fixed USD
column, with an INR→USD rate fallback only for legacy rows whose USD column
is still NULL. No database, no network — pure value logic.
"""

from __future__ import annotations

from app.core.pricing import display_price, format_amount


def test_indian_reads_inr_paise_directly():
    # Indian visitor sees the stored INR paise, no conversion.
    assert display_price(inr_paise=179900, usd_cents=1900, country="IN") == (179900, "INR")


def test_non_indian_reads_usd_column():
    # Non-Indian visitor sees the fixed USD column, no conversion.
    assert display_price(inr_paise=179900, usd_cents=1900, country="US") == (1900, "USD")


def test_unknown_geo_treated_as_non_indian():
    # None country (local dev / edge bypass) → USD path, per geo.py policy.
    assert display_price(inr_paise=459900, usd_cents=4900, country=None) == (4900, "USD")


def test_non_indian_with_null_usd_falls_back_to_rate():
    # Legacy row: usd_cents None → convert INR paise via rate (≈ $19 at 94.67).
    cents, currency = display_price(inr_paise=179900, usd_cents=None, country="US", rate=94.67)
    assert currency == "USD"
    assert 1890 <= cents <= 1910


def test_zero_rate_fallback_is_safe():
    # Defensive: a misconfigured zero rate must not divide-by-zero.
    assert display_price(inr_paise=179900, usd_cents=None, country="US", rate=0) == (0, "USD")


def test_format_amount_drops_trailing_zeros():
    assert format_amount(1900, "USD") == "$19"
    assert format_amount(179900, "INR") == "₹1,799"


def test_format_amount_keeps_cents_when_present():
    assert format_amount(15050, "USD") == "$150.50"


def test_format_amount_unknown_currency_prefixes_code():
    assert format_amount(1000, "EUR") == "EUR 10"
