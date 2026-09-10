"""The team email for an urgent incident, sent by the worker.

The chat pipeline enqueues this once per conversation when a visitor reports an
active incident; the provider call is blocking, so it never runs inside the turn.
"""

import pytest

from app.db.models import LeadInfo
from app.services import email_service
from app.worker.tasks import URGENT_INCIDENT_EMAIL_REASON, task_send_urgent_incident_email
from tests.test_rag_pipeline_defects import _make_bot, _make_client, _make_session


@pytest.fixture()
def sent(monkeypatch):
    calls: list[dict] = []

    def fake_send(recipient, bot_name, reason, contact=None, *, reply_to=None):
        calls.append({"to": recipient, "bot": bot_name, "reason": reason, "contact": contact, "reply_to": reply_to})

    monkeypatch.setattr(email_service, "send_handoff_request_email", fake_send)
    return calls


def _bot_with_session(db, session_id, **bot_kwargs):
    client = _make_client(db)
    bot = _make_bot(db, client, **bot_kwargs)
    _make_session(db, bot, client, session_id)
    return bot


@pytest.mark.asyncio
async def test_emails_the_handoff_request_list_with_the_visitor_contact(db, sent):
    bot = _bot_with_session(
        db,
        "urgent-mail-1",
        notification_emails={"handoff_request": ["soc@acme.test"], "default": ["owner@acme.test"]},
        reply_to_email="help@acme.test",
    )
    db.add(LeadInfo(session_id="urgent-mail-1", bot_id=bot.id, name="Eva", email="eva@x.test", phone="+100"))
    db.commit()

    assert await task_send_urgent_incident_email({}, bot.id, "urgent-mail-1") is True

    assert sent == [
        {
            "to": "soc@acme.test",
            "bot": bot.name,
            "reason": URGENT_INCIDENT_EMAIL_REASON,
            "contact": {"name": "Eva", "email": "eva@x.test", "phone": "+100"},
            "reply_to": "help@acme.test",
        }
    ]
    assert URGENT_INCIDENT_EMAIL_REASON.startswith("URGENT")


@pytest.mark.asyncio
async def test_falls_back_to_the_default_list_without_a_lead(db, sent):
    bot = _bot_with_session(db, "urgent-mail-2", notification_emails={"default": ["owner@acme.test"]})

    assert await task_send_urgent_incident_email({}, bot.id, "urgent-mail-2") is True

    assert [c["to"] for c in sent] == ["owner@acme.test"]
    assert sent[0]["contact"] is None


@pytest.mark.asyncio
async def test_an_owner_who_turned_off_handoff_email_gets_none(db, sent):
    bot = _bot_with_session(
        db, "urgent-mail-3", notification_emails={"default": ["owner@acme.test"]}, email_on_handoff=False
    )

    assert await task_send_urgent_incident_email({}, bot.id, "urgent-mail-3") is False
    assert sent == []


@pytest.mark.asyncio
async def test_a_missing_bot_sends_nothing(db, sent):
    assert await task_send_urgent_incident_email({}, 987654321, "urgent-mail-4") is False
    assert sent == []


@pytest.mark.asyncio
async def test_one_failing_recipient_does_not_stop_the_next(db, monkeypatch):
    bot = _bot_with_session(
        db, "urgent-mail-5", notification_emails={"handoff_request": ["broken@acme.test", "soc@acme.test"]}
    )
    delivered: list[str] = []

    def flaky_send(recipient, bot_name, reason, contact=None, *, reply_to=None):
        if recipient == "broken@acme.test":
            raise RuntimeError("provider rejected the address")
        delivered.append(recipient)

    monkeypatch.setattr(email_service, "send_handoff_request_email", flaky_send)

    assert await task_send_urgent_incident_email({}, bot.id, "urgent-mail-5") is True
    assert delivered == ["soc@acme.test"]
