"""Outbound webhooks: a dead endpoint must stop costing us, and the delivery
log must not keep visitor PII forever.

Three separate defects, one subsystem:

A. ``_MAX_RETRIES`` bounds retries PER EVENT only. Nothing ever flipped
   ``Webhook.is_active``, so an endpoint that has been dead for a week still
   received five attempts for EVERY event a busy bot produced, forever.
B. ``process_pending_retries`` claimed the whole due set in one transaction and
   held ``FOR UPDATE`` locks across N serial Redis round-trips while the 30s
   cron re-fired on top of it.
C. ``webhook_deliveries`` rows carry the full ``lead_captured`` body (visitor
   name, email, phone) and up to 1KB of the endpoint's response, and NOTHING
   pruned them, unlike every sibling telemetry table.
"""

import asyncio
import os
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select

from app.db.models import Bot, Client, Plan, Subscription, Webhook, WebhookDelivery
from app.services import plan_entitlements_service, webhook_service
from app.worker import tasks as worker_tasks

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")

_EVENT = "lead_captured"


@contextmanager
def _session_cm(session):
    yield session


def _webhook(db, slug: str, *, is_active: bool = True) -> Webhook:
    client = Client(name="W", email=f"{slug}@test.example", api_key=f"key-{slug}", hashed_password="h")
    db.add(client)
    db.flush()
    bot = Bot(client_id=client.id, name="B", bot_key=f"bot-{slug}")
    db.add(bot)
    db.flush()
    hook = Webhook(
        bot_id=bot.id,
        url="https://customer.example/hook",
        secret="s3cret",
        events=[_EVENT],
        is_active=is_active,
    )
    db.add(hook)
    db.commit()
    return hook


def _fail_delivery(hook_id: int) -> None:
    """Drive one event all the way to its FINAL, failed attempt."""

    def _refused(*args, **kwargs):
        raise RuntimeError("connection refused")

    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(webhook_service, "_is_safe_webhook_url", lambda url: True)
        mp.setattr(webhook_service, "_open_pinned", _refused)
        webhook_service._deliver_webhook(hook_id, _EVENT, {"k": "v"}, attempt=webhook_service._MAX_RETRIES)


def _succeed_delivery(hook_id: int) -> None:
    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(webhook_service, "_is_safe_webhook_url", lambda url: True)
        mp.setattr(webhook_service, "_open_pinned", lambda *a, **k: (200, "ok"))
        webhook_service._deliver_webhook(hook_id, _EVENT, {"k": "v"}, attempt=1)


# ── A. per-endpoint circuit breaker ──────────────────────────────────────────


def test_nine_exhausted_then_a_success_keeps_the_webhook_active(db, monkeypatch):
    hook = _webhook(db, "cb-nine")
    monkeypatch.setattr(webhook_service, "get_session", lambda: _session_cm(db))

    for _ in range(webhook_service._CIRCUIT_BREAKER_THRESHOLD - 1):
        _fail_delivery(hook.id)
    _succeed_delivery(hook.id)

    db.refresh(hook)
    assert hook.is_active is True
    assert hook.disabled_reason is None
    assert hook.disabled_at is None


def test_ten_consecutive_exhausted_deliveries_disable_the_webhook(db, monkeypatch, caplog):
    hook = _webhook(db, "cb-ten")
    monkeypatch.setattr(webhook_service, "get_session", lambda: _session_cm(db))

    with caplog.at_level("ERROR", logger=webhook_service.logger.name):
        for _ in range(webhook_service._CIRCUIT_BREAKER_THRESHOLD):
            _fail_delivery(hook.id)

    db.refresh(hook)
    assert hook.is_active is False
    assert hook.disabled_reason
    assert "consecutive" in hook.disabled_reason
    assert hook.disabled_at is not None
    # Logged exactly once: the flip happens on the tenth failure and the
    # dispatcher skips the webhook from then on.
    assert sum("AUTO-DISABLED" in rec.message for rec in caplog.records) == 1


def test_a_disabled_webhook_is_skipped_by_the_dispatcher(db, monkeypatch):
    client = Client(name="c", email="cb-skip@test.example", api_key="key-cb-skip", hashed_password="h")
    db.add(client)
    db.flush()
    plan = Plan(
        name="CB Plan",
        slug="cb-skip",
        monthly_price_cents=44900,
        credits_per_month=2000,
        included_operator_seats=1,
        is_active=True,
        features={"webhooks": True},
    )
    db.add(plan)
    db.flush()
    sub = Subscription(client_id=client.id, plan_id=plan.id, status="active")
    sub.plan = plan
    db.add(sub)
    bot = Bot(client_id=client.id, name="B", bot_key="bot-cb-skip")
    db.add(bot)
    db.flush()
    db.add(
        Webhook(
            bot_id=bot.id,
            url="https://customer.example/hook",
            secret="s",
            events=[_EVENT],
            is_active=False,
            disabled_reason="Auto-disabled: 10 consecutive exhausted deliveries.",
            disabled_at=datetime.now(UTC),
        )
    )
    db.commit()

    queued: list[int] = []
    monkeypatch.setattr(webhook_service, "get_session", lambda: _session_cm(db))
    monkeypatch.setattr(plan_entitlements_service, "get_redis", lambda: None)
    monkeypatch.setattr(webhook_service, "queue_webhook_delivery", lambda wid, *a, **k: queued.append(wid))

    webhook_service.fire_webhook(bot.id, _EVENT, {"lead": "x"})

    assert queued == [], "an auto-disabled webhook must not receive further events"


# ── B. bounded retry sweep ───────────────────────────────────────────────────


def test_retry_sweep_claims_at_most_one_batch_and_leaves_the_rest(db, monkeypatch):
    hook = _webhook(db, "sweep")
    due = datetime.now(UTC) - timedelta(minutes=1)
    total = webhook_service._RETRY_SWEEP_LIMIT + 50
    db.add_all(
        [
            WebhookDelivery(
                webhook_id=hook.id,
                event_type=_EVENT,
                payload={"k": "v"},
                status_code=500,
                attempt=1,
                next_retry_at=due,
                delivered_at=None,
            )
            for _ in range(total)
        ]
    )
    db.commit()

    monkeypatch.setattr(webhook_service, "get_session", lambda: _session_cm(db))

    from unittest.mock import patch

    with patch.object(webhook_service, "queue_webhook_delivery"):
        first = webhook_service.process_pending_retries()
        second = webhook_service.process_pending_retries()

    assert first == webhook_service._RETRY_SWEEP_LIMIT, "one sweep must not claim the whole backlog"
    assert second == total - webhook_service._RETRY_SWEEP_LIMIT, "the remainder must stay claimable"


# ── C. delivery-log retention ────────────────────────────────────────────────


def _delivery(db, hook_id: int, *, age_days: int, next_retry_at=None) -> int:
    row = WebhookDelivery(
        webhook_id=hook_id,
        event_type=_EVENT,
        payload={"email": "visitor@example.com", "phone": "+911234567890"},
        status_code=500,
        attempt=1,
        next_retry_at=next_retry_at,
        delivered_at=None,
        created_at=datetime.now(UTC) - timedelta(days=age_days),
    )
    db.add(row)
    db.flush()
    return row.id


def test_prune_drops_aged_deliveries_but_keeps_recent_and_owed_ones(db):
    hook = _webhook(db, "retention")
    aged_id = _delivery(db, hook.id, age_days=100)
    recent_id = _delivery(db, hook.id, age_days=10)
    owed_id = _delivery(db, hook.id, age_days=400, next_retry_at=datetime.now(UTC) - timedelta(days=1))
    db.commit()

    asyncio.run(worker_tasks.task_prune_processed_webhooks({}))

    db.expire_all()
    surviving = set(db.execute(select(WebhookDelivery.id)).scalars())
    assert aged_id not in surviving, "a 100-day-old delivery still holds visitor PII"
    assert recent_id in surviving
    # The marker is the ONLY record that a redelivery is owed. Age never wins
    # over it, or the customer silently loses the event.
    assert owed_id in surviving


def test_prune_never_touches_the_webhooks_table(db):
    hook = _webhook(db, "retention-parent")
    _delivery(db, hook.id, age_days=500)
    db.commit()

    asyncio.run(worker_tasks.task_prune_processed_webhooks({}))

    db.expire_all()
    assert db.get(Webhook, hook.id) is not None, "pruning the delivery log must never delete the registration"
