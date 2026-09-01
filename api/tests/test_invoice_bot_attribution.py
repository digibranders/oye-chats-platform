"""An invoice has to say which chatbot it is for.

Billing is per chatbot: `subscriptions.bot_id` and `invoices.bot_id` both exist,
and creating a second chatbot returns 402 "Each additional chatbot needs its own
paid subscription". So an account with two paid chatbots receives two
interleaved streams of invoices.

The list endpoint emitted no chatbot field, so those rows were unattributable.
That matters more here than anywhere else in the product: these are tax
documents someone has to reconcile against a bank statement.

`bot_name` is denormalised alongside the id for the same reason it is on leads —
an invoice outlives the chatbot it was raised for, and joining ids in the
dashboard would blank the row for a charge that really was made.
"""

from __future__ import annotations

import os
from contextlib import contextmanager

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api import subscription_routes
from app.api.auth import get_current_client_strict
from app.db.models import Bot, Client, Invoice

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")


@contextmanager
def _ctx(session):
    yield session


def _setup(db, monkeypatch):
    client = Client(name="Acme", email="inv-attr@test.example", api_key="key-inv-attr")
    db.add(client)
    db.flush()
    bot = Bot(client_id=client.id, name="Support", bot_key="bot-inv-attr")
    db.add(bot)
    db.flush()
    db.add(Invoice(client_id=client.id, bot_id=bot.id, amount_cents=59900, currency="inr", status="paid"))
    # An invoice with no chatbot: the account-level subscription, which funds
    # whichever chatbots have no plan of their own.
    db.add(Invoice(client_id=client.id, bot_id=None, amount_cents=299900, currency="inr", status="paid"))
    db.flush()
    db.commit()

    monkeypatch.setattr(subscription_routes, "get_session", lambda: _ctx(db))
    app = FastAPI()
    app.include_router(subscription_routes.router)
    app.dependency_overrides[get_current_client_strict] = lambda: client
    return TestClient(app), client, bot


def test_each_invoice_names_its_chatbot(db, monkeypatch):
    tc, _client, bot = _setup(db, monkeypatch)
    rows = tc.get("/subscriptions/invoices").json()
    assert rows, rows
    attributed = [r for r in rows if r["bot_id"] == bot.id]
    assert attributed, "no invoice carried the chatbot it was raised for"
    assert attributed[0]["bot_name"] == "Support"


def test_an_account_level_invoice_reports_no_chatbot(db, monkeypatch):
    # `bot_id IS NULL` is a real state, not a gap: it is the account-level
    # subscription that funds chatbots without one of their own. The row must
    # say so rather than borrowing another chatbot's name.
    tc, _client, _bot = _setup(db, monkeypatch)
    rows = tc.get("/subscriptions/invoices").json()
    account_level = [r for r in rows if r["bot_id"] is None]
    assert account_level, "expected the unattributed invoice to survive"
    assert account_level[0]["bot_name"] is None


def test_every_row_carries_both_keys(db, monkeypatch):
    # Schema stability: the dashboard renders a column from these, so a missing
    # key is a crash rather than a blank cell.
    tc, _client, _bot = _setup(db, monkeypatch)
    for row in tc.get("/subscriptions/invoices").json():
        assert "bot_id" in row and "bot_name" in row
