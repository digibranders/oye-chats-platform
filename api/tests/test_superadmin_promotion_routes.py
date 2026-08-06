"""Unit tests for the superadmin promotion route helpers.

Offline — the validation guards and the admin serializer are pure, so they're
tested directly without the DB-backed route layer. ``_promotion_stats`` and the
endpoints themselves need Postgres and are covered by the integration suite.
"""

from __future__ import annotations

from datetime import UTC, datetime
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.api import superadmin_promotion_routes as routes

AUG1 = datetime(2026, 8, 1, tzinfo=UTC)
AUG31 = datetime(2026, 8, 31, 23, 59, 59, tzinfo=UTC)


# ── _validate_window_and_bounds ──────────────────────────────────────────────


def test_valid_window_passes():
    routes._validate_window_and_bounds(AUG1, AUG31, free_cycles=3, max_redemptions=None)  # no raise


def test_end_before_start_rejected():
    with pytest.raises(HTTPException) as exc:
        routes._validate_window_and_bounds(AUG31, AUG1, free_cycles=3, max_redemptions=None)
    assert exc.value.status_code == 400


def test_zero_free_cycles_rejected():
    with pytest.raises(HTTPException) as exc:
        routes._validate_window_and_bounds(AUG1, AUG31, free_cycles=0, max_redemptions=None)
    assert exc.value.status_code == 400


def test_nonpositive_cap_rejected():
    with pytest.raises(HTTPException) as exc:
        routes._validate_window_and_bounds(AUG1, AUG31, free_cycles=3, max_redemptions=0)
    assert exc.value.status_code == 400


def test_null_cap_allowed():
    routes._validate_window_and_bounds(AUG1, AUG31, free_cycles=3, max_redemptions=None)  # no raise


# ── _ensure_utc ──────────────────────────────────────────────────────────────


def test_ensure_utc_coerces_naive():
    naive = datetime(2026, 8, 1, 10, 0)
    assert routes._ensure_utc(naive).tzinfo is UTC


def test_ensure_utc_passes_aware_through():
    assert routes._ensure_utc(AUG1) == AUG1


# ── _serialize ───────────────────────────────────────────────────────────────


def _promo(**overrides):
    base = dict(
        id=4,
        code="LAUNCH3",
        name="August Launch",
        is_active=True,
        starts_at=AUG1,
        ends_at=AUG31,
        free_cycles=3,
        eligible_plan_ids=[2, 3],
        max_redemptions=100,
        redeemed_count=17,
        created_at=AUG1,
        updated_at=AUG1,
    )
    base.update(overrides)
    return SimpleNamespace(**base)


def test_serialize_exposes_admin_fields():
    out = routes._serialize(_promo())
    assert out["id"] == 4
    assert out["code"] == "LAUNCH3"
    assert out["is_active"] is True
    assert out["free_cycles"] == 3
    assert out["eligible_plan_ids"] == [2, 3]
    assert out["max_redemptions"] == 100
    # The admin projection surfaces the internal counter (unlike serialize_public).
    assert out["slots_claimed"] == 17
    assert "stats" not in out


def test_serialize_attaches_stats_when_given():
    stats = {"subscriptions_created": 12, "converted": 5, "in_free_period": 6, "by_status": {}}
    out = routes._serialize(_promo(), stats)
    assert out["stats"] is stats


def test_serialize_null_plan_ids_means_all():
    out = routes._serialize(_promo(eligible_plan_ids=None))
    assert out["eligible_plan_ids"] is None
