"""The quotation gate grants what the console says it grants.

Three places decided this and they disagreed. The console
(`app/src/lib/planGates.ts`) grants any slug off the seeded ladder, and its own
comment says "the server grants it; matching that here is what keeps the UI
from contradicting the API". The server did not: it used a bare set membership,
so a bespoke enterprise customer (`enterprise-acme`) saw the Quotations page
unlocked, configured a catalog, and got a 403 on save. The chat runtime, third,
checked no plan at all.

The server now uses `_paid_tier_includes`, the same two-part rule every other
paid gate on this platform uses, so this one moves with them instead of
drifting on its own.
"""

from __future__ import annotations

import pytest

from app.api.quotation_routes import QUOTATION_PLAN_SLUGS, _plan_allows_quotations


@pytest.mark.parametrize("slug", sorted(QUOTATION_PLAN_SLUGS))
def test_every_named_ladder_tier_is_granted(slug):
    assert _plan_allows_quotations(slug) is True


@pytest.mark.parametrize("slug", ["enterprise-acme", "acme-2026", "custom-deal"])
def test_a_bespoke_contract_slug_is_granted(slug):
    """The case that produced a 403 behind an unlocked page."""
    assert _plan_allows_quotations(slug) is True


@pytest.mark.parametrize("slug", ["free", "starter", "standard"])
def test_the_lower_ladder_tiers_are_denied(slug):
    assert _plan_allows_quotations(slug) is False


@pytest.mark.parametrize("slug", ["", "   ", None])
def test_an_unresolved_plan_denies(slug):
    """A blank slug is off the seeded ladder, so delegating it straight to
    ``_paid_tier_includes`` would read as bespoke and grant the feature to a
    plan that simply failed to resolve."""
    assert _plan_allows_quotations(slug) is False


def test_case_and_whitespace_do_not_change_the_answer():
    assert _plan_allows_quotations("  Professional  ") is True
    assert _plan_allows_quotations("FREE") is False
