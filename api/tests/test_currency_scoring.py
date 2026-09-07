"""Currency normalisation for budget scoring.

The bug this closes: budget rubrics are denominated in one currency (the BANT
preset is USD) but visitors state budgets in their own, and the LLM extractor
matched the RAW MAGNITUDE against those bands. "50,000 rupees per month"
(~$600) scored 25/25 -- the top "$20K+/mo" band -- a ~30x over-valuation that
silently ranked a small lead as the most valuable on the platform, invisible in
the transcript because the number is quoted back correctly and only the score
is wrong.
"""

from __future__ import annotations

import pytest

from app.services.currency_scoring import RATES_TO_USD, detect_money, normalization_hint


class TestDetectMoney:
    @pytest.mark.parametrize(
        ("text", "currency", "monthly"),
        [
            ("our budget is $5,000 per month", "USD", 5_000),
            ("500 USD per month", "USD", 500),
            ("we can do $5k/mo", "USD", 5_000),
            ("our budget is 50,000 rupees per month", "INR", 50_000),
            ("INR 50000", "INR", 50_000),
            ("Rs. 50,000 monthly", "INR", 50_000),
            ("₹5,00,000 per month", "INR", 500_000),
            ("€2000 per month", "EUR", 2_000),
            ("£15,000 per month", "GBP", 15_000),
            ("¥500,000 a month", "JPY", 500_000),
        ],
    )
    def test_reads_amount_and_currency(self, text, currency, monthly):
        found = detect_money(text)
        assert found is not None, text
        assert found.currency == currency
        assert found.per_month == pytest.approx(monthly, rel=0.01)

    def test_monthly_suffix_is_not_read_as_the_millions_scale(self):
        """Regression: the scale group matched the leading "m" of "monthly", so
        "Rs. 50,000 monthly" was read as 50 BILLION rupees."""
        found = detect_money("Rs. 50,000 monthly")
        assert found is not None
        assert found.per_month == pytest.approx(50_000)

    def test_annual_figures_are_spread_over_the_year(self):
        """Rubric bands are monthly; an annual total compared against them
        directly would read twelve times too large."""
        found = detect_money("we have 60000 USD per year")
        assert found is not None
        assert found.per_month == pytest.approx(5_000)

    @pytest.mark.parametrize(
        ("text", "monthly"),
        [("2 lakh per month", 200_000), ("5 lakhs a month", 500_000), ("1 crore per year", 10_000_000 / 12)],
    )
    def test_indian_numbering_without_a_currency_marker_reads_as_inr(self, text, monthly):
        """Lakh/crore are Indian numbering and are not used for any other
        currency in practice — a narrow, named inference, unlike guessing the
        currency of a bare number."""
        found = detect_money(text)
        assert found is not None
        assert found.currency == "INR"
        assert found.per_month == pytest.approx(monthly, rel=0.01)

    @pytest.mark.parametrize(
        "text",
        [
            "about 5k a month",  # no currency marker at all
            "5000",
            "50 million CVEs",  # a magnitude that is not money
            "no budget yet",
            "",
            None,
            12345,
        ],
    )
    def test_fails_closed_rather_than_guessing(self, text):
        """An unscored budget beats one scored 30x wrong, the same call the
        pricing gate makes about stale prices."""
        assert detect_money(text) is None

    def test_unknown_target_currency_fails_closed(self):
        assert detect_money("$5,000 per month", target_currency="XYZ") is None


class TestConversion:
    def test_the_reported_case_lands_in_the_right_band(self):
        """~$600/mo must read as "Under $1K/mo", NOT the $20K+ top band."""
        found = detect_money("our budget is 50,000 rupees per month")
        assert found is not None
        assert found.converted < 1_000

    def test_usd_is_unchanged(self):
        found = detect_money("$5,000 per month")
        assert found is not None
        assert found.converted == pytest.approx(5_000)

    def test_conversion_uses_the_table(self):
        found = detect_money("€2000 per month")
        assert found is not None
        assert found.converted == pytest.approx(2_000 * RATES_TO_USD["EUR"], rel=0.01)

    def test_every_rate_is_positive(self):
        assert all(rate > 0 for rate in RATES_TO_USD.values())
        assert RATES_TO_USD["USD"] == 1.0


class TestNormalizationHint:
    def test_hint_states_the_converted_figure(self):
        hint = normalization_hint("our budget is 50,000 rupees per month")
        assert hint is not None
        assert "USD" in hint
        assert "do NOT convert" in hint

    def test_no_hint_when_the_visitor_already_used_the_rubric_currency(self):
        """The prompt must stay byte-identical for the common USD case."""
        assert normalization_hint("$5,000 per month") is None

    def test_no_hint_when_nothing_is_detected(self):
        assert normalization_hint("we are just browsing") is None
        assert normalization_hint(None) is None
