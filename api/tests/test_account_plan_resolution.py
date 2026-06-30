"""Account plan/entitlement resolution — remediation H2 (real Postgres).

Under per-bot billing a client can hold several active subscriptions at once
(one account-level + one per paid bot). The account-level resolver must pick the
**highest tier**, not whichever was created most recently — otherwise a Standard
customer who later adds a Free second bot is silently downgraded to Free.
"""

from __future__ import annotations

import os
from datetime import UTC, datetime, timedelta

import pytest

from app.db.models import Bot, Client, Plan, Subscription
from app.services import plan_service

pytestmark = pytest.mark.skipif(
    not os.getenv("DB_URL"),
    reason="account-plan resolution tests need a reachable Postgres at DB_URL",
)


def _setup_standard_then_newer_free(db):
    client = Client(name="c", email="h2@e.com", api_key="h2", hashed_password="h")
    db.add(client)
    db.flush()
    free = Plan(name="Free", slug="free", monthly_price_cents=0, credits_per_month=200)
    standard = Plan(name="Standard", slug="standard", monthly_price_cents=399900, credits_per_month=10000)
    db.add_all([free, standard])
    db.flush()
    bot = Bot(client_id=client.id, bot_key="bot-h2", name="B2", is_legacy_pooled=False)
    db.add(bot)
    db.flush()

    now = datetime.now(UTC)
    # Account-level Standard, created EARLIER.
    sub_std = Subscription(
        client_id=client.id,
        plan_id=standard.id,
        bot_id=None,
        status="active",
        payment_provider="razorpay",
        created_at=now - timedelta(days=2),
    )
    # Per-bot Free, created LATER (the newer row that used to win).
    sub_free = Subscription(
        client_id=client.id,
        plan_id=free.id,
        bot_id=bot.id,
        status="active",
        payment_provider="manual",
        created_at=now,
    )
    db.add_all([sub_std, sub_free])
    db.commit()
    return client, standard, free


def test_get_client_subscription_prefers_highest_tier_over_newest(db):
    client, standard, _free = _setup_standard_then_newer_free(db)
    sub = plan_service.get_client_subscription(db, client.id)
    assert sub is not None
    assert sub.plan_id == standard.id  # highest tier wins, not the newer Free


def test_get_client_plan_resolves_to_highest_tier(db):
    client, standard, _free = _setup_standard_then_newer_free(db)
    plan = plan_service.get_client_plan(db, client.id)
    assert plan.id == standard.id


def test_single_subscription_still_resolves(db):
    """Regression: the common single-subscription case is unaffected."""
    client = Client(name="c1", email="h2b@e.com", api_key="h2b", hashed_password="h")
    db.add(client)
    db.flush()
    plan = Plan(name="Starter", slug="starter", monthly_price_cents=159900, credits_per_month=2000)
    db.add(plan)
    db.flush()
    db.add(Subscription(client_id=client.id, plan_id=plan.id, bot_id=None, status="active"))
    db.commit()

    assert plan_service.get_client_subscription(db, client.id).plan_id == plan.id


# ── M7 / M4 / NV6 — usage counters & records ─────────────────────────────────


def test_documents_counted_by_source_not_name_heuristic(db):
    """M7 — an uploaded file named like a URL still counts as a document, and a
    crawled page is excluded, because the count keys on ``source`` not the name."""
    from app.db.models import Document
    from app.services.plan_entitlements_service import _build_usage

    client = Client(name="c", email="m7@e.com", api_key="m7", hashed_password="h")
    db.add(client)
    db.flush()
    # An uploaded file whose name starts with "http" (old heuristic excluded it).
    db.add(
        Document(
            client_id=client.id,
            document_name="https-notes.pdf",
            source="upload",
            file_hash="h1",
            content="x",
        )
    )
    # A crawled page (must NOT count toward the documents quota).
    db.add(
        Document(
            client_id=client.id,
            document_name="http://example.com/page",
            source="crawl",
            file_hash="h2",
            content="y",
        )
    )
    db.commit()

    usage = _build_usage(client_id=client.id, db_session=db, limits={})
    assert usage["documents"] == 1


def test_get_or_create_usage_record_is_idempotent(db):
    """M4/NV6 — a second call in the same period returns the existing row
    deterministically, never a duplicate or an error."""
    client = Client(name="c", email="m4@e.com", api_key="m4", hashed_password="h")
    db.add(client)
    db.flush()
    free = Plan(name="Free", slug="free", monthly_price_cents=0, credits_per_month=200)
    db.add(free)
    db.commit()

    first = plan_service.get_or_create_usage_record(db, client.id)
    db.commit()
    second = plan_service.get_or_create_usage_record(db, client.id)
    assert second.id == first.id
