"""Wave 3.3 (M-1/M-4/L-4): outbound webhook delivery must not lose retries.

The ``next_retry_at`` marker is the ONLY record that a redelivery is owed.
The old sweep cleared it before the enqueue was confirmed (a Redis hiccup
lost the retry forever), took no row locks (concurrent sweepers double-
enqueued → duplicate deliveries to the customer), and the final attempt
failing was logged at the same level as any other attempt.
"""

import os
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from unittest.mock import patch

import pytest

from app.db.models import Bot, Client, Webhook, WebhookDelivery
from app.services import webhook_service

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")


@contextmanager
def _session_cm(session):
    yield session


def _due_delivery(db, *, attempt=1):
    client = Client(name="W", email=f"wh-{attempt}@test.example", api_key=f"key-wh-{attempt}")
    db.add(client)
    db.flush()
    bot = Bot(client_id=client.id, name="B", bot_key=f"bot-wh-{attempt}")
    db.add(bot)
    db.flush()
    hook = Webhook(bot_id=bot.id, url="https://customer.example/hook", secret="s3cret", events=["lead.created"])
    db.add(hook)
    db.flush()
    delivery = WebhookDelivery(
        webhook_id=hook.id,
        event_type="lead.created",
        payload={"k": "v"},
        status_code=500,
        attempt=attempt,
        next_retry_at=datetime.now(UTC) - timedelta(minutes=1),
        delivered_at=None,
    )
    db.add(delivery)
    db.commit()
    return delivery


def test_enqueue_failure_keeps_the_retry_marker(db, monkeypatch):
    delivery = _due_delivery(db)
    monkeypatch.setattr(webhook_service, "get_session", lambda: _session_cm(db))

    with patch.object(webhook_service, "queue_webhook_delivery", side_effect=RuntimeError("redis down")):
        queued = webhook_service.process_pending_retries()

    assert queued == 0
    db.refresh(delivery)
    # The marker survives, so the NEXT sweep re-claims this retry.
    assert delivery.next_retry_at is not None


def test_successful_enqueue_clears_the_marker(db, monkeypatch):
    delivery = _due_delivery(db, attempt=2)
    monkeypatch.setattr(webhook_service, "get_session", lambda: _session_cm(db))

    with patch.object(webhook_service, "queue_webhook_delivery") as queue:
        queued = webhook_service.process_pending_retries()

    assert queued == 1
    assert queue.call_count == 1
    db.refresh(delivery)
    assert delivery.next_retry_at is None


def test_final_exhaustion_logs_at_error(db, monkeypatch, caplog):
    # A webhook whose LAST attempt fails goes permanently dark for the event —
    # that must surface at ERROR (Sentry), not as one more silent attempt row.
    client = Client(name="WX", email="wh-x@test.example", api_key="key-wh-x")
    db.add(client)
    db.flush()
    bot = Bot(client_id=client.id, name="B", bot_key="bot-wh-x")
    db.add(bot)
    db.flush()
    hook = Webhook(bot_id=bot.id, url="https://customer.example/hook", secret="s3cret", events=["lead.created"])
    db.add(hook)
    db.commit()

    monkeypatch.setattr(webhook_service, "get_session", lambda: _session_cm(db))
    with (
        patch.object(webhook_service, "_is_safe_webhook_url", return_value=True),
        patch.object(webhook_service, "_open_pinned", side_effect=RuntimeError("connection refused")),
        caplog.at_level("ERROR", logger=webhook_service.logger.name),
    ):
        webhook_service._deliver_webhook(hook.id, "lead.created", {"k": "v"}, attempt=webhook_service._MAX_RETRIES)

    assert any("EXHAUSTED" in rec.message for rec in caplog.records)

