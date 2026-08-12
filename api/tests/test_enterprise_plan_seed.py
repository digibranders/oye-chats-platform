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

    assert ent["credits_per_month"] == 13000
    assert ent["monthly_price_cents"] == 479900  # ₹4,799
    assert ent["annual_price_cents"] == 4606800  # ₹46,068 (₹3,839/mo)
    assert ent["monthly_price_usd_cents"] == 9199  # $91.99
    assert ent["annual_price_usd_cents"] == 91188  # $911.88 ($75.99/mo)

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
