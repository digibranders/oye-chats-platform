"""`included_operator_seats = -1` means unlimited, not a cap of minus one.

Enterprise is the first plan to use -1 here. Without the guard,
check_seat_overflow can never return None for it, so any billing-cycle change
is refused with a 409 even when the account has zero operators.

The same sentinel has to survive the super-admin plan editor (which rejected
-1 outright) and the seat-entitlement mirror razorpay_service derives from the
column (which produced a nonsense negative seat count).
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from app.api.superadmin_plan_routes import CreatePlanRequest, UpdatePlanRequest
from app.services.plan_entitlements_service import UNLIMITED
from app.services.razorpay_service import derive_operator_quantity
from app.services.transition_service import check_seat_overflow


class _FakeSession:
    """Minimal stand-in — check_seat_overflow only ever calls .scalar()."""

    def __init__(self, active_operators: int) -> None:
        self._active = active_operators

    def scalar(self, _stmt):  # noqa: ANN001 - test double
        return self._active


# ── check_seat_overflow ──────────────────────────────────────────────────────


def test_unlimited_seats_never_overflow():
    plan = SimpleNamespace(included_operator_seats=-1, name="Enterprise")
    assert check_seat_overflow(_FakeSession(0), client_id=1, target_plan=plan) is None
    assert check_seat_overflow(_FakeSession(250), client_id=1, target_plan=plan) is None


def test_finite_seats_still_overflow():
    plan = SimpleNamespace(included_operator_seats=2, name="Standard")
    assert check_seat_overflow(_FakeSession(2), client_id=1, target_plan=plan) is None

    overflow = check_seat_overflow(_FakeSession(5), client_id=1, target_plan=plan)
    assert overflow is not None
    assert overflow.active_seats == 5
    assert overflow.allowed_seats == 2


# ── Super-admin plan editor validation ───────────────────────────────────────


@pytest.mark.parametrize("model", [CreatePlanRequest, UpdatePlanRequest])
def test_plan_editor_accepts_unlimited_seat_sentinel(model):
    """The seeded Enterprise row must round-trip through the plan editor."""
    payload = {"name": "Enterprise", "slug": "enterprise", "included_operator_seats": -1}
    parsed = model.model_validate(payload)
    assert parsed.included_operator_seats == UNLIMITED


@pytest.mark.parametrize("model", [CreatePlanRequest, UpdatePlanRequest])
@pytest.mark.parametrize("bad_value", [0, -2, -100])
def test_plan_editor_rejects_non_sentinel_non_positive_seats(model, bad_value):
    """-1 is the ONLY meaningful non-positive value; 0 and -2 are still nonsense."""
    payload = {"name": "Enterprise", "slug": "enterprise", "included_operator_seats": bad_value}
    with pytest.raises(ValidationError):
        model.model_validate(payload)


@pytest.mark.parametrize("model", [CreatePlanRequest, UpdatePlanRequest])
def test_plan_editor_still_accepts_finite_seats(model):
    payload = {"name": "Standard", "slug": "standard", "included_operator_seats": 3}
    assert model.model_validate(payload).included_operator_seats == 3


# ── Seat-entitlement mirror (operator_quantity) ──────────────────────────────


def test_operator_quantity_mirror_stays_unlimited():
    """`included + addon` on an unlimited plan used to yield -1, which the
    WebSocket seat gate then read as a hard cap of one online operator."""
    plan = SimpleNamespace(included_operator_seats=-1)
    assert derive_operator_quantity(plan, 0) == UNLIMITED
    assert derive_operator_quantity(plan, 4) == UNLIMITED


def test_operator_quantity_mirror_unchanged_for_finite_plans():
    plan = SimpleNamespace(included_operator_seats=2)
    assert derive_operator_quantity(plan, None) == 2
    assert derive_operator_quantity(plan, 3) == 5
    # No plan row → the legacy 1-seat assumption stands.
    assert derive_operator_quantity(None, 2) == 3
