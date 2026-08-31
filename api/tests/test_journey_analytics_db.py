"""Real-Postgres coverage for the Journeys aggregates' *SQL*.

``test_journey_analytics.py`` patches ``_fetch_journeys`` in every aggregation
test, which is right for the Python-side counting but leaves the two database
reads in this module — the journey SELECT and the lead count in
``summary_counts`` — completely unexercised: the ``bot_id`` predicate, the
inclusive ``(since, until)`` bounds and the NULL-journey skip are all asserted
nowhere. These tests hit a real database instead, so a change to either query
has to keep answering the same numbers.
"""

from __future__ import annotations

import os
from datetime import UTC, datetime, timedelta

import pytest

from app.db.models import Bot, ChatSession, Client, LeadInfo
from app.services import journey_analytics_service as jas

pytestmark = pytest.mark.skipif(
    not os.getenv("DB_URL"),
    reason="journey SQL tests need a reachable Postgres at DB_URL",
)

NOW = datetime.now(UTC)
SINCE = NOW - timedelta(days=30)
UNTIL = NOW + timedelta(minutes=1)


def _make_client(db, *, email: str) -> Client:
    client = Client(name="c", email=email, api_key=email, hashed_password="h", is_verified=True)
    db.add(client)
    db.flush()
    return client


def _make_bot(db, client: Client, *, key: str) -> Bot:
    bot = Bot(client_id=client.id, bot_key=key, name="Bot")
    db.add(bot)
    db.flush()
    return bot


def _journey_session(db, bot: Bot, *, sid: str, journey, created_at: datetime) -> ChatSession:
    row = ChatSession(
        id=sid,
        client_id=bot.client_id,
        bot_id=bot.id,
        created_at=created_at,
        visitor_journey=journey,
    )
    db.add(row)
    db.flush()
    return row


def _lead(db, bot: Bot, *, sid: str, created_at: datetime) -> None:
    _journey_session(db, bot, sid=sid, journey=None, created_at=created_at)
    db.add(LeadInfo(session_id=sid, bot_id=bot.id, email=f"{sid}@lead.com", created_at=created_at))


def test_fetch_journeys_scopes_by_bot_and_window(db) -> None:
    client = _make_client(db, email="journey-scope@e.com")
    mine = _make_bot(db, client, key="bot-journey-mine")
    theirs = _make_bot(db, _make_client(db, email="journey-other@e.com"), key="bot-journey-theirs")

    _journey_session(db, mine, sid="j-in", journey=[{"path": "/a", "phase": "pre"}], created_at=NOW - timedelta(days=1))
    _journey_session(
        db, mine, sid="j-old", journey=[{"path": "/old", "phase": "pre"}], created_at=NOW - timedelta(days=90)
    )
    _journey_session(
        db, mine, sid="j-future", journey=[{"path": "/f", "phase": "pre"}], created_at=NOW + timedelta(days=2)
    )
    # A session with no journey at all must not surface as an empty row.
    _journey_session(db, mine, sid="j-null", journey=None, created_at=NOW - timedelta(days=1))
    _journey_session(
        db, theirs, sid="j-theirs", journey=[{"path": "/x", "phase": "pre"}], created_at=NOW - timedelta(days=1)
    )
    db.commit()

    journeys = jas._fetch_journeys(db, mine.id, SINCE, UNTIL)
    assert journeys == [[{"path": "/a", "phase": "pre"}]]

    # Inclusive bounds: a session sitting exactly on ``since`` is inside.
    edge_at = NOW - timedelta(days=10)
    _journey_session(db, mine, sid="j-edge", journey=[{"path": "/edge", "phase": "pre"}], created_at=edge_at)
    db.commit()
    assert jas._fetch_journeys(db, mine.id, edge_at, edge_at) == [[{"path": "/edge", "phase": "pre"}]]


def test_summary_counts_leads_are_scoped_and_windowed(db) -> None:
    """The lead figure is a SQL count over this bot's window, nothing wider."""
    client = _make_client(db, email="journey-leads@e.com")
    mine = _make_bot(db, client, key="bot-journey-leads")
    theirs = _make_bot(db, _make_client(db, email="journey-leads-other@e.com"), key="bot-journey-leads-other")

    _journey_session(
        db,
        mine,
        sid="j-conv",
        journey=[
            {"path": "/pricing", "phase": "pre"},
            {"event": "meeting_booked", "phase": "chat"},
            {"path": "/thanks", "phase": "post"},
        ],
        created_at=NOW - timedelta(days=1),
    )
    _lead(db, mine, sid="j-lead-in", created_at=NOW - timedelta(days=2))
    _lead(db, mine, sid="j-lead-old", created_at=NOW - timedelta(days=90))
    _lead(db, theirs, sid="j-lead-theirs", created_at=NOW - timedelta(days=2))
    db.commit()

    counts = jas.summary_counts(db, bot_id=mine.id, since=SINCE, until=UNTIL)

    assert counts["leads_captured"] == 1
    assert counts["sessions_with_journey"] == 1
    assert counts["meeting_booked"] == 1
    assert counts["handoff_requested"] == 0
    assert counts["sessions_no_activity"] == 0
    assert counts["sessions_browsed_no_conversion"] == 0
    # Every key the dashboard reads is still present and integral.
    assert all(isinstance(value, int) for value in counts.values())
