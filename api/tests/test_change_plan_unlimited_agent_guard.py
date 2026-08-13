"""``POST /subscriptions/change-plan`` must refuse unlimited-agent plans per-bot.

Sibling of ``test_bot_checkout_plan_guard.py``. Per-bot checkout was only the
first door onto a bot-scoped subscription; ``change-plan`` is the second, and
the one existing customers actually walk through — the per-agent Billing view
passes the selected agent's id as ``bot_id`` on every plan switch
(``BillingPage`` → ``PlanConfirmModal`` → ``usePlanCheckout``), and the
dashboard is always scoped to exactly one agent.

Two branches land a bot-scoped subscription on the requested plan:

* **Branch 2a** (per-bot upgrade) — ``transition_service.execute_paid_upgrade``
  stamps ``oyechats_bot_id`` into the new mandate's notes whenever the targeted
  subscription is bot-scoped, so the replacement is bot-scoped too.
* **Branch 3** (revive-in-place) — ``razorpay_service.create_bot_resubscription``
  carries the ``bot_id`` straight through, whatever the plan.

Either way the plan's credits are granted into ONE bot's isolated ledger
(``credit_service.resolve_bot_ledger_bot_id``) while every other agent the
"unlimited agents" promise entitles drains the unfunded shared client pool.

These tests pin the guard on the sentinel, never a slug: the unlimited plan is
rejected for a bot-scoped request, an ordinary paid plan is untouched, a plan
row without a ``bots`` quota is untouched, and the ACCOUNT-level request
(``bot_id`` omitted) — the correct way to buy such a tier — still goes through.
"""

from __future__ import annotations

from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api import subscription_routes
from app.api.auth import get_current_client_strict, require_verified_email
from app.db.models import Plan, Subscription
from app.services.plan_entitlements_service import UNLIMITED

_CHECKOUT_PAYLOAD = {"subscription_id": "sub_test123", "key_id": "rzp_test_key"}


@contextmanager
def _session_ctx(session):
    yield session


def _plan(slug: str, bots_limit: int | None, *, plan_id: int = 7, monthly: int = 479900) -> Plan:
    """A plan row. ``bots_limit=None`` omits the ``bots`` key entirely."""
    limits: dict[str, int] = {"credits": 13000}
    if bots_limit is not None:
        limits["bots"] = bots_limit
    return Plan(
        id=plan_id,
        name=slug.capitalize(),
        slug=slug,
        monthly_price_cents=monthly,
        annual_price_cents=monthly * 10,
        credits_per_month=13000,
        limits=limits,
        features={},
        is_active=True,
    )


def _bot_scoped_sub(*, bot_id: int = 42, monthly: int = 94900) -> Subscription:
    """An active, gateway-backed subscription scoped to one agent.

    Cheaper than the target plans below, so ``change_plan`` routes it into
    Branch 2a (upgrade-now) rather than the downgrade branch.
    """
    current = _plan("professional", 1, plan_id=3, monthly=monthly)
    sub = Subscription(
        id=11,
        client_id=1,
        plan_id=current.id,
        bot_id=bot_id,
        status="active",
        billing_cycle="monthly",
        payment_provider="razorpay",
        razorpay_subscription_id="sub_live_bot42",
    )
    sub.plan = current
    return sub


def _build_app() -> FastAPI:
    app = FastAPI()
    app.include_router(subscription_routes.router)
    client = SimpleNamespace(id=1)
    app.dependency_overrides[get_current_client_strict] = lambda: client
    # The email-verification gate has its own coverage; act as a verified client.
    app.dependency_overrides[require_verified_email] = lambda: client
    return app


@pytest.fixture()
def gateway(monkeypatch):
    """Neutralise everything around the guard and capture the money calls.

    The DB-touching helpers (``lock_client_for_billing``,
    ``_resolve_target_subscription``) and the pre-charge identity/country gates
    are covered by their own suites; stubbing them keeps this file a pure test
    of the plan-scope guard, exactly like the per-bot checkout sibling.
    """
    session = MagicMock()
    monkeypatch.setattr(subscription_routes, "get_session", lambda: _session_ctx(session))
    monkeypatch.setattr(subscription_routes, "lock_client_for_billing", lambda *a, **k: None)
    monkeypatch.setattr(subscription_routes, "_require_precharge_gates", lambda *a, **k: "IN")

    def _run(*, plan: Plan, sub: Subscription | None, bot_id: int | None):
        monkeypatch.setattr(subscription_routes, "_resolve_target_subscription", lambda *a, **k: sub)
        body: dict[str, object] = {"plan_id": plan.id, "billing_cycle": "monthly"}
        if bot_id is not None:
            body["bot_id"] = bot_id
        with (
            patch("app.services.plan_service.get_plan_by_id", return_value=plan),
            patch(
                "app.services.transition_service.execute_paid_upgrade",
                return_value=dict(_CHECKOUT_PAYLOAD),
            ) as upgrade,
            patch(
                "app.services.razorpay_service.create_bot_resubscription",
                return_value=dict(_CHECKOUT_PAYLOAD),
            ) as revive,
            patch(
                "app.services.razorpay_service.create_subscription",
                return_value=dict(_CHECKOUT_PAYLOAD),
            ) as mint,
        ):
            response = TestClient(_build_app()).post("/subscriptions/change-plan", json=body)
        return SimpleNamespace(
            response=response,
            session=session,
            upgrade=upgrade,
            revive=revive,
            mint=mint,
        )

    return _run


def _assert_no_gateway_calls(result) -> None:
    result.upgrade.assert_not_called()
    result.revive.assert_not_called()
    result.mint.assert_not_called()
    result.session.commit.assert_not_called()


# ── The guard ───────────────────────────────────────────────────────────────


def test_bot_scoped_upgrade_to_unlimited_agent_plan_is_rejected(gateway):
    """Branch 2a: upgrading a per-bot subscription onto the unlimited tier."""
    result = gateway(plan=_plan("enterprise", UNLIMITED), sub=_bot_scoped_sub(), bot_id=42)

    assert result.response.status_code == 400, result.response.text
    detail = result.response.json()["detail"]
    assert detail["code"] == "plan_not_per_agent"
    assert "unlimited" in detail["message"].lower()
    # The caller must be told where the plan IS buyable.
    assert "account" in detail["message"].lower()
    _assert_no_gateway_calls(result)


def test_bot_scoped_revive_onto_unlimited_agent_plan_is_rejected(gateway):
    """Branch 3: reviving an unsubscribed agent straight onto the unlimited tier."""
    result = gateway(plan=_plan("enterprise", UNLIMITED), sub=None, bot_id=42)

    assert result.response.status_code == 400, result.response.text
    assert result.response.json()["detail"]["code"] == "plan_not_per_agent"
    _assert_no_gateway_calls(result)


# ── Everything the guard must leave alone ───────────────────────────────────


def test_bot_scoped_change_to_a_normal_paid_plan_still_proceeds(gateway):
    """A finite ``limits.bots`` quota is per-bot sellable exactly as before."""
    result = gateway(plan=_plan("scale", 1), sub=_bot_scoped_sub(), bot_id=42)

    assert result.response.status_code == 200, result.response.text
    result.upgrade.assert_called_once()
    result.session.commit.assert_called_once()


def test_plan_without_a_bots_quota_still_proceeds(gateway):
    """A bespoke plan row missing ``limits.bots`` is not an unlimited plan.

    Only the explicit ``-1`` sentinel may trip the guard — reading a missing or
    garbled quota as unlimited would block legitimate per-agent plan changes on
    hand-provisioned plan rows.
    """
    result = gateway(plan=_plan("bespoke-acme", None), sub=None, bot_id=42)

    assert result.response.status_code == 200, result.response.text
    result.revive.assert_called_once()
    result.session.commit.assert_called_once()


def test_account_level_change_to_unlimited_agent_plan_proceeds(gateway):
    """``bot_id`` omitted is the CORRECT purchase path and must not regress.

    Without a bot scope the subscription is minted against the shared client
    pool (``bot_id IS NULL``) — which is exactly what an unlimited-agent tier
    sells — so the guard must stay out of the way.
    """
    result = gateway(plan=_plan("enterprise", UNLIMITED), sub=None, bot_id=None)

    assert result.response.status_code == 200, result.response.text
    result.mint.assert_called_once()
    result.revive.assert_not_called()
    result.session.commit.assert_called_once()
