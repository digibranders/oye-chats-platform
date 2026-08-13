"""A POOLED plan must never land on a bot-scoped subscription.

A plan whose ``limits.bots`` is the ``UNLIMITED`` sentinel sells ONE credit
balance pooled across unlimited agents. Attached to a bot-scoped subscription
its credits are granted into that single bot's isolated ledger
(``credit_service.resolve_bot_ledger_bot_id``) while every other agent the
promise entitles drains the unfunded shared client pool — one working agent and
N silent ones.

The defence has three shapes, and all three are covered here. Which one applies
turns on ONE question: does a subscription already exist that a refusal would be
protecting?

**REFUSE — an existing bot-scoped subscription.** ``POST /subscriptions/change-plan``
Branches 1 / 2a / 2b act on the subscription ``_resolve_target_subscription``
returned, so their scope is ``sub.bot_id``. Re-scoping such a row would move a
live credit ledger, so these refuse. ``POST /subscriptions/resume`` Mode 2 is the
same shape: it stamps ``oyechats_bot_id`` into the replacement mandate's notes
whenever ``sub.bot_id`` is set, and had no plan check at all.

**DEMOTE — no subscription exists yet.** ``change-plan`` Branch 3 mints a brand
new mandate, and ``create_bot_resubscription`` stamps ``request.bot_id`` onto it
whatever the resolver returned. Refusing here was the regression: Branch 3 is
reached WITH a ``bot_id`` whenever the resolved row is the account row carrying
no Razorpay mandate — every Free, manual, and trialing account, including the
trial→paid conversion — and since ``BotContext`` scopes the shell to exactly one
agent as soon as the account has any, that refusal made a pooled tier unbuyable
by every existing customer. Nothing is being re-scoped, so the fix is to drop the
agent scope the UI happened to carry and mint at account scope, which is what the
tier sells.

**The sink** (``razorpay_service._handle_subscription_activated``). Every mint
path funnels into one INSERT; the sink refuses to persist the incoherent state
whichever door the mandate came through — including a per-bot mandate created
BEFORE the route guards shipped and only authorised afterwards. Because the money
is already taken by then, the refusal must leave a durable, actionable artifact
and must not permanently burn the idempotency key.

Every case pins the sentinel, never a slug.
"""

from __future__ import annotations

from contextlib import contextmanager
from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import Delete, Select

from app.api import subscription_routes, superadmin_plan_routes
from app.api.auth import get_current_client_strict, get_superadmin, require_verified_email
from app.db.models import Client, FailedWebhook, Plan, ProcessedWebhook, Subscription
from app.services import razorpay_service, transition_service
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


# ── The demotion (Branch 3) ─────────────────────────────────────────────────


def test_branch_3_demotes_a_pooled_plan_to_account_scope(gateway):
    """THE FIX. A ``bot_id`` on Branch 3 must be DROPPED, not refused.

    Nothing exists to protect here: the agent holds no subscription, so
    ``create_bot_resubscription`` would be minting the client's first mandate for
    it. An account-scoped mandate is exactly what a pooled tier sells, so the
    request is routed to ``create_subscription`` (``bot_id`` NULL) instead of
    being turned away.
    """
    result = gateway(plan=_plan("enterprise", UNLIMITED), sub=None, bot_id=42)

    assert result.response.status_code == 200, result.response.text
    # The bot-scoped mint is the one thing that must NOT happen.
    result.revive.assert_not_called()
    result.mint.assert_called_once()
    result.session.commit.assert_called_once()


def test_account_fallback_that_reaches_branch_3_is_demoted(gateway):
    """The regression's real entry point: a trialing/Free/manual account.

    The agent has no subscription of its own, so the resolver falls back to the
    ACCOUNT row — which carries no Razorpay mandate, so neither in-place paid
    branch matches and the request falls through to Branch 3. This is the shape
    every Free, manual, and trialing customer arrives in (the docstring on
    ``change_plan`` names the trial→paid conversion explicitly), and refusing it
    left the tier with no reachable CTA at all.
    """
    result = gateway(
        plan=_plan("enterprise", UNLIMITED),
        sub=_account_sub(razorpay=None),
        bot_id=42,
    )

    assert result.response.status_code == 200, result.response.text
    result.revive.assert_not_called()
    result.mint.assert_called_once()
    result.session.commit.assert_called_once()


def test_branch_3_keeps_the_bot_scope_for_an_ordinary_plan(gateway):
    """The demotion is keyed on the plan, not on the branch.

    A finite ``limits.bots`` quota still revives THAT agent in place, carrying
    its id so activation reattaches the subscription and reactivates the agent's
    knowledge (same ``bot_key``/embed).
    """
    result = gateway(plan=_plan("scale", 1), sub=None, bot_id=42)

    assert result.response.status_code == 200, result.response.text
    result.mint.assert_not_called()
    result.revive.assert_called_once()
    assert result.revive.call_args.kwargs["bot_id"] == 42


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


# ── ``POST /subscriptions/resume`` ──────────────────────────────────────────
#
# Mode 2 mints a REAL replacement mandate and stamps ``oyechats_bot_id`` +
# ``purpose=per_bot_subscription`` into its notes whenever ``sub.bot_id`` is set
# — with no plan check of its own before this change. Refusal has to land BEFORE
# ``create_subscription``, or the customer is charged for a mandate the sink will
# then refuse to persist.


@pytest.fixture()
def resume(monkeypatch):
    """Drive ``/resume`` Mode 2 with the subscription under test."""
    session = MagicMock()
    monkeypatch.setattr(subscription_routes, "get_session", lambda: _session_ctx(session))
    monkeypatch.setattr(subscription_routes, "lock_client_for_billing", lambda *a, **k: None)
    monkeypatch.setattr(subscription_routes, "_require_precharge_gates", lambda *a, **k: "IN")

    def _run(*, sub: Subscription, bot_id: int | None):
        monkeypatch.setattr(subscription_routes, "_resolve_target_subscription", lambda *a, **k: sub)
        body: dict[str, object] = {}
        if bot_id is not None:
            body["bot_id"] = bot_id
        with (
            patch(
                "app.services.razorpay_service.create_subscription",
                return_value=dict(_CHECKOUT_PAYLOAD),
            ) as mint,
            patch("app.services.razorpay_service.is_subscription_live", return_value=False) as live,
            patch("app.services.transition_service.remaining_plan_credits", return_value=0),
        ):
            response = TestClient(_build_app()).post("/subscriptions/resume", json=body)
        return SimpleNamespace(response=response, session=session, mint=mint, live=live)

    return _run


def _cancelled_sub(*, plan: Plan, bot_id: int | None) -> Subscription:
    """A subscription whose gateway mandate has ALREADY been cancelled.

    ``gateway_cancel_executed_at`` set is what routes ``/resume`` past Mode 1
    (clear-a-flag) and into Mode 2 (mint a replacement mandate).
    """
    sub = Subscription(
        id=21,
        client_id=1,
        plan_id=plan.id,
        bot_id=bot_id,
        status="active",
        billing_cycle="monthly",
        payment_provider="razorpay",
        razorpay_subscription_id="sub_live_cancelled",
        cancel_at_period_end=True,
        gateway_cancel_executed_at=datetime(2026, 1, 1, tzinfo=UTC),
        current_period_end=datetime(2026, 2, 1, tzinfo=UTC),
    )
    sub.plan = plan
    return sub


def test_resume_refuses_a_bot_scoped_subscription_on_a_pooled_plan(resume):
    """Refused BEFORE the gateway call — no mandate, so no charge."""
    result = resume(sub=_cancelled_sub(plan=_plan("enterprise", UNLIMITED), bot_id=42), bot_id=42)

    assert result.response.status_code == 400, result.response.text
    assert result.response.json()["detail"]["code"] == "plan_not_per_agent"
    result.mint.assert_not_called()
    result.session.commit.assert_not_called()


def test_resume_of_an_account_scoped_subscription_on_a_pooled_plan_proceeds(resume):
    """``bot_id IS NULL`` is the shape a pooled tier is sold on — untouched."""
    result = resume(sub=_cancelled_sub(plan=_plan("enterprise", UNLIMITED), bot_id=None), bot_id=None)

    assert result.response.status_code == 200, result.response.text
    result.mint.assert_called_once()


def test_resume_of_a_bot_scoped_subscription_on_a_normal_plan_proceeds(resume):
    """A finite ``limits.bots`` quota resumes per-agent exactly as before."""
    result = resume(sub=_cancelled_sub(plan=_plan("scale", 1), bot_id=42), bot_id=42)

    assert result.response.status_code == 200, result.response.text
    result.mint.assert_called_once()


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
    account-level path's sibling-cancel sweep (every read past the guard is a
    ``SELECT``). Either firing proves the guard let the activation through; the
    guard returning proves it refused BEFORE anything the surrounding
    transaction would commit.

    ``DELETE`` is exempted from the sweep tripwire because the refusal itself
    issues one — releasing the idempotency key it would otherwise have burned on
    work it never did. Those statements are captured so a test can assert it.

    The dead-letter write opens its OWN session, so it is captured separately
    rather than landing on ``session``.
    """

    def _run(*, plan: Plan, notes: dict[str, str], event_id: str | None = "evt_pooled"):
        def _mint_tripwire(*_args, **_kwargs):
            raise _ReachedTheMint("bot mint reached")

        executed: list[object] = []

        def _execute(statement, *_args, **_kwargs):
            executed.append(statement)
            if isinstance(statement, Select):
                raise _ReachedTheMint("sibling sweep reached")
            return MagicMock()

        dead_letters: list[FailedWebhook] = []

        @contextmanager
        def _dead_letter_session():
            dl_session = MagicMock()
            # No pre-existing row, so the idempotent write goes ahead.
            dl_session.execute.return_value.scalars.return_value.first.return_value = None
            dl_session.add.side_effect = dead_letters.append
            yield dl_session

        session = MagicMock()
        session.get.side_effect = lambda model, _pk: plan if model is Plan else None
        session.execute.side_effect = _execute
        monkeypatch.setattr(razorpay_service, "_resolve_local_subscription", lambda *a, **k: None)
        monkeypatch.setattr(razorpay_service, "_create_bot_from_subscription_notes", _mint_tripwire)
        monkeypatch.setattr("app.db.session.get_session", _dead_letter_session)
        return SimpleNamespace(
            session=session,
            executed=executed,
            dead_letters=dead_letters,
            run=lambda: razorpay_service._handle_subscription_activated(
                session, _activation_payload(notes), event_id=event_id
            ),
        )

    return _run


def _deleted_event_ids(executed: list[object]) -> list[str]:
    """Event ids named by every DELETE the handler issued against the key store."""
    ids: list[str] = []
    for statement in executed:
        if not isinstance(statement, Delete) or statement.entity_description["entity"] is not ProcessedWebhook:
            continue
        ids.extend(
            str(criterion.right.value)
            for criterion in statement.whereclause.clauses
            if criterion.left.name == "event_id"
        )
    return ids


def test_sink_refuses_a_pooled_plan_on_a_new_per_bot_activation(activation):
    """``purpose=per_bot_subscription`` would mint a bot AND scope the sub to it."""
    fixture = activation(plan=_plan("enterprise", UNLIMITED), notes={"purpose": "per_bot_subscription"})

    result = fixture.run()

    assert "NOT created" in result
    # Refused before the Bot INSERT and before any sibling was cancelled — the
    # webhook route commits whatever the handler leaves behind, so an early
    # return must leave behind nothing but the key release.
    fixture.session.add.assert_not_called()
    assert not any(isinstance(statement, Select) for statement in fixture.executed)


def test_sink_refuses_a_pooled_plan_on_a_resume_or_revive_activation(activation):
    """``oyechats_bot_id`` funds an EXISTING bot — same forbidden scope."""
    fixture = activation(plan=_plan("enterprise", UNLIMITED), notes={"oyechats_bot_id": "42"})

    result = fixture.run()

    assert "NOT created" in result
    fixture.session.add.assert_not_called()
    assert not any(isinstance(statement, Select) for statement in fixture.executed)


def test_sink_acks_rather_than_raising_so_razorpay_stops_retrying(activation):
    """The refusal is deterministic, so a retry could only re-fail.

    Returning ACKs the delivery (the route 200s); raising would dead-letter and
    5xx, burning Razorpay's whole retry window on an outcome that cannot change.
    """
    fixture = activation(plan=_plan("enterprise", UNLIMITED), notes={"purpose": "per_bot_subscription"})

    assert isinstance(fixture.run(), str)  # no exception escaped


def test_sink_records_a_reconciliation_row_for_the_charge_it_refuses(activation):
    """The customer HAS been charged — an ERROR log alone is not an artifact.

    Before this, a refused activation left no ``Subscription``, no ``Invoice``,
    and nothing durable but a Sentry event. The row must land in
    ``failed_webhooks`` (the dead-letter list ops already triages) carrying every
    id needed to act: mandate, client, plan, agent, and the payment.
    """
    fixture = activation(plan=_plan("enterprise", UNLIMITED), notes={"oyechats_bot_id": "42"})

    fixture.run()

    assert len(fixture.dead_letters) == 1, "the charge left no durable record"
    row = fixture.dead_letters[0]
    assert row.provider == "razorpay"
    assert row.status == "pending"
    # Keyed on the MANDATE, not the provider event id, so the webhook and the
    # verify-reconcile that both hit this refusal collapse into one row.
    assert row.event_id == "pooled-plan-scope-refusal:sub_live_activation"
    assert row.headers == {
        "razorpay_subscription_id": "sub_live_activation",
        "razorpay_payment_id": None,
        "provider_event_id": "evt_pooled",
        "client_id": 1,
        "plan_id": 7,
        "plan_slug": "enterprise",
        "bot_id": "42",
    }
    # Actionable from the list endpoint alone, which returns `error` but never
    # `headers` or `raw_payload`.
    assert "sub_live_activation" in row.error
    assert "MANUAL RECONCILIATION REQUIRED" in row.error


def test_sink_releases_the_idempotency_key_it_would_otherwise_burn(activation):
    """Nothing was persisted, so nothing needs replay protection.

    Leaving the key burned is what made the refusal terminal: after a fix ships,
    neither a redelivery nor ``reconcile_subscription_from_razorpay`` could ever
    reprocess the activation without someone deleting a row in production. It is
    still not a retry loop — the handler ACKs, so the provider stops redelivering
    and only a DELIBERATE reprocess picks the event back up.
    """
    fixture = activation(
        plan=_plan("enterprise", UNLIMITED),
        notes={"purpose": "per_bot_subscription"},
        event_id="reconcile:sub_live_activation",
    )

    fixture.run()

    assert _deleted_event_ids(fixture.executed) == ["reconcile:sub_live_activation"]


def test_sink_release_is_a_no_op_without_an_event_id(activation):
    """A direct caller with no key must not issue an unbounded DELETE."""
    fixture = activation(
        plan=_plan("enterprise", UNLIMITED),
        notes={"purpose": "per_bot_subscription"},
        event_id=None,
    )

    fixture.run()

    assert _deleted_event_ids(fixture.executed) == []


def test_sink_leaves_an_account_level_activation_of_a_pooled_plan_alone(activation):
    """``bot_id IS NULL`` is exactly what a pooled tier is sold on."""
    fixture = activation(plan=_plan("enterprise", UNLIMITED), notes={})

    with pytest.raises(_ReachedTheMint):
        fixture.run()
    assert fixture.dead_letters == []
    assert _deleted_event_ids(fixture.executed) == []


def test_sink_leaves_a_normal_paid_plan_on_a_per_bot_activation_alone(activation):
    """A finite ``limits.bots`` quota is per-bot sellable exactly as before."""
    fixture = activation(plan=_plan("scale", 1), notes={"purpose": "per_bot_subscription"})

    with pytest.raises(_ReachedTheMint):
        fixture.run()
    assert fixture.dead_letters == []
    assert _deleted_event_ids(fixture.executed) == []


def test_sink_treats_an_unreadable_plan_row_conservatively(activation):
    """No ``bots`` quota is NOT unlimited — a bespoke plan row still activates."""
    fixture = activation(plan=_plan("bespoke-acme", None), notes={"purpose": "per_bot_subscription"})

    with pytest.raises(_ReachedTheMint):
        fixture.run()
    assert fixture.dead_letters == []


# ── The remaining scope leaks ───────────────────────────────────────────────
#
# Neither of these passes through ``/change-plan`` or the per-bot checkout, so
# neither is covered by any guard above — they reach the plan/scope pairing by a
# different route entirely.


def test_superadmin_plan_override_refuses_a_pooled_plan_on_a_bot_scoped_sub(monkeypatch):
    """``PUT /superadmin/subscriptions/{id}`` writes ``plan_id`` with no scope check.

    Rejected rather than silently re-scoped to ``bot_id=None``: this is a manual
    plan override, and moving the subscription's credit ledger as a side effect
    (with a real chance of colliding with the client's account row on
    ``ix_subscriptions_client_bot_active`` at COMMIT, after the audit log already
    said it succeeded) is not something to do on the admin's behalf.
    """
    plan = _plan("enterprise", UNLIMITED)
    sub = _bot_scoped_sub()
    session = MagicMock()
    session.execute.return_value.scalars.return_value.first.side_effect = [sub, plan]
    monkeypatch.setattr(superadmin_plan_routes, "get_session", lambda: _session_ctx(session))

    app = FastAPI()
    app.include_router(superadmin_plan_routes.router)
    app.dependency_overrides[get_superadmin] = lambda: SimpleNamespace(id=1, superadmin_role="owner")
    response = TestClient(app).put(f"/superadmin/subscriptions/{sub.id}", json={"plan_id": plan.id})

    assert response.status_code == 400, response.text
    assert "unlimited AI agents" in response.json()["detail"]
    assert sub.plan_id != plan.id
    session.commit.assert_not_called()


def test_superadmin_plan_override_allows_a_pooled_plan_on_an_account_sub(monkeypatch):
    """``bot_id IS NULL`` is the scope a pooled plan belongs on — no refusal."""
    plan = _plan("enterprise", UNLIMITED)
    sub = _account_sub()
    session = MagicMock()
    session.execute.return_value.scalars.return_value.first.side_effect = [sub, plan]
    monkeypatch.setattr(superadmin_plan_routes, "get_session", lambda: _session_ctx(session))

    app = FastAPI()
    app.include_router(superadmin_plan_routes.router)
    app.dependency_overrides[get_superadmin] = lambda: SimpleNamespace(id=1, superadmin_role="owner")
    response = TestClient(app).put(f"/superadmin/subscriptions/{sub.id}", json={"plan_id": plan.id})

    assert response.status_code == 200, response.text
    assert sub.plan_id == plan.id


def _promotion_session(sub: Subscription, new_plan: Plan) -> MagicMock:
    session = MagicMock()
    session.get.side_effect = lambda model, _pk: new_plan if model is Plan else None
    return session


def test_promotion_refuses_to_cut_a_bot_scoped_sub_over_to_a_pooled_plan(monkeypatch):
    """The downgrade cutover copies ``sub.bot_id`` onto the grace row it INSERTs.

    That grace row is a real active-set row — it carries entitlements and scopes
    the credit ledger for the whole re-authorisation window — so a pooled plan on
    it is the same incoherent state, reached by cron rather than by a request.
    The scheduled trio is deliberately left SET: clearing it would destroy the
    customer's requested change and hide the defect.
    """
    new_plan = _plan("enterprise", UNLIMITED)
    sub = _bot_scoped_sub()
    sub.scheduled_plan_id = new_plan.id
    sub.scheduled_billing_cycle = "monthly"
    session = _promotion_session(sub, new_plan)
    monkeypatch.setattr("app.services.plan_service.lock_client_for_billing", lambda *a, **k: None)

    with patch("app.services.razorpay_service.create_subscription") as mint:
        result = transition_service.promote_scheduled_change(session, sub)

    assert result is None
    mint.assert_not_called()
    session.add.assert_not_called()
    # Still queued, so a human can unblock it by re-scoping the subscription.
    assert sub.scheduled_plan_id == new_plan.id
    assert sub.status == "active"


def test_promotion_of_an_account_scoped_sub_onto_a_pooled_plan_proceeds(monkeypatch):
    """``bot_id IS NULL`` is the shape a pooled tier is sold on — cutover runs."""
    new_plan = _plan("enterprise", UNLIMITED)
    sub = _account_sub()
    sub.scheduled_plan_id = new_plan.id
    sub.scheduled_billing_cycle = "monthly"
    sub.client = Client(id=1, name="Acme", email="ops@acme.test")
    session = _promotion_session(sub, new_plan)
    monkeypatch.setattr("app.services.plan_service.lock_client_for_billing", lambda *a, **k: None)

    with patch(
        "app.services.razorpay_service.create_subscription",
        return_value=dict(_CHECKOUT_PAYLOAD),
    ) as mint:
        result = transition_service.promote_scheduled_change(session, sub)

    assert result is not None
    mint.assert_called_once()
    assert sub.scheduled_plan_id is None
