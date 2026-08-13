"""``POST /bots/checkout`` must refuse plans that are not per-bot sellable.

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
paid plan still reaches Razorpay exactly as before.
"""

from __future__ import annotations

from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.auth import (
    get_current_client_or_operator,
    require_verified_email_for_workspace,
)
from app.api.bot_routes import router
from app.db.models import Plan
from app.services.plan_entitlements_service import UNLIMITED
from tests.test_bot_routes import _ExecuteResult


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
    session = _mock_session(_plan("bespoke-acme", 1))
    session.execute.return_value = _ExecuteResult(
        Plan(id=9, name="Acme", slug="bespoke-acme", limits={"credits": 5000}, features={})
    )
    payload = {"subscription_id": "sub_test999", "key_id": "rzp_test_key"}

    with patch("app.services.razorpay_service.create_per_bot_subscription", return_value=payload) as create_sub:
        response = _post(session, monkeypatch, plan_slug="bespoke-acme")

    assert response.status_code == 200, response.text
    create_sub.assert_called_once()
