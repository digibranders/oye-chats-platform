"""The follow-up a few minutes after an urgent alert that had no way to reach the visitor.

On 2026-09-28 the owner got an urgent alert with the name "Eva" and no email, and
asked how the team could reach her. A panicked visitor may never share contact
details, so a worker job checks three minutes after the alert: with an email or a
phone by then it does nothing, otherwise it tells the team once, with whether the
visitor is still on the page.
"""

import os
import time
from datetime import UTC, datetime, timedelta

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.auth import get_current_bot
from app.db.models import ChatMessage, ChatSession, LeadInfo, Operator
from app.services import urgent_followup
from app.worker import tasks
from tests.test_rag_pipeline_defects import _make_bot, _make_client, _make_session

TEAM_EMAILS = {"handoff_request": ["soc@acme.test"], "default": ["owner@acme.test"]}
NOW = datetime(2026, 9, 28, 10, 0, tzinfo=UTC)
ALERTED_AT = (NOW - timedelta(minutes=3)).timestamp()
DUE_AT = ALERTED_AT + urgent_followup.NO_CONTACT_FOLLOW_UP_DELAY_SECONDS
#: The flags ``rag_service`` leaves on a session whose alert enqueued the follow-up.
SCHEDULED = {"urgent_notified": True, urgent_followup.FOLLOW_UP_DUE_KEY: DUE_AT}


class _Cache:
    def __init__(self) -> None:
        self.store: dict = {}

    def get(self, key):
        return self.store.get(key)

    def set(self, key, value, ttl):
        self.store[key] = value
        return True


@pytest.fixture()
def cache(monkeypatch):
    fake = _Cache()
    monkeypatch.setattr(urgent_followup, "cache_get", fake.get)
    monkeypatch.setattr(urgent_followup, "cache_set", fake.set)
    return fake


@pytest.fixture()
def team(monkeypatch):
    sent: dict[str, list] = {"emails": [], "updates": []}
    monkeypatch.setattr(
        urgent_followup,
        "send_urgent_no_contact_email",
        lambda recipient, bot_name, visitor_name, **kwargs: sent["emails"].append(
            {"to": recipient, "bot": bot_name, "name": visitor_name, **kwargs}
        ),
    )
    monkeypatch.setattr(
        urgent_followup, "notify_urgent_follow_up", lambda _session, **kwargs: sent["updates"].append(kwargs)
    )
    return sent


def _urgent_session(db, session_id, *, lead=None, status="bot", flags=None, last_message_at=None, **bot_kwargs):
    client = _make_client(db)
    bot = _make_bot(db, client, notification_emails=TEAM_EMAILS, reply_to_email="help@acme.test", **bot_kwargs)
    _make_session(
        db,
        bot,
        client,
        session_id,
        status=status,
        inline_cards_shown={**SCHEDULED, **(flags or {})},
        last_active_at=NOW - timedelta(minutes=10),
    )
    if lead is not None:
        db.add(LeadInfo(session_id=session_id, bot_id=bot.id, **lead))
    if last_message_at is not None:
        db.add(
            ChatMessage(
                session_id=session_id,
                role="user",
                content="we are under a ransomware attack right now",
                created_at=last_message_at,
            )
        )
    db.commit()
    return client, bot


def _run(session_id, bot):
    return urgent_followup.run_no_contact_follow_up(session_id, bot.id, ALERTED_AT, now=NOW.timestamp())


def _flags(db, session_id):
    db.expire_all()
    return db.get(ChatSession, session_id).inline_cards_shown


def test_no_contact_sends_one_email_and_update_with_the_visitor_on_the_page(db, cache, team):
    client, bot = _urgent_session(db, "follow-1", lead={"name": "Eva"})
    urgent_followup.record_presence("follow-1")
    cache.store["urgent_presence:follow-1"] = {"seen_at": NOW.timestamp() - 4}

    assert _run("follow-1", bot) is True

    presence = "Still on the page: their chat window checked in less than a minute ago."
    assert team["emails"] == [
        {
            "to": "soc@acme.test",
            "bot": bot.name,
            "name": "Eva",
            "presence": presence,
            "minutes_since_alert": 3,
            "reply_to": "help@acme.test",
            "session_id": "follow-1",
        }
    ]
    assert team["updates"] == [
        {
            "client_id": client.id,
            "session_id": "follow-1",
            "title": "Still no contact details for Eva",
            "body": presence,
            "kind": "no_contact",
        }
    ]
    assert _flags(db, "follow-1")[urgent_followup.NO_CONTACT_FOLLOW_UP_KEY] is True


def test_a_second_run_or_a_retry_sends_nothing_again(db, cache, team):
    _client, bot = _urgent_session(db, "follow-2", lead={"name": "Eva"})

    assert _run("follow-2", bot) is True
    assert _run("follow-2", bot) is False

    assert len(team["emails"]) == 1 and len(team["updates"]) == 1


@pytest.mark.parametrize("contact", [{"email": "eva@acme.test"}, {"phone": "+91 98765 43210"}])
def test_contact_details_that_arrived_cancel_the_follow_up(db, cache, team, contact):
    _client, bot = _urgent_session(db, "follow-3", lead={"name": "Eva", **contact})

    assert _run("follow-3", bot) is False

    assert team == {"emails": [], "updates": []}
    # Settled, so the widget's poll stops writing the heartbeat.
    assert _flags(db, "follow-3")[urgent_followup.NO_CONTACT_FOLLOW_UP_KEY] is True
    assert urgent_followup.awaits_follow_up(db.get(ChatSession, "follow-3"), now=NOW.timestamp()) is False


def test_a_chat_window_that_stopped_polling_closed(db, cache, team):
    """The widget polls only while the chat panel is open: a stale poll says the window closed, not the page."""
    _client, bot = _urgent_session(db, "follow-4", lead={"name": "Eva"})
    cache.store["urgent_presence:follow-4"] = {"seen_at": NOW.timestamp() - 150}

    _run("follow-4", bot)

    assert team["emails"][0]["presence"] == "Their chat window closed about 2 minutes ago."


@pytest.mark.parametrize(
    ("seconds", "presence"),
    [
        (4, "Still on the page: their chat window checked in less than a minute ago."),
        (45, "Their chat window closed less than a minute ago."),
        (70, "Their chat window closed about 1 minute ago."),
        (150, "Their chat window closed about 2 minutes ago."),
    ],
)
def test_the_presence_line(seconds, presence):
    now = NOW.timestamp()
    assert (
        urgent_followup.describe_presence(status="bot", seen_at=now - seconds, last_active_at=None, now=now) == presence
    )


def test_a_heartbeat_that_stopped_on_purpose_says_nothing_about_the_window():
    """A late job reads the last write before the poll stopped at ``heartbeat_until``: not a closed window."""
    now = NOW.timestamp()
    until = now - 300
    presence = urgent_followup.describe_presence(
        status="bot", seen_at=until - 3, last_active_at=None, now=now, heartbeat_until=until
    )
    assert presence == "Not known whether they are still on the page. Their chat window last checked in 5 minutes ago."


def test_a_failing_cache_read_falls_back_to_the_last_activity(db, team, monkeypatch):
    def broken(_key):
        raise RuntimeError("Redis is required in production but connection failed")

    monkeypatch.setattr(urgent_followup, "cache_get", broken)
    _client, bot = _urgent_session(
        db, "follow-cache", lead={"name": "Eva"}, last_message_at=NOW - timedelta(minutes=4, seconds=10)
    )

    assert _run("follow-cache", bot) is True
    assert team["updates"][0]["body"] == "Not known whether they are still on the page. Last active 4 minutes ago."


def test_without_a_presence_record_the_last_activity_is_reported(db, cache, team):
    _client, bot = _urgent_session(
        db, "follow-5", lead={"name": "Eva"}, last_message_at=NOW - timedelta(minutes=4, seconds=10)
    )

    _run("follow-5", bot)

    assert team["updates"][0]["body"] == "Not known whether they are still on the page. Last active 4 minutes ago."


def test_an_unnamed_visitor_in_the_queue(db, cache, team):
    _client, bot = _urgent_session(db, "follow-6", status="waiting")

    _run("follow-6", bot)

    assert team["updates"][0]["title"] == "Still no contact details for a visitor"
    assert team["emails"][0]["presence"] == "Waiting in the live chat queue now."
    assert team["emails"][0]["name"] is None


def test_an_operator_already_in_the_chat_needs_no_reminder(db, cache, team):
    _client, bot = _urgent_session(db, "follow-7", lead={"name": "Eva"}, status="live")

    assert _run("follow-7", bot) is False
    assert team == {"emails": [], "updates": []}
    assert _flags(db, "follow-7")[urgent_followup.NO_CONTACT_FOLLOW_UP_KEY] is True


def test_a_closed_conversation_needs_no_reminder(db, cache, team):
    _client, bot = _urgent_session(db, "follow-closed", lead={"name": "Eva"}, status="closed")

    assert _run("follow-closed", bot) is False
    assert team == {"emails": [], "updates": []}
    assert _flags(db, "follow-closed")[urgent_followup.NO_CONTACT_FOLLOW_UP_KEY] is True


def test_an_assigned_operator_needs_no_reminder(db, cache, team):
    client, bot = _urgent_session(db, "follow-assigned", lead={"name": "Eva"}, status="waiting")
    operator = Operator(client_id=client.id, bot_id=bot.id, name="Op", email="op@acme.test")
    db.add(operator)
    db.flush()
    db.get(ChatSession, "follow-assigned").assigned_operator_id = operator.id
    db.commit()

    assert _run("follow-assigned", bot) is False
    assert team == {"emails": [], "updates": []}
    assert _flags(db, "follow-assigned")[urgent_followup.NO_CONTACT_FOLLOW_UP_KEY] is True


def test_a_session_whose_alert_scheduled_no_job_is_not_followed_up(db, cache, team):
    """No due time means no job was enqueued: nothing to send and no heartbeat."""
    _client, bot = _urgent_session(db, "follow-unscheduled", lead={"name": "Eva"})
    chat_session = db.get(ChatSession, "follow-unscheduled")
    chat_session.inline_cards_shown = {"urgent_notified": True}
    db.commit()

    assert _run("follow-unscheduled", bot) is False
    assert team == {"emails": [], "updates": []}
    assert urgent_followup.awaits_follow_up(db.get(ChatSession, "follow-unscheduled"), now=NOW.timestamp()) is False


def test_a_session_the_team_was_never_alerted_about_is_skipped(db, cache, team):
    """An owner preview's urgent turn schedules no job; a stray one still finds nothing to do."""
    client = _make_client(db)
    bot = _make_bot(db, client, notification_emails=TEAM_EMAILS)
    _make_session(db, bot, client, "follow-8")

    assert urgent_followup.run_no_contact_follow_up("follow-8", bot.id, ALERTED_AT) is False
    assert urgent_followup.run_no_contact_follow_up("missing", bot.id, ALERTED_AT) is False
    assert team == {"emails": [], "updates": []}


def test_another_bots_session_is_not_followed_up(db, cache, team):
    _client, bot = _urgent_session(db, "follow-9", lead={"name": "Eva"})
    other = _make_bot(db, _make_client(db))

    assert urgent_followup.run_no_contact_follow_up("follow-9", other.id, ALERTED_AT) is False
    assert team == {"emails": [], "updates": []}


def test_an_owner_who_turned_off_handoff_email_still_gets_the_inbox_update(db, cache, team):
    _client, bot = _urgent_session(db, "follow-10", lead={"name": "Eva"}, email_on_handoff=False)

    assert _run("follow-10", bot) is True
    assert team["emails"] == [] and len(team["updates"]) == 1


def test_a_failing_email_does_not_undo_the_record(db, cache, team, monkeypatch):
    _client, bot = _urgent_session(db, "follow-11", lead={"name": "Eva"})

    def broken(*_args, **_kwargs):
        raise RuntimeError("provider rejected the address")

    monkeypatch.setattr(urgent_followup, "send_urgent_no_contact_email", broken)

    assert _run("follow-11", bot) is True
    assert _run("follow-11", bot) is False
    assert len(team["updates"]) == 1


@pytest.mark.asyncio
async def test_the_worker_task_runs_the_follow_up(db, cache, team):
    _client, bot = _urgent_session(db, "follow-12", lead={"name": "Eva"})

    assert await tasks.task_urgent_no_contact_follow_up({}, "follow-12", bot.id, ALERTED_AT) is True
    assert await tasks.task_urgent_no_contact_follow_up({}, "follow-12", bot.id, ALERTED_AT) is False
    assert len(team["emails"]) == 1


def test_the_worker_registers_the_task(monkeypatch):
    # The settings module parses REDIS_URL at import; parsing opens no connection.
    monkeypatch.setenv("REDIS_URL", os.getenv("REDIS_URL") or "redis://localhost:6379/0")
    from app.worker.settings import WorkerSettings

    names = {getattr(f, "name", getattr(f, "__name__", "")) for f in WorkerSettings.functions}
    assert urgent_followup.NO_CONTACT_FOLLOW_UP_TASK in names


# ── The presence heartbeat ────────────────────────────────────────────────────


def _poll(bot, session_id):
    from app.api.chat_routes import router

    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_current_bot] = lambda: bot
    return TestClient(app).get(f"/chat/connect-request/{session_id}")


def test_the_widget_poll_records_presence_while_the_follow_up_is_due(db, cache):
    _client, bot = _urgent_session(db, "beat-1", flags={urgent_followup.FOLLOW_UP_DUE_KEY: time.time() + 120})

    assert _poll(bot, "beat-1").json() == {"pending": False}

    assert urgent_followup.presence_seen_at("beat-1") is not None


def test_the_widget_poll_stops_recording_after_the_grace_past_the_due_time(db, cache):
    overdue = time.time() - urgent_followup.PRESENCE_GRACE_SECONDS - 5
    _client, bot = _urgent_session(db, "beat-late", flags={urgent_followup.FOLLOW_UP_DUE_KEY: overdue})

    assert _poll(bot, "beat-late").json() == {"pending": False}

    assert cache.store == {}


def test_a_failing_cache_never_turns_the_poll_into_an_error(db, monkeypatch):
    """``get_redis`` raises RuntimeError in production when it cannot connect."""

    def broken(*_args, **_kwargs):
        raise RuntimeError("Redis is required in production but connection failed")

    monkeypatch.setattr(urgent_followup, "cache_set", broken)
    _client, bot = _urgent_session(db, "beat-broken", flags={urgent_followup.FOLLOW_UP_DUE_KEY: time.time() + 120})

    response = _poll(bot, "beat-broken")

    assert response.status_code == 200
    assert response.json() == {"pending": False}


def test_the_widget_poll_records_nothing_for_other_sessions(db, cache):
    _client, bot = _urgent_session(db, "beat-2", flags={urgent_followup.NO_CONTACT_FOLLOW_UP_KEY: True})
    client = _make_client(db)
    plain_bot = _make_bot(db, client)
    _make_session(db, plain_bot, client, "beat-3")

    _poll(bot, "beat-2")
    _poll(plain_bot, "beat-3")

    assert cache.store == {}
