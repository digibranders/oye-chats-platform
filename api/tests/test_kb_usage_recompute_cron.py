"""I6: ``clients.kb_characters_used`` must come back down after bulk deletes.

The counter is only maintained incrementally, on ingest and single-document
delete. Every path that removes documents through an ``ON DELETE CASCADE``
(bot deletion, the orphan sweep, the trial purge) leaves it untouched, so the
counter only ever grows and the workspace eventually gets a 402 on an almost
empty knowledge base. ``task_recompute_kb_usage`` is the daily backstop, and
the trial purge recounts inline so it does not have to wait a day.
"""

from __future__ import annotations

import asyncio
import os
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select

from app.db.models import Bot, Client, Document, Plan, Subscription
from app.worker import tasks

pytestmark = pytest.mark.skipif(
    os.getenv("DB_URL") is None,
    reason="kb-usage recompute tests need a reachable Postgres at DB_URL",
)

_EMBEDDING = [0.0] * 768


@contextmanager
def _session_cm(session):
    yield session


def _client(db, tag: str, *, kb_used: int) -> Client:
    client = Client(
        name=tag,
        email=f"{tag}@example.com",
        hashed_password="$2b$12$notarealhash",
        api_key=f"key-{tag}",
        kb_characters_used=kb_used,
    )
    db.add(client)
    db.commit()
    return client


def _bot_with_document(db, client: Client, *, chars: int) -> Bot:
    bot = Bot(client_id=client.id, bot_key=f"bot-{client.id}", name="B")
    db.add(bot)
    db.flush()
    # Two chunks of ONE source: the recompute must count the source once.
    for i in range(2):
        db.add(
            Document(
                client_id=client.id,
                bot_id=bot.id,
                document_name="handbook.pdf",
                source="upload",
                file_hash=f"hash-{client.id}-{i}",
                content=f"chunk {i}",
                source_char_count=chars,
                embedding=_EMBEDDING,
            )
        )
    db.commit()
    return bot


def _kb_used(db, client_id: int) -> int:
    return int(db.execute(select(Client.kb_characters_used).where(Client.id == client_id)).scalar_one())


def test_cron_corrects_a_counter_left_high_by_a_cascade_delete(db, monkeypatch):
    client = _client(db, "drifted", kb_used=500_000)
    _bot_with_document(db, client, chars=1_200)

    import app.db.session as db_session

    monkeypatch.setattr(db_session, "get_session", lambda: _session_cm(db))

    assert asyncio.run(tasks.task_recompute_kb_usage({})) == 1
    assert _kb_used(db, client.id) == 1_200


def test_cron_leaves_an_accurate_counter_alone(db, monkeypatch):
    client = _client(db, "accurate", kb_used=1_200)
    _bot_with_document(db, client, chars=1_200)

    import app.db.session as db_session

    monkeypatch.setattr(db_session, "get_session", lambda: _session_cm(db))

    assert asyncio.run(tasks.task_recompute_kb_usage({})) == 0
    assert _kb_used(db, client.id) == 1_200


def test_trial_purge_zeroes_the_counter_it_emptied(db, monkeypatch):
    client = _client(db, "purged", kb_used=9_000)
    _bot_with_document(db, client, chars=9_000)
    plan = Plan(name="Std", slug="std-purge", monthly_price_cents=399900, credits_per_month=1000)
    db.add(plan)
    db.flush()
    db.add(
        Subscription(
            client_id=client.id,
            plan_id=plan.id,
            status="trial_expired",
            data_retention_until=datetime.now(UTC) - timedelta(hours=1),
        )
    )
    db.commit()

    import app.db.session as db_session

    monkeypatch.setattr(db_session, "get_session", lambda: _session_cm(db))
    monkeypatch.setattr("app.services.email_service.send_trial_data_deleted_email", lambda *a, **k: True)

    assert asyncio.run(tasks.task_delete_expired_trial_data({})) == 1

    assert db.execute(select(Document.id).where(Document.client_id == client.id)).first() is None
    assert _kb_used(db, client.id) == 0, "a purged workspace must not keep a character balance"
