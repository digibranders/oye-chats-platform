"""The team alert for an urgent incident: inbox notification, email and push.

Sent from the chat turn once per conversation when a visitor reports an active
incident. The email goes out inline because ``send_handoff_request_email`` only
builds the message and hands it to ``send_email_async``, which queues it (or
submits it to the email thread pool) without waiting on the provider.
"""

import pytest
from sqlalchemy import text

from app.db.models import LeadInfo
from app.services import rag_service as rs
from tests.test_rag_pipeline_defects import _make_bot, _make_client, _make_session

MESSAGE = "we are under a ransomware attack right now, please help!"
PUSH_TASK = "task_dispatch_handoff_push"
PUSH_REASON = "URGENT: active incident reported in chat"


@pytest.fixture()
def outbox(monkeypatch):
    sent: dict[str, list] = {"notify": [], "emails": [], "enqueue": []}
    monkeypatch.setattr(rs, "notify_handoff_request", lambda session, **kwargs: sent["notify"].append(kwargs))

    def fake_send(recipient, bot_name, reason, contact=None, *, reply_to=None, urgent=False, session_id=None):
        sent["emails"].append(
            {
                "to": recipient,
                "bot": bot_name,
                "reason": reason,
                "contact": contact,
                "reply_to": reply_to,
                "urgent": urgent,
                "session_id": session_id,
            }
        )

    monkeypatch.setattr(rs, "send_handoff_request_email", fake_send)
    monkeypatch.setattr(rs, "enqueue_sync", lambda task, *args, **_kwargs: sent["enqueue"].append((task, args)))
    return sent


def _bot_with_session(db, session_id, **bot_kwargs):
    client = _make_client(db)
    bot = _make_bot(db, client, **bot_kwargs)
    _make_session(db, bot, client, session_id)
    return client, bot


def test_emails_the_handoff_request_list_with_the_visitor_contact(db, outbox):
    client, bot = _bot_with_session(
        db,
        "urgent-mail-1",
        notification_emails={"handoff_request": ["soc@acme.test"], "default": ["owner@acme.test"]},
        reply_to_email="help@acme.test",
    )
    db.add(LeadInfo(session_id="urgent-mail-1", bot_id=bot.id, name="Eva", email="eva@x.test", phone="+100"))
    db.commit()

    rs._alert_team_of_urgent_incident(db, bot, client.id, "urgent-mail-1", MESSAGE)

    assert outbox["emails"] == [
        {
            "to": "soc@acme.test",
            "bot": bot.name,
            "reason": MESSAGE,
            "contact": {"name": "Eva", "email": "eva@x.test", "phone": "+100"},
            "reply_to": "help@acme.test",
            "urgent": True,
            "session_id": "urgent-mail-1",
        }
    ]
    assert len(outbox["notify"]) == 1
    notification = outbox["notify"][0]
    assert notification["urgent"] is True
    assert notification["visitor_name"] == "Eva"
    assert notification["session_id"] == "urgent-mail-1"
    assert notification["client_id"] == client.id
    assert outbox["enqueue"] == [(PUSH_TASK, ("urgent-mail-1", bot.id, None, "Eva", PUSH_REASON, 20))]


def test_falls_back_to_the_default_list_without_a_lead(db, outbox):
    client, bot = _bot_with_session(db, "urgent-mail-2", notification_emails={"default": ["owner@acme.test"]})

    rs._alert_team_of_urgent_incident(db, bot, client.id, "urgent-mail-2", MESSAGE)

    assert [email["to"] for email in outbox["emails"]] == ["owner@acme.test"]
    assert outbox["emails"][0]["contact"] is None
    assert outbox["notify"][0]["visitor_name"] is None
    assert outbox["enqueue"] == [(PUSH_TASK, ("urgent-mail-2", bot.id, None, None, PUSH_REASON, 20))]


def test_an_owner_who_turned_off_handoff_email_still_gets_the_inbox_alert_and_push(db, outbox):
    client, bot = _bot_with_session(
        db,
        "urgent-mail-3",
        notification_emails={"default": ["owner@acme.test"]},
        email_on_handoff=False,
    )

    rs._alert_team_of_urgent_incident(db, bot, client.id, "urgent-mail-3", MESSAGE)

    assert outbox["emails"] == []
    assert len(outbox["notify"]) == 1
    assert [task for task, _args in outbox["enqueue"]] == [PUSH_TASK]


def test_one_failing_recipient_does_not_stop_the_next(db, outbox, monkeypatch):
    client, bot = _bot_with_session(
        db, "urgent-mail-4", notification_emails={"handoff_request": ["broken@acme.test", "soc@acme.test"]}
    )
    delivered: list[str] = []

    def flaky_send(recipient, *_args, **_kwargs):
        if recipient == "broken@acme.test":
            raise RuntimeError("provider rejected the address")
        delivered.append(recipient)

    monkeypatch.setattr(rs, "send_handoff_request_email", flaky_send)

    rs._alert_team_of_urgent_incident(db, bot, client.id, "urgent-mail-4", MESSAGE)

    assert delivered == ["soc@acme.test"]


def test_the_visitor_message_is_trimmed_for_the_email(db, outbox):
    client, bot = _bot_with_session(db, "urgent-mail-5", notification_emails={"default": ["owner@acme.test"]})
    long_message = "our servers have been hacked " + "x" * 800

    rs._alert_team_of_urgent_incident(db, bot, client.id, "urgent-mail-5", long_message)

    assert outbox["emails"][0]["reason"] == long_message[:500]


def test_a_queue_failure_does_not_break_the_turn(db, outbox, monkeypatch):
    client, bot = _bot_with_session(db, "urgent-mail-6", notification_emails={"default": ["owner@acme.test"]})

    def broken_enqueue(*_args, **_kwargs):
        raise RuntimeError("REDIS_URL required for task queue")

    monkeypatch.setattr(rs, "enqueue_sync", broken_enqueue)

    rs._alert_team_of_urgent_incident(db, bot, client.id, "urgent-mail-6", MESSAGE)

    assert len(outbox["notify"]) == 1
    assert len(outbox["emails"]) == 1


def test_a_failed_notification_is_rolled_back_and_the_email_and_push_still_go(db, outbox, monkeypatch):
    client, bot = _bot_with_session(db, "urgent-mail-7", notification_emails={"default": ["owner@acme.test"]})

    def failing_notification(session, **_kwargs):
        session.execute(text("SELECT 1 / 0"))

    monkeypatch.setattr(rs, "notify_handoff_request", failing_notification)

    rs._alert_team_of_urgent_incident(db, bot, client.id, "urgent-mail-7", MESSAGE)

    assert db.execute(text("SELECT 1")).scalar() == 1, "the session must be usable after the failed notification"
    assert len(outbox["emails"]) == 1
    assert [task for task, _args in outbox["enqueue"]] == [PUSH_TASK]
