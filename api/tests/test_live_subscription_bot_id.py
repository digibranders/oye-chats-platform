"""``credit_service.live_subscription_bot_id`` - the auth-layer ledger pre-resolution.

``get_current_bot()`` stashes ``subscription.bot_id`` on the bot before
expunging it, so the chat route can decide which ledger to drain without a
lazy-load. That pre-resolution must carry the same "is it live?" judgement as
``resolve_bot_ledger_bot_id``'s slow path: resolving the scope of a DEAD
subscription re-creates the exact P1 it exists to fix, on the hot path.

Real Postgres via the shared ``db`` fixture. Skips without DB_URL.
"""

from __future__ import annotations

import os
from datetime import UTC, datetime

import pytest

from app.db.models import Bot, Client, Plan, Subscription
from app.services.credit_service import live_subscription_bot_id

pytestmark = pytest.mark.skipif(
    not os.getenv("DB_URL"),
    reason="live_subscription_bot_id tests need a reachable Postgres at DB_URL",
)


def _fixture(db, *, email: str, key: str, status: str) -> tuple[Bot, Subscription]:
    client = Client(name="c", email=email, api_key=email, hashed_password="h")
    db.add(client)
    db.flush()
    plan = Plan(
        name="Starter",
        slug=f"starter-{key}",
        monthly_price_cents=44900,
        credits_per_month=1000,
        included_operator_seats=1,
        is_active=True,
    )
    db.add(plan)
    db.flush()
    bot = Bot(client_id=client.id, bot_key=key, name="Agent")
    db.add(bot)
    db.flush()
    now = datetime(2026, 1, 1, tzinfo=UTC)
    sub = Subscription(
        client_id=client.id,
        plan_id=plan.id,
        bot_id=bot.id,
        status=status,
        billing_cycle="monthly",
        operator_quantity=1,
        current_period_start=now,
        current_period_end=datetime(2026, 1, 31, tzinfo=UTC),
        payment_provider="razorpay",
    )
    db.add(sub)
    db.flush()
    bot.subscription_id = sub.id
    db.flush()
    return bot, sub


def test_live_subscription_resolves_its_bot_scope(db):
    bot, sub = _fixture(db, email="live-scope@e.com", key="bot-live-scope", status="active")
    assert live_subscription_bot_id(db, sub.id) == bot.id


def test_dead_subscription_resolves_to_the_pool(db):
    _, sub = _fixture(db, email="dead-scope@e.com", key="bot-dead-scope", status="canceled")
    assert live_subscription_bot_id(db, sub.id) is None


def test_missing_subscription_resolves_to_the_pool(db):
    assert live_subscription_bot_id(db, 999_999_999) is None
