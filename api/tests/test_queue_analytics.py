"""Queue depth and wait time, built on the signal that is actually
maintained (ChatSession.status == 'waiting' + ChatAuditLog), not on
LiveChatQueueEntry, which nothing populates (see test_live_chat_cas_and_queue.py,
finding F33)."""

from datetime import UTC, datetime, timedelta

import pytest

pytestmark = pytest.mark.skipif(
    __import__("os").getenv("DB_URL") is None, reason="needs a reachable Postgres at DB_URL"
)


def test_current_depth_counts_only_fresh_waiting_sessions(db):
    from app.db.models import Bot, ChatAuditLog, ChatSession, Client
    from app.db.repository import get_queue_summary

    client = Client(name="Queue Co", email="queue@test.example", api_key="key-queue")
    db.add(client)
    db.flush()
    bot = Bot(client_id=client.id, name="B", bot_key="bot-queue")
    db.add(bot)
    db.flush()

    now = datetime.now(UTC)
    fresh = ChatSession(id="q-fresh", bot_id=bot.id, client_id=client.id, status="waiting", last_active_at=now)
    stale = ChatSession(
        id="q-stale",
        bot_id=bot.id,
        client_id=client.id,
        status="waiting",
        last_active_at=now - timedelta(hours=2),
    )
    db.add_all([fresh, stale])
    db.commit()

    summary = get_queue_summary(db, bot_id=bot.id, since=now - timedelta(days=7))

    assert summary["current_depth"] == 1


def test_average_wait_pairs_handoff_with_the_next_terminal_entry(db):
    from app.db.models import Bot, ChatAuditLog, ChatSession, Client
    from app.db.repository import get_queue_summary

    client = Client(name="Wait Co", email="wait@test.example", api_key="key-wait")
    db.add(client)
    db.flush()
    bot = Bot(client_id=client.id, name="B", bot_key="bot-wait")
    db.add(bot)
    db.flush()

    session = ChatSession(id="q-wait-1", bot_id=bot.id, client_id=client.id, status="closed")
    db.add(session)
    db.commit()

    t0 = datetime(2026, 8, 1, 10, 0, 0, tzinfo=UTC)
    db.add_all(
        [
            ChatAuditLog(session_id=session.id, action="handoff_requested", created_at=t0),
            ChatAuditLog(session_id=session.id, action="accepted", created_at=t0 + timedelta(seconds=90)),
        ]
    )
    db.commit()

    summary = get_queue_summary(db, bot_id=bot.id, since=t0 - timedelta(days=1))

    assert summary["avg_wait_seconds"] == 90
    assert summary["resolved_count"] == 1
    assert summary["abandoned_count"] == 0


def test_timeout_and_visitor_cancelled_count_as_abandoned(db):
    from app.db.models import Bot, ChatAuditLog, ChatSession, Client
    from app.db.repository import get_queue_summary

    client = Client(name="Abandon Co", email="abandon@test.example", api_key="key-abandon")
    db.add(client)
    db.flush()
    bot = Bot(client_id=client.id, name="B", bot_key="bot-abandon")
    db.add(bot)
    db.flush()

    s1 = ChatSession(id="q-abandon-1", bot_id=bot.id, client_id=client.id, status="closed")
    s2 = ChatSession(id="q-abandon-2", bot_id=bot.id, client_id=client.id, status="closed")
    db.add_all([s1, s2])
    db.commit()

    t0 = datetime(2026, 8, 1, 10, 0, 0, tzinfo=UTC)
    db.add_all(
        [
            ChatAuditLog(session_id=s1.id, action="handoff_requested", created_at=t0),
            ChatAuditLog(session_id=s1.id, action="timeout", created_at=t0 + timedelta(seconds=60)),
            ChatAuditLog(session_id=s2.id, action="handoff_requested", created_at=t0),
            ChatAuditLog(session_id=s2.id, action="visitor_cancelled", created_at=t0 + timedelta(seconds=30)),
        ]
    )
    db.commit()

    summary = get_queue_summary(db, bot_id=bot.id, since=t0 - timedelta(days=1))

    assert summary["abandoned_count"] == 2
    assert summary["resolved_count"] == 0
