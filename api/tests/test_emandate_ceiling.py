"""RBI E-mandate Framework 2026: recurring debit above Rs 15,000 per
transaction requires AFA on every charge, which breaks silent auto-renewal.

The catalogue is already across the line — Professional annual is Rs 28,188
and Enterprise annual Rs 57,588 — and it got there through
``scripts/seed_plans.py``, which ran no check at all. So this file pins two
things: the rule itself, and the fact that BOTH writers of a plan price (the
super-admin editor and the seed) run that rule off the same constant.
"""

import contextlib

import pytest

from app.api import superadmin_plan_routes
from app.core.pricing import EMANDATE_AFA_CEILING_MINOR, emandate_warning
from app.db.models import Plan
from scripts import seed_plans

_ABOVE_CEILING = EMANDATE_AFA_CEILING_MINOR + 100
_BELOW_CEILING = EMANDATE_AFA_CEILING_MINOR - 100


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


# ── The two write paths ────────────────────────────────────────────────────


def _seed_entry(slug: str, *, monthly: int, annual: int) -> dict:
    return {"slug": slug, "monthly_price_cents": monthly, "annual_price_cents": annual}


def test_seed_warns_for_a_plan_priced_above_the_ceiling():
    """The case that matters: a price change through the seed is flagged."""
    warnings = seed_plans._emandate_warnings(_seed_entry("pro", monthly=299_900, annual=_ABOVE_CEILING))

    assert len(warnings) == 1
    assert warnings[0].startswith("pro annual: ")
    assert "15,000" in warnings[0]


def test_seed_is_silent_for_a_plan_priced_below_the_ceiling():
    assert seed_plans._emandate_warnings(_seed_entry("starter", monthly=59_900, annual=_BELOW_CEILING)) == []


def test_seed_flags_both_cycles_when_both_cross():
    warnings = seed_plans._emandate_warnings(_seed_entry("agency", monthly=_ABOVE_CEILING, annual=_ABOVE_CEILING * 12))

    assert [w.split(":")[0] for w in warnings] == ["agency monthly", "agency annual"]


def test_both_write_paths_agree_on_every_catalogue_entry():
    """The seed and the plan editor must never disagree about a price.

    They share :func:`app.core.pricing.emandate_warning`; this asserts the
    sharing is real by running the whole shipped matrix through both and
    comparing the warning bodies.
    """
    for data in seed_plans._PLANS:
        from_seed = [w.split(": ", 1)[1] for w in seed_plans._emandate_warnings(data)]
        from_route = superadmin_plan_routes._emandate_warnings(
            Plan(
                currency="INR",
                monthly_price_cents=data["monthly_price_cents"],
                annual_price_cents=data["annual_price_cents"],
            )
        )
        assert from_seed == from_route, f"{data['slug']}: seed and plan editor disagree"


def test_the_shipped_catalogue_warns_on_exactly_the_two_annual_tiers():
    """Documents the live breach, and fails the moment the set changes.

    Both directions are load-bearing: a new tier crossing the ceiling fails
    here, and so does re-pricing Professional or Enterprise annual back under
    it without updating this list.
    """
    offenders = [w.split(":")[0] for data in seed_plans._PLANS for w in seed_plans._emandate_warnings(data)]

    assert offenders == ["professional annual", "enterprise annual"]


def test_the_banner_names_every_offender_and_says_it_is_not_a_blocker(capsys):
    seed_plans._print_emandate_warnings(["professional annual: over", "enterprise annual: over"])

    out = capsys.readouterr().out
    assert "professional annual" in out
    assert "enterprise annual" in out
    assert "2 plan-cycles" in out
    assert "Not a blocker" in out


def test_the_banner_is_absent_when_nothing_crosses(capsys):
    seed_plans._print_emandate_warnings([])

    assert capsys.readouterr().out == ""


def _stub_empty_database(monkeypatch) -> None:
    """A session with no plan rows — enough for a dry-run over the matrix."""

    class _Result:
        def all(self):
            return []

    class _Session:
        def scalars(self, _stmt):
            return _Result()

    @contextlib.contextmanager
    def _fake_get_session():
        yield _Session()

    monkeypatch.setattr(seed_plans, "get_session", _fake_get_session)


def test_the_dry_run_warns_before_anything_is_written(monkeypatch, capsys):
    """The warning must reach the operator while the price is still changeable.

    A dry-run exists so a change can be inspected before it lands; a ceiling
    warning gated behind ``--apply`` would only ever appear after the price was
    already committed.
    """
    _stub_empty_database(monkeypatch)

    assert seed_plans.run(apply=False) == 0

    out = capsys.readouterr().out
    assert "DRY-RUN" in out
    assert "RBI E-MANDATE CEILING" in out
    assert "professional annual" in out
