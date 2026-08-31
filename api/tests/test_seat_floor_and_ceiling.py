"""The two guards that decide whether a seat may be sold at all.

Both were wrong in the same direction, and the direction matters: the plan that
grants no operators was the ONLY one where a seat purchase reached the Razorpay
mint. A Free workspace could be charged ₹499 a month for an operator it could
never create, while every paid plan was refused a seat it was entitled to buy.

* ``floor`` read ``int(plan.included_operator_seats or 1)``. Python's ``or``
  treats ``0`` as falsy, so a plan including zero seats reported a floor of one.
  That single character is what put "0 / 1" on a Free workspace's billing page,
  and it made ``extra_seats = new_total - floor`` undercount by one, so the
  customer saw a charge for two seats and the mandate was minted for one.
* The ceiling check ran only ``if ceiling > 0``, so ``limits.operators == 0``
  skipped it entirely. Zero is the most restrictive ceiling there is; it has to
  be the most strictly enforced, not the one case that is waved through.
"""

from __future__ import annotations

import pytest

from app.services.seat_math import seat_ceiling_blocks, seat_floor_for


class _Plan:
    def __init__(self, included, operators):
        self.included_operator_seats = included
        self.limits = {"operators": operators}


# ── floor ────────────────────────────────────────────────────────────────────


def test_a_plan_including_no_seats_has_a_floor_of_zero():
    # The bug: `0 or 1` is 1. A Free workspace was told it held one seat.
    assert seat_floor_for(_Plan(0, 0)) == 0


@pytest.mark.parametrize("included,expected", [(1, 1), (2, 2), (3, 3), (-1, -1)])
def test_every_other_included_count_is_passed_through(included, expected):
    assert seat_floor_for(_Plan(included, 5)) == expected


def test_a_null_included_count_falls_back_to_one():
    # Only NULL is missing data. Zero is a real, deliberate answer.
    assert seat_floor_for(_Plan(None, 5)) == 1


# ── ceiling ──────────────────────────────────────────────────────────────────


def test_a_zero_operator_plan_refuses_every_seat():
    # The plan grants no operators, so a seat buys capacity that stays at zero.
    assert seat_ceiling_blocks(_Plan(0, 0), new_total=1) is True
    assert seat_ceiling_blocks(_Plan(0, 0), new_total=5) is True


def test_a_seat_inside_the_ceiling_is_allowed():
    assert seat_ceiling_blocks(_Plan(2, 10), new_total=3) is False
    assert seat_ceiling_blocks(_Plan(2, 10), new_total=10) is False


def test_a_seat_past_the_ceiling_is_refused():
    assert seat_ceiling_blocks(_Plan(2, 10), new_total=11) is True


def test_an_unlimited_ceiling_never_blocks():
    # -1 is unlimited. It must not be read as a numeric ceiling of -1, which
    # would refuse every seat including the first.
    assert seat_ceiling_blocks(_Plan(2, -1), new_total=99) is False


def test_a_plan_with_no_operators_key_is_not_blocked_here():
    # Absent means "no per-plan ceiling"; the absolute cap upstream still bounds
    # it. Only an explicit integer is a ceiling.
    plan = _Plan(2, None)
    plan.limits = {}
    assert seat_ceiling_blocks(plan, new_total=50) is False
