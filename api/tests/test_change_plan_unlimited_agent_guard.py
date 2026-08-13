"""A POOLED plan must never land on a bot-scoped subscription.

A plan whose ``limits.bots`` is the ``UNLIMITED`` sentinel sells ONE credit
balance pooled across unlimited agents. Attached to a bot-scoped subscription
its credits are granted into that single bot's isolated ledger
(``credit_service.resolve_bot_ledger_bot_id``) while every other agent the
promise entitles drains the unfunded shared client pool — one working agent and
N silent ones.

Two layers defend that invariant, and both are covered here.

**The request layer** (``POST /subscriptions/change-plan``). The guard keys off
the SCOPE THE MUTATION WILL LAND ON, not off ``request.bot_id``:

* Branches 1 / 2a / 2b act on the subscription ``_resolve_target_subscription``
  returned, so their scope is ``sub.bot_id``. That resolver falls back to the
  ACCOUNT row when the selected agent has no subscription of its own — and in
  that fallback the upgrade is account-scoped and perfectly correct, so it must
  go through. Keying the guard on ``request.bot_id`` blocked it, which (given
  the shell is always scoped to exactly one agent — ``BotContext``) made such a
  tier unbuyable by every existing customer.
* Branch 3 is the exception: ``razorpay_service.create_bot_resubscription``
  stamps ``request.bot_id`` onto the new subscription whatever the resolver
  returned, so that branch is guarded on the request parameter.

**The sink** (``razorpay_service._handle_subscription_activated``). Eight mint
paths can attach a plan to a bot-scoped subscription and they all funnel into
one INSERT; the sink refuses to persist the incoherent state whichever door the
mandate came through — including a per-bot mandate created BEFORE the route
guards shipped and only authorised afterwards.

Every case pins the sentinel, never a slug.
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
from app.services import razorpay_service
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


def _account_sub(*, monthly: int = 94900, razorpay: str | None = "sub_live_account") -> Subscription:
    """The ACCOUNT subscription (``bot_id IS NULL``).

    What ``_resolve_target_subscription`` falls back to when the selected agent
    holds no subscription of its own — the case the regression blocked.
    """
    current = _plan("professional", 1, plan_id=3, monthly=monthly)
    sub = Subscription(
        id=9,
        client_id=1,
        plan_id=current.id,
        bot_id=None,
        status="active",
        billing_cycle="monthly",
        payment_provider="razorpay" if razorpay else "manual",
        razorpay_subscription_id=razorpay,
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


def test_account_fallback_that_reaches_branch_3_is_still_rejected(gateway):
    """The fallback does NOT make Branch 3 safe — hence the second guard.

    Here the agent has no subscription, so the resolver falls back to the
    account row (``bot_id IS NULL``) and the first guard passes. But that row
    carries no Razorpay mandate, so neither in-place paid branch matches and the
    request falls through to Branch 3 — which hands ``request.bot_id`` to
    ``create_bot_resubscription`` and would mint a BOT-SCOPED mandate on the
    pooled plan. A guard on ``sub.bot_id`` alone would have missed this.
    """
    result = gateway(
        plan=_plan("enterprise", UNLIMITED),
        sub=_account_sub(razorpay=None),
        bot_id=42,
    )

    assert result.response.status_code == 400, result.response.text
    assert result.response.json()["detail"]["code"] == "plan_not_per_agent"
    _assert_no_gateway_calls(result)


def test_error_message_does_not_send_the_customer_to_a_view_that_cannot_exist(gateway):
    """The refusal must be actionable.

    The shell resolves to exactly one agent whenever the account has any
    (``BotContext``), so "switch from account-level Billing with no agent
    selected" named a view the customer can never reach.
    """
    result = gateway(plan=_plan("enterprise", UNLIMITED), sub=_bot_scoped_sub(), bot_id=42)

    message = result.response.json()["detail"]["message"].lower()
    assert "no agent selected" not in message
    assert "support" in message


# ── Everything the guard must leave alone ───────────────────────────────────


def test_account_fallback_upgrade_to_unlimited_agent_plan_proceeds(gateway):
    """THE REGRESSION. A ``bot_id`` alone is not bot scope.

    The selected agent holds no subscription of its own, so
    ``_resolve_target_subscription`` falls back to the ACCOUNT row and Branch 2a
    upgrades THAT. ``transition_service.execute_paid_upgrade`` only stamps
    ``oyechats_bot_id`` into the replacement mandate's notes when
    ``sub.bot_id is not None``, so the replacement is account-scoped — exactly
    the pooled shape the tier sells. The guard must stay out of the way.
    """
    result = gateway(plan=_plan("enterprise", UNLIMITED), sub=_account_sub(), bot_id=42)

    assert result.response.status_code == 200, result.response.text
    result.upgrade.assert_called_once()
    result.revive.assert_not_called()
    result.session.commit.assert_called_once()


def test_account_fallback_upgrade_to_a_normal_paid_plan_proceeds(gateway):
    """The same fallback shape on an ordinary plan — untouched by either guard."""
    result = gateway(plan=_plan("scale", 1), sub=_account_sub(), bot_id=42)

    assert result.response.status_code == 200, result.response.text
    result.upgrade.assert_called_once()
    result.session.commit.assert_called_once()


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


# ── The sink: ``razorpay_service._handle_subscription_activated`` ────────────
#
# The request guards close two doors; the sink closes them all, and is the only
# thing that can stop a per-bot mandate authorised AFTER this deploy but created
# BEFORE it from materialising the incoherent state.


class _ReachedTheMint(Exception):
    """Raised by a stub placed just past the guard, to prove it let the call through."""


_PAST_PERIOD_START = 1704067200  # 2024-01-01Z — safely past, so no deferred-start branch.
_PAST_PERIOD_END = 1706745600  # 2024-02-01Z


def _activation_payload(notes: dict[str, str]) -> dict:
    """A ``subscription.activated`` envelope for a not-yet-linked mandate."""
    return {
        "subscription": {
            "entity": {
                "id": "sub_live_activation",
                "notes": {"oyechats_client_id": "1", "oyechats_plan_id": "7", **notes},
                "current_start": _PAST_PERIOD_START,
                "current_end": _PAST_PERIOD_END,
                "quantity": 1,
                "customer_id": "cust_test",
            }
        }
    }


@pytest.fixture()
def activation(monkeypatch):
    """Drive the activation handler's CREATE path with the plan row under test.

    ``_resolve_local_subscription`` returns ``None`` so the handler takes the
    branch that INSERTS — the sink itself. Two tripwires stand immediately past
    the guard, one per scope: the per-bot path's ``Bot`` mint and the
    account-level path's sibling-cancel sweep. Either firing proves the guard
    let the activation through; the guard returning proves it refused BEFORE
    anything the surrounding transaction would commit.
    """

    def _run(*, plan: Plan, notes: dict[str, str]):
        def _mint_tripwire(*_args, **_kwargs):
            raise _ReachedTheMint("bot mint reached")

        def _sweep_tripwire(*_args, **_kwargs):
            raise _ReachedTheMint("sibling sweep reached")

        session = MagicMock()
        session.get.side_effect = lambda model, _pk: plan if model is Plan else None
        session.execute.side_effect = _sweep_tripwire
        monkeypatch.setattr(razorpay_service, "_resolve_local_subscription", lambda *a, **k: None)
        monkeypatch.setattr(razorpay_service, "_create_bot_from_subscription_notes", _mint_tripwire)
        return session, lambda: razorpay_service._handle_subscription_activated(session, _activation_payload(notes))

    return _run


def test_sink_refuses_a_pooled_plan_on_a_new_per_bot_activation(activation):
    """``purpose=per_bot_subscription`` would mint a bot AND scope the sub to it."""
    session, run = activation(plan=_plan("enterprise", UNLIMITED), notes={"purpose": "per_bot_subscription"})

    result = run()

    assert "NOT created" in result
    # Refused before the Bot INSERT and before any sibling was cancelled — the
    # webhook route commits whatever the handler leaves behind, so an early
    # return must leave nothing behind.
    session.add.assert_not_called()
    session.execute.assert_not_called()


def test_sink_refuses_a_pooled_plan_on_a_resume_or_revive_activation(activation):
    """``oyechats_bot_id`` funds an EXISTING bot — same forbidden scope."""
    session, run = activation(plan=_plan("enterprise", UNLIMITED), notes={"oyechats_bot_id": "42"})

    result = run()

    assert "NOT created" in result
    session.add.assert_not_called()
    session.execute.assert_not_called()


def test_sink_acks_rather_than_raising_so_razorpay_stops_retrying(activation):
    """The refusal is deterministic, so a retry could only re-fail.

    Returning ACKs the delivery (the route 200s); raising would dead-letter and
    5xx, burning Razorpay's whole retry window on an outcome that cannot change.
    The ERROR log is what carries the already-charged mandate to a human.
    """
    _session, run = activation(plan=_plan("enterprise", UNLIMITED), notes={"purpose": "per_bot_subscription"})

    assert isinstance(run(), str)  # no exception escaped


def test_sink_leaves_an_account_level_activation_of_a_pooled_plan_alone(activation):
    """``bot_id IS NULL`` is exactly what a pooled tier is sold on."""
    _session, run = activation(plan=_plan("enterprise", UNLIMITED), notes={})

    with pytest.raises(_ReachedTheMint):
        run()


def test_sink_leaves_a_normal_paid_plan_on_a_per_bot_activation_alone(activation):
    """A finite ``limits.bots`` quota is per-bot sellable exactly as before."""
    _session, run = activation(plan=_plan("scale", 1), notes={"purpose": "per_bot_subscription"})

    with pytest.raises(_ReachedTheMint):
        run()


def test_sink_treats_an_unreadable_plan_row_conservatively(activation):
    """No ``bots`` quota is NOT unlimited — a bespoke plan row still activates."""
    _session, run = activation(plan=_plan("bespoke-acme", None), notes={"purpose": "per_bot_subscription"})

    with pytest.raises(_ReachedTheMint):
        run()
