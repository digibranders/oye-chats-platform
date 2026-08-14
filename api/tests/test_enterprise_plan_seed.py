"""The Enterprise plan row, and the catalogue-wide invariants around it.

Asserts the seed definition itself, not the DB — this is a pure data check
so it runs without Postgres. It is also the only place in ``api/tests`` that
imports ``_PLANS``, so the ladder and annual-discount guards below deliberately
cover every tier rather than just the Enterprise rung.
"""

from __future__ import annotations

import pytest

from scripts.seed_plans import _PLANS

# Cheapest → dearest. Every guard below walks this list, so a new tier that is
# not slotted into it fails ``test_the_ladder_covers_every_seeded_plan``
# rather than slipping through unguarded.
_LADDER: tuple[str, ...] = ("free", "starter", "standard", "professional", "enterprise")
_PAID: tuple[str, ...] = _LADDER[1:]

_PRICE_AXES: tuple[str, ...] = (
    "monthly_price_cents",
    "annual_price_cents",
    "monthly_price_usd_cents",
    "annual_price_usd_cents",
)


def _plan(slug: str) -> dict:
    for p in _PLANS:
        if p["slug"] == slug:
            return p
    raise AssertionError(f"plan {slug!r} not in _PLANS")


def _saving_percent(full_price: int, annual_price: int) -> float:
    """Discount the annual price represents against 12 × the monthly price."""
    return (full_price - annual_price) / full_price * 100


def test_enterprise_plan_exists_with_agency_entitlements():
    ent = _plan("enterprise")

    assert ent["credits_per_month"] == 10000
    assert ent["monthly_price_cents"] == 599900  # ₹5,999
    assert ent["annual_price_cents"] == 5758800  # ₹57,588 (₹4,799/mo × 12)
    assert ent["monthly_price_usd_cents"] == 8999  # $89.99
    assert ent["annual_price_usd_cents"] == 86388  # $863.88 ($71.99/mo × 12)

    # Unlimited is -1 everywhere in this codebase.
    assert ent["limits"]["bots"] == -1
    assert ent["limits"]["operators"] == -1
    assert ent["limits"]["knowledge_characters"] == -1
    assert ent["limits"]["documents"] == -1
    assert ent["limits"]["page_scraping"] == -1

    # Everything Professional has, plus white-label included (not an add-on).
    prof = _plan("professional")
    for flag, value in prof["features"].items():
        assert ent["features"][flag] == value, f"enterprise lost feature {flag}"
    assert ent["features"]["branding_removable"] is True


def test_enterprise_sorts_after_professional():
    assert _plan("enterprise")["sort_order"] > _plan("professional")["sort_order"]


def test_the_ladder_covers_every_seeded_plan():
    """``_LADDER`` is the subject of every guard below — keep it total and ordered."""
    assert {p["slug"] for p in _PLANS} == set(_LADDER)
    sort_orders = [_plan(slug)["sort_order"] for slug in _LADDER]
    assert sort_orders == sorted(sort_orders), f"_LADDER disagrees with sort_order: {sort_orders}"


@pytest.mark.parametrize("axis", _PRICE_AXES)
@pytest.mark.parametrize(("cheaper", "dearer"), list(zip(_LADDER, _LADDER[1:], strict=False)))
def test_the_price_ladder_never_inverts(axis: str, cheaper: str, dearer: str):
    """Every rung must cost strictly more than the one below it, on every axis.

    The ladder has inverted in production once already — Enterprise shipped at
    ₹2,799 against Professional's ₹2,999, a strictly better tier for less money.
    The guard written for it covered only that one rung, leaving free → starter
    → standard → professional untested on every axis, so this walks the whole
    ladder across all four (INR monthly/annual, USD monthly/annual).
    """
    assert _plan(dearer)[axis] > _plan(cheaper)[axis], (
        f"{dearer} must cost more than {cheaper} on {axis}: {_plan(dearer)[axis]} vs {_plan(cheaper)[axis]}"
    )


# The tightest bound the shipped catalogue permits. Professional is the binding
# case: ₹2,349/mo × 12 is a 21.674% saving carried by an int that reads "22",
# a 0.326pp gap that no amount of tightening removes without moving a price.
# The previous guard used round(), i.e. ±0.5pp — ±₹360/yr of unnoticed drift on
# Enterprise. This allows ±₹252/yr, and the ×12 guard below pins what is left to
# whole-rupee steps.
_INR_DISCOUNT_TOLERANCE_PP = 0.35

# The USD rail has no discount field of its own, so it can only be bounded, not
# pinned. The band is wide enough for the shipped spread (17.40%–20.00%) and
# narrow enough that a transposed or dropped digit fails.
_USD_SAVING_BAND_PCT = (15.0, 25.0)


@pytest.mark.parametrize("slug", _PAID)
def test_annual_is_cheaper_than_paying_monthly(slug: str):
    """An annual plan must never cost more than 12 monthly charges, on either rail.

    Commit ba22a0c shipped Professional annual at ₹36,000 against ₹2,399/mo —
    ₹7,212 MORE than paying monthly — carried by an ``annual_discount_percent``
    of ``-25``. A tolerance guard alone cannot catch that: the stored int
    faithfully described the negative saving. Sign is a separate invariant.
    """
    plan = _plan(slug)
    assert plan["annual_discount_percent"] > 0, f"{slug}: advertises a non-positive annual discount"
    assert plan["annual_price_cents"] < plan["monthly_price_cents"] * 12, f"{slug}: INR annual is dearer than monthly"
    assert plan["annual_price_usd_cents"] < plan["monthly_price_usd_cents"] * 12, (
        f"{slug}: USD annual is dearer than monthly"
    )


@pytest.mark.parametrize("slug", _PAID)
def test_annual_discount_percent_matches_the_inr_annual_price(slug: str):
    """``annual_discount_percent`` is displayed, so it must not lie about INR.

    **This guard bounds the INR rail only, and that is not an oversight.** One
    int cannot describe two rails: against the same stored percent the actual
    USD savings are Starter 18.77%, Standard 18.76%, Professional 17.40%,
    Enterprise 20.00% — Professional is 4.6pp adrift. Tightening this test to
    cover USD would fail on shipped prices, so the USD rail gets its own,
    weaker guard below and the honest statement of the gap lives here.

    INR gaps today: Enterprise 0.003pp, Standard 0.017pp, Starter 0.033pp,
    Professional 0.326pp.
    """
    plan = _plan(slug)
    saving = _saving_percent(plan["monthly_price_cents"] * 12, plan["annual_price_cents"])
    assert abs(saving - plan["annual_discount_percent"]) <= _INR_DISCOUNT_TOLERANCE_PP, (
        f"{slug}: annual ₹{plan['annual_price_cents'] / 100:,.0f} is a {saving:.3f}% saving "
        f"but the plan advertises {plan['annual_discount_percent']}%"
    )


@pytest.mark.parametrize("slug", _PAID)
def test_annual_prices_are_twelve_whole_monthly_equivalents(slug: str):
    """Annual is always priced as a whole monthly-equivalent × 12, on both rails.

    Every annual amount in the catalogue is built this way (₹479 · ₹959 · ₹2,349
    · ₹4,799 and $6.49 · $12.99 · $37.99 · $71.99 per month). Asserting it
    removes the sub-unit slack the percentage tolerance above cannot close.
    """
    plan = _plan(slug)
    assert plan["annual_price_cents"] % 1200 == 0, f"{slug}: INR annual is not a whole ₹/mo × 12"
    assert plan["annual_price_usd_cents"] % 12 == 0, f"{slug}: USD annual is not a whole ¢/mo × 12"


@pytest.mark.parametrize("slug", _PAID)
def test_usd_annual_is_a_real_discount_within_band(slug: str):
    """The USD annual price must be a genuine, plausible discount.

    ``annual_discount_percent`` describes the INR rail (see above), so nothing
    in the data pins the USD annual amount. This bounds it instead: strictly
    cheaper than 12 × monthly, and inside a sane band.
    """
    plan = _plan(slug)
    low, high = _USD_SAVING_BAND_PCT
    saving = _saving_percent(plan["monthly_price_usd_cents"] * 12, plan["annual_price_usd_cents"])
    assert low <= saving <= high, (
        f"{slug}: USD annual ${plan['annual_price_usd_cents'] / 100:,.2f} is a {saving:.2f}% "
        f"saving, outside the {low}–{high}% band"
    )
