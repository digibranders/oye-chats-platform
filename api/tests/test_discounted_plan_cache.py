"""DiscountedPlanCache must refresh when the base plan price changes (audit F34).

The cache is keyed on (base_plan_id, billing_cycle, discount_bps) and returned a
plan_id without checking the cached amount against the base plan's CURRENT price.
So after a price change, new referral-discounted signups kept billing the stale
(old) discounted amount forever. A price change must invalidate the cached row.
"""

from __future__ import annotations

import os

import pytest

from app.db.models import Plan
from app.services import razorpay_service as rzp_svc

pytestmark = pytest.mark.skipif(
    not os.getenv("DB_URL"),
    reason="discounted-plan-cache test needs a reachable Postgres at DB_URL",
)


def test_cache_refreshes_when_base_price_changes(db, monkeypatch):
    plan = Plan(name="Std", slug="std-disc", monthly_price_cents=100000, credits_per_month=1000)
    db.add(plan)
    db.flush()

    created: list[dict] = []

    class _FakePlanAPI:
        def create(self, data):
            created.append(data)
            return {"id": f"plan_{len(created)}"}

    class _FakeRzp:
        plan = _FakePlanAPI()

    monkeypatch.setattr(rzp_svc, "_get_razorpay", lambda: _FakeRzp())

    # Miss → creates plan_1 at 10% off 100000 = 90000.
    p1 = rzp_svc.resolve_discounted_plan(db, plan, "monthly", 1000)
    assert p1 == "plan_1"
    assert len(created) == 1

    # Hit (same price) → no new plan.
    p2 = rzp_svc.resolve_discounted_plan(db, plan, "monthly", 1000)
    assert p2 == "plan_1"
    assert len(created) == 1

    # Base price doubles → the cached amount is now stale, so a fresh discounted
    # plan must be created at the new price (10% off 200000 = 180000).
    plan.monthly_price_cents = 200000
    db.flush()
    p3 = rzp_svc.resolve_discounted_plan(db, plan, "monthly", 1000)
    assert p3 == "plan_2", "a base price change must refresh the cached discounted plan"
    assert len(created) == 2

    # And the refreshed cache is now a hit at the new price.
    p4 = rzp_svc.resolve_discounted_plan(db, plan, "monthly", 1000)
    assert p4 == "plan_2"
    assert len(created) == 2
