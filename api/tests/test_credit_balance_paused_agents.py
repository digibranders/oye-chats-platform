"""``GET /credits/balance`` must keep showing a PAUSED agent's own credit ledger.

``Bot.is_active`` is the pause switch (``bot_routes.update_bot``), not a
delete, and pausing changes nothing about the money: a per-bot-funded agent
keeps its own subscription, keeps being charged for it, and keeps a balance
whose top-ups keep expiring on schedule. The balance endpoint used to build its
per-bot ledger list with ``Bot.is_active.is_(True)``, so the moment a customer
paused such an agent its card disappeared from the Usage page entirely: no
balance, no usage, no expiry warning, on a ledger their subscription is still
funding.

The fix is disclosure, not omission: the entry is served with ``is_active`` so
the console can show the balance AND say why the agent is not answering.
"""

from __future__ import annotations

import os
from contextlib import contextmanager

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api import subscription_routes
from app.api.auth import get_current_client_strict, require_verified_email
from app.db.models import Bot, Client, CreditLedger, Plan, Subscription

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")


@contextmanager
def _ctx(session):
    yield session


def _api(db, monkeypatch, client: Client) -> TestClient:
    monkeypatch.setattr(subscription_routes, "get_session", lambda: _ctx(db))
    monkeypatch.setattr(subscription_routes, "resolve_country", lambda request: "IN")
    app = FastAPI()
    app.include_router(subscription_routes.credits_router)
    app.dependency_overrides[get_current_client_strict] = lambda: client
    app.dependency_overrides[require_verified_email] = lambda: client
    return TestClient(app, raise_server_exceptions=True)


def _client(db, slug: str) -> Client:
    row = Client(name=f"Acct {slug}", email=f"{slug}@paused.example", api_key=f"key-{slug}", billing_country="IN")
    db.add(row)
    db.flush()
    return row


def _plan(db, slug: str, **overrides) -> Plan:
    row = Plan(
        name=slug.title(),
        slug=slug,
        currency="INR",
        monthly_price_cents=94_900,
        annual_price_cents=949_000,
        credits_per_month=6_000,
        included_operator_seats=1,
        is_active=True,
        **overrides,
    )
    db.add(row)
    db.flush()
    return row


def _funded_bot(db, client: Client, plan: Plan, slug: str, *, is_active: bool) -> Bot:
    """A bot with its own per-bot subscription, i.e. its own isolated ledger."""
    bot = Bot(
        client_id=client.id,
        bot_key=f"bot-{slug}",
        name=f"Agent {slug}",
        is_active=is_active,
        is_legacy_pooled=False,
        plan_id=plan.id,
    )
    db.add(bot)
    db.flush()
    sub = Subscription(
        client_id=client.id,
        plan_id=plan.id,
        bot_id=bot.id,  # scoped to the bot: this is what routes credits per-bot
        status="active",
        billing_cycle="monthly",
    )
    db.add(sub)
    db.flush()
    bot.subscription_id = sub.id
    db.flush()
    return bot


def _grant(db, client: Client, bot: Bot, delta: int) -> None:
    db.add(CreditLedger(client_id=client.id, bot_id=bot.id, delta=delta, reason="plan_grant"))
    db.flush()


def test_a_paused_funded_agent_still_reports_its_own_balance(db, monkeypatch):
    """The money surface must not go silent because the agent did."""
    client = _client(db, "paused-visible")
    plan = _plan(db, "paused-visible-plan")
    paused = _funded_bot(db, client, plan, "paused-visible", is_active=False)
    _grant(db, client, paused, 6_000)

    body = _api(db, monkeypatch, client).get("/credits/balance").json()

    entries = {entry["bot_id"]: entry for entry in body["bots"]}
    assert paused.id in entries, (
        "a paused agent with its own subscription vanished from /credits/balance; "
        "its ledger is still funded and still expiring"
    )
    entry = entries[paused.id]
    assert entry["total"] == 6_000
    assert entry["plan"] == 6_000
    # ...and the pause is DISCLOSED, so the console can explain a balance on an
    # agent that is not answering rather than leaving it unexplained.
    assert entry["is_active"] is False


def test_an_active_agent_is_unchanged_and_marked_active(db, monkeypatch):
    client = _client(db, "active-visible")
    plan = _plan(db, "active-visible-plan")
    live = _funded_bot(db, client, plan, "active-visible", is_active=True)
    _grant(db, client, live, 4_000)

    body = _api(db, monkeypatch, client).get("/credits/balance").json()

    (entry,) = body["bots"]
    assert entry["bot_id"] == live.id
    assert entry["is_active"] is True
    assert entry["total"] == 4_000


def test_a_paused_pooled_bot_still_gets_no_card_of_its_own(db, monkeypatch):
    """Widening the query must not widen the OUTPUT.

    A legacy-pooled / Free bot has no isolated ledger — its usage rolls up to
    the account pool — so it never had a card and must not gain one now that
    inactive rows reach the loop. ``resolve_bot_ledger_bot_id`` is what skips
    it, and it is still the only thing deciding.
    """
    client = _client(db, "pooled-paused")
    # The account-level half of the payload resolves the client's plan, and the
    # test database carries no seed rows.
    _plan(db, "pooled-paused-plan", is_default=True)
    bot = Bot(
        client_id=client.id,
        bot_key="bot-pooled-paused",
        name="Free agent",
        is_active=False,
        is_legacy_pooled=True,
    )
    db.add(bot)
    db.flush()
    db.add(CreditLedger(client_id=client.id, bot_id=None, delta=500, reason="plan_grant"))
    db.flush()

    body = _api(db, monkeypatch, client).get("/credits/balance").json()

    assert body["bots"] == []
    # It still drains the account pool, so the account card stays on.
    assert body["account_pool_bot_count"] == 1
    assert body["total"] == 500
