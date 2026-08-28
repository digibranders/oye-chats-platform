"""The trial plan is default for signups and invisible to buyers.

The trial has to satisfy ``get_default_plan`` (which filters ``is_active``)
without ever reaching ``get_active_plans``, the feed behind ``/plans`` and
``GET /public/pricing-catalog``. That is what ``plans.is_public`` is for.

Real-Postgres tests via the shared ``db`` fixture. Skips without DB_URL.
"""

from __future__ import annotations

import os
from contextlib import contextmanager
from unittest.mock import patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.db.models import Client, Plan
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


def test_seed_matrix_defaults_the_trial_and_not_free():
    from scripts.seed_plans import _PLANS

    by_slug = {p["slug"]: p for p in _PLANS}
    trial, free = by_slug["trial"], by_slug["free"]
    assert trial["is_default"] and not free["is_default"]
    assert trial["is_public"] is False and trial["trial_days"] == 14
    assert trial["credits_per_month"] == 500
    assert trial["limits"]["max_crawl_pages"] == 100
    assert trial["limits"]["knowledge_characters"] == 500_000
    assert trial["limits"]["bots"] == 1 and trial["limits"]["operators"] == 1
    assert trial["features"]["topup_allowed"] is False
    assert trial["features"]["first_training_free"] is True
    # every Professional feature except volume/topup is open
    pro = by_slug["professional"]["features"]
    for key, val in pro.items():
        if key != "topup_allowed":
            assert trial["features"][key] == val, key


def test_the_signup_trial_is_the_only_trial_in_the_matrix():
    """Standard's 7-day offer is retired; nothing else may carry trial_days."""
    from scripts.seed_plans import _PLANS

    by_slug = {p["slug"]: p for p in _PLANS}
    assert by_slug["standard"]["trial_days"] == 0
    assert all(p["trial_days"] == 0 for p in _PLANS if p["slug"] != "trial")


def test_every_public_row_is_marked_public():
    """``is_public`` is upserted, so an unmarked row would silently delist."""
    from scripts.seed_plans import _PLANS

    assert {p["slug"] for p in _PLANS if p["is_public"]} == {
        "free",
        "starter",
        "standard",
        "professional",
        "enterprise",
    }


# ── The purchase guards ───────────────────────────────────────────────────────
#
# Four routes resolve a plan the caller names and then start spending money on
# it. Each one has to refuse a row that is assignable but was never for sale,
# and each refusal has to land BEFORE any gateway side effect. The fourth,
# ``POST /bots/checkout``, is covered in tests/test_bot_checkout_plan_guard.py
# next to its own sibling guard.


@contextmanager
def _session_cm(session):
    yield session


def _buyer(db, *, email: str) -> Client:
    c = Client(name="b", email=email, api_key=email, hashed_password="h", is_verified=True)
    db.add(c)
    db.flush()
    return c


def _api(db, buyer):
    from app.api import auth, subscription_routes

    app = FastAPI()
    app.include_router(subscription_routes.router)
    # subscription_routes aliases get_current_client_strict as get_current_client.
    app.dependency_overrides[auth.get_current_client_strict] = lambda: buyer
    return TestClient(app, raise_server_exceptions=False)


def test_checkout_quote_refuses_a_non_public_plan(db):
    trial = _mk(db, "trial", default=True, public=False, trial_days=14)
    buyer = _buyer(db, email="quote-trial@e.com")
    db.commit()

    from app.api import subscription_routes

    with patch.object(subscription_routes, "get_session", lambda: _session_cm(db)):
        res = _api(db, buyer).get(f"/subscriptions/checkout/quote?plan_id={trial.id}")

    assert res.status_code == 400, res.text
    assert res.json()["detail"] == "This plan cannot be purchased."


def test_checkout_refuses_a_non_public_plan_before_minting_a_mandate(db):
    trial = _mk(db, "trial", default=True, public=False, trial_days=14)
    buyer = _buyer(db, email="checkout-trial@e.com")
    db.commit()

    from app.api import subscription_routes

    with (
        patch.object(subscription_routes, "get_session", lambda: _session_cm(db)),
        patch.object(subscription_routes, "lock_client_for_billing", lambda *a, **k: None),
        patch("app.services.razorpay_service.create_subscription") as create_sub,
    ):
        res = _api(db, buyer).post("/subscriptions/checkout", json={"plan_id": trial.id, "billing_cycle": "monthly"})

    assert res.status_code == 400, res.text
    assert res.json()["detail"] == "This plan cannot be purchased."
    create_sub.assert_not_called()


def test_change_plan_refuses_a_non_public_plan_as_a_target(db):
    """``/change-plan`` resolves any active plan by id, so it needs its own guard.

    A trialing customer picking the trial row here would otherwise be priced at
    zero and routed through a real plan change.
    """
    trial = _mk(db, "trial", default=True, public=False, trial_days=14)
    buyer = _buyer(db, email="changeplan-trial@e.com")
    db.commit()

    from app.api import subscription_routes

    with (
        patch.object(subscription_routes, "get_session", lambda: _session_cm(db)),
        patch.object(subscription_routes, "lock_client_for_billing", lambda *a, **k: None),
        patch("app.services.razorpay_service.create_subscription") as create_sub,
    ):
        res = _api(db, buyer).post("/subscriptions/change-plan", json={"plan_id": trial.id, "billing_cycle": "monthly"})

    assert res.status_code == 400, res.text
    assert res.json()["detail"] == "This plan cannot be purchased."
    create_sub.assert_not_called()


def test_the_trial_matches_professional_on_every_gate_outside_plan_features():
    """Capabilities gated by slug, not by the ``features`` column, must agree.

    The trial's ``features`` dict is Professional's, and the seed test above
    pins that. But five capabilities are gated on slug sets instead, so a row
    absent from them silently carries LESS than its features claim. Worse, a
    slug absent from ``_SEEDED_PLAN_SLUGS`` is read by ``_paid_tier_includes``
    as a bespoke per-contract tier and silently carries MORE. Pinning the trial
    to Professional's answer on each gate is what keeps "fourteen days of
    everything" true in both directions.
    """
    from app.services.plan_entitlements_service import (
        EMAIL_VERIFICATION_SLUGS,
        JOURNEY_ANALYTICS_SLUGS,
        LEAD_SOURCE_ATTRIBUTION_SLUGS,
        VISITOR_INTELLIGENCE_SLUGS,
        _paid_tier_includes,
    )
    from app.services.plan_service import _DELTA_RECRAWL_PLAN_SLUGS

    for ladder in (
        EMAIL_VERIFICATION_SLUGS,
        JOURNEY_ANALYTICS_SLUGS,
        LEAD_SOURCE_ATTRIBUTION_SLUGS,
        VISITOR_INTELLIGENCE_SLUGS,
        _DELTA_RECRAWL_PLAN_SLUGS,
    ):
        assert ("trial" in ladder) == ("professional" in ladder)
        assert _paid_tier_includes("trial", ladder) == _paid_tier_includes("professional", ladder)
