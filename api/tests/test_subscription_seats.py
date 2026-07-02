"""Tests for POST /subscription/seats (``change_seat_count``).

The floor check (can't drop below included seats) already existed; these
tests cover the new ceiling check added alongside it — a client should
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
        plan=plan,
        operator_quantity=operator_quantity,
        razorpay_subscription_id=None,
    )


def _run(sub, delta, mock_db_session, mock_get_session):
    request = SeatChangeRequest(delta=delta, bot_id=None)
    client = SimpleNamespace(id=1)
    with (
        patch("app.api.subscription_routes.get_session", mock_get_session),
        patch("app.api.subscription_routes.lock_client_for_billing", MagicMock()),
        patch("app.api.subscription_routes._resolve_target_subscription", return_value=sub),
        patch("app.services.razorpay_service.update_subscription_quantity") as mock_update_qty,
    ):
        # Mirrors the real function's side effect: bump operator_quantity.
        def _apply(session, sub_arg, new_total):
            sub_arg.operator_quantity = new_total
            return new_total

        mock_update_qty.side_effect = _apply
        return change_seat_count(request, client)


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
