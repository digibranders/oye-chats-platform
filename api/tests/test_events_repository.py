"""DB-backed tests for the events repository functions.

Requires a reachable Postgres at ``DB_URL`` (throwaway ``*_pytest`` DB is
created by the ``pg_engine`` fixture). Skipped cleanly when none is set.
Matches the pattern used by the credit-notes / affiliate tests so CI can
run selectively.

Locks in the two Tier 2 invariants that are hardest to catch by inspection:

  * ``upsert_events`` is idempotent. Re-writing the same page never
    duplicates rows on ``(bot_id, source_url, title)``.
  * ``prune_stale_events`` drops rows whose source page stopped listing
    them or whose start date has aged past the retention window.
"""

from __future__ import annotations

import os
from datetime import datetime, timedelta

import pytest

from app.db import repository
from app.db.models import Bot, Client, Event

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")


def _client(db) -> Client:
    row = Client(name="ACME", email="acme@example.com", api_key="k-acme")
    db.add(row)
    db.flush()
    return row


def _bot(db, client: Client, suffix: str = "") -> Bot:
    # Bot key must be globally unique; callers that create multiple bots
    # under the same client pass a distinct ``suffix``.
    key = f"bot-{client.id}{('-' + suffix) if suffix else ''}"
    row = Bot(client_id=client.id, bot_key=key)
    db.add(row)
    db.flush()
    return row


def _sample_events(now: datetime) -> list[dict]:
    return [
        {
            "title": "AI in Retail Webinar",
            "starts_at": now + timedelta(days=30),
            "ends_at": None,
            "url": "https://acme.com/webinars/ai",
            "location": "Online",
        },
        {
            "title": "Product Launch",
            "starts_at": now + timedelta(days=60),
            "ends_at": None,
            "url": None,
            "location": None,
        },
    ]


class TestUpsertEvents:
    def test_inserts_rows_on_first_write(self, db):
        client = _client(db)
        bot = _bot(db, client)
        now = datetime.utcnow()

        written = repository.upsert_events(
            db,
            bot_id=bot.id,
            source_url="https://acme.com/events",
            events=_sample_events(now),
        )
        db.commit()

        assert written == 2
        rows = db.query(Event).filter(Event.bot_id == bot.id).all()
        assert len(rows) == 2

    def test_re_upsert_updates_last_seen_at_no_duplicates(self, db):
        client = _client(db)
        bot = _bot(db, client)
        now = datetime.utcnow()

        repository.upsert_events(db, bot_id=bot.id, source_url="https://acme.com/events", events=_sample_events(now))
        db.commit()
        first_seen = db.query(Event).filter(Event.bot_id == bot.id).first().last_seen_at

        # Second crawl of the same page, same rows, new timestamps.
        repository.upsert_events(db, bot_id=bot.id, source_url="https://acme.com/events", events=_sample_events(now))
        db.commit()

        rows = db.query(Event).filter(Event.bot_id == bot.id).all()
        assert len(rows) == 2  # no duplicates
        assert all(r.last_seen_at >= first_seen for r in rows)

    def test_empty_inputs_are_no_ops(self, db):
        client = _client(db)
        bot = _bot(db, client)

        assert repository.upsert_events(db, bot_id=bot.id, source_url="", events=[{"title": "x"}]) == 0
        assert repository.upsert_events(db, bot_id=bot.id, source_url="https://acme.com/e", events=[]) == 0
        assert repository.upsert_events(db, bot_id=0, source_url="https://acme.com/e", events=[]) == 0

    def test_skips_rows_missing_title_or_starts_at(self, db):
        client = _client(db)
        bot = _bot(db, client)
        now = datetime.utcnow()

        written = repository.upsert_events(
            db,
            bot_id=bot.id,
            source_url="https://acme.com/events",
            events=[
                {"title": "", "starts_at": now + timedelta(days=1)},
                {"title": "Good One", "starts_at": None},
                {"title": "Real Event", "starts_at": now + timedelta(days=7)},
            ],
        )
        db.commit()

        assert written == 1
        titles = [r.title for r in db.query(Event).filter(Event.bot_id == bot.id).all()]
        assert titles == ["Real Event"]


class TestGetUpcomingEvents:
    def test_returns_future_events_only_soonest_first(self, db):
        client = _client(db)
        bot = _bot(db, client)
        now = datetime.utcnow()

        repository.upsert_events(
            db,
            bot_id=bot.id,
            source_url="https://acme.com/events",
            events=[
                {"title": "Past Event", "starts_at": now - timedelta(days=1)},
                {"title": "Soon Event", "starts_at": now + timedelta(days=1)},
                {"title": "Later Event", "starts_at": now + timedelta(days=10)},
            ],
        )
        db.commit()

        rows = repository.get_upcoming_events(db, bot_id=bot.id, now=now)
        assert [r.title for r in rows] == ["Soon Event", "Later Event"]

    def test_respects_limit(self, db):
        client = _client(db)
        bot = _bot(db, client)
        now = datetime.utcnow()

        repository.upsert_events(
            db,
            bot_id=bot.id,
            source_url="https://acme.com/events",
            events=[{"title": f"Event {i}", "starts_at": now + timedelta(days=i + 1)} for i in range(5)],
        )
        db.commit()

        rows = repository.get_upcoming_events(db, bot_id=bot.id, limit=2, now=now)
        assert len(rows) == 2

    def test_scopes_to_bot(self, db):
        client = _client(db)
        bot_a = _bot(db, client, suffix="a")
        bot_b = _bot(db, client, suffix="b")
        now = datetime.utcnow()

        repository.upsert_events(
            db,
            bot_id=bot_a.id,
            source_url="https://acme.com/events",
            events=[{"title": "A Event", "starts_at": now + timedelta(days=1)}],
        )
        repository.upsert_events(
            db,
            bot_id=bot_b.id,
            source_url="https://acme.com/events",
            events=[{"title": "B Event", "starts_at": now + timedelta(days=1)}],
        )
        db.commit()

        titles = [r.title for r in repository.get_upcoming_events(db, bot_id=bot_a.id, now=now)]
        assert titles == ["A Event"]


class TestPruneStaleEvents:
    def test_deletes_rows_with_stale_last_seen_at(self, db):
        client = _client(db)
        bot = _bot(db, client)
        now = datetime.utcnow()

        # Insert two events on the same page with very fresh timestamps.
        repository.upsert_events(
            db,
            bot_id=bot.id,
            source_url="https://acme.com/events",
            events=[
                {"title": "Stale", "starts_at": now + timedelta(days=30)},
                {"title": "Fresh", "starts_at": now + timedelta(days=30)},
            ],
        )
        db.commit()

        # Manually age one row's ``last_seen_at`` past the retention cutoff.
        stale = db.query(Event).filter_by(title="Stale").one()
        stale.last_seen_at = now - timedelta(days=200)
        db.commit()

        deleted = repository.prune_stale_events(db, retention_days=180)
        db.commit()

        titles = {r.title for r in db.query(Event).filter(Event.bot_id == bot.id).all()}
        assert deleted == 1
        assert titles == {"Fresh"}

    def test_deletes_rows_with_far_past_starts_at(self, db):
        client = _client(db)
        bot = _bot(db, client)
        now = datetime.utcnow()

        # Seed with a very-past event by inserting directly (upsert would
        # accept it too, the horizon is enforced in the extractor, not
        # here).
        db.add(
            Event(
                bot_id=bot.id,
                title="Ancient",
                starts_at=now - timedelta(days=400),
                source_url="https://acme.com/events",
            )
        )
        db.commit()

        deleted = repository.prune_stale_events(db, retention_days=180)
        db.commit()

        assert deleted == 1
        assert db.query(Event).filter(Event.bot_id == bot.id).count() == 0

    def test_no_op_on_retention_days_zero(self, db):
        client = _client(db)
        bot = _bot(db, client)
        now = datetime.utcnow()
        db.add(
            Event(
                bot_id=bot.id,
                title="Anything",
                starts_at=now - timedelta(days=1000),
                source_url="https://acme.com/events",
            )
        )
        db.commit()

        assert repository.prune_stale_events(db, retention_days=0) == 0
        assert db.query(Event).count() == 1
