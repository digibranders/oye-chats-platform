"""Operator-seat arithmetic, in one place.

Four call sites each re-derived "how many seats does this plan include" with the
idiom ``int(plan.included_operator_seats or 1)``. Python's ``or`` treats ``0`` as
falsy, so every one of them reported ONE included seat for a plan that
deliberately includes NONE:

* ``subscription_routes.change_seat_count`` used it as the reduction floor and as
  the base for ``extra_seats``, so a Free workspace was quoted two seats and
  billed for one.
* ``razorpay_service.derive_operator_quantity`` used it to build the seat mirror
  the live-chat gate reads, which is what put a phantom "0 / 1" on the billing
  page of a plan that grants no operators.
* ``razorpay_service.update_subscription_quantity`` used it as a floor.
* ``plan_service`` hardcoded ``operator_quantity=1`` on every new subscription,
  regardless of the plan it was for.

Zero is a real, deliberate answer to "how many seats are included". Only
``None`` is missing data. That distinction is the whole content of this module,
which is why it is a module and not four expressions.
"""

from __future__ import annotations

# ``included_operator_seats`` / ``limits.operators`` sentinel for "no bound".
UNLIMITED_SEATS = -1


def seat_floor_for(plan) -> int:
    """Seats a plan grants for free, and the floor a reduction cannot pass.

    Returns ``UNLIMITED_SEATS`` unchanged; callers test for it before treating
    the result as a count.
    """
    included = getattr(plan, "included_operator_seats", None) if plan is not None else None
    return 1 if included is None else int(included)


def seat_ceiling_blocks(plan, *, new_total: int) -> bool:
    """Whether ``limits.operators`` refuses this seat count.

    ``limits.operators`` is the hard cap an account can never exceed even with
    paid seats (``plan_entitlements_service`` clamps the entitlement to it), and
    ``operator_routes.create_operator`` gates creation on the same number, so a
    seat sold above it is capacity the customer can never use.

    This check used to run only ``if ceiling > 0``, which waved through the most
    restrictive ceiling there is. A plan with ``operators: 0`` grants no
    operators at all, so every seat sold against it is unusable — and that was
    the one plan whose seat purchases were NOT refused.
    """
    ceiling = (getattr(plan, "limits", None) or {}).get("operators") if plan is not None else None
    if not isinstance(ceiling, int) or isinstance(ceiling, bool):
        return False
    if ceiling == UNLIMITED_SEATS:
        return False
    return new_total > ceiling
