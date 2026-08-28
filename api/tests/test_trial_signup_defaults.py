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
from app.services.plan_entitlements_service import _paid_tier_includes
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

    # Priced at nothing, on purpose and in every column. The row is
    # ``is_default``, so ``assign_default_plan_to_client`` opens a subscription
    # on it and grants its credits with no payment anywhere in the loop. A
    # non-zero price here would be a tier billed to nobody.
    for axis in (
        "monthly_price_cents",
        "annual_price_cents",
        "monthly_price_usd_cents",
        "annual_price_usd_cents",
        "extra_seat_price_cents",
        "extra_seat_price_usd_cents",
    ):
        assert trial[axis] == 0, axis

    assert trial["sort_order"] == 0
    assert trial["included_operator_seats"] == 1
    # The rest of the limits map, which is served verbatim in the
    # current-subscription payload and so is read by the customer.
    assert trial["limits"]["credits"] == 500
    assert trial["limits"]["leads"] == -1
    assert trial["limits"]["documents"] == -1
    assert trial["limits"]["page_scraping"] == 100
    assert trial["limits"]["chat_history_days"] == 90
    assert trial["limits"]["max_crawl_depth"] == 4
    assert trial["limits"]["max_crawl_js_pages"] == 50
    assert trial["limits"]["max_crawl_concurrency"] == 4


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


# The slug gates known to exist when this was written. The scan below must find
# at least these, so a rename that drops one out of the scan fails here instead
# of silently narrowing the guard to whatever is left.
_KNOWN_SLUG_GATES: frozenset[str] = frozenset(
    {
        "app.api.quotation_routes.QUOTATION_PLAN_SLUGS",
        "app.services.plan_entitlements_service.EMAIL_VERIFICATION_SLUGS",
        "app.services.plan_entitlements_service.JOURNEY_ANALYTICS_SLUGS",
        "app.services.plan_entitlements_service.LEAD_SOURCE_ATTRIBUTION_SLUGS",
        "app.services.plan_entitlements_service.VISITOR_INTELLIGENCE_SLUGS",
        "app.services.plan_service._DELTA_RECRAWL_PLAN_SLUGS",
    }
)


def _slug_gate_constants() -> list[tuple[str, frozenset[str] | set[str]]]:
    """Every module-level plan-slug gate, discovered rather than enumerated.

    A gate is a module-level set of plan slugs whose name ends in ``_SLUGS``:
    the shape every capability gate outside ``Plan.features`` uses. Membership
    decides whether a tier gets the feature, so a new one that forgets the
    trial takes a Professional capability away from it, silently and behind
    copy that promises the opposite.

    Every module under ``app`` is walked, not a hand-picked list, because the
    gate that motivated this scan (``QUOTATION_PLAN_SLUGS``) lives in
    ``app.api`` while the others live in ``app.services``: gates do not stay
    where you expect them. The walk is over FILES rather than
    ``pkgutil.walk_packages`` because ``app.api`` carries no ``__init__.py``,
    so the package walker never descends into it and the scan would have
    silently missed the one gate it exists to catch.

    ``_KNOWN_SLUG_GATES`` is the floor, so a rename out of the ``_SLUGS``
    convention fails loudly rather than quietly shrinking the guard.
    """
    import importlib
    from pathlib import Path

    import app

    root = Path(app.__file__).resolve().parent
    gates: dict[str, frozenset[str] | set[str]] = {}
    for path in sorted(root.rglob("*.py")):
        rel = path.relative_to(root).with_suffix("")
        parts = [part for part in rel.parts if part != "__init__"]
        if not parts or any(part.startswith("_") and part != "__init__" for part in parts[:-1]):
            continue
        module_name = ".".join(["app", *parts])
        try:
            module = importlib.import_module(module_name)
        except Exception:  # noqa: BLE001 - an unimportable module cannot hold a live gate
            continue
        for attr in dir(module):
            if not attr.endswith("_SLUGS"):
                continue
            # ``_SEEDED_PLAN_SLUGS`` is the roster of seeded tiers, not a gate:
            # it answers "is this slug bespoke", which is the opposite question.
            if attr == "_SEEDED_PLAN_SLUGS":
                continue
            value = getattr(module, attr)
            if not isinstance(value, frozenset | set) or not all(isinstance(item, str) for item in value):
                continue
            gates[f"{module_name}.{attr}"] = value

    missing = _KNOWN_SLUG_GATES - set(gates)
    assert not missing, f"the scan stopped finding known slug gates: {sorted(missing)}"
    return sorted(gates.items())


def test_the_trial_matches_professional_on_every_gate_outside_plan_features():
    """Capabilities gated by slug, not by the ``features`` column, must agree.

    The trial's ``features`` dict is Professional's, and the seed test above
    pins that. But several capabilities are gated on slug sets instead, so a
    row absent from one silently carries LESS than its features claim. Worse, a
    slug absent from ``_SEEDED_PLAN_SLUGS`` is read by ``_paid_tier_includes``
    as a bespoke per-contract tier and silently carries MORE. Pinning the trial
    to Professional's answer on each gate is what keeps the row's own
    description, "Fourteen days of everything", true in both directions.

    ``_slug_gate_constants`` finds the gates by scanning the modules that hold
    them rather than listing them here, so a gate added later is covered the
    day it lands. A hand-written list is what let the quotation flow sit
    outside this guard.
    """
    for name, ladder in _slug_gate_constants():
        assert ("trial" in ladder) == ("professional" in ladder), name

    # Membership is what every gate reads. Four of them wrap it in
    # ``_paid_tier_includes``, which also grants any slug OUTSIDE
    # ``_SEEDED_PLAN_SLUGS`` (a bespoke per-contract tier); the other two use a
    # bare ``in``. Asserting the wrapper over all six would be vacuous on the
    # two that never call it, so it is asserted only where it is the enforcer.
    from app.services.plan_entitlements_service import (
        EMAIL_VERIFICATION_SLUGS,
        JOURNEY_ANALYTICS_SLUGS,
        LEAD_SOURCE_ATTRIBUTION_SLUGS,
        VISITOR_INTELLIGENCE_SLUGS,
    )

    for ladder in (
        EMAIL_VERIFICATION_SLUGS,
        JOURNEY_ANALYTICS_SLUGS,
        LEAD_SOURCE_ATTRIBUTION_SLUGS,
        VISITOR_INTELLIGENCE_SLUGS,
    ):
        assert _paid_tier_includes("trial", ladder) == _paid_tier_includes("professional", ladder)


def test_start_trial_route_is_gone(db):
    """The Standard-only trial offer is removed, not gated.

    404, not 400 or 403. A Free customer post-conversion must never be able to
    reach a second trial concept, and a gated route is still a route the next
    reader has to reconcile with the signup trial.
    """
    from app.api import subscription_routes

    assert not any(getattr(route, "path", "").endswith("/start-trial") for route in subscription_routes.router.routes)

    buyer = _buyer(db, email="starttrial-gone@e.com")
    db.commit()
    with patch.object(subscription_routes, "get_session", lambda: _session_cm(db)):
        res = _api(db, buyer).post("/subscriptions/start-trial", json={"plan_slug": "standard"})
    assert res.status_code == 404, res.text


def test_signup_opens_a_trialing_sub_with_500_credits(db):
    """The signup branch already exists. This pins it against the new row.

    ``assign_default_plan_to_client`` branches on ``trial_days > 0``, opens the
    subscription in ``trialing``, pins ``current_period_end`` to ``trial_end``
    so the billing UI's "renews on" label is the trial deadline, and grants the
    plan's credits inline because no payment ever arrives to trigger a grant.
    """
    from app.services import credit_service, plan_service

    _mk(db, "free")
    _mk(db, "trial", default=True, public=False, trial_days=14)
    c = Client(name="T", email="trial-t@example.com", api_key="k-trial-1", hashed_password="h")
    db.add(c)
    db.flush()
    db.commit()

    sub = plan_service.assign_default_plan_to_client(db, c.id)
    db.commit()

    assert sub.status == "trialing"
    assert (sub.trial_end - sub.trial_start).days == 14
    assert sub.current_period_end == sub.trial_end
    assert credit_service.get_balance(db, c.id) == 500
