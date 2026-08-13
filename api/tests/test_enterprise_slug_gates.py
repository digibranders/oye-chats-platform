"""Enterprise must appear in every plan-slug gate Professional appears in.

These gates key off `plan_slug` membership, not the plan's `features` dict, so
copying Professional's features in seed_plans.py does NOT grant them. Delta
recrawl is the costly one: without it Enterprise re-embeds every page on each
recrawl and charges credits for all of them.

Registering `enterprise` in `_SEEDED_PLAN_SLUGS` also REVOKES the rule-2
bespoke fallback in `_paid_tier_includes` (an off-ladder slug is a hand-
provisioned deal and is granted everything). Every gate routed through that
helper therefore has to name `enterprise` explicitly in the same change, or
adding the tier silently takes Visitor Intelligence and email verification
away from it. That coupling is what the `_paid_tier_includes` tests below pin.
"""

from __future__ import annotations

from app.services.plan_entitlements_service import (
    _SEEDED_PLAN_SLUGS,
    EMAIL_VERIFICATION_SLUGS,
    JOURNEY_ANALYTICS_SLUGS,
    LEAD_SOURCE_ATTRIBUTION_SLUGS,
    VISITOR_INTELLIGENCE_SLUGS,
    _paid_tier_includes,
)
from app.services.plan_service import _DELTA_RECRAWL_PLAN_SLUGS


def test_enterprise_is_a_seeded_plan():
    assert "enterprise" in _SEEDED_PLAN_SLUGS


def test_enterprise_gets_delta_recrawl():
    # Full recrawl on this tier would charge credits for every page.
    assert "enterprise" in _DELTA_RECRAWL_PLAN_SLUGS


def test_enterprise_gets_every_professional_slug_gate():
    for name, gate in [
        ("lead source attribution", LEAD_SOURCE_ATTRIBUTION_SLUGS),
        ("journey analytics", JOURNEY_ANALYTICS_SLUGS),
        ("email verification", EMAIL_VERIFICATION_SLUGS),
        ("visitor intelligence", VISITOR_INTELLIGENCE_SLUGS),
        ("delta recrawl", _DELTA_RECRAWL_PLAN_SLUGS),
    ]:
        assert "professional" in gate, f"{name}: test assumption wrong"
        assert "enterprise" in gate, f"{name}: enterprise excluded"


def test_enterprise_keeps_paid_tier_features_once_it_is_seeded():
    """Seeding the slug must not revoke what the bespoke fallback used to grant.

    Both helpers below route through `_paid_tier_includes`, so listing
    `enterprise` in `_SEEDED_PLAN_SLUGS` without also listing it in each ladder
    would flip these from True to False.
    """
    assert _paid_tier_includes("enterprise", VISITOR_INTELLIGENCE_SLUGS) is True
    assert _paid_tier_includes("enterprise", EMAIL_VERIFICATION_SLUGS) is True


def test_bespoke_and_lower_tiers_are_unchanged():
    """Purely additive: no existing slug's answer moves."""
    # A hand-provisioned deal slug is still off-ladder, so rule 2 still grants.
    assert _paid_tier_includes("enterprise-acme", EMAIL_VERIFICATION_SLUGS) is True
    assert _paid_tier_includes("enterprise-acme", VISITOR_INTELLIGENCE_SLUGS) is True
    # Seeded tiers below the ladder entry stay denied.
    for slug in ("free", "starter"):
        assert _paid_tier_includes(slug, EMAIL_VERIFICATION_SLUGS) is False
        assert _paid_tier_includes(slug, VISITOR_INTELLIGENCE_SLUGS) is False
        assert slug not in LEAD_SOURCE_ATTRIBUTION_SLUGS
        assert slug not in JOURNEY_ANALYTICS_SLUGS
        assert slug not in _DELTA_RECRAWL_PLAN_SLUGS
    # Standard keeps exactly what it had: the two ladder gates, not Visitor
    # Intelligence (Professional-only).
    assert "standard" in EMAIL_VERIFICATION_SLUGS
    assert _paid_tier_includes("standard", VISITOR_INTELLIGENCE_SLUGS) is False
