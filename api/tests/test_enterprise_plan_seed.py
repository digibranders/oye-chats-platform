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
    assert ent["monthly_price_cents"] == 279900  # ₹2,799
    assert ent["annual_price_cents"] == 2686800  # ₹26,868 (₹2,239/mo × 12)
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
