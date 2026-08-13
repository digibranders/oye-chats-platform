"""``POST /bots/checkout`` must refuse plans that are not per-bot sellable.

Two independent reasons a plan is unsellable here. One is per-bot coherence
(the ``limits.bots`` sentinel, below). The other is that the plan is simply not
on sale: ``is_active`` is part of the slug lookup, so a soft-deleted or
withdrawn tier 404s instead of quietly minting a subscription for a caller who
skipped the plan list and posted the slug directly.

Per-bot checkout mints a subscription **scoped to one bot** — the activation
webhook stamps ``subscription.bot_id`` with the bot it materialises, which in
turn routes that bot to its own isolated credit ledger
(``credit_service.resolve_bot_ledger_bot_id``).

A plan whose ``limits.bots`` is ``UNLIMITED`` (-1) is incoherent in that model:
its whole promise is one credit pool shared across every agent on the account.
Bought per-bot, the monthly credits land in a single bot's isolated ledger while
every other agent the plan entitles falls back to the (unfunded) shared client
pool. So the guard keys off the quota sentinel, never a slug — any future
unlimited-agent plan is covered the moment it is seeded.

These tests pin both sides: the unlimited plan is rejected, and an ordinary
paid plan still reaches Razorpay exactly as before. The route tests can only
reach the predicate through one plan shape each, so
:func:`plan_entitlements_service.plan_grants_unlimited_bots` — a pure function
over ``Plan.limits`` — is also asserted directly below, across every JSONB
value that column can actually hold. It is what the whole guard turns on, and
"conservative on bad data" is a claim about inputs no route test constructs.
"""

from __future__ import annotations

import os
from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.auth import (
    get_current_client_or_operator,
    require_verified_email_for_workspace,
)
from app.api.bot_routes import router
from app.db.models import Client, Plan
from app.services.plan_entitlements_service import UNLIMITED, plan_grants_unlimited_bots
from tests.test_bot_routes import _ExecuteResult

needs_db = pytest.mark.skipif(
    not os.getenv("DB_URL"),
    reason="the is_active lookup must be proven against real SQL, so it needs Postgres at DB_URL",
)


@contextmanager
def _session_ctx(session):
    yield session


def _build_app(client_id: int = 1) -> FastAPI:
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_current_client_or_operator] = lambda: {
        "type": "client",
        "entity": SimpleNamespace(id=client_id),
        "client_id": client_id,
        "operator_id": None,
    }
    # The email-verification gate has its own coverage; act as a verified workspace.
    app.dependency_overrides[require_verified_email_for_workspace] = lambda: None
    return app


def _plan(slug: str, bots_limit: int) -> Plan:
    return Plan(
        id=7,
        name=slug.capitalize(),
        slug=slug,
        monthly_price_cents=479900,
        credits_per_month=13000,
        limits={"bots": bots_limit, "credits": 13000},
        features={},
    )


def _mock_session(plan: Plan) -> MagicMock:
    session = MagicMock()
    session.execute.return_value = _ExecuteResult(plan)
    return session


def _post(session: MagicMock, monkeypatch, *, plan_slug: str):
    from app.api import bot_routes

    monkeypatch.setattr(bot_routes, "get_session", lambda: _session_ctx(session))
    tc = TestClient(_build_app())
    return tc.post(
        "/bots/checkout",
        json={"name": "Client Site 12", "website": "https://client12.com", "plan_slug": plan_slug},
    )


def test_unlimited_agent_plan_is_rejected(monkeypatch):
    """A ``limits.bots == -1`` plan must not be sellable through per-bot checkout."""
    session = _mock_session(_plan("enterprise", UNLIMITED))

    with patch("app.services.razorpay_service.create_per_bot_subscription") as create_sub:
        response = _post(session, monkeypatch, plan_slug="enterprise")

    assert response.status_code == 400, response.text
    detail = response.json()["detail"]
    assert "unlimited" in detail.lower()
    # The caller must be told where the plan IS sellable.
    assert "account" in detail.lower()
    # Nothing may have been minted at the gateway, and nothing committed.
    create_sub.assert_not_called()
    session.commit.assert_not_called()


def test_finite_agent_quota_plan_still_reaches_checkout(monkeypatch):
    """A normal paid plan (``limits.bots: 1``) is unaffected by the guard."""
    session = _mock_session(_plan("standard", 1))
    payload = {"subscription_id": "sub_test123", "key_id": "rzp_test_key"}

    with patch("app.services.razorpay_service.create_per_bot_subscription", return_value=payload) as create_sub:
        response = _post(session, monkeypatch, plan_slug="standard")

    assert response.status_code == 200, response.text
    assert response.json() == payload
    create_sub.assert_called_once()
    session.commit.assert_called_once()


def test_plan_without_a_bots_quota_still_reaches_checkout(monkeypatch):
    """A bespoke plan row missing ``limits.bots`` is not an unlimited plan.

    The guard must only fire on the explicit ``-1`` sentinel — treating a
    missing/garbled key as unlimited would block legitimate per-bot purchases
    on hand-provisioned plan rows.
    """
    # Built here rather than through ``_plan``, whose signature demands a
    # ``bots`` quota — the absence of that key IS the case under test.
    session = _mock_session(Plan(id=9, name="Acme", slug="bespoke-acme", limits={"credits": 5000}, features={}))
    payload = {"subscription_id": "sub_test999", "key_id": "rzp_test_key"}

    with patch("app.services.razorpay_service.create_per_bot_subscription", return_value=payload) as create_sub:
        response = _post(session, monkeypatch, plan_slug="bespoke-acme")

    assert response.status_code == 200, response.text
    create_sub.assert_called_once()
    session.commit.assert_called_once()


# ── the predicate itself (pure function over Plan.limits) ────────────────────


def _limits(value: object) -> Plan:
    """A plan row whose ``limits`` is exactly ``value``."""
    return Plan(id=1, name="P", slug="p", limits=value, features={})


class TestPlanGrantsUnlimitedBots:
    """``limits`` is untyped JSONB, so the predicate must survive its whole range.

    Only the explicit ``-1`` sentinel may fire. Everything unreadable has to
    answer False, because a False here merely lets a per-bot purchase proceed
    as it always did, whereas a stray True refuses a legitimate sale on a
    hand-provisioned plan row — and the customer has no way to tell why.
    """

    def test_the_sentinel_fires(self):
        assert plan_grants_unlimited_bots(_limits({"bots": UNLIMITED})) is True

    def test_the_sentinel_stored_as_a_string_fires(self):
        # A super-admin editing the Plans page can write the quota as text; the
        # server reads it through ``int()``, so ``"-1"`` is the same sentinel.
        # ``billingModel.toNumberMap`` coerces the same way, so the frontend
        # picker filters this row instead of offering a plan this route refuses.
        assert plan_grants_unlimited_bots(_limits({"bots": "-1"})) is True

    def test_a_float_sentinel_fires(self):
        # JSON has one number type; a round-tripped ``-1`` can land as ``-1.0``.
        assert plan_grants_unlimited_bots(_limits({"bots": -1.0})) is True

    def test_a_missing_quota_is_not_unlimited(self):
        assert plan_grants_unlimited_bots(_limits({"credits": 5000})) is False

    def test_a_null_quota_is_not_unlimited(self):
        assert plan_grants_unlimited_bots(_limits({"bots": None})) is False

    def test_a_non_numeric_quota_is_not_unlimited(self):
        assert plan_grants_unlimited_bots(_limits({"bots": "unlimited"})) is False

    def test_limits_that_is_not_an_object_at_all_is_not_unlimited(self):
        # ``limits`` is nullable, and nothing constrains it to an object.
        assert plan_grants_unlimited_bots(_limits(None)) is False
        assert plan_grants_unlimited_bots(_limits([-1])) is False

    def test_another_negative_quota_is_not_the_sentinel(self):
        # Only -1 means unlimited. -2 is corrupt data, and reading it as
        # "unlimited" would refuse a sale on the strength of a typo.
        assert plan_grants_unlimited_bots(_limits({"bots": -2})) is False

    def test_a_finite_quota_is_not_unlimited(self):
        assert plan_grants_unlimited_bots(_limits({"bots": 1})) is False
        assert plan_grants_unlimited_bots(_limits({"bots": 0})) is False


# ── withdrawn plans (real SQL — the mock session ignores the WHERE clause) ────


def _persist_plan(db, *, slug: str, is_active: bool) -> Plan:
    plan = Plan(
        name=slug.title(),
        slug=slug,
        monthly_price_cents=179900,
        annual_price_cents=1799000,
        credits_per_month=1000,
        included_operator_seats=1,
        is_active=is_active,
        limits={"bots": 1, "credits": 1000},
        features={},
        razorpay_plan_id_monthly=f"plan_{slug}_inr_m",
        razorpay_plan_id_annual=f"plan_{slug}_inr_a",
    )
    db.add(plan)
    db.flush()
    return plan


def _post_db(db, monkeypatch, owner: Client, *, plan_slug: str):
    from app.api import bot_routes

    monkeypatch.setattr(bot_routes, "get_session", lambda: _session_ctx(db))
    tc = TestClient(_build_app(client_id=owner.id))
    return tc.post(
        "/bots/checkout",
        json={"name": "Client Site 12", "website": "https://client12.com", "plan_slug": plan_slug},
    )


def _owner(db, *, email: str) -> Client:
    client = Client(name="o", email=email, api_key=email, hashed_password="h", is_verified=True)
    db.add(client)
    db.flush()
    return client


@needs_db
def test_deactivated_plan_is_not_purchasable_by_slug(db, monkeypatch):
    """A withdrawn / soft-deleted tier must 404, not mint a subscription.

    The plan list already hides it, so the only way here is a caller posting
    the slug directly — which is exactly the case the predicate exists for.
    """
    owner = _owner(db, email="botco-inactive@e.com")
    _persist_plan(db, slug="retired-tier", is_active=False)
    db.commit()

    with patch("app.services.razorpay_service.create_per_bot_subscription") as create_sub:
        response = _post_db(db, monkeypatch, owner, plan_slug="retired-tier")

    assert response.status_code == 404, response.text
    # Same wording as a slug that never existed — no probing for retired tiers.
    assert "not found" in response.json()["detail"].lower()
    create_sub.assert_not_called()


@needs_db
def test_active_plan_of_the_same_shape_still_reaches_checkout(db, monkeypatch):
    """Control: only the flag differs, and it is the flag doing the work."""
    owner = _owner(db, email="botco-active@e.com")
    _persist_plan(db, slug="live-tier", is_active=True)
    db.commit()
    payload = {"subscription_id": "sub_live123", "key_id": "rzp_test_key"}

    with patch("app.services.razorpay_service.create_per_bot_subscription", return_value=payload) as create_sub:
        response = _post_db(db, monkeypatch, owner, plan_slug="live-tier")

    assert response.status_code == 200, response.text
    assert response.json() == payload
    create_sub.assert_called_once()
