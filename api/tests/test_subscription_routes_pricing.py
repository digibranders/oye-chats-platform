"""Locks the dual-currency contract used by checkout_quote and /geo.

These are pure unit tests over display_price — they do not hit the database
or the network. They exist to pin the rule: Indian visitors see INR paise,
everyone else sees the fixed USD column from the plan row.
"""

from __future__ import annotations

from app.core.pricing import display_price


def test_quote_indian_uses_inr():
    cents, cur = display_price(inr_paise=459900, usd_cents=4900, country="IN")
    assert (cents, cur) == (459900, "INR")


def test_quote_us_uses_usd_column():
    cents, cur = display_price(inr_paise=459900, usd_cents=4900, country="US")
    assert (cents, cur) == (4900, "USD")


def test_quote_null_country_treated_as_non_indian():
    cents, cur = display_price(inr_paise=179900, usd_cents=1900, country=None)
    assert (cents, cur) == (1900, "USD")


def test_quote_null_usd_falls_back_to_rate():
    # Plans without a USD column yet: convert via rate, don't crash.
    cents, cur = display_price(inr_paise=179900, usd_cents=None, country="US", rate=94.67)
    assert cur == "USD"
    assert 1890 <= cents <= 1910
