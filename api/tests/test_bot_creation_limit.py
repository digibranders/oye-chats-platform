"""POST /bots must honour the plan's ``bots`` quota.

``limits.bots`` is the number of AI agents a plan's subscription *includes*.
Every plan row has declared it since the plans were seeded and nothing read it,
so the only rule in force was the per-bot billing default in
``can_client_add_new_bot``: one agent per account here, every extra agent bought
through ``POST /bots/checkout``. That made Enterprise (``bots: -1``, unlimited
agents) unsellable — it behaved exactly like Free.

These tests pin both sides of the gate:

* a finite quota that is already used up leaves the paid-checkout 402 intact
  (the quota check must never *weaken* the default rule), and
* ``UNLIMITED`` (-1) waives it, which is how an agency on Enterprise gets
  unlimited agents pooled under its single subscription.
"""

from __future__ import annotations

from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.auth import (
    get_current_client_or_operator,
    require_active_subscription_for_workspace,
    require_verified_email_for_workspace,
)
from app.api.bot_routes import router
from app.services.plan_entitlements_service import UNLIMITED, AddBotDecision, PlanEntitlements
from tests.test_bot_routes import _apply_flush_defaults, _ExecuteResult


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
    # Subscription + email-verification gates are separate concerns with their
    # own coverage; act as an active, verified workspace here.
    app.dependency_overrides[require_active_subscription_for_workspace] = lambda: None
    app.dependency_overrides[require_verified_email_for_workspace] = lambda: None
    return app


def _entitlements(bots_limit: int) -> PlanEntitlements:
    return PlanEntitlements(
        client_id=1,
        plan_slug="enterprise" if bots_limit == UNLIMITED else "free",
        plan_name="Enterprise" if bots_limit == UNLIMITED else "Free",
        subscription_status="active",
        limits={"bots": bots_limit},
        features={},
    )


# The account already holds one agent, so the per-bot billing default denies.
# Whether the create proceeds is then decided purely by the plan's quota.
_DENIED = AddBotDecision(allowed=False, reason="upgrade_required", must_subscribe=True, active_bot_count=1)


def test_finite_quota_already_used_still_requires_a_paid_subscription(monkeypatch):
    """A ``bots: 1`` plan with one agent must keep 402-ing — no free second agent."""
    from app.api import bot_routes

    session = MagicMock()
    # No existing bot for this website, so the idempotent-retry branch is skipped
    # and the gate's real 402 surfaces.
    session.execute.return_value = _ExecuteResult([])
    monkeypatch.setattr(bot_routes, "get_session", lambda: _session_ctx(session))

    tc = TestClient(_build_app())
    with (
        patch("app.services.plan_entitlements_service.can_client_add_new_bot", return_value=_DENIED),
        patch(
            "app.services.plan_entitlements_service.get_entitlements",
            return_value=_entitlements(1),
        ),
    ):
        response = tc.post("/bots", json={"name": "Second", "website": "https://second.com"})

    assert response.status_code == 402
    detail = response.json()["detail"]
    assert detail["metric"] == "bots"
    assert detail["must_subscribe"] is True
    # The blocked create must not have persisted anything.
    session.add.assert_not_called()


def test_unlimited_quota_waives_the_paid_subscription_requirement(monkeypatch):
    """Enterprise (``bots: -1``) creates additional agents without a new checkout."""
    from app.api import bot_routes
    from app.db.models import Bot

    session = MagicMock()
    added: list[object] = []
    session.add.side_effect = added.append
    session.refresh.side_effect = lambda obj: _apply_flush_defaults(obj, 99)
    monkeypatch.setattr(bot_routes, "get_session", lambda: _session_ctx(session))

    tc = TestClient(_build_app())
    with (
        patch("app.services.plan_entitlements_service.can_client_add_new_bot", return_value=_DENIED),
        patch(
            "app.services.plan_entitlements_service.get_entitlements",
            return_value=_entitlements(UNLIMITED),
        ),
    ):
        response = tc.post("/bots", json={"name": "Client Site 12", "website": "https://client12.com"})

    assert response.status_code == 201
    assert response.json()["name"] == "Client Site 12"
    assert any(isinstance(row, Bot) for row in added)


def test_missing_bots_quota_denies_and_leaves_a_support_trail(monkeypatch, caplog):
    """A contract plan that loses its ``bots`` term fails closed — and says so.

    ``limit_for`` answers 0 for a missing key, so the widening simply stops and
    the account is pushed back through per-bot checkout. Nothing else about the
    response changes, so without this log the customer reaches support saying
    "my contract includes unlimited agents" and there is no evidence the plan
    row is the thing that broke.
    """
    import logging

    from app.api import bot_routes

    session = MagicMock()
    session.execute.return_value = _ExecuteResult([])
    monkeypatch.setattr(bot_routes, "get_session", lambda: _session_ctx(session))

    no_quota = PlanEntitlements(
        client_id=1,
        plan_slug="bespoke-acme",
        plan_name="Acme",
        subscription_status="active",
        limits={"credits": 50_000},  # the ``bots`` term is gone
        features={},
    )

    tc = TestClient(_build_app())
    with (
        caplog.at_level(logging.INFO, logger=bot_routes.logger.name),
        patch("app.services.plan_entitlements_service.can_client_add_new_bot", return_value=_DENIED),
        patch("app.services.plan_entitlements_service.get_entitlements", return_value=no_quota),
    ):
        response = tc.post("/bots", json={"name": "Bespoke", "website": "https://bespoke.com"})

    assert response.status_code == 402
    session.add.assert_not_called()
    messages = [r.getMessage() for r in caplog.records if r.levelno == logging.INFO]
    assert any("bespoke-acme" in m and "no 'bots' quota" in m for m in messages), messages


def test_entitlements_failure_falls_back_to_the_paid_subscription_gate(monkeypatch):
    """Fail closed: a resolver error must not hand out a free extra agent."""
    from app.api import bot_routes

    session = MagicMock()
    session.execute.return_value = _ExecuteResult([])
    monkeypatch.setattr(bot_routes, "get_session", lambda: _session_ctx(session))

    tc = TestClient(_build_app())
    with (
        patch("app.services.plan_entitlements_service.can_client_add_new_bot", return_value=_DENIED),
        patch(
            "app.services.plan_entitlements_service.get_entitlements",
            side_effect=RuntimeError("redis and postgres both down"),
        ),
    ):
        response = tc.post("/bots", json={"name": "Third", "website": "https://third.com"})

    assert response.status_code == 402
    session.add.assert_not_called()
