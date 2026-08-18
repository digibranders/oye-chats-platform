"""Invoice list scoping, an agent with no subscription of its own must show
the ACCOUNT's invoices, mirroring /subscription/current's fallback (F1).

Without this, the Billing page renders an account subscription beside an
agent-scoped (empty) invoice list: a paying customer sees "Active" next to
"No invoices yet" and the two panels can never agree.
"""

import os

import pytest

from app.db.models import Bot, Client, Invoice, Plan, Subscription

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")


def _client(db, email="scope@test.dev"):
    c = Client(name="Scope", email=email, api_key=f"key-{email}")
    db.add(c)
    db.flush()
    return c


def _bot(db, client, key="bot-scope-1"):
    b = Bot(client_id=client.id, bot_key=key, name="Agent")
    db.add(b)
    db.flush()
    return b


def _invoice(db, client, *, bot_id=None, amount=94900):
    inv = Invoice(client_id=client.id, bot_id=bot_id, amount_cents=amount, currency="inr", status="paid")
    db.add(inv)
    db.flush()
    return inv


def test_agent_without_own_subscription_sees_account_invoices(db):
    from app.api.subscription_routes import _resolve_invoice_scope

    client = _client(db)
    bot = _bot(db, client)
    _invoice(db, client, bot_id=None)

    # No Subscription row for this bot → scope collapses to account-wide.
    assert _resolve_invoice_scope(db, client.id, bot.id) is None


def test_agent_with_own_subscription_stays_scoped(db):
    from app.api.subscription_routes import _resolve_invoice_scope

    client = _client(db, "scope2@test.dev")
    bot = _bot(db, client, "bot-scope-2")
    plan = Plan(name="Standard", slug="standard-scope", monthly_price_cents=94900, credits_per_month=6000)
    db.add(plan)
    db.flush()
    db.add(Subscription(client_id=client.id, bot_id=bot.id, plan_id=plan.id, status="active"))
    db.flush()

    assert _resolve_invoice_scope(db, client.id, bot.id) == bot.id


def test_no_bot_id_is_always_account_wide(db):
    from app.api.subscription_routes import _resolve_invoice_scope

    client = _client(db, "scope3@test.dev")
    assert _resolve_invoice_scope(db, client.id, None) is None


def test_foreign_bot_id_does_not_leak_another_workspace(db):
    """get_subscription_for_bot filters by client_id, so a bot belonging to a
    different account resolves to None → account-wide for the CALLER, never the
    other workspace's rows (the client_id filter on the query still applies)."""
    from app.api.subscription_routes import _resolve_invoice_scope

    owner = _client(db, "owner@test.dev")
    other = _client(db, "other@test.dev")
    other_bot = _bot(db, other, "bot-scope-other")
    plan = Plan(name="Std", slug="standard-scope-2", monthly_price_cents=94900, credits_per_month=6000)
    db.add(plan)
    db.flush()
    db.add(Subscription(client_id=other.id, bot_id=other_bot.id, plan_id=plan.id, status="active"))
    db.flush()

    assert _resolve_invoice_scope(db, owner.id, other_bot.id) is None
