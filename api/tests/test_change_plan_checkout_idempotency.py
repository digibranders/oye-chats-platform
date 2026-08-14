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
  before minting its replacement, so the abandoned one can never charge;
* the marker is durable (a DB column, not process memory);
* concurrent callers serialise on the billing advisory lock, so the loser reads
  the winner's committed marker instead of racing past a read-then-write check.
"""

import os
import threading
import time
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from unittest.mock import patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.api import subscription_routes
from app.api.auth import get_current_client_strict, require_verified_email
from app.db.models import Bot, Client, Plan
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
        patch.object(rzp, "cancel_superseded_checkout") as cancel,
    ):
        res = api.post("/subscriptions/change-plan", json={"plan_id": plan.id, "billing_cycle": "monthly"})

    assert res.status_code == 200, res.text
    assert mint.call_count == 1
    # Dead at the gateway means there is nothing left to cancel.
    assert not cancel.called
    db.refresh(client)
    assert client.pending_checkout_subscription_id == "sub_cpidem_fresh"


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
