"""The team alert for a support request: inbox notification, email and push.

Sent from the chat turn once per conversation when an existing customer reports
a problem with the service or needs account help. The routine handoff email says
the visitor is "waiting in the queue right now", which is not true of someone who
has only been shown the form, so the email has its own support variant.
"""

from unittest.mock import patch

import pytest
from sqlalchemy import text

from app.config import APP_URL
from app.db.models import LeadInfo
from app.services import email_service, support_route
from tests.test_rag_pipeline_defects import _make_bot, _make_client, _make_session

MESSAGE = "im already a customer, our portal is not loading since morning"
PUSH_TASK = "task_dispatch_handoff_push"
PUSH_REASON = "Existing customer needs help in chat"


@pytest.fixture()
def outbox(monkeypatch):
    sent: dict[str, list] = {"notify": [], "emails": [], "enqueue": []}
    monkeypatch.setattr(
        support_route, "notify_handoff_request", lambda session, **kwargs: sent["notify"].append(kwargs)
    )

    def fake_send(recipient, bot_name, reason, contact=None, *, reply_to=None, support=False, session_id=None):
        sent["emails"].append(
            {
                "to": recipient,
                "bot": bot_name,
                "reason": reason,
                "contact": contact,
                "reply_to": reply_to,
                "support": support,
                "session_id": session_id,
            }
        )

    monkeypatch.setattr(support_route, "send_handoff_request_email", fake_send)
    monkeypatch.setattr(
        support_route, "enqueue_sync", lambda task, *args, **_kwargs: sent["enqueue"].append((task, args))
    )
    return sent


def _bot_with_session(db, session_id, **bot_kwargs):
    client = _make_client(db)
    bot = _make_bot(db, client, **bot_kwargs)
    _make_session(db, bot, client, session_id)
    return client, bot


def test_emails_the_handoff_request_list_with_the_visitor_contact(db, outbox):
    client, bot = _bot_with_session(
        db,
        "support-mail-1",
        notification_emails={"handoff_request": ["cs@acme.test"], "default": ["owner@acme.test"]},
        reply_to_email="help@acme.test",
    )
    db.add(LeadInfo(session_id="support-mail-1", bot_id=bot.id, name="Eva", email="eva@x.test", phone="+100"))
    db.commit()

    support_route.alert_team_of_support_request(db, bot, client.id, "support-mail-1", MESSAGE)

    assert outbox["emails"] == [
        {
            "to": "cs@acme.test",
            "bot": bot.name,
            "reason": MESSAGE,
            "contact": {"name": "Eva", "email": "eva@x.test", "phone": "+100"},
            "reply_to": "help@acme.test",
            "support": True,
            "session_id": "support-mail-1",
        }
    ]
    assert outbox["notify"] == [
        {
            "client_id": client.id,
            "session_id": "support-mail-1",
            "visitor_name": "Eva",
            "bot_name": bot.name,
        }
    ]
    assert outbox["enqueue"] == [(PUSH_TASK, ("support-mail-1", bot.id, None, "Eva", PUSH_REASON, 60))]


def test_falls_back_to_the_default_list_without_a_lead(db, outbox):
    client, bot = _bot_with_session(db, "support-mail-2", notification_emails={"default": ["owner@acme.test"]})

    support_route.alert_team_of_support_request(db, bot, client.id, "support-mail-2", MESSAGE)

    assert [email["to"] for email in outbox["emails"]] == ["owner@acme.test"]
    assert outbox["emails"][0]["contact"] is None
    assert outbox["notify"][0]["visitor_name"] is None
    assert outbox["enqueue"] == [(PUSH_TASK, ("support-mail-2", bot.id, None, None, PUSH_REASON, 60))]


def test_the_bot_queue_timeout_is_passed_to_the_push(db, outbox):
    client, bot = _bot_with_session(db, "support-mail-timeout", notification_emails={"default": ["owner@acme.test"]})
    bot.live_chat_queue_timeout_seconds = 180
    db.commit()

    support_route.alert_team_of_support_request(db, bot, client.id, "support-mail-timeout", MESSAGE)

    assert outbox["enqueue"] == [(PUSH_TASK, ("support-mail-timeout", bot.id, None, None, PUSH_REASON, 180))]


def test_an_owner_who_turned_off_handoff_email_still_gets_the_inbox_alert_and_push(db, outbox):
    client, bot = _bot_with_session(
        db,
        "support-mail-3",
        notification_emails={"default": ["owner@acme.test"]},
        email_on_handoff=False,
    )

    support_route.alert_team_of_support_request(db, bot, client.id, "support-mail-3", MESSAGE)

    assert outbox["emails"] == []
    assert len(outbox["notify"]) == 1
    assert [task for task, _args in outbox["enqueue"]] == [PUSH_TASK]


def test_one_failing_recipient_does_not_stop_the_next(db, outbox, monkeypatch):
    client, bot = _bot_with_session(
        db, "support-mail-4", notification_emails={"handoff_request": ["broken@acme.test", "cs@acme.test"]}
    )
    delivered: list[str] = []

    def flaky_send(recipient, *_args, **_kwargs):
        if recipient == "broken@acme.test":
            raise RuntimeError("provider rejected the address")
        delivered.append(recipient)

    monkeypatch.setattr(support_route, "send_handoff_request_email", flaky_send)

    support_route.alert_team_of_support_request(db, bot, client.id, "support-mail-4", MESSAGE)

    assert delivered == ["cs@acme.test"]


def test_the_visitor_message_is_trimmed_for_the_email(db, outbox):
    client, bot = _bot_with_session(db, "support-mail-5", notification_emails={"default": ["owner@acme.test"]})
    long_message = "our portal is not loading " + "x" * 800

    support_route.alert_team_of_support_request(db, bot, client.id, "support-mail-5", long_message)

    assert outbox["emails"][0]["reason"] == long_message[:500]


def test_a_queue_failure_does_not_break_the_turn(db, outbox, monkeypatch):
    client, bot = _bot_with_session(db, "support-mail-6", notification_emails={"default": ["owner@acme.test"]})

    def broken_enqueue(*_args, **_kwargs):
        raise RuntimeError("REDIS_URL required for task queue")

    monkeypatch.setattr(support_route, "enqueue_sync", broken_enqueue)

    support_route.alert_team_of_support_request(db, bot, client.id, "support-mail-6", MESSAGE)

    assert len(outbox["notify"]) == 1
    assert len(outbox["emails"]) == 1


def test_a_failed_notification_is_rolled_back_and_the_email_and_push_still_go(db, outbox, monkeypatch):
    client, bot = _bot_with_session(db, "support-mail-7", notification_emails={"default": ["owner@acme.test"]})

    def failing_notification(session, **_kwargs):
        session.execute(text("SELECT 1 / 0"))

    monkeypatch.setattr(support_route, "notify_handoff_request", failing_notification)

    support_route.alert_team_of_support_request(db, bot, client.id, "support-mail-7", MESSAGE)

    assert db.execute(text("SELECT 1")).scalar() == 1, "the session must be usable after the failed notification"
    assert len(outbox["emails"]) == 1
    assert [task for task, _args in outbox["enqueue"]] == [PUSH_TASK]


# ── The support variant of the handoff email ─────────────────────────────────

CONTACT = {"name": "Eva", "email": "eva@x.test", "phone": "+1 415 555 0100"}


def _render(*args, **kwargs) -> tuple[str, str, dict]:
    with patch.object(email_service, "send_email_async") as send:
        email_service.send_handoff_request_email(*args, **kwargs)
    send.assert_called_once()
    (_to, subject, html_body), options = send.call_args
    return subject, html_body, options


def test_a_support_request_email_drops_the_queue_wording_and_links_to_the_conversation():
    subject, html_body, options = _render(
        "cs@acme.test",
        "Acme Bot",
        MESSAGE,
        CONTACT,
        reply_to="help@acme.test",
        support=True,
        session_id="support-1",
    )

    assert subject == "Support request: Eva needs help on Acme Bot"
    assert "Support request from Eva" in html_body
    assert "waiting in the queue" not in html_body
    assert "60 seconds" not in html_body
    assert "active incident" not in html_body
    assert ">Phone<" in html_body and "+1 415 555 0100" in html_body
    assert MESSAGE in html_body
    assert f'href="{APP_URL}/support?session=support-1"' in html_body
    assert options["reply_to"] == "help@acme.test"


def test_a_support_request_email_without_a_name_or_phone_names_a_visitor():
    subject, html_body, _ = _render(
        "cs@acme.test",
        "Acme Bot",
        MESSAGE,
        {"name": None, "email": "eva@x.test", "phone": None},
        support=True,
        session_id="support-2",
    )

    assert subject == "Support request: A visitor needs help on Acme Bot"
    assert ">Phone<" not in html_body


def test_a_support_request_email_escapes_the_message_and_the_session_id():
    _, html_body, _ = _render(
        "cs@acme.test", "Acme Bot", "<script>alert(1)</script>", None, support=True, session_id="a b&c"
    )

    assert "<script>" not in html_body
    assert "&lt;script&gt;" in html_body
    assert f'href="{APP_URL}/support?session=a%20b%26c"' in html_body


def test_urgent_wins_when_both_variants_are_asked_for():
    subject, _, _ = _render("cs@acme.test", "Acme Bot", MESSAGE, CONTACT, urgent=True, support=True, session_id="x")

    assert subject == "URGENT: Eva reported an active incident on Acme Bot"
