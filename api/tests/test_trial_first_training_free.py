"""During the trial, the FIRST website training is free; later ones charge.

Site size is a fact about the customer's website, not about the value they will
get from us, and metering it made a 100-page site spend its whole trial budget
before the customer had evaluated a single answer.

The switch is the ``first_training_free`` feature flag on the plan row, not a
slug check, the same convention as ``topup_allowed``. "First" is judged per bot
by whether any crawl-sourced Document exists.

Real-Postgres tests via the shared ``db`` fixture. Skips without DB_URL.
"""

from __future__ import annotations

import os

import pytest

from app.api.document_routes import resolve_crawl_cost_per_page
from app.db.models import Bot, Client, Document, Plan, Subscription

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")


@pytest.fixture(autouse=True)
def _no_entitlements_cache(monkeypatch):
    """Read the live plan row, never a cached one.

    ``get_entitlements`` caches on ``client_id`` alone, and the ``db`` fixture
    truncates with RESTART IDENTITY, so every test here builds client id 1. On
    a machine with Redis up (a dev box running dev.sh, not CI) one test's trial
    entitlements are served to the next test's paid client and the assertion
    silently inverts.
    """
    from app.services import plan_entitlements_service

    monkeypatch.setattr(plan_entitlements_service, "get_redis", lambda: None)


_URL_SCAN_COST = 5


def _plan(db, slug: str, *, first_training_free: bool) -> Plan:
    plan = Plan(
        slug=slug,
        name=slug.title(),
        credits_per_month=500,
        monthly_price_cents=0 if first_training_free else 119900,
        annual_price_cents=0,
        trial_days=14 if first_training_free else 0,
        is_active=True,
        is_public=not first_training_free,
        sort_order=1,
        limits={"bots": 1, "credits": 500},
        features={"topup_allowed": False, "first_training_free": first_training_free},
    )
    db.add(plan)
    db.flush()
    return plan


def _client_on(db, plan: Plan, *, email: str) -> tuple[Client, Bot]:
    client = Client(name="c", email=email, api_key=email, hashed_password="h")
    db.add(client)
    db.flush()
    db.add(
        Subscription(
            client_id=client.id,
            plan_id=plan.id,
            status="trialing" if plan.trial_days else "active",
            billing_cycle="monthly",
            operator_quantity=1,
            payment_provider="manual",
        )
    )
    bot = Bot(client_id=client.id, bot_key=f"bot-{email[:8]}", name="B")
    db.add(bot)
    db.flush()
    db.commit()
    return client, bot


def _crawled_page(db, client: Client, bot: Bot) -> None:
    db.add(
        Document(
            client_id=client.id,
            bot_id=bot.id,
            document_name="https://example.com/",
            source="crawl",
            file_hash="h-crawl",
            content="hello",
            embedding=[0.0] * 768,
        )
    )
    db.flush()
    db.commit()


def test_first_training_costs_zero_on_trial(db):
    plan = _plan(db, "trial", first_training_free=True)
    client, bot = _client_on(db, plan, email="ftf-first@e.com")
    assert resolve_crawl_cost_per_page(db, client.id, bot.id) == 0


def test_second_training_charges_url_scan_on_trial(db):
    plan = _plan(db, "trial", first_training_free=True)
    client, bot = _client_on(db, plan, email="ftf-second@e.com")
    _crawled_page(db, client, bot)
    assert resolve_crawl_cost_per_page(db, client.id, bot.id) == _URL_SCAN_COST


def test_first_training_still_charges_on_paid_plans(db):
    plan = _plan(db, "standard", first_training_free=False)
    client, bot = _client_on(db, plan, email="ftf-paid@e.com")
    assert resolve_crawl_cost_per_page(db, client.id, bot.id) == _URL_SCAN_COST
    _crawled_page(db, client, bot)
    assert resolve_crawl_cost_per_page(db, client.id, bot.id) == _URL_SCAN_COST


def test_an_uploaded_document_is_not_a_training(db):
    """The predicate is crawl-sourced documents, not documents.

    A customer who uploaded a PDF on day one has not used their free website
    training, and charging them for it would be the metering this removes.
    """
    plan = _plan(db, "trial", first_training_free=True)
    client, bot = _client_on(db, plan, email="ftf-upload@e.com")
    db.add(
        Document(
            client_id=client.id,
            bot_id=bot.id,
            document_name="handbook.pdf",
            source="upload",
            file_hash="h-upload",
            content="hello",
            embedding=[0.0] * 768,
        )
    )
    db.flush()
    db.commit()
    assert resolve_crawl_cost_per_page(db, client.id, bot.id) == 0


def test_a_sibling_bots_crawl_spends_the_accounts_one_free_training(db):
    """One free training per ACCOUNT, not per bot.

    Per bot is exploitable, because ``bot_id`` is optional on every crawl
    route: a crawl with it omitted and a crawl with it set are two scopes, and
    both would come out free. The trial grants one bot anyway, so the two rules
    only differ where the difference is abuse.
    """
    plan = _plan(db, "trial", first_training_free=True)
    client, bot = _client_on(db, plan, email="ftf-sibling@e.com")
    other = Bot(client_id=client.id, bot_key="bot-ftf-other", name="Other")
    db.add(other)
    db.flush()
    _crawled_page(db, client, other)
    assert resolve_crawl_cost_per_page(db, client.id, bot.id) == _URL_SCAN_COST
    assert resolve_crawl_cost_per_page(db, client.id, other.id) == _URL_SCAN_COST


def test_omitting_the_bot_id_cannot_buy_a_second_free_training(db):
    """The exploit the account scope exists to close, stated directly."""
    plan = _plan(db, "trial", first_training_free=True)
    client, bot = _client_on(db, plan, email="ftf-nobot@e.com")

    # First crawl, account level: free.
    assert resolve_crawl_cost_per_page(db, client.id, None) == 0
    db.add(
        Document(
            client_id=client.id,
            bot_id=None,
            document_name="https://example.com/",
            source="crawl",
            file_hash="h-acct",
            content="hello",
            embedding=[0.0] * 768,
        )
    )
    db.flush()
    db.commit()

    # Second crawl, now naming the bot. Under a per-bot rule this bot has no
    # crawl documents of its own and would be free all over again.
    assert resolve_crawl_cost_per_page(db, client.id, bot.id) == _URL_SCAN_COST
    assert resolve_crawl_cost_per_page(db, client.id, None) == _URL_SCAN_COST
