"""The super-admin feature kill switch, tested against the real config keys.

This existed with ZERO coverage, and that is precisely why it was broken for
its whole life: `is_feature_enabled` read `feature.<name>`, while every place
that DEFINES the config — `_DEFAULT_PRICING` and `seed_pricing_config.py` —
writes `feature.<name>_enabled`. The key it read existed nowhere, and the
lookup fails open, so every switch was permanently ON.

The consequence was not theoretical. `feature.company_name_enabled` was seeded
False while the Visitor-Intelligence company lookup was unlaunched — the admin
UI badged it "Coming soon" and its own comment promised it "never charges" —
yet it charged 10 credits per visitor session, and a super-admin toggling it off
changed nothing. On Professional that is the entire 10,000-credit monthly
allowance in 1,000 sessions. (The feature has since launched, so the default is
now True; the switch itself still has to work.)

Nothing caught it because every test of the enrichment paths patches
`_charge_for_enrichment` wholesale, so the switch inside it was never executed.
These tests deliberately do NOT patch it.
"""

from __future__ import annotations

import os

import pytest

from app.db.models import PricingConfig
from app.services.credit_service import invalidate_pricing_cache, is_feature_enabled

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")


def _set(db, key: str, value) -> None:
    db.merge(PricingConfig(key=key, value=value))
    db.commit()
    invalidate_pricing_cache()


@pytest.mark.parametrize("feature", ["company_name", "email_verification"])
def test_the_switch_reads_the_key_the_config_actually_writes(db, feature):
    """The whole bug in one assertion: the row is present and False, so the
    feature must be off. It read a differently-named key and returned True."""
    _set(db, f"feature.{feature}_enabled", False)
    assert is_feature_enabled(db, feature) is False


@pytest.mark.parametrize("feature", ["company_name", "email_verification"])
def test_a_switch_turned_back_on_is_honoured(db, feature):
    _set(db, f"feature.{feature}_enabled", True)
    assert is_feature_enabled(db, feature) is True


@pytest.mark.parametrize("falsy", ["false", "False", "FALSE", "0", "no", "off", "disabled", " false "])
def test_a_string_typed_into_the_admin_panel_means_what_it_says(db, falsy):
    """The pricing panel's editor is an untyped `value: Any` field, so a
    super-admin can save the STRING "false". `bool("false")` is True in Python,
    which would turn the off switch on — on the one control whose entire job is
    to stop a metered feature from charging."""
    _set(db, "feature.company_name_enabled", falsy)
    assert is_feature_enabled(db, "company_name") is False


@pytest.mark.parametrize("truthy", ["true", "True", "1", "yes", "on"])
def test_a_truthy_string_still_enables(db, truthy):
    _set(db, "feature.company_name_enabled", truthy)
    assert is_feature_enabled(db, "company_name") is True


def test_an_absent_key_fails_open(db):
    """A feature shipped without a config row behaves like its default rather
    than silently dying. Only ABSENCE fails open — a present falsy value is
    always honoured (the tests above)."""
    assert is_feature_enabled(db, "some_feature_with_no_row_at_all") is True


@pytest.mark.parametrize("feature", ["company_name", "email_verification"])
def test_the_shipped_defaults_are_on(db, feature):
    """Guards the shipped posture, not just the mechanism.

    `company_name` was seeded False while the feature was unlaunched and is now
    on. Either way this test is the thing that would notice a silent drift —
    the previous value went unguarded, which is part of why nobody spotted that
    the switch was not being read at all.
    """
    from app.services.credit_service import _DEFAULT_PRICING

    assert _DEFAULT_PRICING[f"feature.{feature}_enabled"] is True
    invalidate_pricing_cache()
    assert is_feature_enabled(db, feature) is True
