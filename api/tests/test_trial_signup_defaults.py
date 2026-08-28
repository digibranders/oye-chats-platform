"""The trial plan is default for signups and invisible to buyers.

The trial has to satisfy ``get_default_plan`` (which filters ``is_active``)
without ever reaching ``get_active_plans``, the feed behind ``/plans`` and
``GET /public/pricing-catalog``. That is what ``plans.is_public`` is for.

Real-Postgres tests via the shared ``db`` fixture. Skips without DB_URL.
"""

from __future__ import annotations

import os

import pytest

from app.db.models import Plan
from app.services.plan_service import get_active_plans, get_default_plan

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")


def _mk(db, slug, *, default=False, public=True, trial_days=0, active=True):
    p = Plan(
        slug=slug,
        name=slug.title(),
        credits_per_month=500,
        monthly_price_cents=0,
        annual_price_cents=0,
        trial_days=trial_days,
        is_default=default,
        is_active=active,
        is_public=public,
        sort_order=99,
        limits={"bots": 1},
        features={"topup_allowed": False},
    )
    db.add(p)
    db.flush()
    db.commit()
    return p


def test_non_public_default_wins_signup_but_never_lists(db):
    _mk(db, "free")
    trial = _mk(db, "trial", default=True, public=False, trial_days=14)
    assert get_default_plan(db).id == trial.id
    assert trial.id not in {p.id for p in get_active_plans(db)}


def test_public_listing_unchanged_for_ordinary_plans(db):
    free = _mk(db, "free")
    assert free.id in {p.id for p in get_active_plans(db)}
