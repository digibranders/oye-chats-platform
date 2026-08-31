"""Windowing, timezone and tenant scoping for the analytics aggregates.

Every number on the Overview and Analytics pages comes out of
``app.db.repository``'s analytics block, and the window each one applies was
not the window the caller asked for:

* ``total_messages`` and ``success_rate`` were cut on the *session's* creation
  date, so a conversation opened before the window contributed none of the
  turns it took inside it, and one opened just inside it contributed every
  turn it would ever receive.
* ``success_rate`` had no window at all.
* ``get_message_activity`` took a ``days`` argument it never used.
* Day buckets were cut in the database's zone but read as local dates.
* Ratings and resolution had no window parameter to pass.

These are real-Postgres tests on purpose. The bugs live in SQL — in which
column a predicate lands and in which zone a timestamp is truncated — so a
mocked session would assert the shape of the code rather than the meaning of
the answer.
"""

from __future__ import annotations

import os
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.db.models import Bot, ChatMessage, ChatSession, Client
from app.db.repository import (
    get_dashboard_stats,
    get_message_activity,
    get_ratings_summary,
    get_resolution_summary,
    get_unanswered_questions,
)

pytestmark = pytest.mark.skipif(
    not os.getenv("DB_URL"),
    reason="analytics window tests need a reachable Postgres at DB_URL",
)

NOW = datetime.now(UTC)
IST = ZoneInfo("Asia/Kolkata")


# ── Fixture builders ─────────────────────────────────────────────────────────


@contextmanager
def _session_cm(session):
    yield session


def _make_client(db, *, email: str) -> Client:
    client = Client(name="c", email=email, api_key=email, hashed_password="h", is_verified=True)
    db.add(client)
    db.flush()
    return client


def _make_bot(db, client: Client, *, key: str, name: str = "Bot") -> Bot:
    bot = Bot(client_id=client.id, bot_key=key, name=name)
    db.add(bot)
    db.flush()
    return bot


def _session_row(db, bot: Bot, *, sid: str, created_at: datetime, **kwargs) -> ChatSession:
    row = ChatSession(id=sid, client_id=bot.client_id, bot_id=bot.id, created_at=created_at, **kwargs)
    db.add(row)
    db.flush()
    return row


def _message(
    db,
    chat_session: ChatSession,
    *,
    created_at: datetime,
    role: str = "bot",
    content: str = "hi",
    feedback: int | None = None,
    is_unanswered: bool = False,
) -> ChatMessage:
    msg = ChatMessage(
        session_id=chat_session.id,
        role=role,
        content=content,
        created_at=created_at,
        feedback=feedback,
        is_unanswered=is_unanswered,
    )
    db.add(msg)
    db.flush()
    return msg


def _api(client: Client) -> TestClient:
    from app.api import analytics_routes
    from app.api.auth import get_current_client_or_operator

    app = FastAPI()
    app.include_router(analytics_routes.router)
    app.dependency_overrides[get_current_client_or_operator] = lambda: {"client_id": client.id}
    return TestClient(app, raise_server_exceptions=False)


def _get(db, client: Client, url: str):
    from unittest.mock import patch

    from app.api import analytics_routes

    with patch.object(analytics_routes, "get_session", lambda: _session_cm(db)):
        return _api(client).get(url)


# ── Defect 1: messages are windowed by the message's own date ────────────────


def test_message_count_follows_the_message_date_not_the_session_date(db) -> None:
    """A returning visitor's turns land in the window they were typed in.

    The session was opened 40 days ago and is still alive; the visitor came
    back today and sent two more messages. A 30-day window contains no *new
    conversation* — but it certainly contains those two messages. Cutting on
    ``ChatSession.created_at`` reported zero.
    """
    client = _make_client(db, email="win-msg-date@e.com")
    bot = _make_bot(db, client, key="bot-win-msg-date")

    old = _session_row(db, bot, sid="s-old", created_at=NOW - timedelta(days=40))
    _message(db, old, created_at=NOW - timedelta(days=40))  # outside the window
    _message(db, old, created_at=NOW - timedelta(days=1))  # inside it
    _message(db, old, created_at=NOW - timedelta(hours=1))  # inside it
    db.commit()

    stats = get_dashboard_stats(db, client_id=client.id, bot_id=bot.id, days=30)

    assert stats["total_conversations"] == 0, "the conversation itself started before the window"
    assert stats["total_messages"] == 2, "but two of its messages were sent inside the window"


def test_message_count_excludes_later_turns_of_an_in_window_session(db) -> None:
    """The mirror case: a session opened inside the window does not drag in
    every message it ever receives."""
    client = _make_client(db, email="win-msg-date-2@e.com")
    bot = _make_bot(db, client, key="bot-win-msg-date-2")

    recent = _session_row(db, bot, sid="s-recent", created_at=NOW - timedelta(days=3))
    _message(db, recent, created_at=NOW - timedelta(days=3))
    _message(db, recent, created_at=NOW - timedelta(days=2))
    db.commit()

    assert get_dashboard_stats(db, client_id=client.id, bot_id=bot.id, days=1)["total_messages"] == 0
    assert get_dashboard_stats(db, client_id=client.id, bot_id=bot.id, days=30)["total_messages"] == 2


# ── Defect 2: success_rate honours the requested window ──────────────────────


def test_success_rate_respects_the_days_window(db) -> None:
    """``?days=7`` must not answer with an all-time helpfulness rate."""
    client = _make_client(db, email="win-success@e.com")
    bot = _make_bot(db, client, key="bot-win-success")

    chat = _session_row(db, bot, sid="s-fb", created_at=NOW - timedelta(days=60))
    # Two thumbs-up long ago, one thumbs-down yesterday.
    _message(db, chat, created_at=NOW - timedelta(days=60), feedback=1)
    _message(db, chat, created_at=NOW - timedelta(days=59), feedback=1)
    _message(db, chat, created_at=NOW - timedelta(days=1), feedback=0)
    db.commit()

    all_time = get_dashboard_stats(db, client_id=client.id, bot_id=bot.id)
    windowed = get_dashboard_stats(db, client_id=client.id, bot_id=bot.id, days=7)

    assert all_time["success_rate"] == 67, "2 of 3 rated answers were helpful, all time"
    assert windowed["success_rate"] == 0, "the only answer rated in the last 7 days was unhelpful"


# ── Defect 3: /analytics/activity honours days ───────────────────────────────


def test_message_activity_honours_the_days_argument(db) -> None:
    client = _make_client(db, email="win-activity@e.com")
    bot = _make_bot(db, client, key="bot-win-activity")

    chat = _session_row(db, bot, sid="s-act", created_at=NOW - timedelta(days=90))
    _message(db, chat, created_at=NOW - timedelta(days=45))
    _message(db, chat, created_at=NOW - timedelta(days=2))
    db.commit()

    unbounded = get_message_activity(db, client_id=client.id, bot_id=bot.id)
    assert sum(row["messages"] for row in unbounded) == 2

    windowed = get_message_activity(db, client_id=client.id, bot_id=bot.id, days=30)
    assert sum(row["messages"] for row in windowed) == 1
    assert all(isinstance(row["date"], str) for row in windowed)


def test_activity_route_passes_days_through(db) -> None:
    client = _make_client(db, email="win-activity-route@e.com")
    bot = _make_bot(db, client, key="bot-win-activity-route")

    chat = _session_row(db, bot, sid="s-act-route", created_at=NOW - timedelta(days=90))
    _message(db, chat, created_at=NOW - timedelta(days=45))
    _message(db, chat, created_at=NOW - timedelta(days=2))
    db.commit()

    res = _get(db, client, f"/analytics/activity?bot_id={bot.id}&days=30")
    assert res.status_code == 200, res.text
    assert sum(row["messages"] for row in res.json()) == 1

    # Shape is unchanged: a list of {"date", "messages"} rows.
    assert set(res.json()[0]) == {"date", "messages"}

    res_all = _get(db, client, f"/analytics/activity?bot_id={bot.id}")
    assert res_all.status_code == 200, res_all.text
    assert sum(row["messages"] for row in res_all.json()) == 2


# ── Defect 4: day buckets are cut in the caller's timezone ───────────────────


def test_day_buckets_are_cut_in_the_requested_timezone(db) -> None:
    """00:30 IST on 1 August is August traffic, not July traffic.

    ``2026-07-31T20:30Z`` is ``2026-08-01T02:00+05:30``. Truncated in UTC it
    files under July; an Indian customer looking at their August total would
    never see it.
    """
    client = _make_client(db, email="win-tz@e.com")
    bot = _make_bot(db, client, key="bot-win-tz")

    chat = _session_row(db, bot, sid="s-tz", created_at=datetime(2026, 7, 30, 12, 0, tzinfo=UTC))
    _message(db, chat, created_at=datetime(2026, 7, 31, 20, 30, tzinfo=UTC))
    db.commit()

    utc_rows = get_message_activity(db, client_id=client.id, bot_id=bot.id)
    assert [row["date"] for row in utc_rows] == ["2026-07-31"]

    ist_rows = get_message_activity(db, client_id=client.id, bot_id=bot.id, tz="Asia/Kolkata")
    assert [row["date"] for row in ist_rows] == ["2026-08-01"]


def test_activity_route_accepts_a_timezone(db) -> None:
    client = _make_client(db, email="win-tz-route@e.com")
    bot = _make_bot(db, client, key="bot-win-tz-route")

    chat = _session_row(db, bot, sid="s-tz-route", created_at=datetime(2026, 7, 30, 12, 0, tzinfo=UTC))
    _message(db, chat, created_at=datetime(2026, 7, 31, 20, 30, tzinfo=UTC))
    db.commit()

    res = _get(db, client, f"/analytics/activity?bot_id={bot.id}&tz=Asia/Kolkata")
    assert res.status_code == 200, res.text
    assert [row["date"] for row in res.json()] == ["2026-08-01"]

    bad = _get(db, client, f"/analytics/activity?bot_id={bot.id}&tz=Mars/Olympus_Mons")
    assert bad.status_code == 422, bad.text


def test_days_window_is_cut_on_whole_local_days(db) -> None:
    """``days=1`` means today in ``tz``, not the trailing 24 hours."""
    client = _make_client(db, email="win-tz-days@e.com")
    bot = _make_bot(db, client, key="bot-win-tz-days")

    now_ist = datetime.now(IST)
    start_of_today_ist = now_ist.replace(hour=0, minute=0, second=0, microsecond=0)
    chat = _session_row(db, bot, sid="s-tz-days", created_at=now_ist - timedelta(days=5))
    # One minute before local midnight — yesterday, however recent it is.
    _message(db, chat, created_at=start_of_today_ist - timedelta(minutes=1))
    # One minute after local midnight — today.
    _message(db, chat, created_at=start_of_today_ist + timedelta(minutes=1))
    db.commit()

    rows = get_message_activity(db, client_id=client.id, bot_id=bot.id, days=1, tz="Asia/Kolkata")
    assert sum(row["messages"] for row in rows) == 1
    assert [row["date"] for row in rows] == [start_of_today_ist.date().isoformat()]


# ── Defect 5: ratings and resolution take a window ───────────────────────────


def test_ratings_summary_takes_a_window(db) -> None:
    client = _make_client(db, email="win-ratings@e.com")
    bot = _make_bot(db, client, key="bot-win-ratings")

    _session_row(db, bot, sid="s-rate-old", created_at=NOW - timedelta(days=60), visitor_rating=5)
    _session_row(db, bot, sid="s-rate-new", created_at=NOW - timedelta(days=1), visitor_rating=1)
    db.commit()

    all_time = get_ratings_summary(db, client_id=client.id, bot_id=bot.id)
    assert all_time["total"] == 2
    assert all_time["avg"] == 3.0

    windowed = get_ratings_summary(db, client_id=client.id, bot_id=bot.id, days=30)
    assert windowed["total"] == 1
    assert windowed["avg"] == 1.0
    assert windowed["distribution"] == {1: 1, 2: 0, 3: 0, 4: 0, 5: 0}


def test_resolution_summary_takes_a_window(db) -> None:
    client = _make_client(db, email="win-resolution@e.com")
    bot = _make_bot(db, client, key="bot-win-resolution")

    _session_row(db, bot, sid="s-res-old", created_at=NOW - timedelta(days=60), visitor_resolved=True)
    _session_row(db, bot, sid="s-res-new", created_at=NOW - timedelta(days=1), visitor_resolved=False)
    db.commit()

    all_time = get_resolution_summary(db, client_id=client.id, bot_id=bot.id)
    assert (all_time["resolved"], all_time["unresolved"], all_time["rate"]) == (1, 1, 50.0)

    windowed = get_resolution_summary(db, client_id=client.id, bot_id=bot.id, days=30)
    assert (windowed["resolved"], windowed["unresolved"], windowed["rate"]) == (0, 1, 0.0)


def test_rating_and_resolution_routes_accept_days(db) -> None:
    client = _make_client(db, email="win-postchat-route@e.com")
    bot = _make_bot(db, client, key="bot-win-postchat-route")

    _session_row(db, bot, sid="s-pc-old", created_at=NOW - timedelta(days=60), visitor_rating=5, visitor_resolved=True)
    _session_row(db, bot, sid="s-pc-new", created_at=NOW - timedelta(days=1), visitor_rating=1, visitor_resolved=False)
    db.commit()

    ratings = _get(db, client, f"/analytics/ratings-summary?bot_id={bot.id}&days=30")
    assert ratings.status_code == 200, ratings.text
    assert ratings.json()["total"] == 1

    resolution = _get(db, client, f"/analytics/resolution-summary?bot_id={bot.id}&days=30")
    assert resolution.status_code == 200, resolution.text
    assert resolution.json()["total"] == 1

    # Omitting ``days`` keeps the all-time behaviour the dashboard relies on.
    assert _get(db, client, f"/analytics/ratings-summary?bot_id={bot.id}").json()["total"] == 2


# ── Defect 9: knowledge gaps are tenant-scoped in the SQL itself ─────────────


def _unanswered_pair(db, bot: Bot, *, sid: str, question: str) -> None:
    chat = _session_row(db, bot, sid=sid, created_at=NOW - timedelta(days=1))
    _message(db, chat, created_at=NOW - timedelta(days=1), role="user", content=question)
    _message(db, chat, created_at=NOW - timedelta(days=1), role="bot", content="no idea", is_unanswered=True)


def test_unanswered_questions_scope_to_the_owner_even_with_a_foreign_bot_id(db) -> None:
    """The SQL must be safe on its own, not only behind the route's check.

    ``get_unanswered_questions`` dropped ``client_id`` from the predicate the
    moment a ``bot_id`` was supplied, so any caller that forgot the ownership
    check handed one tenant another tenant's visitor questions verbatim.
    """
    mine = _make_client(db, email="gap-mine@e.com")
    theirs = _make_client(db, email="gap-theirs@e.com")
    my_bot = _make_bot(db, mine, key="bot-gap-mine")
    their_bot = _make_bot(db, theirs, key="bot-gap-theirs")

    _unanswered_pair(db, my_bot, sid="s-gap-mine", question="do you ship to India?")
    _unanswered_pair(db, their_bot, sid="s-gap-theirs", question="what is your enterprise discount?")
    db.commit()

    mine_rows = get_unanswered_questions(db, client_id=mine.id, bot_id=my_bot.id)
    assert [row["question"] for row in mine_rows] == ["do you ship to India?"]

    # The load-bearing assertion: my credentials plus THEIR bot id yields nothing.
    leaked = get_unanswered_questions(db, client_id=mine.id, bot_id=their_bot.id)
    assert leaked == [], "bot B's knowledge gaps must never resolve for bot A's owner"

    # And the client-wide call still sees only my own bots.
    assert [row["question"] for row in get_unanswered_questions(db, client_id=mine.id)] == ["do you ship to India?"]
