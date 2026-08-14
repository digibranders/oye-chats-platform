"""``/change-plan`` Branch 3 must not mint a second chargeable mandate on retry.

Prod, client 18, one month: ``POST /subscriptions/change-plan`` was retried
while ``sub_TPaGNnEfFML4Lr`` was still in Razorpay's ``created`` state (the
verify call had correctly deferred the local upsert — "key not burned"), and the
retry minted ``sub_TPaHBPNyYV3tfe``. Both were authorised, both charged one
cycle: ₹11,998 collected for one ₹5,999 subscription.

``/checkout`` already solved this with ``clients.pending_checkout_*`` (finding
H1). Branch 3 mints exactly the same kind of first mandate — trial→paid,
Free→paid, revive-in-place — and simply never consulted the marker. These tests
pin the extended mechanism:

* a retry under the same key reuses the in-flight mandate (asserted on the
  CREATE CALL COUNT, not just the end state — one mandate, not two);
* a retry under a different key cancels the superseded mandate at Razorpay
  before minting its replacement, so the abandoned one can never charge —
  unless that mandate has ALREADY been paid, in which case the replacement is
  refused rather than minted beside it;
* the marker is durable (a DB column, not process memory);
* concurrent callers serialise on the billing advisory lock, so the loser reads
  the winner's committed marker instead of racing past a read-then-write check.
"""

import os
import threading
import time
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from unittest.mock import MagicMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.api import subscription_routes
from app.api.auth import get_current_client_strict, require_verified_email
from app.core.middleware import subscription_activation_conflict_handler
from app.db.models import Bot, Client, Plan, Subscription
from app.services import pending_checkout_service, plan_service
from app.services import razorpay_service as rzp

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")

_IDENTITY = {
    "legal_name": "Acme Pvt Ltd",
    "billing_address": {"line1": "1 Lane", "city": "Mumbai", "postal_code": "400001"},
    "billing_state_code": "27",
    "billing_country": "IN",
}


@contextmanager
def _ctx(session):
    yield session


def _plan(db, slug="std-cpidem", monthly=599900) -> Plan:
    plan = Plan(
        name=slug.title(),
        slug=slug,
        monthly_price_cents=monthly,
        annual_price_cents=monthly * 10,
        credits_per_month=10_000,
        included_operator_seats=2,
        is_active=True,
        razorpay_plan_id_monthly=f"plan_{slug}_m",
        razorpay_plan_id_annual=f"plan_{slug}_a",
    )
    db.add(plan)
    db.flush()
    return plan


def _mk(db, monkeypatch, **client_kw):
    defaults = {"name": "C18", "email": "cpidem@test.example", "api_key": "key-cpidem", **_IDENTITY}
    defaults.update(client_kw)
    client = Client(**defaults)
    db.add(client)
    db.flush()
    monkeypatch.setattr(subscription_routes, "get_session", lambda: _ctx(db))
    monkeypatch.setattr(subscription_routes, "resolve_country", lambda request: None)
    monkeypatch.setattr(subscription_routes, "RAZORPAY_ENABLED", True)
    app = FastAPI()
    app.include_router(subscription_routes.router)
    app.dependency_overrides[get_current_client_strict] = lambda: client
    app.dependency_overrides[require_verified_email] = lambda: client
    return TestClient(app, raise_server_exceptions=True), client


def _mint(sub_id="sub_cpidem_1"):
    return {"subscription_id": sub_id, "key_id": "rzp_test", "provider": "razorpay"}


# Captured before the autouse fixture below can stub it out, so the two unit
# tests of the predicate itself exercise the real implementation.
_real_checkout_already_paid = rzp.checkout_already_paid


@pytest.fixture(autouse=True)
def _pending_mandate_is_unpaid():
    """Default every test here to an UNPAID in-flight mandate.

    ``reuse_or_supersede`` asks the gateway ``checkout_already_paid`` before it
    decides anything, so without this every test with a marker would reach for
    the network. The PAID case is the actual prod defect and gets its own tests,
    which override this with an inner patch.
    """
    with patch.object(rzp, "checkout_already_paid", return_value=False):
        yield


# ── The defect: a retry minted a second chargeable mandate ───────────────────


def test_change_plan_retry_reuses_the_in_flight_mandate(db, monkeypatch):
    api, client = _mk(db, monkeypatch)
    plan = _plan(db)
    body = {"plan_id": plan.id, "billing_cycle": "monthly"}

    with (
        patch.object(rzp, "create_subscription", return_value=_mint()) as mint,
        patch.object(rzp, "rebuild_upgrade_checkout", return_value=_mint()) as rebuild,
        patch.object(rzp, "cancel_superseded_checkout") as cancel,
    ):
        first = api.post("/subscriptions/change-plan", json=body)
        second = api.post("/subscriptions/change-plan", json=body)

    assert first.status_code == 200, first.text
    assert second.status_code == 200, second.text
    # The whole point: ONE authorizable mandate exists at Razorpay, not two.
    assert mint.call_count == 1
    assert rebuild.called
    assert not cancel.called  # same key → nothing was superseded
    assert second.json()["subscription_id"] == first.json()["subscription_id"]
    assert second.json()["status"] == "checkout_required"
    db.refresh(client)
    assert client.pending_checkout_subscription_id == "sub_cpidem_1"
    assert client.pending_checkout_plan_id == plan.id
    assert client.pending_checkout_bot_id is None


def test_marker_is_durable_across_a_process_restart(db, monkeypatch):
    """The marker is a DB column, so a retry served by a DIFFERENT worker (or the
    same one after a deploy) still reuses. An in-memory guard would not."""
    api, client = _mk(db, monkeypatch)
    plan = _plan(db, slug="std-cpidem-restart")
    # State left behind by a process that has since exited.
    pending_checkout_service.record(
        client,
        subscription_id="sub_cpidem_prev_process",
        plan_id=plan.id,
        billing_cycle="monthly",
        country="IN",
    )
    db.flush()

    with (
        patch.object(rzp, "create_subscription") as mint,
        patch.object(rzp, "rebuild_upgrade_checkout", return_value=_mint("sub_cpidem_prev_process")) as rebuild,
    ):
        res = api.post("/subscriptions/change-plan", json={"plan_id": plan.id, "billing_cycle": "monthly"})

    assert res.status_code == 200, res.text
    assert res.json()["subscription_id"] == "sub_cpidem_prev_process"
    assert rebuild.called
    assert not mint.called


# ── A genuinely different purchase supersedes, it does not accumulate ────────


def test_different_plan_cancels_the_superseded_mandate_before_minting(db, monkeypatch):
    api, client = _mk(db, monkeypatch)
    plan_a = _plan(db, slug="std-cpidem-a")
    plan_b = _plan(db, slug="std-cpidem-b", monthly=94900)

    with (
        patch.object(rzp, "create_subscription", side_effect=[_mint("sub_cpidem_a"), _mint("sub_cpidem_b")]) as mint,
        patch.object(rzp, "cancel_superseded_checkout", return_value="created") as cancel,
    ):
        first = api.post("/subscriptions/change-plan", json={"plan_id": plan_a.id, "billing_cycle": "monthly"})
        second = api.post("/subscriptions/change-plan", json={"plan_id": plan_b.id, "billing_cycle": "monthly"})

    assert first.status_code == 200 and second.status_code == 200, second.text
    assert mint.call_count == 2
    # The abandoned mandate is dead at the gateway — it can never charge.
    cancel.assert_called_once_with("sub_cpidem_a")
    db.refresh(client)
    assert client.pending_checkout_subscription_id == "sub_cpidem_b"


def test_different_cycle_supersedes(db, monkeypatch):
    api, client = _mk(db, monkeypatch)
    plan = _plan(db, slug="std-cpidem-cycle")
    with (
        patch.object(rzp, "create_subscription", side_effect=[_mint("sub_cpidem_m"), _mint("sub_cpidem_y")]),
        patch.object(rzp, "cancel_superseded_checkout", return_value="created") as cancel,
    ):
        api.post("/subscriptions/change-plan", json={"plan_id": plan.id, "billing_cycle": "monthly"})
        second = api.post("/subscriptions/change-plan", json={"plan_id": plan.id, "billing_cycle": "annual"})
    assert second.status_code == 200, second.text
    cancel.assert_called_once_with("sub_cpidem_m")
    db.refresh(client)
    assert client.pending_checkout_cycle == "annual"


def test_bot_scope_is_part_of_the_reuse_key(db, monkeypatch):
    """An ACCOUNT-level in-flight mandate must never be handed back for a
    per-agent purchase: the activation would attach the plan to the wrong
    ledger. Different scope → supersede + mint, never reuse."""
    api, client = _mk(db, monkeypatch)
    plan = _plan(db, slug="std-cpidem-bot")
    bot = Bot(client_id=client.id, name="Agent", bot_key="bot-cpidem")
    db.add(bot)
    db.flush()
    pending_checkout_service.record(
        client,
        subscription_id="sub_cpidem_account",
        plan_id=plan.id,
        billing_cycle="monthly",
        country="IN",
        bot_id=None,
    )
    db.flush()

    with (
        patch.object(rzp, "create_bot_resubscription", return_value=_mint("sub_cpidem_bot")) as mint,
        patch.object(rzp, "rebuild_upgrade_checkout") as rebuild,
        patch.object(rzp, "cancel_superseded_checkout", return_value="created") as cancel,
    ):
        res = api.post(
            "/subscriptions/change-plan",
            json={"plan_id": plan.id, "billing_cycle": "monthly", "bot_id": bot.id},
        )

    assert res.status_code == 200, res.text
    assert not rebuild.called
    cancel.assert_called_once_with("sub_cpidem_account")
    assert mint.call_count == 1
    db.refresh(client)
    assert client.pending_checkout_bot_id == bot.id


# ── Never guess when the gateway can't be read ───────────────────────────────


def test_gateway_read_failure_is_a_502_not_a_sibling_mint(db, monkeypatch):
    api, client = _mk(db, monkeypatch)
    plan = _plan(db, slug="std-cpidem-502")
    pending_checkout_service.record(
        client,
        subscription_id="sub_cpidem_flaky",
        plan_id=plan.id,
        billing_cycle="monthly",
        country="IN",
    )
    db.flush()

    with (
        patch.object(rzp, "create_subscription") as mint,
        patch.object(rzp, "rebuild_upgrade_checkout", side_effect=rzp.RazorpayBillingError("gateway timeout")),
    ):
        res = api.post("/subscriptions/change-plan", json={"plan_id": plan.id, "billing_cycle": "monthly"})

    assert res.status_code == 502, res.text
    assert not mint.called
    db.refresh(client)
    assert client.pending_checkout_subscription_id == "sub_cpidem_flaky"  # marker intact


def test_supersede_cancel_failure_refuses_rather_than_minting_a_sibling(db, monkeypatch):
    api, client = _mk(db, monkeypatch)
    plan_a = _plan(db, slug="std-cpidem-cf-a")
    plan_b = _plan(db, slug="std-cpidem-cf-b", monthly=94900)
    pending_checkout_service.record(
        client,
        subscription_id="sub_cpidem_stuck",
        plan_id=plan_a.id,
        billing_cycle="monthly",
        country="IN",
    )
    db.flush()

    with (
        patch.object(rzp, "create_subscription") as mint,
        patch.object(rzp, "cancel_superseded_checkout", side_effect=rzp.RazorpayBillingError("cancel failed")),
    ):
        res = api.post("/subscriptions/change-plan", json={"plan_id": plan_b.id, "billing_cycle": "monthly"})

    assert res.status_code == 502, res.text
    assert not mint.called
    db.refresh(client)
    assert client.pending_checkout_subscription_id == "sub_cpidem_stuck"


def test_a_pending_mandate_that_just_went_active_blocks_the_replacement(db, monkeypatch):
    """The narrowest remaining window: the customer authorises AND pays the
    pending mandate between the two requests. Nothing may cancel a charged
    mandate from a checkout path, so minting the replacement would leave two
    charged subscriptions for one month — the original defect, one race later.
    Refuse; once the activation lands, this customer goes through the real
    upgrade/downgrade branches instead."""
    api, client = _mk(db, monkeypatch)
    api.app.add_exception_handler(rzp.SubscriptionActivationConflict, subscription_activation_conflict_handler)
    api = TestClient(api.app, raise_server_exceptions=False)
    plan_a = _plan(db, slug="std-cpidem-live-a")
    plan_b = _plan(db, slug="std-cpidem-live-b", monthly=94900)
    pending_checkout_service.record(
        client,
        subscription_id="sub_cpidem_just_paid",
        plan_id=plan_a.id,
        billing_cycle="monthly",
        country="IN",
    )
    db.flush()

    with (
        patch.object(rzp, "create_subscription") as mint,
        patch.object(rzp, "cancel_superseded_checkout", return_value="active"),
    ):
        res = api.post("/subscriptions/change-plan", json={"plan_id": plan_b.id, "billing_cycle": "monthly"})

    assert res.status_code == 409, res.text
    assert res.json()["detail"]["payment_captured"] is True
    assert not mint.called
    db.refresh(client)
    # The marker survives: the activation still has to consume it.
    assert client.pending_checkout_subscription_id == "sub_cpidem_just_paid"


def test_a_terminal_pending_mandate_does_not_block_the_replacement(db, monkeypatch):
    """``cancelled``/``expired`` at the gateway: nothing to cancel, nothing to
    fear — mint the replacement."""
    api, client = _mk(db, monkeypatch)
    plan_a = _plan(db, slug="std-cpidem-term-a")
    plan_b = _plan(db, slug="std-cpidem-term-b", monthly=94900)
    pending_checkout_service.record(
        client,
        subscription_id="sub_cpidem_expired",
        plan_id=plan_a.id,
        billing_cycle="monthly",
        country="IN",
    )
    db.flush()

    with (
        patch.object(rzp, "create_subscription", return_value=_mint("sub_cpidem_term_new")) as mint,
        patch.object(rzp, "cancel_superseded_checkout", return_value="expired"),
    ):
        res = api.post("/subscriptions/change-plan", json={"plan_id": plan_b.id, "billing_cycle": "monthly"})

    assert res.status_code == 200, res.text
    assert mint.call_count == 1
    db.refresh(client)
    assert client.pending_checkout_subscription_id == "sub_cpidem_term_new"


def test_same_plan_retry_after_the_mandate_went_active_is_refused(db, monkeypatch):
    """The nastiest shape, and the one prod hit: the customer re-submits the SAME
    plan while the first mandate has just been authorised and charged.
    ``rebuild_upgrade_checkout`` says "not reusable" for a paid mandate exactly
    as it does for an expired one, so re-minting on that answer alone would
    charge the month twice. The gateway status is what separates them."""
    api, client = _mk(db, monkeypatch)
    api.app.add_exception_handler(rzp.SubscriptionActivationConflict, subscription_activation_conflict_handler)
    api = TestClient(api.app, raise_server_exceptions=False)
    plan = _plan(db, slug="std-cpidem-samepaid")
    pending_checkout_service.record(
        client,
        subscription_id="sub_cpidem_samepaid",
        plan_id=plan.id,
        billing_cycle="monthly",
        country="IN",
    )
    db.flush()

    with (
        patch.object(rzp, "create_subscription") as mint,
        patch.object(rzp, "rebuild_upgrade_checkout", return_value=None),
        patch.object(rzp, "cancel_superseded_checkout", return_value="active"),
    ):
        res = api.post("/subscriptions/change-plan", json={"plan_id": plan.id, "billing_cycle": "monthly"})

    assert res.status_code == 409, res.text
    assert res.json()["detail"]["payment_captured"] is True
    assert not mint.called


def test_dead_pending_mandate_is_re_minted(db, monkeypatch):
    api, client = _mk(db, monkeypatch)
    plan = _plan(db, slug="std-cpidem-dead")
    pending_checkout_service.record(
        client,
        subscription_id="sub_cpidem_dead",
        plan_id=plan.id,
        billing_cycle="monthly",
        country="IN",
    )
    client.pending_checkout_at = datetime.now(UTC) - timedelta(hours=6)
    db.flush()

    with (
        patch.object(rzp, "create_subscription", return_value=_mint("sub_cpidem_fresh")) as mint,
        patch.object(rzp, "rebuild_upgrade_checkout", return_value=None),
        patch.object(rzp, "cancel_superseded_checkout", return_value="expired") as cancel,
    ):
        res = api.post("/subscriptions/change-plan", json={"plan_id": plan.id, "billing_cycle": "monthly"})

    assert res.status_code == 200, res.text
    assert mint.call_count == 1
    # "Not reusable" is not the same fact as "dead", and only one of them makes a
    # fresh mint safe — so the gateway is asked before anything is minted.
    cancel.assert_called_once_with("sub_cpidem_dead")
    db.refresh(client)
    assert client.pending_checkout_subscription_id == "sub_cpidem_fresh"


# ── The reported prod sequence: paid, no UI change, human retry ──────────────


def test_a_paid_mandate_still_reading_created_is_never_re_opened(db, monkeypatch):
    """THE reported defect, end to end.

    The customer picked Enterprise on the Launch Studio welcome screen and paid.
    The plan card did not update (the activation had not landed, and
    ``verify-razorpay-subscription`` had logged "in non-billable state 'created'
    — deferring local upsert"). Forty-four seconds later they clicked Select
    again, on the SAME plan.

    Razorpay still reported ``created`` at that moment, so every state-based
    check calls the mandate authorizable and hands back a payment sheet.
    ``paid_count`` is what says otherwise. Nothing may be minted, and nothing
    may be re-opened.
    """
    api, client = _mk(db, monkeypatch)
    api.app.add_exception_handler(rzp.SubscriptionActivationConflict, subscription_activation_conflict_handler)
    api = TestClient(api.app, raise_server_exceptions=False)
    plan = _plan(db, slug="std-cpidem-enterprise")
    pending_checkout_service.record(
        client,
        subscription_id="sub_TPaGNnEfFML4Lr",
        plan_id=plan.id,
        billing_cycle="monthly",
        country="IN",
    )
    db.flush()

    with (
        patch.object(rzp, "create_subscription") as mint,
        patch.object(rzp, "create_bot_resubscription") as bot_mint,
        patch.object(rzp, "rebuild_upgrade_checkout") as rebuild,
        patch.object(rzp, "cancel_superseded_checkout") as cancel,
        # status still 'created', but paid_count == 1
        patch.object(rzp, "checkout_already_paid", return_value=True),
    ):
        res = api.post("/subscriptions/change-plan", json={"plan_id": plan.id, "billing_cycle": "monthly"})

    # No second mandate, and no second payment sheet for one already paid.
    assert not mint.called
    assert not bot_mint.called
    assert not rebuild.called
    assert not cancel.called
    assert res.status_code == 409, res.text

    detail = res.json()["detail"]
    # What the payer reads must not sound like a failed payment — their next
    # move on "payment failed" is a THIRD attempt or a support ticket.
    assert detail["payment_captured"] is True
    assert detail["message"] == (
        f"Your {plan.name} payment went through — we're activating your plan now. "
        "You don't need to pay again; this usually takes under a minute."
    )
    assert detail["reason"] == "subscription_activation_conflict"
    # Operator detail never reaches the browser.
    assert "sub_TPaGNnEfFML4Lr" not in res.text
    assert "paid_count" not in res.text

    db.refresh(client)
    # The marker survives — the activation still has to consume it.
    assert client.pending_checkout_subscription_id == "sub_TPaGNnEfFML4Lr"


def test_a_different_plan_retry_after_payment_does_not_name_the_wrong_plan(db, monkeypatch):
    """The customer paid for one plan and is now asking for another. The refusal
    is the same, but claiming "Your Professional payment went through" when they
    paid for Enterprise would be a lie."""
    api, client = _mk(db, monkeypatch)
    api.app.add_exception_handler(rzp.SubscriptionActivationConflict, subscription_activation_conflict_handler)
    api = TestClient(api.app, raise_server_exceptions=False)
    paid_plan = _plan(db, slug="std-cpidem-paidfor")
    other_plan = _plan(db, slug="std-cpidem-other", monthly=94900)
    pending_checkout_service.record(
        client,
        subscription_id="sub_cpidem_paidfor",
        plan_id=paid_plan.id,
        billing_cycle="monthly",
        country="IN",
    )
    db.flush()

    with (
        patch.object(rzp, "create_subscription") as mint,
        patch.object(rzp, "checkout_already_paid", return_value=True),
    ):
        res = api.post("/subscriptions/change-plan", json={"plan_id": other_plan.id, "billing_cycle": "monthly"})

    assert res.status_code == 409, res.text
    assert not mint.called
    message = res.json()["detail"]["message"]
    assert message.startswith("Your payment went through")
    assert other_plan.name not in message


def test_the_paid_check_runs_before_the_first_mint_is_ever_recorded(db, monkeypatch):
    """A FIRST purchase has no marker, so no gateway read happens — the paid
    check must not add a round-trip to the common path."""
    api, _client = _mk(db, monkeypatch)
    plan = _plan(db, slug="std-cpidem-firstbuy")
    with (
        patch.object(rzp, "create_subscription", return_value=_mint("sub_cpidem_first")) as mint,
        patch.object(rzp, "checkout_already_paid") as paid,
    ):
        res = api.post("/subscriptions/change-plan", json={"plan_id": plan.id, "billing_cycle": "monthly"})
    assert res.status_code == 200, res.text
    assert mint.call_count == 1
    assert not paid.called


def test_checkout_already_paid_trusts_paid_count_over_status():
    """Razorpay's status lags its own money: the mandate both prod customers had
    paid still read ``created``. ``paid_count`` is the fact that does not lag."""

    def _fetch(entity):
        rzp_client = MagicMock()
        rzp_client.subscription.fetch.return_value = entity
        return patch.object(rzp, "_get_razorpay", return_value=rzp_client)

    with _fetch({"status": "created", "paid_count": 1}):
        assert _real_checkout_already_paid("sub_x") is True
    with _fetch({"status": "created", "paid_count": 0}):
        assert _real_checkout_already_paid("sub_x") is False
    with _fetch({"status": "authenticated", "paid_count": 0}):
        assert _real_checkout_already_paid("sub_x") is False
    # status moved but the counter has not — must not read as unpaid.
    with _fetch({"status": "active", "paid_count": 0}):
        assert _real_checkout_already_paid("sub_x") is True


def test_checkout_already_paid_never_guesses_when_the_gateway_is_unreadable():
    """Guessing "not paid" is exactly how the month gets charged twice."""
    rzp_client = MagicMock()
    rzp_client.subscription.fetch.side_effect = TimeoutError("boom")
    with (
        patch.object(rzp, "_get_razorpay", return_value=rzp_client),
        pytest.raises(rzp.RazorpayBillingError),
    ):
        _real_checkout_already_paid("sub_unknown")


# ── The gateway-side supersede helper ────────────────────────────────────────


def test_cancel_superseded_checkout_only_cancels_authorizable_mandates():
    """An ``active`` mandate has already been authorised AND charged. Cancelling
    it from a checkout path would kill a live subscription behind the customer's
    back — only the activation handler's sibling sweep may retire one."""
    with (
        patch.object(rzp, "_get_razorpay") as get_rzp,
        patch.object(rzp, "cancel_subscription_by_id") as cancel,
    ):
        get_rzp.return_value.subscription.fetch.return_value = {"status": "active"}
        assert rzp.cancel_superseded_checkout("sub_live") == "active"
    assert not cancel.called

    with (
        patch.object(rzp, "_get_razorpay") as get_rzp,
        patch.object(rzp, "cancel_subscription_by_id") as cancel,
    ):
        get_rzp.return_value.subscription.fetch.return_value = {"status": "created"}
        assert rzp.cancel_superseded_checkout("sub_inflight") == "created"
    cancel.assert_called_once_with("sub_inflight", at_period_end=False)


def test_cancel_superseded_checkout_raises_when_the_gateway_is_unreadable():
    with (
        patch.object(rzp, "_get_razorpay") as get_rzp,
        patch.object(rzp, "cancel_subscription_by_id") as cancel,
        pytest.raises(rzp.RazorpayBillingError),
    ):
        get_rzp.return_value.subscription.fetch.side_effect = TimeoutError("boom")
        rzp.cancel_superseded_checkout("sub_unknown")
    assert not cancel.called


# ── The same defect on the Subscription-row marker (upgrade / resume) ───────


def _paying_customer(db, plan, *, pending_plan, pending_sub_id="sub_upgrade_pending"):
    """An existing paying customer mid-upgrade: live mandate + in-flight replacement."""
    sub = Subscription(
        client_id=plan.id and db.query(Client).one().id,
        plan_id=plan.id,
        status="active",
        billing_cycle="monthly",
        operator_quantity=1,
        payment_provider="razorpay",
        razorpay_subscription_id="sub_upgrade_current",
        current_period_end=datetime.now(UTC) + timedelta(days=20),
        upgrade_pending_subscription_id=pending_sub_id,
        upgrade_pending_plan_id=pending_plan.id,
    )
    sub.plan = plan
    db.add(sub)
    db.flush()
    return sub


def test_upgrade_does_not_re_mint_over_an_already_paid_replacement(db, monkeypatch):
    """The Branch 2a twin of the reported defect.

    ``execute_paid_upgrade`` cleared ``upgrade_pending_subscription_id`` and
    re-minted whenever ``rebuild_upgrade_checkout`` returned ``None`` — which it
    does for a PAID mandate exactly as for an abandoned one. It missed the
    incident only because both affected clients were first purchases; an
    existing paying customer upgrading is a more valuable account to
    double-charge, not a less likely one.
    """
    api, client = _mk(db, monkeypatch)
    api.app.add_exception_handler(rzp.SubscriptionActivationConflict, subscription_activation_conflict_handler)
    api = TestClient(api.app, raise_server_exceptions=False)
    current = _plan(db, slug="std-upg-current", monthly=94900)
    target = _plan(db, slug="std-upg-target", monthly=599900)
    _paying_customer(db, current, pending_plan=target)

    with (
        patch.object(rzp, "create_subscription") as mint,
        patch.object(rzp, "rebuild_upgrade_checkout") as rebuild,
        patch.object(rzp, "checkout_already_paid", return_value=True),
    ):
        res = api.post("/subscriptions/change-plan", json={"plan_id": target.id, "billing_cycle": "monthly"})

    assert res.status_code == 409, res.text
    assert res.json()["detail"]["payment_captured"] is True
    assert target.name in res.json()["detail"]["message"]
    assert not mint.called
    assert not rebuild.called


def test_upgrade_still_reuses_an_unpaid_in_flight_replacement(db, monkeypatch):
    """The paid check must not break the finding-D reuse it sits in front of."""
    api, _client = _mk(db, monkeypatch)
    current = _plan(db, slug="std-upg2-current", monthly=94900)
    target = _plan(db, slug="std-upg2-target", monthly=599900)
    _paying_customer(db, current, pending_plan=target, pending_sub_id="sub_upgrade_unpaid")

    with (
        patch.object(rzp, "create_subscription") as mint,
        patch.object(rzp, "rebuild_upgrade_checkout", return_value=_mint("sub_upgrade_unpaid")) as rebuild,
    ):
        res = api.post("/subscriptions/change-plan", json={"plan_id": target.id, "billing_cycle": "monthly"})

    assert res.status_code == 200, res.text
    assert res.json()["subscription_id"] == "sub_upgrade_unpaid"
    assert rebuild.called
    assert not mint.called


def test_upgrade_to_a_different_plan_after_payment_is_also_refused(db, monkeypatch):
    """The paid check runs BEFORE the plan-id match. A customer who paid and then
    asked for a different plan is in the same position as one who re-asked for
    the same plan, and neither may be handed a fresh mandate."""
    api, _client = _mk(db, monkeypatch)
    api.app.add_exception_handler(rzp.SubscriptionActivationConflict, subscription_activation_conflict_handler)
    api = TestClient(api.app, raise_server_exceptions=False)
    current = _plan(db, slug="std-upg3-current", monthly=94900)
    paid_for = _plan(db, slug="std-upg3-paid", monthly=599900)
    now_wants = _plan(db, slug="std-upg3-other", monthly=799900)
    _paying_customer(db, current, pending_plan=paid_for, pending_sub_id="sub_upgrade_paid_other")

    with (
        patch.object(rzp, "create_subscription") as mint,
        patch.object(rzp, "checkout_already_paid", return_value=True),
    ):
        res = api.post("/subscriptions/change-plan", json={"plan_id": now_wants.id, "billing_cycle": "monthly"})

    assert res.status_code == 409, res.text
    assert not mint.called
    # Never names the plan they did not pay for.
    assert now_wants.name not in res.json()["detail"]["message"]


# ── The claim "your payment went through" must be unfalsifiable ─────────────


@pytest.mark.parametrize(
    "entity",
    [
        # Never authorised — the customer closed the sheet.
        {"status": "created", "paid_count": 0},
        # Mandate approved, first charge not taken yet (deferred start / promo).
        {"status": "authenticated", "paid_count": 0},
        # Razorpay's "the payment failed and I am retrying" state, first cycle.
        {"status": "pending", "paid_count": 0},
        # Retries exhausted with nothing ever collected.
        {"status": "halted", "paid_count": 0},
        # Customer or ops killed it before any money moved.
        {"status": "cancelled", "paid_count": 0},
        {"status": "expired", "paid_count": 0},
    ],
)
def test_a_payment_that_never_landed_never_claims_it_did(entity):
    """``payment_captured: true`` and "your payment went through" are
    load-bearing claims: a customer who reads them stops chasing the payment.
    If a FAILED payment could reach that message it would be worse than the bug
    this fixes.

    Every state in which money has NOT moved must answer False, so the refusal —
    and therefore the claim — cannot be raised at all.
    """
    rzp_client = MagicMock()
    rzp_client.subscription.fetch.return_value = entity
    with patch.object(rzp, "_get_razorpay", return_value=rzp_client):
        assert _real_checkout_already_paid("sub_x") is False


def test_the_claim_requires_money_to_have_actually_moved():
    """The mirror of the above: it is True only when Razorpay says a cycle was
    charged (``paid_count``) or the subscription is live (``active`` — Razorpay
    only moves it there after the first successful charge)."""
    rzp_client = MagicMock()
    for entity in ({"status": "created", "paid_count": 1}, {"status": "active", "paid_count": 1}):
        rzp_client.subscription.fetch.return_value = entity
        with patch.object(rzp, "_get_razorpay", return_value=rzp_client):
            assert _real_checkout_already_paid("sub_x") is True


# ── Concurrency: the loser reads the winner's COMMITTED marker ───────────────


def test_concurrent_mints_serialise_on_the_billing_lock(pg_engine):
    """Two simultaneous Branch-3 requests must not both pass the reuse check.

    The route holds ``lock_client_for_billing`` (a transaction-scoped Postgres
    advisory lock) across read → decide → mint → write, so the second request
    cannot even READ the marker until the first has COMMITTED it. This drives
    that sequence with two real sessions and a thread: a bare read-then-write
    would let B observe an empty marker and mint a sibling mandate.
    """
    setup = Session(pg_engine)
    plan = Plan(
        name="Conc",
        slug="std-cpidem-conc",
        monthly_price_cents=599900,
        credits_per_month=10_000,
        is_active=True,
    )
    setup.add(plan)
    client = Client(name="Conc", email="conc@test.example", api_key="key-cpidem-conc")
    setup.add(client)
    setup.commit()
    client_id, plan_id = client.id, plan.id
    setup.close()

    session_a = Session(pg_engine)
    session_b = Session(pg_engine)
    observed: dict[str, object] = {}
    b_started = threading.Event()

    def request_b():
        b_started.set()
        # Blocks here until A commits and releases the advisory lock.
        plan_service.lock_client_for_billing(session_b, client_id)
        row = session_b.get(Client, client_id)
        observed["pending_id"] = row.pending_checkout_subscription_id
        observed["matches"] = pending_checkout_service._matches(
            row, plan_id=plan_id, billing_cycle="monthly", country="IN", bot_id=None
        )
        session_b.commit()

    thread = threading.Thread(target=request_b, daemon=True)
    try:
        # Request A: lock, see no marker, mint, record — not yet committed.
        plan_service.lock_client_for_billing(session_a, client_id)
        row_a = session_a.get(Client, client_id)
        assert row_a.pending_checkout_subscription_id is None
        pending_checkout_service.record(
            row_a,
            subscription_id="sub_conc_winner",
            plan_id=plan_id,
            billing_cycle="monthly",
            country="IN",
        )
        session_a.flush()

        thread.start()
        b_started.wait(timeout=5)
        time.sleep(0.3)
        assert thread.is_alive(), "B read the marker without waiting for A's lock"
        assert "pending_id" not in observed

        session_a.commit()
        thread.join(timeout=10)
        assert not thread.is_alive(), "B never acquired the lock after A committed"

        # B sees the mandate A minted and reuses it instead of minting a second.
        assert observed["pending_id"] == "sub_conc_winner"
        assert observed["matches"] is True
    finally:
        thread.join(timeout=5)
        session_a.rollback()
        session_a.close()
        session_b.rollback()
        session_b.close()
        cleanup = Session(pg_engine)
        cleanup.execute(text('TRUNCATE "clients", "plans" RESTART IDENTITY CASCADE'))
        cleanup.commit()
        cleanup.close()
