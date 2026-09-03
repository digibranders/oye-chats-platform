"""I8: the outbound webhook retry ladder must match the documented cadence.

``CLAUDE.md`` and the customer-facing docs promise five retries after the first
attempt at 30s / 2m / 10m / 1h / 4h. The code shipped four rungs and stopped an
hour in, so an endpoint down for a lunch break lost every event fired in it.
"""

import os
from contextlib import contextmanager
from datetime import UTC, datetime
from unittest.mock import patch

import pytest

from app.db.models import Bot, Client, Webhook, WebhookDelivery
from app.services import webhook_service

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")

_DOCUMENTED_LADDER = [30, 120, 600, 3600, 14400]


@contextmanager
def _session_cm(session):
    yield session


def test_ladder_matches_the_documented_cadence():
    assert webhook_service._RETRY_DELAYS == _DOCUMENTED_LADDER
    # One first attempt plus one per rung.
    assert len(_DOCUMENTED_LADDER) + 1 == webhook_service._MAX_RETRIES


def _hook(db) -> Webhook:
    client = Client(name="W", email="wh-ladder@test.example", api_key="key-wh-ladder")
    db.add(client)
    db.flush()
    bot = Bot(client_id=client.id, name="B", bot_key="bot-wh-ladder")
    db.add(bot)
    db.flush()
    hook = Webhook(bot_id=bot.id, url="https://customer.example/hook", secret="s3cret", events=["lead.created"])
    db.add(hook)
    db.commit()
    return hook


@pytest.mark.parametrize("attempt,expected_delay", list(enumerate(_DOCUMENTED_LADDER, start=1)))
def test_each_failed_attempt_schedules_its_rung(db, monkeypatch, attempt, expected_delay):
    hook = _hook(db)
    monkeypatch.setattr(webhook_service, "get_session", lambda: _session_cm(db))

    before = datetime.now(UTC)
    with (
        patch.object(webhook_service, "_is_safe_webhook_url", return_value=True),
        patch.object(webhook_service, "_open_pinned", return_value=(500, "nope")),
    ):
        webhook_service._deliver_webhook(hook.id, "lead.created", {"k": "v"}, attempt=attempt)

    row = db.query(WebhookDelivery).filter_by(webhook_id=hook.id, attempt=attempt).one()
    assert row.next_retry_at is not None, f"attempt {attempt} must schedule the {expected_delay}s rung"
    scheduled = (row.next_retry_at - before).total_seconds()
    assert expected_delay <= scheduled <= expected_delay + 60


def test_the_attempt_after_the_last_rung_is_terminal(db, monkeypatch):
    hook = _hook(db)
    monkeypatch.setattr(webhook_service, "get_session", lambda: _session_cm(db))

    with (
        patch.object(webhook_service, "_is_safe_webhook_url", return_value=True),
        patch.object(webhook_service, "_open_pinned", return_value=(500, "nope")),
    ):
        webhook_service._deliver_webhook(hook.id, "lead.created", {"k": "v"}, attempt=len(_DOCUMENTED_LADDER) + 1)

    row = db.query(WebhookDelivery).filter_by(webhook_id=hook.id).one()
    assert row.next_retry_at is None
