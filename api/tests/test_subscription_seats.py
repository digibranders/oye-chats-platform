"""Tests for POST /subscription/seats (``change_seat_count``).

The floor check (can't drop below included seats) already existed; these
tests cover the new ceiling check added alongside it, a client should
never be able to buy more seats than their plan allows them to actually
use (mirrors the cap enforced in ``operator_routes.create_operator``).
"""

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest
from fastapi import HTTPException

from app.api.subscription_routes import SeatChangeRequest, change_seat_count


def _make_plan(*, operators_ceiling, included_operator_seats=1):
    return SimpleNamespace(
        id=2,
        slug="starter",
        limits={"operators": operators_ceiling},
        included_operator_seats=included_operator_seats,
        extra_seat_price_cents=119900,
        currency="INR",
    )


def _make_sub(plan, operator_quantity):
    return SimpleNamespace(
        id=10,
        client_id=1,
        client=SimpleNamespace(
            id=1,
            name="Test",
            email="test@example.com",
            # Bare unregistered domestic buyer: the pre-charge gate must pass
            # (Rule 46(f) requires nothing below the threshold).
            billing_country=None,
            gstin=None,
            legal_name=None,
            billing_address=None,
            billing_state_code=None,
        ),
        plan=plan,
        operator_quantity=operator_quantity,
        razorpay_subscription_id=None,
        seat_addon_subscription_id=None,
        seat_addon_quantity=0,
    )


def _run(sub, delta, mock_db_session, mock_get_session):
    request = SeatChangeRequest(delta=delta, bot_id=None)
    client = SimpleNamespace(
        id=1,
        billing_country=None,
        gstin=None,
        legal_name=None,
        billing_address=None,
        billing_state_code=None,
    )
    with (
        patch("app.api.subscription_routes.get_session", mock_get_session),
        patch("app.api.subscription_routes.lock_client_for_billing", MagicMock()),
        patch("app.api.subscription_routes._resolve_target_subscription", return_value=sub),
        patch("app.services.razorpay_service.edit_seat_addon_quantity") as mock_edit_addon,
    ):
        # Mirrors the real helper's side effect: record the add-on seat count.
        def _apply(session, sub_arg, extra_seats):
            sub_arg.seat_addon_quantity = extra_seats

        mock_edit_addon.side_effect = _apply
        return change_seat_count(request, http_request=None, client=client)


def _run_addon(sub, delta, mock_get_session):
    """Run change_seat_count with BOTH seat helpers patched.

    The main-plan quantity edit (``update_subscription_quantity``) is booby-
    trapped to fail the test if it is ever called; the seat add-on helper is
    faked to record its invocation. Enforces the P0-3 invariant: seat deltas
    must route through a SEPARATE add-on subscription, never the main plan.
    """
    request = SeatChangeRequest(delta=delta, bot_id=None)
    client = SimpleNamespace(
        id=1,
        billing_country=None,
        gstin=None,
        legal_name=None,
        billing_address=None,
        billing_state_code=None,
    )

    def _explode(*_args, **_kwargs):
        raise AssertionError("update_subscription_quantity must NOT be called for seat changes (P0-3)")

    def _fake_addon(session, sub_arg, extra_seats):
        sub_arg.seat_addon_subscription_id = "sub_addon_123"
        sub_arg.seat_addon_quantity = extra_seats

    with (
        patch("app.api.subscription_routes.get_session", mock_get_session),
        patch("app.api.subscription_routes.lock_client_for_billing", MagicMock()),
        patch("app.api.subscription_routes._resolve_target_subscription", return_value=sub),
        patch("app.services.razorpay_service.update_subscription_quantity") as mock_edit_main,
        patch("app.services.razorpay_service.edit_seat_addon_quantity") as mock_addon,
    ):
        mock_edit_main.side_effect = _explode
        mock_addon.side_effect = _fake_addon
        result = change_seat_count(request, http_request=None, client=client)
        return result, mock_edit_main, mock_addon


class TestSeatAddonRouting:
    def test_seat_delta_never_edits_main_plan_quantity(self, mock_db_session, mock_get_session):
        """A +1 seat change must create/extend the add-on subscription and
        must NEVER touch the main-plan subscription quantity (P0-3)."""
        plan = _make_plan(operators_ceiling=10, included_operator_seats=1)
        sub = _make_sub(plan, operator_quantity=1)

        result, mock_edit_main, mock_addon = _run_addon(sub, delta=1, mock_get_session=mock_get_session)

        # Invariant: edit_main == 0, addon >= 1.
        assert mock_edit_main.call_count == 0
        assert mock_addon.call_count >= 1
        # The add-on carries the seats ABOVE the included floor (2 total - 1 floor = 1).
        _session_arg, sub_arg, extra_seats = mock_addon.call_args.args
        assert sub_arg is sub
        assert extra_seats == 1
        assert result["total_seats"] == 2
        assert result["extra_seats"] == 1


class TestSeatCeiling:
    def test_can_buy_up_to_the_ceiling(self, mock_db_session, mock_get_session):
        plan = _make_plan(operators_ceiling=5, included_operator_seats=1)
        sub = _make_sub(plan, operator_quantity=4)
        result = _run(sub, delta=1, mock_db_session=mock_db_session, mock_get_session=mock_get_session)
        assert result["operator_quantity"] == 5

    def test_blocked_from_exceeding_the_ceiling(self, mock_db_session, mock_get_session):
        plan = _make_plan(operators_ceiling=5, included_operator_seats=1)
        sub = _make_sub(plan, operator_quantity=5)
        with pytest.raises(HTTPException) as exc_info:
            _run(sub, delta=1, mock_db_session=mock_db_session, mock_get_session=mock_get_session)
        assert exc_info.value.status_code == 400
        assert "5 seat" in exc_info.value.detail

    def test_unlimited_ceiling_allows_any_purchase(self, mock_db_session, mock_get_session):
        plan = _make_plan(operators_ceiling=-1, included_operator_seats=5)
        sub = _make_sub(plan, operator_quantity=50)
        result = _run(sub, delta=25, mock_db_session=mock_db_session, mock_get_session=mock_get_session)
        assert result["operator_quantity"] == 75

    def test_missing_ceiling_key_does_not_block_purchase(self, mock_db_session, mock_get_session):
        """Defensive: malformed/legacy plan rows without an ``operators``
        limit key should fail open on the ceiling check rather than block
        a legitimate purchase."""
        plan = _make_plan(operators_ceiling=5, included_operator_seats=1)
        del plan.limits["operators"]
        sub = _make_sub(plan, operator_quantity=10)
        result = _run(sub, delta=1, mock_db_session=mock_db_session, mock_get_session=mock_get_session)
        assert result["operator_quantity"] == 11

    def test_floor_check_still_blocks_going_below_included_seats(self, mock_db_session, mock_get_session):
        """Regression guard: the new ceiling check must not have disturbed
        the pre-existing floor check."""
        plan = _make_plan(operators_ceiling=5, included_operator_seats=2)
        sub = _make_sub(plan, operator_quantity=2)
        with pytest.raises(HTTPException) as exc_info:
            _run(sub, delta=-1, mock_db_session=mock_db_session, mock_get_session=mock_get_session)
        assert exc_info.value.status_code == 400
        assert "included seat" in exc_info.value.detail
