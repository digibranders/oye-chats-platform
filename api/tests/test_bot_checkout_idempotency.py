"""``POST /bots/checkout`` must not mint a second chargeable mandate on retry.

The last uncovered double-charge path. Two prod incidents drove the account-level
fixes — client 19 paid ₹11,998 for one month of Enterprise, client 8 authorised
two Professional mandates 44 seconds apart and got 20,000 credits instead of
10,000 — and both were fixed on ``/subscriptions/checkout``, ``/change-plan``
Branch 3, ``execute_paid_upgrade`` and ``/resume``. This route was left minting
straight through: no lock, no marker consulted, no in-flight mandate retired.

It could not have been caught by the live testing that found the others.
Enterprise has ``limits.bots = -1``, which this route refuses outright, so the
tier being exercised in prod never reaches it. Every *other* paid tier does —
it is the upsell a growing customer hits repeatedly.

Two things make this path different from the account-level twin, and both are
pinned below:

* **The agent does not exist yet.** The bot row is deliberately not created
  until the mandate is paid, so ``clients.pending_checkout_bot_id`` has no id to
  hold. Which agent a mandate would create lives only in its Razorpay notes, so
  that is what the reuse decision compares — otherwise a retry that renamed the
  agent would be handed back a mandate that creates the *other* one, pointed at
  the other website.
* **A failed supersede-cancel is not fatal here.** This path has never cancelled
  anything, so leaving an unretired handle for Razorpay to expire is precisely
  today's behaviour; refusing would newly block agent purchases during a gateway
  wobble that currently succeed. Same call ``reuse_pending_upgrade`` makes.

Recording the marker also closes the leak half: an abandoned per-agent checkout
was previously tracked nowhere, so nothing could ever supersede or cancel it.
"""

from __future__ import annotations

import os
import threading
import time
from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.api import bot_routes
from app.api.auth import (
    get_current_client_or_operator,
    require_verified_email_for_workspace,
)
from app.core.middleware import subscription_activation_conflict_handler
from app.db.models import Client, Plan
from app.services import pending_checkout_service, plan_service
from app.services import razorpay_service as rzp

pytestmark = pytest.mark.skipif(
    not os.getenv("DB_URL"),
    reason="the marker is a DB column, so the reuse decision must be proven against real SQL",
)


@contextmanager
def _ctx(session):
    yield session


def _plan(db, slug="std-botidem", monthly=94900) -> Plan:
    plan = Plan(
        name=slug.title(),
        slug=slug,
        monthly_price_cents=monthly,
        annual_price_cents=monthly * 10,
        credits_per_month=10_000,
        included_operator_seats=2,
        is_active=True,
        limits={"bots": 1, "credits": 10_000},
        features={},
        razorpay_plan_id_monthly=f"plan_{slug}_m",
        razorpay_plan_id_annual=f"plan_{slug}_a",
    )
    db.add(plan)
    db.flush()
    return plan


def _mk(db, monkeypatch, **client_kw):
    defaults = {
        "name": "Agency",
        "email": "botidem@test.example",
        "api_key": "key-botidem",
        "hashed_password": "h",
        "is_verified": True,
    }
    defaults.update(client_kw)
    client = Client(**defaults)
    db.add(client)
    db.flush()
    monkeypatch.setattr(bot_routes, "get_session", lambda: _ctx(db))
    app = FastAPI()
    app.include_router(bot_routes.router)
    app.dependency_overrides[get_current_client_or_operator] = lambda: {
        "type": "client",
        "entity": SimpleNamespace(id=client.id),
        "client_id": client.id,
        "operator_id": None,
    }
    app.dependency_overrides[require_verified_email_for_workspace] = lambda: None
    app.add_exception_handler(rzp.SubscriptionActivationConflict, subscription_activation_conflict_handler)
    return TestClient(app, raise_server_exceptions=False), client


def _mint(sub_id="sub_botidem_1"):
    return {"subscription_id": sub_id, "key_id": "rzp_test", "provider": "razorpay"}


def _body(plan: Plan, *, name="Client Site 12", website="https://client12.com", cycle="monthly"):
    return {"name": name, "website": website, "plan_slug": plan.slug, "billing_cycle": cycle}


@pytest.fixture(autouse=True)
def _pending_mandate_is_unpaid():
    """Default every test here to an UNPAID in-flight mandate.

    ``reuse_or_supersede`` asks the gateway ``checkout_already_paid`` before it
    decides anything, so without this every test with a marker would reach for
    the network. The PAID case is the actual prod defect and gets its own test,
    which overrides this with an inner patch.
    """
    with patch.object(rzp, "checkout_already_paid", return_value=False):
        yield


# ── The defect: a sequential re-submit minted a second chargeable mandate ────


def test_a_resubmit_reuses_the_in_flight_mandate(db, monkeypatch):
    """The headline. Asserted on the CREATE CALL COUNT, not just the end state:
    one authorizable mandate exists at Razorpay, not two."""
    api, client = _mk(db, monkeypatch)
    plan = _plan(db)

    with (
        patch.object(rzp, "create_per_bot_subscription", return_value=_mint()) as mint,
        patch.object(rzp, "rebuild_upgrade_checkout", return_value=_mint()) as rebuild,
        patch.object(rzp, "cancel_superseded_checkout") as cancel,
    ):
        first = api.post("/bots/checkout", json=_body(plan))
        second = api.post("/bots/checkout", json=_body(plan))

    assert first.status_code == 200, first.text
    assert second.status_code == 200, second.text
    assert mint.call_count == 1
    assert rebuild.called
    assert not cancel.called  # same purchase → nothing was superseded
    assert second.json()["subscription_id"] == first.json()["subscription_id"]
    db.refresh(client)
    assert client.pending_checkout_subscription_id == "sub_botidem_1"


def test_the_abandoned_checkout_is_now_tracked(db, monkeypatch):
    """The leak half. Nothing recorded a per-agent checkout before, so nothing
    could supersede or cancel one — an abandoned mandate stayed authorizable at
    Razorpay indefinitely and still charged if the customer reopened it."""
    api, client = _mk(db, monkeypatch)
    plan = _plan(db, slug="std-botidem-leak")

    with patch.object(rzp, "create_per_bot_subscription", return_value=_mint("sub_botidem_leak")):
        res = api.post("/bots/checkout", json=_body(plan))

    assert res.status_code == 200, res.text
    db.refresh(client)
    assert client.pending_checkout_subscription_id == "sub_botidem_leak"
    assert client.pending_checkout_plan_id == plan.id
    assert client.pending_checkout_at is not None
    # Scoped to a bot that does not exist yet — NOT account-level (NULL), which
    # would let the account routes hand this mandate back for a plan purchase.
    assert client.pending_checkout_bot_id == pending_checkout_service.NEW_BOT_SCOPE


# ── The reported prod sequence: paid, no UI change, human retry ──────────────


def test_a_paid_mandate_still_reading_created_is_refused_not_reopened(db, monkeypatch):
    """The decisive case. Razorpay's status lags its own money: the mandate both
    prod customers had already paid still read ``created``, which is
    indistinguishable from an abandoned checkout by state alone. Reuse would
    happily rebuild a payment sheet for an agent already bought."""
    api, client = _mk(db, monkeypatch)
    plan = _plan(db, slug="std-botidem-paid")
    pending_checkout_service.record(
        client,
        subscription_id="sub_botidem_just_paid",
        plan_id=plan.id,
        billing_cycle="monthly",
        country="IN",
        bot_id=pending_checkout_service.NEW_BOT_SCOPE,
    )
    db.flush()

    with (
        patch.object(rzp, "checkout_already_paid", return_value=True),
        patch.object(rzp, "create_per_bot_subscription") as mint,
        patch.object(rzp, "rebuild_upgrade_checkout", return_value=_mint()) as rebuild,
        patch.object(rzp, "cancel_superseded_checkout") as cancel,
    ):
        res = api.post("/bots/checkout", json=_body(plan))

    assert res.status_code == 409, res.text
    assert res.json()["detail"]["payment_captured"] is True
    assert not mint.called
    # Refused outright — not rebuilt into a payment sheet, not cancelled.
    assert not rebuild.called
    assert not cancel.called
    db.refresh(client)
    # The marker survives: the activation still has to consume it.
    assert client.pending_checkout_subscription_id == "sub_botidem_just_paid"


# ── A genuinely different purchase supersedes, it does not accumulate ────────


def _pending_notes_for(name: str, website: str | None) -> dict[str, str]:
    """The notes an in-flight mandate for this agent actually carries.

    Built through the route's own domain derivation and the real identity
    helper, so the fixture cannot drift from what the route would mint — and,
    more importantly, so the tests below drive the REAL comparison rather than a
    stubbed answer to it.
    """
    return {
        key: value
        for key, value in rzp.per_bot_checkout_identity(
            bot_name=name,
            bot_website=website,
            bot_allowed_domains=bot_routes._derive_allowed_domains_from_website(website),
            # The route's secure-by-default when the request omits the field.
            bot_domain_check_enabled=True,
        ).items()
        if value != ""
    }


@contextmanager
def _gateway_holding(plan: Plan, notes: dict[str, str]):
    """A Razorpay whose in-flight mandate carries ``notes``.

    Patches the gateway rather than ``rebuild_upgrade_checkout`` so the real
    reuse decision runs: the route builds the identity, the service passes it
    down, and the comparison is what answers.
    """
    entity = {
        "status": "created",
        "short_url": "https://rzp.io/i/x",
        "plan_id": plan.razorpay_plan_id_monthly,
        "notes": notes,
    }
    with patch.object(rzp, "_get_razorpay") as gw:
        gw.return_value.subscription.fetch.return_value = entity
        yield gw


def test_the_same_agent_resubmitted_reuses_the_real_mandate(db, monkeypatch):
    """End to end through the real comparison: identity built by the route,
    carried by the service, decided against the gateway's own notes."""
    api, client = _mk(db, monkeypatch)
    plan = _plan(db, slug="std-botidem-samereal")
    pending_checkout_service.record(
        client,
        subscription_id="sub_botidem_alpha",
        plan_id=plan.id,
        billing_cycle="monthly",
        country="IN",
        bot_id=pending_checkout_service.NEW_BOT_SCOPE,
    )
    db.flush()

    with (
        patch.object(rzp, "create_per_bot_subscription") as mint,
        patch.object(rzp, "cancel_superseded_checkout") as cancel,
        _gateway_holding(plan, _pending_notes_for("Alpha", "https://alpha.com")),
    ):
        res = api.post("/bots/checkout", json=_body(plan, name="Alpha", website="https://alpha.com"))

    assert res.status_code == 200, res.text
    assert res.json()["subscription_id"] == "sub_botidem_alpha"
    assert not mint.called
    assert not cancel.called


def test_renaming_the_agent_supersedes_and_cancels(db, monkeypatch):
    """Two same-plan purchases of two DIFFERENT agents are identical on every
    column of the marker — same plan, same cycle, same rail, same scope. The
    agent lives only in the gateway notes, so without reading them this request
    would be handed a mandate that creates the OTHER agent, at the other
    agent's website, with the other agent's domain allowlist.

    Drives the real comparison, so removing it from the route fails here."""
    api, client = _mk(db, monkeypatch)
    plan = _plan(db, slug="std-botidem-rename")
    pending_checkout_service.record(
        client,
        subscription_id="sub_botidem_alpha",
        plan_id=plan.id,
        billing_cycle="monthly",
        country="IN",
        bot_id=pending_checkout_service.NEW_BOT_SCOPE,
    )
    db.flush()

    with (
        patch.object(rzp, "create_per_bot_subscription", return_value=_mint("sub_botidem_beta")) as mint,
        patch.object(rzp, "cancel_superseded_checkout", return_value="created") as cancel,
        _gateway_holding(plan, _pending_notes_for("Alpha", "https://alpha.com")),
    ):
        res = api.post("/bots/checkout", json=_body(plan, name="Beta", website="https://beta.com"))

    assert res.status_code == 200, res.text
    assert mint.call_count == 1
    # The abandoned mandate is dead at the gateway — it can never charge.
    cancel.assert_called_once_with("sub_botidem_alpha")
    db.refresh(client)
    assert client.pending_checkout_subscription_id == "sub_botidem_beta"


def test_a_different_plan_supersedes_and_cancels(db, monkeypatch):
    api, client = _mk(db, monkeypatch)
    plan_a = _plan(db, slug="std-botidem-a")
    plan_b = _plan(db, slug="std-botidem-b", monthly=179900)

    with (
        patch.object(
            rzp,
            "create_per_bot_subscription",
            side_effect=[_mint("sub_botidem_pa"), _mint("sub_botidem_pb")],
        ) as mint,
        patch.object(rzp, "rebuild_upgrade_checkout") as rebuild,
        patch.object(rzp, "cancel_superseded_checkout", return_value="created") as cancel,
    ):
        api.post("/bots/checkout", json=_body(plan_a))
        second = api.post("/bots/checkout", json=_body(plan_b))

    assert second.status_code == 200, second.text
    assert mint.call_count == 2
    assert not rebuild.called  # different key never even tries to reuse
    cancel.assert_called_once_with("sub_botidem_pa")
    db.refresh(client)
    assert client.pending_checkout_plan_id == plan_b.id


def test_an_account_level_marker_is_never_reused_for_an_agent_purchase(db, monkeypatch):
    """An account-level mandate activates into an account subscription, not an
    agent. Handing one back here would take the customer's money for an agent
    and fund the account pool instead — the wrong-ledger hazard the bot scope
    column exists to prevent."""
    api, client = _mk(db, monkeypatch)
    plan = _plan(db, slug="std-botidem-scope")
    pending_checkout_service.record(
        client,
        subscription_id="sub_botidem_account",
        plan_id=plan.id,
        billing_cycle="monthly",
        country="IN",
        bot_id=None,  # account-level
    )
    db.flush()

    with (
        patch.object(rzp, "create_per_bot_subscription", return_value=_mint("sub_botidem_agent")) as mint,
        patch.object(rzp, "rebuild_upgrade_checkout") as rebuild,
        patch.object(rzp, "cancel_superseded_checkout", return_value="created") as cancel,
    ):
        res = api.post("/bots/checkout", json=_body(plan))

    assert res.status_code == 200, res.text
    assert not rebuild.called
    cancel.assert_called_once_with("sub_botidem_account")
    assert mint.call_count == 1
    db.refresh(client)
    assert client.pending_checkout_bot_id == pending_checkout_service.NEW_BOT_SCOPE


def test_an_agent_marker_is_never_reused_for_an_account_purchase(db, monkeypatch):
    """The same collision, read the other way round. A per-agent mandate carries
    ``purpose=per_bot_subscription`` and materialises a BOT on activation, so
    the account-level routes must not reuse it either. ``NEW_BOT_SCOPE`` is what
    keeps the keys apart; had the marker been recorded account-level (NULL) they
    would match on every column."""
    _api, client = _mk(db, monkeypatch)
    plan = _plan(db, slug="std-botidem-reverse")
    pending_checkout_service.record(
        client,
        subscription_id="sub_botidem_agent_inflight",
        plan_id=plan.id,
        billing_cycle="monthly",
        country="IN",
        bot_id=pending_checkout_service.NEW_BOT_SCOPE,
    )
    db.flush()

    # The key the ACCOUNT-level routes ask with (``bot_id=None``).
    assert (
        pending_checkout_service._matches(client, plan_id=plan.id, billing_cycle="monthly", country="IN", bot_id=None)
        is False
    )
    # ...and the key this route asks with still matches its own mandate.
    assert (
        pending_checkout_service._matches(
            client,
            plan_id=plan.id,
            billing_cycle="monthly",
            country="IN",
            bot_id=pending_checkout_service.NEW_BOT_SCOPE,
        )
        is True
    )


# ── Gateway trouble: never guess, but never block a purchase needlessly ──────


def test_gateway_read_failure_is_a_502_not_a_sibling_mint(db, monkeypatch):
    """A fetch failure is not evidence the pending mandate is dead. Minting a
    sibling against a live authorizable one is the double-charge itself."""
    api, client = _mk(db, monkeypatch)
    plan = _plan(db, slug="std-botidem-502")
    pending_checkout_service.record(
        client,
        subscription_id="sub_botidem_flaky",
        plan_id=plan.id,
        billing_cycle="monthly",
        country="IN",
        bot_id=pending_checkout_service.NEW_BOT_SCOPE,
    )
    db.flush()

    with (
        patch.object(rzp, "create_per_bot_subscription") as mint,
        patch.object(rzp, "rebuild_upgrade_checkout", side_effect=rzp.RazorpayBillingError("gateway timeout")),
    ):
        res = api.post("/bots/checkout", json=_body(plan))

    assert res.status_code == 502, res.text
    assert not mint.called
    db.refresh(client)
    assert client.pending_checkout_subscription_id == "sub_botidem_flaky"  # marker intact


def test_a_failed_cancel_does_not_block_the_purchase(db, monkeypatch):
    """The customer is trying to give us money.

    A Razorpay 5xx while tidying up a handle they abandoned must not surface as
    a failed purchase. The mandate was read as unpaid moments earlier, so this
    is not minting beside a mandate of unknown state — only beside one whose
    cancel did not land, which is exactly the pre-existing behaviour on a path
    that never cancelled anything. Refusing would newly break agent purchases
    that succeed today.
    """
    api, client = _mk(db, monkeypatch)
    plan_a = _plan(db, slug="std-botidem-cf-a")
    plan_b = _plan(db, slug="std-botidem-cf-b", monthly=179900)
    pending_checkout_service.record(
        client,
        subscription_id="sub_botidem_stuck",
        plan_id=plan_a.id,
        billing_cycle="monthly",
        country="IN",
        bot_id=pending_checkout_service.NEW_BOT_SCOPE,
    )
    db.flush()

    with (
        patch.object(rzp, "create_per_bot_subscription", return_value=_mint("sub_botidem_after_stuck")) as mint,
        patch.object(rzp, "cancel_superseded_checkout", side_effect=rzp.RazorpayBillingError("cancel failed")),
    ):
        res = api.post("/bots/checkout", json=_body(plan_b))

    assert res.status_code == 200, res.text
    assert mint.call_count == 1
    db.refresh(client)
    assert client.pending_checkout_subscription_id == "sub_botidem_after_stuck"


def test_the_account_routes_still_refuse_on_a_failed_cancel(db, monkeypatch):
    """The tolerance above is opt-in, and must not have leaked to the callers
    that deliberately refuse. Default behaviour is unchanged."""
    plan = _plan(db, slug="std-botidem-default")
    client = Client(name="D", email="botidem-default@test.example", api_key="key-botidem-default")
    db.add(client)
    pending_checkout_service.record(
        client,
        subscription_id="sub_botidem_default",
        plan_id=plan.id,
        billing_cycle="monthly",
        country="IN",
    )
    db.flush()
    other = _plan(db, slug="std-botidem-default-other", monthly=179900)

    with (
        patch.object(rzp, "cancel_superseded_checkout", side_effect=rzp.RazorpayBillingError("cancel failed")),
        pytest.raises(rzp.RazorpayBillingError),
    ):
        pending_checkout_service.reuse_or_supersede(
            db,
            client_row=client,
            client=client,
            plan=other,
            billing_cycle="monthly",
            country="IN",
        )


def test_a_mandate_that_went_active_midflight_blocks_the_mint(db, monkeypatch):
    """``paid_count`` and ``status`` can move apart for a moment. Whichever
    notices first, nothing was cancelled — only the activation sweep may retire
    a live mandate — so minting now would leave two CHARGED subscriptions."""
    api, client = _mk(db, monkeypatch)
    plan = _plan(db, slug="std-botidem-active")
    pending_checkout_service.record(
        client,
        subscription_id="sub_botidem_live",
        plan_id=plan.id,
        billing_cycle="monthly",
        country="IN",
        bot_id=pending_checkout_service.NEW_BOT_SCOPE,
    )
    db.flush()

    with (
        patch.object(rzp, "create_per_bot_subscription") as mint,
        patch.object(rzp, "rebuild_upgrade_checkout", return_value=None),
        patch.object(rzp, "cancel_superseded_checkout", return_value="active"),
    ):
        res = api.post("/bots/checkout", json=_body(plan))

    assert res.status_code == 409, res.text
    assert res.json()["detail"]["payment_captured"] is True
    assert not mint.called


# ── The agent identity, which lives only in the gateway notes ────────────────


def test_identity_renders_an_absent_field_as_empty_not_missing():
    """Symmetry is the whole point: a pending mandate carrying a website and a
    request without one must DIFFER. A missing key on one side would drop out of
    the comparison and read as a match."""
    identity = rzp.per_bot_checkout_identity(
        bot_name="Alpha",
        bot_website=None,
        bot_allowed_domains=None,
        bot_domain_check_enabled=False,
    )
    assert identity == {
        "purpose": "per_bot_subscription",
        "bot_name": "Alpha",
        "bot_website": "",
        "bot_allowed_domains": "",
        "bot_domain_check_enabled": "0",
    }


def test_the_minted_notes_carry_no_empty_values():
    """The wire payload is unchanged by single-sourcing the identity: the
    activation handler reads a missing key and an empty one identically, and
    notes free of blank keys is what it received before."""
    with patch.object(rzp, "create_subscription", return_value=_mint()) as create:
        rzp.create_per_bot_subscription(
            None,
            SimpleNamespace(id=1),
            SimpleNamespace(id=2),
            bot_name="Alpha",
            bot_website=None,
            bot_allowed_domains=None,
            bot_domain_check_enabled=True,
        )
    notes = create.call_args.kwargs["extra_notes"]
    assert notes == {
        "purpose": "per_bot_subscription",
        "bot_name": "Alpha",
        "bot_domain_check_enabled": "1",
    }


def _minted_notes(*, bot_name: str, bot_website: str | None) -> dict[str, str]:
    """Notes exactly as ``create_per_bot_subscription`` puts them on the wire.

    Built through the real code rather than written out, so these cases cannot
    quietly stop resembling a mandate the gateway would actually hold.
    """
    return {
        key: value
        for key, value in rzp.per_bot_checkout_identity(
            bot_name=bot_name,
            bot_website=bot_website,
            bot_allowed_domains=None,
            bot_domain_check_enabled=False,
        ).items()
        if value != ""
    }


@pytest.mark.parametrize(
    ("pending_notes", "reusable"),
    [
        # The genuine retry: same agent, same everything.
        (_minted_notes(bot_name="Alpha", bot_website="https://alpha.com"), True),
        # A renamed agent.
        (_minted_notes(bot_name="Beta", bot_website="https://alpha.com"), False),
        # A re-pointed agent.
        (_minted_notes(bot_name="Alpha", bot_website="https://beta.com"), False),
        # The pending mandate carries no website, this request does — the
        # asymmetry a "compare only the keys present" check would miss.
        (_minted_notes(bot_name="Alpha", bot_website=None), False),
        # An ACCOUNT-level mandate: no per-bot purpose at all.
        ({}, False),
    ],
)
def test_reuse_requires_the_notes_to_describe_the_same_agent(pending_notes, reusable):
    """``rebuild_upgrade_checkout`` answers "not reusable" for a mandate that
    would create a different agent, exactly as it does for the wrong rail — so
    the caller supersedes it and mints the right one."""
    required = rzp.per_bot_checkout_identity(
        bot_name="Alpha",
        bot_website="https://alpha.com",
        bot_allowed_domains=None,
        bot_domain_check_enabled=False,
    )
    entity = {"status": "created", "short_url": "https://rzp.io/x", "plan_id": None, "notes": pending_notes}
    plan = SimpleNamespace(id=1, name="Std", razorpay_plan_id_monthly=None, razorpay_plan_id_annual=None)

    with patch.object(rzp, "_get_razorpay") as gw:
        gw.return_value.subscription.fetch.return_value = entity
        result = rzp.rebuild_upgrade_checkout(
            "sub_notes",
            SimpleNamespace(name="C", email="c@e.com", billing_country="IN"),
            plan,
            "monthly",
            required_notes=required,
        )

    assert (result is not None) is reusable


def test_notes_are_not_compared_when_the_caller_does_not_ask():
    """The account-level callers pass no notes and must be unaffected."""
    entity = {"status": "created", "short_url": "https://rzp.io/x", "plan_id": None, "notes": {"anything": "at all"}}
    plan = SimpleNamespace(id=1, name="Std", razorpay_plan_id_monthly=None, razorpay_plan_id_annual=None)

    with patch.object(rzp, "_get_razorpay") as gw:
        gw.return_value.subscription.fetch.return_value = entity
        result = rzp.rebuild_upgrade_checkout(
            "sub_notes",
            SimpleNamespace(name="C", email="c@e.com", billing_country="IN"),
            plan,
            "monthly",
        )

    assert result is not None


# ── Concurrency: the read-then-write check needs the lock to mean anything ───


def test_concurrent_agent_purchases_serialise_on_the_billing_lock(pg_engine):
    """Two simultaneous submits must not both pass the reuse check.

    The route holds ``lock_client_for_billing`` across read → decide → mint →
    write, so the second request cannot even READ the marker until the first has
    COMMITTED it. Without the lock both observe an empty marker and both mint —
    which is the bug itself, not a smaller version of it.
    """
    setup = Session(pg_engine)
    plan = Plan(
        name="Conc",
        slug="std-botidem-conc",
        monthly_price_cents=94900,
        credits_per_month=10_000,
        is_active=True,
    )
    setup.add(plan)
    client = Client(name="Conc", email="botconc@test.example", api_key="key-botidem-conc")
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
            row,
            plan_id=plan_id,
            billing_cycle="monthly",
            country="IN",
            bot_id=pending_checkout_service.NEW_BOT_SCOPE,
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
            subscription_id="sub_botconc_winner",
            plan_id=plan_id,
            billing_cycle="monthly",
            country="IN",
            bot_id=pending_checkout_service.NEW_BOT_SCOPE,
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
        assert observed["pending_id"] == "sub_botconc_winner"
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
