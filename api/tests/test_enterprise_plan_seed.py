"""The Enterprise plan row, and the catalogue-wide invariants around it.

Asserts the seed definition itself, not the DB. This is a pure data check
so it runs without Postgres. It is also the only place in ``api/tests`` that
imports ``_PLANS``, so the ladder and annual-discount guards below deliberately
cover every tier rather than just the Enterprise rung.
"""

from __future__ import annotations

import pytest

from app.core.pricing import annual_saving_percent
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

    # Everything Professional has.
    prof = _plan("professional")
    for flag, value in prof["features"].items():
        assert ent["features"][flag] == value, f"enterprise lost feature {flag}"


def test_no_plan_bundles_branding_removal():
    """Branding removal is sold ONLY as a paid add-on, never bundled in a tier.

    ``plan_entitlements_service`` overrides ``features.branding_removable`` from
    the subscription's add-on mandate and ignores this JSONB value entirely, so
    a ``True`` here would not actually grant anything. It would, however, be
    read straight into the pricing matrix and the plan cards, advertising a
    feature the plan does not include. Keep the seed honest.
    """
    for slug in _LADDER:
        assert _plan(slug)["features"]["branding_removable"] is False, f"{slug} must not bundle branding removal"


def test_enterprise_sorts_after_professional():
    assert _plan("enterprise")["sort_order"] > _plan("professional")["sort_order"]


@pytest.mark.parametrize("slug", _LADDER)
def test_limits_credits_mirrors_credits_per_month(slug: str):
    """One quantity, two fields. They must never disagree.

    ``credits_per_month`` is what actually grants credits (``credit_service``
    and ``plan_service``); ``limits["credits"]`` is a copy that no runtime path
    reads today but that ``GET /subscriptions/plans`` and
    ``GET /public/pricing-catalog`` both serialize verbatim. Enterprise shipped
    with 10,000 granted and 13,000 advertised. Invisible in the product,
    visible to anyone rendering the catalog, and a trap for the next surface
    wired to the limits map.
    """
    plan = _plan(slug)
    assert plan["limits"]["credits"] == plan["credits_per_month"], (
        f"{slug}: limits.credits {plan['limits']['credits']} disagrees with "
        f"credits_per_month {plan['credits_per_month']}"
    )


def test_the_ladder_covers_every_seeded_plan():
    """``_LADDER`` is the subject of every guard below. Keep it total and ordered."""
    assert {p["slug"] for p in _PLANS} == set(_LADDER)
    sort_orders = [_plan(slug)["sort_order"] for slug in _LADDER]
    assert sort_orders == sorted(sort_orders), f"_LADDER disagrees with sort_order: {sort_orders}"


@pytest.mark.parametrize("axis", _PRICE_AXES)
@pytest.mark.parametrize(("cheaper", "dearer"), list(zip(_LADDER, _LADDER[1:], strict=False)))
def test_the_price_ladder_never_inverts(axis: str, cheaper: str, dearer: str):
    """Every rung must cost strictly more than the one below it, on every axis.

    The ladder has inverted in production once already. Enterprise shipped at
    ₹2,799 against Professional's ₹2,999, a strictly better tier for less money.
    The guard written for it covered only that one rung, leaving free → starter
    → standard → professional untested on every axis, so this walks the whole
    ladder across all four (INR monthly/annual, USD monthly/annual).
    """
    assert _plan(dearer)[axis] > _plan(cheaper)[axis], (
        f"{dearer} must cost more than {cheaper} on {axis}: {_plan(dearer)[axis]} vs {_plan(cheaper)[axis]}"
    )


# The USD rail has no discount field of its own, so it can only be bounded, not
# pinned. The band is wide enough for the shipped spread (17.40%-20.00%) and
# narrow enough that a transposed or dropped digit fails.
_USD_SAVING_BAND_PCT = (15.0, 25.0)


@pytest.mark.parametrize("slug", _PAID)
def test_annual_is_cheaper_than_paying_monthly(slug: str):
    """An annual plan must never cost more than 12 monthly charges, on either rail.

    Commit ba22a0c shipped Professional annual at ₹36,000 against ₹2,399/mo
    (₹7,212 MORE than paying monthly) carried by an ``annual_discount_percent``
    of ``-25``. A tolerance guard alone cannot catch that: the stored int
    faithfully described the negative saving. Sign is a separate invariant.

    The percent is no longer authored in the matrix, so this asserts the DERIVED
    one is positive. That is a strictly weaker statement than it was (the helper
    floors an inverted pair to 0 rather than going negative) which is why the
    two raw price comparisons below carry the guard now.
    """
    plan = _plan(slug)
    assert annual_saving_percent(plan["monthly_price_cents"], plan["annual_price_cents"]) > 0, (
        f"{slug}: advertises a non-positive annual discount"
    )
    assert plan["annual_price_cents"] < plan["monthly_price_cents"] * 12, f"{slug}: INR annual is dearer than monthly"
    assert plan["annual_price_usd_cents"] < plan["monthly_price_usd_cents"] * 12, (
        f"{slug}: USD annual is dearer than monthly"
    )


# The whole percent each seeded tier advertises, derived from its INR prices.
# Written out rather than recomputed so a price move has to restate the headline
# it changes: these are the numbers the pricing page and the marketing site show.
_EXPECTED_SAVING_PCT: dict[str, int] = {
    "free": 0,  # no monthly price, nothing to save against
    "starter": 20,  # 20.033%
    "standard": 20,  # 20.017%
    "professional": 21,  # 21.674%. Stored as 22 until the percent became derived
    "enterprise": 20,  # 20.003%
}


@pytest.mark.parametrize("slug", _LADDER)
def test_the_advertised_annual_saving_is_the_derived_one(slug: str):
    """The percent every surface shows for this tier, pinned.

    ``annual_discount_percent`` is no longer a column anyone authors: the seed,
    the super-admin editor and all three read routes run the prices through
    ``core.pricing.annual_saving_percent``. What used to be a consistency guard
    between two independent values is therefore now a guard on the OUTPUT. Move
    an annual price and this test names the new headline you just published.

    **Floor, not round, and that is the whole point.** The value this replaces
    was ``round(saving)``, which is why Professional's 21.674% shipped as "save
    22%", a discount the plan does not give, printed next to a Subscribe button.
    Understating a saving costs nothing; overstating one misstates the price.

    **This bounds the INR rail only, and that is not an oversight.** One percent
    cannot describe two rails: on the same plans the USD savings are Starter
    18.77%, Standard 18.76%, Professional 17.40%, Enterprise 20.00%.
    Professional is 4.3pp adrift. The helper is currency-agnostic, so a surface
    that starts pricing in USD passes it that rail's two amounts; until one does,
    the INR figure is what ships and the USD rail keeps its own band guard below.
    """
    plan = _plan(slug)
    derived = annual_saving_percent(plan["monthly_price_cents"], plan["annual_price_cents"])
    assert derived == _EXPECTED_SAVING_PCT[slug], (
        f"{slug}: annual ₹{plan['annual_price_cents'] / 100:,.0f} against 12 × ₹"
        f"{plan['monthly_price_cents'] / 100:,.0f} now advertises {derived}%, not "
        f"{_EXPECTED_SAVING_PCT[slug]}%. Update _EXPECTED_SAVING_PCT if the price move was intended."
    )


@pytest.mark.parametrize("slug", _PAID)
def test_the_advertised_annual_saving_never_overstates_the_real_one(slug: str):
    """The published headline is never larger than the saving actually given.

    The pinned table above would still pass if the helper started rounding to
    nearest, so this states the property the pins cannot: derived ≤ true, and
    within one point of it (a floor can never lose more).
    """
    plan = _plan(slug)
    true_saving = _saving_percent(plan["monthly_price_cents"] * 12, plan["annual_price_cents"])
    derived = annual_saving_percent(plan["monthly_price_cents"], plan["annual_price_cents"])
    assert derived <= true_saving, f"{slug}: advertises {derived}% for a real saving of {true_saving:.3f}%. Overstated"
    assert true_saving - derived < 1, f"{slug}: {derived}% understates a {true_saving:.3f}% saving by over a point"


@pytest.mark.parametrize("slug", _PAID)
def test_annual_prices_are_twelve_whole_monthly_equivalents(slug: str):
    """Annual is always priced as a whole monthly-equivalent × 12, on both rails.

    Every annual amount in the catalogue is built this way (₹479 · ₹959 · ₹2,349
    · ₹4,799 and $6.49 · $12.99 · $37.99 · $71.99 per month). Asserting it is
    what pins the sub-percent residual the rounded-percent guard above leaves
    open: a stored percent can only ever describe the saving to the nearest
    point, so the price itself has to be on a whole monthly-equivalent step.
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
        f"saving, outside the {low}-{high}% band"
    )
