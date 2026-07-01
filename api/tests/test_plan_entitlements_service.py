"""Tests for ``app.services.plan_entitlements_service``.

Covers the three layers that have to stay correct for plan enforcement to
work: the ``PlanEntitlements`` dataclass helpers, the resolver's plan
selection logic (with subscription / without / catastrophic fallback), and
the cache invalidation surface.

These are unit tests — the Redis cache and the ``get_client_subscription``
dependency are both mocked so the test suite stays fast and doesn't
require a live database for the service layer.
"""

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from app.services.plan_entitlements_service import (
    UNLIMITED,
    PlanEntitlements,
    _build_usage,
    _compute,
    get_entitlements,
    invalidate,
)

# ── Dataclass helpers ──────────────────────────────────────────────────────


class TestPlanEntitlementsHelpers:
    """The convenience methods on ``PlanEntitlements`` are the public surface
    most callers touch; they need to be bulletproof for the gates to work."""

    def _make(self, **overrides):
        defaults = {
            "client_id": 1,
            "plan_slug": "free",
            "plan_name": "Free",
            "subscription_status": "none",
            "limits": {"bots": 1, "documents": 5, "credits": 250},
            "features": {"live_chat": False, "bant": False, "webhooks": False},
            "usage": {},
        }
        defaults.update(overrides)
        return PlanEntitlements(**defaults)

    def test_has_feature_true_when_enabled(self):
        ent = self._make(features={"live_chat": True})
        assert ent.has_feature("live_chat") is True

    def test_has_feature_false_when_disabled(self):
        ent = self._make(features={"live_chat": False})
        assert ent.has_feature("live_chat") is False

    def test_has_feature_false_when_missing(self):
        """Unknown features default to False — lock down rather than expose."""
        ent = self._make(features={})
        assert ent.has_feature("nonexistent_feature") is False

    def test_has_feature_handles_string_values(self):
        """String features like ``integrations`` return True when set to any
        meaningful value so the generic check stays simple — string-level
        gating ("all" vs "reply_to_only") happens at the caller."""
        ent = self._make(features={"integrations": "all"})
        assert ent.has_feature("integrations") is True

    def test_has_feature_handles_empty_string_as_false(self):
        ent = self._make(features={"integrations": ""})
        assert ent.has_feature("integrations") is False

    def test_limit_for_returns_configured_value(self):
        ent = self._make(limits={"bots": 5})
        assert ent.limit_for("bots") == 5

    def test_limit_for_handles_unlimited(self):
        ent = self._make(limits={"bots": UNLIMITED})
        assert ent.limit_for("bots") == UNLIMITED

    def test_limit_for_zero_when_missing(self):
        """Unknown limits default to 0 — conservative."""
        ent = self._make(limits={})
        assert ent.limit_for("nonexistent") == 0

    def test_limit_for_zero_when_malformed(self):
        ent = self._make(limits={"bots": "not-a-number"})
        assert ent.limit_for("bots") == 0

    def test_within_limit_under_cap(self):
        ent = self._make(limits={"bots": 3})
        assert ent.within_limit("bots", 0) is True
        assert ent.within_limit("bots", 2) is True

    def test_within_limit_at_or_over_cap(self):
        ent = self._make(limits={"bots": 3})
        assert ent.within_limit("bots", 3) is False  # at cap = blocked
        assert ent.within_limit("bots", 5) is False

    def test_within_limit_unlimited_always_true(self):
        ent = self._make(limits={"bots": UNLIMITED})
        assert ent.within_limit("bots", 999_999) is True

    def test_remaining_normal_case(self):
        ent = self._make(limits={"documents": 10})
        assert ent.remaining("documents", 3) == 7

    def test_remaining_returns_zero_at_cap(self):
        ent = self._make(limits={"documents": 10})
        assert ent.remaining("documents", 10) == 0
        assert ent.remaining("documents", 15) == 0  # never negative

    def test_remaining_unlimited_returns_huge(self):
        ent = self._make(limits={"documents": UNLIMITED})
        # Must be big enough that ``min(remaining, batch_size)`` works
        # without special-casing — 1e9 is the documented contract.
        assert ent.remaining("documents", 0) >= 10**9

    def test_to_json_dict_roundtrips(self):
        ent = self._make(features={"live_chat": True}, limits={"bots": 3})
        as_dict = ent.to_json_dict()
        assert as_dict["plan_slug"] == "free"
        assert as_dict["features"]["live_chat"] is True
        assert as_dict["limits"]["bots"] == 3


# ── Resolver (_compute) ────────────────────────────────────────────────────


class TestComputeEntitlements:
    """The compute path needs to handle three scenarios: subscribed client,
    no-subscription client (default to Free), and the catastrophic case
    where even the Free plan row is missing.
    """

    def _make_plan(self, slug="free", name="Free", limits=None, features=None):
        return SimpleNamespace(
            id=1,
            slug=slug,
            name=name,
            limits=limits or {"bots": 1, "documents": 5},
            features=features or {"live_chat": False, "bant": False},
        )

    def test_resolves_subscribed_plan(self):
        plan = self._make_plan(slug="starter", name="Starter")
        sub = SimpleNamespace(plan_id=2, status="active")
        session = MagicMock()
        session.get.return_value = plan

        with patch(
            "app.services.plan_entitlements_service.get_client_subscription",
            return_value=sub,
        ):
            result = _compute(client_id=1, db_session=session, include_usage=False)

        assert result.plan_slug == "starter"
        assert result.subscription_status == "active"

    def test_falls_back_to_free_when_no_subscription(self):
        """No subscription → look up Free plan by slug. This handles new
        signups before their first plan grant has fired."""
        free_plan = self._make_plan(slug="free", name="Free")
        session = MagicMock()
        # session.get(Plan, plan_id) is irrelevant here — no sub means no plan_id
        # session.execute(...).scalar_one_or_none() returns Free
        execute_result = MagicMock()
        execute_result.scalar_one_or_none.return_value = free_plan
        session.execute.return_value = execute_result

        with patch(
            "app.services.plan_entitlements_service.get_client_subscription",
            return_value=None,
        ):
            result = _compute(client_id=1, db_session=session, include_usage=False)

        assert result.plan_slug == "free"
        assert result.subscription_status == "none"

    def test_uses_hardcoded_fallback_when_free_plan_missing(self):
        """Catastrophic: even the Free plan row is gone (super admin error).
        Falls back to the hardcoded constants so we never crash — most
        restrictive defaults applied."""
        session = MagicMock()
        execute_result = MagicMock()
        execute_result.scalar_one_or_none.return_value = None  # no Free plan
        session.execute.return_value = execute_result
        session.get.return_value = None

        with patch(
            "app.services.plan_entitlements_service.get_client_subscription",
            return_value=None,
        ):
            result = _compute(client_id=1, db_session=session, include_usage=False)

        assert result.plan_slug == "free"
        # Hardcoded Free fallback values
        assert result.limits["bots"] == 1
        assert result.limits["operators"] == 0
        assert result.features["live_chat"] is False
        assert result.features["topup_allowed"] is False

    def test_subscription_lookup_failure_degrades_to_free(self):
        """If ``get_client_subscription`` raises, treat as no-subscription."""
        free_plan = self._make_plan(slug="free", name="Free")
        session = MagicMock()
        execute_result = MagicMock()
        execute_result.scalar_one_or_none.return_value = free_plan
        session.execute.return_value = execute_result

        with patch(
            "app.services.plan_entitlements_service.get_client_subscription",
            side_effect=RuntimeError("DB connection lost"),
        ):
            result = _compute(client_id=1, db_session=session, include_usage=False)

        # Did NOT crash — degraded to Free.
        assert result.plan_slug == "free"


class TestOperatorSeatEntitlement:
    """``limits["operators"]`` on the Plan row is the hard ceiling (never
    exceeded even with paid extras) — the actual entitlement a client gets
    is ``max(included_operator_seats, subscription.operator_quantity)``,
    capped at that ceiling. Without this, a client could add operators up
    to the ceiling for free without ever paying for extra seats via
    POST /subscription/seats.
    """

    def _make_plan(self, *, operators_ceiling, included_operator_seats):
        return SimpleNamespace(
            id=2,
            slug="starter",
            name="Starter",
            limits={"bots": 1, "operators": operators_ceiling},
            features={"live_chat": True},
            included_operator_seats=included_operator_seats,
        )

    def _compute_with(self, plan, operator_quantity):
        sub = SimpleNamespace(plan_id=plan.id, status="active", operator_quantity=operator_quantity)
        session = MagicMock()
        session.get.return_value = plan
        with patch(
            "app.services.plan_entitlements_service.get_client_subscription",
            return_value=sub,
        ):
            return _compute(client_id=1, db_session=session, include_usage=False)

    def test_defaults_to_included_seats_when_nothing_purchased(self):
        """A client who never touched billing gets exactly their plan's
        included seats for free — not the full ceiling."""
        plan = self._make_plan(operators_ceiling=5, included_operator_seats=1)
        result = self._compute_with(plan, operator_quantity=1)
        assert result.limits["operators"] == 1

    def test_paid_seats_raise_the_limit_up_to_the_ceiling(self):
        """Buying extra seats raises the effective limit."""
        plan = self._make_plan(operators_ceiling=5, included_operator_seats=1)
        result = self._compute_with(plan, operator_quantity=3)
        assert result.limits["operators"] == 3

    def test_paid_seats_never_exceed_the_plan_ceiling(self):
        """Even if operator_quantity is somehow set above the ceiling
        (e.g. a stale/manual value), the effective limit is still capped."""
        plan = self._make_plan(operators_ceiling=5, included_operator_seats=1)
        result = self._compute_with(plan, operator_quantity=99)
        assert result.limits["operators"] == 5

    def test_stale_low_operator_quantity_never_drops_below_included_seats(self):
        """Guards against the known subscription-creation quirk where
        operator_quantity can be initialized to 1 regardless of plan —
        the client must never get fewer than their included seats."""
        plan = self._make_plan(operators_ceiling=10, included_operator_seats=2)
        result = self._compute_with(plan, operator_quantity=1)
        assert result.limits["operators"] == 2

    def test_unlimited_ceiling_is_left_untouched(self):
        """Enterprise-style ``-1`` ceilings bypass the seat math entirely."""
        plan = self._make_plan(operators_ceiling=-1, included_operator_seats=5)
        result = self._compute_with(plan, operator_quantity=1)
        assert result.limits["operators"] == -1

    def test_no_operators_key_in_limits_is_left_untouched(self):
        """Plans without an ``operators`` limit key (e.g. malformed/legacy
        rows) are skipped rather than crashing on missing attributes."""
        plan = self._make_plan(operators_ceiling=5, included_operator_seats=1)
        del plan.limits["operators"]
        result = self._compute_with(plan, operator_quantity=1)
        assert "operators" not in result.limits


# ── Cache layer ────────────────────────────────────────────────────────────


class TestEntitlementsCache:
    """Cache must respect TTL semantics, separate slots for with/without
    usage, and invalidate cleanly on demand."""

    def test_cache_hit_returns_cached_value(self):
        plan = SimpleNamespace(
            id=1,
            slug="starter",
            name="Starter",
            limits={"bots": 1},
            features={"live_chat": True},
        )
        sub = SimpleNamespace(plan_id=1, status="active")
        session = MagicMock()
        session.get.return_value = plan

        with (
            patch(
                "app.services.plan_entitlements_service.get_client_subscription",
                return_value=sub,
            ),
            patch("app.services.plan_entitlements_service._read_cache") as mock_read,
        ):
            cached = PlanEntitlements(
                client_id=1,
                plan_slug="starter",
                plan_name="Starter",
                subscription_status="active",
                limits={"bots": 1},
                features={"live_chat": True},
            )
            mock_read.return_value = cached
            result = get_entitlements(1, session, use_cache=True)

        assert result.plan_slug == "starter"
        # When cache hits, the underlying DB query is NEVER called.
        session.get.assert_not_called()

    def test_cache_miss_computes_fresh(self):
        plan = SimpleNamespace(
            id=1,
            slug="free",
            name="Free",
            limits={"bots": 1},
            features={"live_chat": False},
        )
        session = MagicMock()
        execute_result = MagicMock()
        execute_result.scalar_one_or_none.return_value = plan
        session.execute.return_value = execute_result

        with (
            patch(
                "app.services.plan_entitlements_service.get_client_subscription",
                return_value=None,
            ),
            patch("app.services.plan_entitlements_service._read_cache", return_value=None),
            patch("app.services.plan_entitlements_service._write_cache"),
        ):
            result = get_entitlements(1, session, use_cache=True)

        assert result.plan_slug == "free"

    def test_invalidate_calls_redis_delete(self):
        """``invalidate(client_id)`` should drop BOTH cache slots (with + without
        usage) so a downstream usage display refresh doesn't read stale data."""
        mock_redis = MagicMock()
        with patch("app.services.plan_entitlements_service.get_redis", return_value=mock_redis):
            invalidate(42)

        assert mock_redis.delete.call_count == 2

    def test_invalidate_no_redis_silent(self):
        """No Redis → invalidate is a silent no-op (does not raise)."""
        with patch("app.services.plan_entitlements_service.get_redis", return_value=None):
            invalidate(42)  # Should not raise


# ── Usage population ───────────────────────────────────────────────────────


class TestBuildUsage:
    """``_build_usage`` populates the per-client counters every gate decision
    reads. Failure of any individual counter must not break the others."""

    def test_returns_zeros_on_empty_workspace(self):
        session = MagicMock()
        # Every scalar_one returns 0
        scalar_result = MagicMock()
        scalar_result.scalar_one.return_value = 0
        session.execute.return_value = scalar_result

        usage = _build_usage(client_id=1, db_session=session, limits={})

        assert usage["bots"] == 0
        assert usage["operators"] == 0
        assert usage["documents"] == 0
        assert usage["leads"] == 0

    def test_single_counter_failure_does_not_break_others(self):
        """If the bot count query fails (e.g. missing index), the operator
        and document counters must still return real numbers."""
        session = MagicMock()

        def side_effect(*args, **kwargs):
            # Reproducible — first call (bots) throws, others succeed
            if not hasattr(side_effect, "call_count"):
                side_effect.call_count = 0
            side_effect.call_count += 1
            if side_effect.call_count == 1:
                raise RuntimeError("missing index")
            mock = MagicMock()
            mock.scalar_one.return_value = 3
            return mock

        session.execute.side_effect = side_effect

        usage = _build_usage(client_id=1, db_session=session, limits={})

        assert usage["bots"] == 0  # degraded
        assert usage["operators"] == 3  # still works


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
