"""The Enterprise plan row: unlimited bots/operators, pooled credits.

Asserts the seed definition itself, not the DB — this is a pure data check
so it runs without Postgres.
"""

from __future__ import annotations

from scripts.seed_plans import _PLANS


def _plan(slug: str) -> dict:
    for p in _PLANS:
        if p["slug"] == slug:
            return p
    raise AssertionError(f"plan {slug!r} not in _PLANS")


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


def test_enterprise_priced_above_professional():
    """The ladder must not invert — Enterprise carries more entitlements.

    Enterprise once sat at ₹2,799 against Professional's ₹2,999: a strictly
    better tier for less money on the INR rail.
    """
    ent, prof = _plan("enterprise"), _plan("professional")
    assert ent["monthly_price_cents"] > prof["monthly_price_cents"]
    assert ent["annual_price_cents"] > prof["annual_price_cents"]
    assert ent["monthly_price_usd_cents"] > prof["monthly_price_usd_cents"]
    assert ent["annual_price_usd_cents"] > prof["annual_price_usd_cents"]


def test_enterprise_annual_discount_matches_the_annual_price():
    """``annual_discount_percent`` is displayed, so it must track the real saving."""
    ent = _plan("enterprise")
    full = ent["monthly_price_cents"] * 12
    saving = (full - ent["annual_price_cents"]) / full * 100
    assert round(saving) == ent["annual_discount_percent"]
