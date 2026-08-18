"""Unit tests for the launch-promotion resolver.

Offline, no live database. ``resolve_active_promotion``'s DB query is exercised
via a mocked session; the branch logic (window, plan eligibility, one-per-
account, cap) lives in ``_is_eligible`` and the slot accounting in
``consume_slot`` / ``free_period_end``, all of which are tested directly here.
"""

from __future__ import annotations

from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import MagicMock

from app.services import promotion_service

AUG1 = datetime(2026, 8, 1, tzinfo=UTC)
AUG10 = datetime(2026, 8, 10, 17, 18, tzinfo=UTC)
AUG15 = datetime(2026, 8, 15, tzinfo=UTC)
AUG31 = datetime(2026, 8, 31, 23, 59, 59, tzinfo=UTC)
JUL10 = datetime(2026, 7, 10, tzinfo=UTC)


def _promo(**overrides):
    base = dict(
        id=1,
        name="August Launch",
        code=None,  # uncoded = public time-window (default for existing tests)
        starts_at=AUG1,
        ends_at=AUG31,
        free_cycles=3,
        eligible_plan_ids=None,
        max_redemptions=None,
        redeemed_count=0,
    )
    base.update(overrides)
    return SimpleNamespace(**base)


def _client(created_at=AUG10, cid=5, signup_promo_code=None):
    return SimpleNamespace(id=cid, created_at=created_at, signup_promo_code=signup_promo_code)


def _plan(pid=2):
    return SimpleNamespace(id=pid)


def _session_not_redeemed():
    """Session whose one-per-account lookup finds no prior redemption."""
    session = MagicMock()
    session.execute.return_value.scalar_one_or_none.return_value = None
    return session


# ── _is_eligible ─────────────────────────────────────────────────────────────


def test_eligible_happy_path():
    assert promotion_service._is_eligible(_session_not_redeemed(), _client(), _plan(), _promo(), AUG15) is True


def test_ineligible_signup_before_window():
    # Signed up before the campaign started → not eligible even inside the window now.
    assert promotion_service._is_eligible(MagicMock(), _client(created_at=JUL10), _plan(), _promo(), AUG15) is False


def test_ineligible_plan_not_in_allowlist():
    promo = _promo(eligible_plan_ids=[99])
    assert promotion_service._is_eligible(MagicMock(), _client(), _plan(pid=2), promo, AUG15) is False


def test_eligible_plan_in_allowlist():
    promo = _promo(eligible_plan_ids=[2, 3])
    assert promotion_service._is_eligible(_session_not_redeemed(), _client(), _plan(pid=2), promo, AUG15) is True


def test_ineligible_already_redeemed():
    session = MagicMock()
    session.execute.return_value.scalar_one_or_none.return_value = 123  # a prior promo sub exists
    assert promotion_service._is_eligible(session, _client(), _plan(), _promo(), AUG15) is False


def test_ineligible_cap_exhausted():
    promo = _promo(max_redemptions=100, redeemed_count=100)
    assert promotion_service._is_eligible(_session_not_redeemed(), _client(), _plan(), promo, AUG15) is False


def test_ineligible_naive_created_at_coerced_and_evaluated():
    # A naive created_at is coerced to UTC, not rejected outright.
    naive_client = SimpleNamespace(id=5, created_at=datetime(2026, 8, 10, 17, 18))
    assert promotion_service._is_eligible(_session_not_redeemed(), naive_client, _plan(), _promo(), AUG15) is True


def test_ineligible_malformed_eligible_plan_ids():
    promo = _promo(eligible_plan_ids=["not-an-int"])
    assert promotion_service._is_eligible(MagicMock(), _client(), _plan(), promo, AUG15) is False


# ── link-exclusive (coded promo) gating ──────────────────────────────────────


def test_coded_promo_eligible_when_signup_code_matches():
    promo = _promo(code="LAUNCH3")
    client = _client(signup_promo_code="LAUNCH3")
    assert promotion_service._is_eligible(_session_not_redeemed(), client, _plan(), promo, AUG15) is True


def test_coded_promo_case_insensitive_match():
    promo = _promo(code="LAUNCH3")
    client = _client(signup_promo_code="  launch3 ")  # trimmed + case-folded
    assert promotion_service._is_eligible(_session_not_redeemed(), client, _plan(), promo, AUG15) is True


def test_coded_promo_ineligible_for_organic_signup():
    # Signed up in the window but WITHOUT the code → link-exclusive means no offer.
    promo = _promo(code="LAUNCH3")
    client = _client(signup_promo_code=None)
    assert promotion_service._is_eligible(MagicMock(), client, _plan(), promo, AUG15) is False


def test_coded_promo_ineligible_for_wrong_code():
    promo = _promo(code="LAUNCH3")
    client = _client(signup_promo_code="OTHER")
    assert promotion_service._is_eligible(MagicMock(), client, _plan(), promo, AUG15) is False


def test_coded_promo_ignores_signup_date_window():
    # A coded promo is gated by the code, NOT created_at, a client who signed up
    # before the window but has the code still qualifies (window bounds the promo
    # being active, handled by _active_promotions_in_window).
    promo = _promo(code="LAUNCH3")
    client = _client(created_at=JUL10, signup_promo_code="LAUNCH3")
    assert promotion_service._is_eligible(_session_not_redeemed(), client, _plan(), promo, AUG15) is True


# ── consume_slot ─────────────────────────────────────────────────────────────


def test_consume_slot_uncapped_always_claims():
    session = MagicMock()
    assert promotion_service.consume_slot(session, _promo(max_redemptions=None)) is True
    session.execute.assert_called_once()


def test_consume_slot_capped_claims_when_row_updated():
    session = MagicMock()
    session.execute.return_value.rowcount = 1
    assert promotion_service.consume_slot(session, _promo(max_redemptions=100, redeemed_count=40)) is True


def test_consume_slot_capped_fails_when_exhausted():
    session = MagicMock()
    session.execute.return_value.rowcount = 0  # guarded UPDATE matched no row
    assert promotion_service.consume_slot(session, _promo(max_redemptions=100, redeemed_count=100)) is False


# ── free_period_end ──────────────────────────────────────────────────────────


def test_free_period_end_adds_free_cycles_months():
    # 3 free cycles from Aug 10 17:18 → Nov 10 17:18, tz + wall-clock preserved.
    end = promotion_service.free_period_end(_promo(free_cycles=3), AUG10)
    assert end == datetime(2026, 11, 10, 17, 18, tzinfo=UTC)


def test_free_period_end_single_cycle():
    end = promotion_service.free_period_end(_promo(free_cycles=1), AUG10)
    assert end == datetime(2026, 9, 10, 17, 18, tzinfo=UTC)


# ── current_free_period_end (free-window monthly boundaries) ─────────────────

# promo_free_until = 5 Nov; free window months end at 5 Sep, 5 Oct, 5 Nov.
PFU = datetime(2026, 11, 5, 13, 1, tzinfo=UTC)


def test_free_boundary_month_1():
    # Anywhere in the first free month → the first boundary (5 Sep).
    end = promotion_service.current_free_period_end(PFU, datetime(2026, 8, 10, tzinfo=UTC))
    assert end == datetime(2026, 9, 5, 13, 1, tzinfo=UTC)


def test_free_boundary_month_2():
    end = promotion_service.current_free_period_end(PFU, datetime(2026, 9, 10, tzinfo=UTC))
    assert end == datetime(2026, 10, 5, 13, 1, tzinfo=UTC)


def test_free_boundary_month_3():
    end = promotion_service.current_free_period_end(PFU, datetime(2026, 10, 10, tzinfo=UTC))
    assert end == PFU


def test_free_boundary_just_before_charge():
    # Right before the first charge, still the last free month → promo_free_until.
    end = promotion_service.current_free_period_end(PFU, datetime(2026, 11, 4, tzinfo=UTC))
    assert end == PFU


def test_free_boundaries_are_distinct_per_month():
    # The three free months must produce three distinct keys so each is granted
    # once and none collides with a paid charge (keyed after promo_free_until).
    keys = {promotion_service.current_free_period_end(PFU, datetime(2026, m, 10, tzinfo=UTC)) for m in (8, 9, 10)}
    assert len(keys) == 3
    assert all(k <= PFU for k in keys)


# ── attribute_signup_code (capture at registration) ──────────────────────────


def test_attribute_signup_code_stores_canonical_on_match():
    client = SimpleNamespace(id=5, signup_promo_code=None)
    session = MagicMock()
    session.get.return_value = client
    session.execute.return_value.scalar_one_or_none.return_value = _promo(code="LAUNCH3")
    assert promotion_service.attribute_signup_code(session, 5, "  launch3 ") is True
    assert client.signup_promo_code == "LAUNCH3"  # canonical code, not the raw input


def test_attribute_signup_code_ignores_unknown_code():
    client = SimpleNamespace(id=5, signup_promo_code=None)
    session = MagicMock()
    session.get.return_value = client
    session.execute.return_value.scalar_one_or_none.return_value = None
    assert promotion_service.attribute_signup_code(session, 5, "GARBAGE") is False
    assert client.signup_promo_code is None


def test_attribute_signup_code_first_touch_immutable():
    client = SimpleNamespace(id=5, signup_promo_code="EXISTING")
    session = MagicMock()
    session.get.return_value = client
    assert promotion_service.attribute_signup_code(session, 5, "LAUNCH3") is False
    assert client.signup_promo_code == "EXISTING"


def test_attribute_signup_code_empty_is_noop():
    session = MagicMock()
    assert promotion_service.attribute_signup_code(session, 5, "") is False
    assert promotion_service.attribute_signup_code(session, 5, None) is False


# ── serialize_public (billing-display projection) ────────────────────────────


def test_serialize_public_none_is_inactive():
    assert promotion_service.serialize_public(None) == {"active": False}


def test_serialize_public_projects_display_fields_no_counters():
    promo = _promo(id=7, free_cycles=3, eligible_plan_ids=[2, 3])
    out = promotion_service.serialize_public(promo)
    assert out["active"] is True
    assert out["id"] == 7
    assert out["free_cycles"] == 3
    assert out["eligible_plan_ids"] == [2, 3]
    assert out["ends_at"] == AUG31.isoformat()
    # Internal counters must never leak to the client.
    assert "redeemed_count" not in out
    assert "max_redemptions" not in out


def test_serialize_public_null_plan_ids_means_all_plans():
    out = promotion_service.serialize_public(_promo(eligible_plan_ids=None))
    assert out["eligible_plan_ids"] is None


# ── _plan_eligible (split out of _is_eligible) ───────────────────────────────


def test_plan_eligible_all_plans_when_unset():
    assert promotion_service._plan_eligible(_plan(pid=2), _promo(eligible_plan_ids=None)) is True


def test_plan_eligible_respects_allowlist():
    promo = _promo(eligible_plan_ids=[2, 3])
    assert promotion_service._plan_eligible(_plan(pid=2), promo) is True
    assert promotion_service._plan_eligible(_plan(pid=9), promo) is False
