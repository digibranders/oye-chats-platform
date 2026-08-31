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
from app.services.plan_entitlements_service import _SEEDED_PLAN_SLUGS, _paid_tier_includes
from app.services.plan_service import get_active_plans, get_default_plan

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")


def _mk(db, slug, *, default=False, public=True, trial_days=0, active=True, credits=500):
    p = Plan(
        slug=slug,
        name=slug.title(),
        credits_per_month=credits,
        monthly_price_cents=0,
        annual_price_cents=0,
        trial_days=trial_days,
        is_default=default,
        is_active=active,
        is_public=public,
        sort_order=99,
        limits={"bots": 1, "credits": credits},
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
    assert trial["limits"]["knowledge_characters"] == 100_000
    # The free-page allowance the trial ships with, sized against real
    # crawled pages (~5,200 chars each) so 25 pages fits inside the cap.
    assert trial["limits"]["free_training_pages"] == 25
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


def _slug_gate_constants() -> list[tuple[str, frozenset[str]]]:
    """Every module-level plan-slug gate, discovered rather than enumerated.

    A gate is a module-level assignment of a set of plan slugs whose name ends
    in ``_SLUGS``: the shape every capability gate outside ``Plan.features``
    uses. Membership decides whether a tier gets the feature, so a new one that
    forgets the trial takes a Professional capability away from it, silently
    and behind copy that promises the opposite.

    Read with :mod:`ast` rather than by importing. Importing every module under
    ``app`` to inspect it would pull the FastAPI app, the ARQ worker and their
    module-level side effects into this test's process, and it would silently
    drop the gate of any module that failed to import, which is exactly the
    silence this scan exists to break. Parsing sees the source whether or not
    it imports.

    Every file under ``app`` is read, not a hand-picked list, because the gate
    that motivated this scan (``QUOTATION_PLAN_SLUGS``) lives in ``app.api``
    while the others live in ``app.services``: gates do not stay where you
    expect them. ``_KNOWN_SLUG_GATES`` is the floor, so a rename out of the
    ``_SLUGS`` convention fails loudly rather than quietly shrinking the guard.
    """
    import ast
    from pathlib import Path

    import app

    root = Path(app.__file__).resolve().parent
    gates: dict[str, frozenset[str]] = {}
    for path in sorted(root.rglob("*.py")):
        rel = path.relative_to(root).with_suffix("")
        module_name = ".".join(["app", *(part for part in rel.parts if part != "__init__")])
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in tree.body:
            targets = (
                [node.target]
                if isinstance(node, ast.AnnAssign)
                else (node.targets if isinstance(node, ast.Assign) else [])
            )
            names = [t.id for t in targets if isinstance(t, ast.Name) and t.id.endswith("_SLUGS")]
            # ``_SEEDED_PLAN_SLUGS`` is the roster of seeded tiers, not a gate:
            # it answers "is this slug bespoke", which is the opposite question.
            names = [name for name in names if name != "_SEEDED_PLAN_SLUGS"]
            if not names or node.value is None:
                continue
            literal = node.value
            # ``frozenset({...})`` / ``set({...})`` wrap the literal in a call.
            if isinstance(literal, ast.Call) and isinstance(literal.func, ast.Name):
                if literal.func.id not in ("frozenset", "set") or len(literal.args) != 1:
                    continue
                literal = literal.args[0]
            try:
                value = ast.literal_eval(literal)
            except ValueError:
                continue
            if not isinstance(value, set | frozenset) or not all(isinstance(item, str) for item in value):
                continue
            for name in names:
                gates[f"{module_name}.{name}"] = frozenset(value)

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
    # ``_paid_tier_includes``, which ALSO grants any slug outside
    # ``_SEEDED_PLAN_SLUGS`` (a bespoke per-contract tier); the other two use a
    # bare ``in``, so a bespoke slug is denied there. That split is real and
    # predates this row, so it is recorded here rather than asserted away.
    #
    # For a slug the roster knows, ``_paid_tier_includes`` collapses to plain
    # membership, so re-asserting it over the ladders above would only restate
    # the loop. The one thing it adds is that the trial IS on the roster: drop
    # it and every ladder-gated feature flips on through the bespoke rule
    # instead, silently and without anyone choosing it.
    assert "trial" in _SEEDED_PLAN_SLUGS
    assert _paid_tier_includes("trial", frozenset()) is False
    assert _paid_tier_includes("enterprise-acme", frozenset()) is True


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
    because the trial is the whole period, and grants the plan's credits inline
    because no payment ever arrives to trigger a grant.
    """
    from app.services import credit_service, plan_service

    # Free grants a DIFFERENT number, so the balance assertion below can tell
    # the trial's grant apart from the free plan's and from a hardcoded 500.
    _mk(db, "free", credits=200)
    _mk(db, "trial", default=True, public=False, trial_days=14, credits=500)
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
