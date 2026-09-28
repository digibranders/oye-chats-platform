"""Contact details a visitor types after the urgent reply asked for them.

On 2026-09-28 an urgent alert reached the team with the name "Eva" and no email,
and the owner asked how the team could reach her. The urgent reply now asks for a
phone number or email in the chat. On the next two visitor turns, and only while
the lead has neither, a message that holds the visitor's own contact is saved to
the lead the way the form saves it, acknowledged in one sentence (above the normal
reply when the message also asks something), and sent to the team on the alert's
own recipients. Numbers that are not phone numbers, someone else's details and a
new incident report are never captured, and nothing replaces a value on the lead.
"""

import pytest

from app.db.models import ChatSession, LeadInfo
from app.db.repository import get_lead_info_by_session
from app.services import rag_service as rs
from app.services import urgent_followup, urgent_route
from tests.test_rag_pipeline_defects import (
    _answer_text,
    _doc,
    _drive_stream,
    _final_meta,
    _make_bot,
    _make_client,
    _make_session,
    _messages,
    _stub_pipeline,
)

URGENT = "we are under a ransomware attack right now, please help!"
TEAM_EMAILS = {"handoff_request": ["soc@acme.test"], "default": ["owner@acme.test"]}
FOLLOW_UP_TASK = "task_urgent_no_contact_follow_up"
ASK = "What's the best phone number or email to reach you on right now?"


@pytest.fixture(autouse=True)
def classifier(monkeypatch):
    """No model call: every message past the vocabulary check is an incident, and none is a support request."""
    monkeypatch.setattr(urgent_route, "_classify_urgent_incident_raw", lambda _question: True)
    monkeypatch.setattr("app.services.support_route._classify_support_request_raw", lambda _question: False)


@pytest.fixture()
def team(monkeypatch):
    """Everything the team would receive, captured instead of sent."""
    sent: dict[str, list] = {"alert_emails": [], "alerts": [], "enqueue": [], "contact_emails": [], "updates": []}
    monkeypatch.setattr(rs, "notify_handoff_request", lambda *_a, **kwargs: sent["alerts"].append(kwargs))
    monkeypatch.setattr(
        rs,
        "send_handoff_request_email",
        lambda recipient, _bot_name, reason, contact=None, **kwargs: sent["alert_emails"].append(
            {"to": recipient, "contact": contact}
        ),
    )
    monkeypatch.setattr(rs, "enqueue_sync", lambda task, *args, **kwargs: sent["enqueue"].append((task, args, kwargs)))
    monkeypatch.setattr(
        urgent_followup,
        "send_urgent_contact_email",
        lambda recipient, bot_name, visitor_name, **kwargs: sent["contact_emails"].append(
            {"to": recipient, "bot": bot_name, "name": visitor_name, **kwargs}
        ),
    )
    monkeypatch.setattr(
        urgent_followup, "notify_urgent_follow_up", lambda _session, **kwargs: sent["updates"].append(kwargs)
    )
    return sent


def _urgent_bot(db, monkeypatch, session_id, *, name="Eva", **bot_kwargs):
    client = _make_client(db)
    bot = _make_bot(
        db,
        client,
        live_chat_enabled=True,
        notification_emails=TEAM_EMAILS,
        reply_to_email="help@acme.test",
        **bot_kwargs,
    )
    _make_session(db, bot, client, session_id)
    if name:
        db.add(LeadInfo(session_id=session_id, bot_id=bot.id, name=name))
        db.commit()
    cap = _stub_pipeline(monkeypatch, retrieved=(_doc("Acme runs incident response."),), support=True)
    monkeypatch.setattr(rs, "_live_team_reachable", lambda *_a, **_k: False)
    return client, bot, cap


def _lead(db, session_id):
    db.expire_all()
    return get_lead_info_by_session(db, session_id)


@pytest.mark.asyncio
async def test_an_email_after_the_urgent_reply_is_saved_acknowledged_and_sent_to_the_team(db, monkeypatch, team):
    client, bot, cap = _urgent_bot(db, monkeypatch, "contact-1")

    first = await _drive_stream(bot, URGENT, "contact-1")
    assert ASK in _answer_text(first)
    assert team["alerts"][0]["no_contact"] is True
    assert [task for task, _args, _kwargs in team["enqueue"]] == ["task_dispatch_handoff_push", FOLLOW_UP_TASK]

    frames = await _drive_stream(bot, "eva.rao@acme.test", "contact-1")

    answer = _answer_text(frames)
    assert answer == "Thanks, the team will reach you on eva.rao@acme.test."
    meta = _final_meta(frames)
    assert meta["suggest_handoff"] is False
    assert _messages(db, "contact-1", role="bot")[-1].content == answer
    assert _lead(db, "contact-1").email == "eva.rao@acme.test"
    assert team["contact_emails"] == [
        {
            "to": "soc@acme.test",
            "bot": bot.name,
            "name": "Eva",
            "email": "eva.rao@acme.test",
            "phone": None,
            "reply_to": "help@acme.test",
            "session_id": "contact-1",
        }
    ]
    assert team["updates"] == [
        {
            "client_id": client.id,
            "session_id": "contact-1",
            "title": "Contact details for Eva: eva.rao@acme.test",
            "body": f"Shared in the chat after the incident report on {bot.name}.",
            "kind": "contact",
        }
    ]
    assert cap["prompts"] == [], "neither turn is a model call"
    assert len(team["alerts"]) == 1, "the urgent alert is not sent again"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("message", "phone"),
    [
        ("+91 98765 43210", "+91 98765 43210"),
        ("call me on 9876543210 please", "9876543210"),
        ("my cell is +1 (415) 555-0100", "+1 (415) 555-0100"),
        ("+44 20 7946 0958", "+44 20 7946 0958"),
    ],
)
async def test_a_phone_number_in_indian_or_international_format_is_captured(db, monkeypatch, team, message, phone):
    _client, bot, _cap = _urgent_bot(db, monkeypatch, "contact-phone")
    await _drive_stream(bot, URGENT, "contact-phone")

    frames = await _drive_stream(bot, message, "contact-phone")

    assert _answer_text(frames) == f"Thanks, the team will reach you on {phone}."
    lead = _lead(db, "contact-phone")
    assert (lead.phone, lead.email, lead.name) == (phone, None, "Eva")
    assert [(email["email"], email["phone"]) for email in team["contact_emails"]] == [(None, phone)]
    assert team["updates"][0]["title"] == f"Contact details for Eva: {phone}"


@pytest.mark.asyncio
async def test_an_email_and_a_phone_in_one_message_go_out_together(db, monkeypatch, team):
    _client, bot, _cap = _urgent_bot(db, monkeypatch, "contact-both")
    await _drive_stream(bot, URGENT, "contact-both")

    frames = await _drive_stream(bot, "eva@acme.test or +91 98765 43210, whichever is faster", "contact-both")

    assert _answer_text(frames) == "Thanks, the team will reach you on eva@acme.test or +91 98765 43210."
    lead = _lead(db, "contact-both")
    assert (lead.email, lead.phone) == ("eva@acme.test", "+91 98765 43210")
    assert [(email["email"], email["phone"]) for email in team["contact_emails"]] == [
        ("eva@acme.test", "+91 98765 43210")
    ]
    assert team["updates"][0]["title"] == "Contact details for Eva: eva@acme.test, +91 98765 43210"


@pytest.mark.asyncio
async def test_once_the_lead_has_a_contact_later_messages_go_through_the_normal_pipeline(db, monkeypatch, team):
    """Capture ends at the first contact: a later number or email is never read as one, nor overwrites it."""
    _client, bot, cap = _urgent_bot(db, monkeypatch, "contact-once")
    await _drive_stream(bot, URGENT, "contact-once")

    await _drive_stream(bot, "+91 98765 43210", "contact-once")
    later = await _drive_stream(bot, "or email eva@acme.test", "contact-once")

    assert "Thanks, the team will reach you" not in _answer_text(later)
    assert len(cap["prompts"]) == 1, "the later message is answered by the normal pipeline"
    assert [(email["email"], email["phone"]) for email in team["contact_emails"]] == [(None, "+91 98765 43210")]
    lead = _lead(db, "contact-once")
    assert (lead.email, lead.phone) == (None, "+91 98765 43210")


@pytest.mark.asyncio
async def test_a_contact_from_the_form_after_the_ask_is_never_overwritten(db, monkeypatch, team):
    _client, bot, _cap = _urgent_bot(db, monkeypatch, "contact-form")
    await _drive_stream(bot, URGENT, "contact-form")
    db.query(LeadInfo).filter(LeadInfo.session_id == "contact-form").update({"email": "form@acme.test"})
    db.commit()

    frames = await _drive_stream(bot, "+91 98765 43210", "contact-form")

    assert "Thanks, the team will reach you" not in _answer_text(frames)
    lead = _lead(db, "contact-form")
    assert (lead.email, lead.phone) == ("form@acme.test", None)
    assert team["contact_emails"] == [] and team["updates"] == []


@pytest.mark.asyncio
async def test_the_second_visitor_turn_after_the_ask_is_still_read(db, monkeypatch, team):
    _client, bot, _cap = _urgent_bot(db, monkeypatch, "contact-second")
    await _drive_stream(bot, URGENT, "contact-second")
    await _drive_stream(bot, "what should we do first?", "contact-second")

    frames = await _drive_stream(bot, "+91 98765 43210", "contact-second")

    assert _answer_text(frames) == "Thanks, the team will reach you on +91 98765 43210."
    assert _lead(db, "contact-second").phone == "+91 98765 43210"


@pytest.mark.asyncio
async def test_a_number_three_visitor_turns_after_the_ask_is_not_read(db, monkeypatch, team):
    _client, bot, _cap = _urgent_bot(db, monkeypatch, "contact-late")
    await _drive_stream(bot, URGENT, "contact-late")
    await _drive_stream(bot, "what should we do first?", "contact-late")
    await _drive_stream(bot, "and after that?", "contact-late")

    frames = await _drive_stream(bot, "+91 98765 43210", "contact-late")

    assert "Thanks, the team will reach you" not in _answer_text(frames)
    assert _lead(db, "contact-late").phone is None
    assert team["contact_emails"] == [] and team["updates"] == []


@pytest.mark.asyncio
async def test_the_ask_is_recorded_on_the_urgent_reply_that_made_it(db, monkeypatch, team):
    _client, bot, _cap = _urgent_bot(db, monkeypatch, "contact-mark")

    await _drive_stream(bot, URGENT, "contact-mark")

    db.expire_all()
    shown = db.get(ChatSession, "contact-mark").inline_cards_shown
    assert shown[urgent_followup.CONTACT_ASKED_KEY] == _messages(db, "contact-mark", role="bot")[-1].id


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "message",
    [
        "ticket #9876543210",
        "invoice 2024001234",
        "1727500000",
        "version 10.0.19045.3693",
        "account 123456789012",
    ],
)
async def test_a_number_that_is_not_a_phone_number_is_not_captured(db, monkeypatch, team, message):
    _client, bot, _cap = _urgent_bot(db, monkeypatch, "contact-not")
    await _drive_stream(bot, URGENT, "contact-not")

    frames = await _drive_stream(bot, message, "contact-not")

    assert "Thanks, the team will reach you" not in _answer_text(frames)
    assert _lead(db, "contact-not").phone is None
    assert team["contact_emails"] == [] and team["updates"] == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "message",
    [
        # Someone else's contact details.
        "the attacker called us from +44 7700 900123",
        "they emailed us from support@paypa1-secure.com",
        # A new incident report, not an answer to the ask.
        "+91 98765 43210, ransomware is still encrypting our servers",
    ],
)
async def test_an_attackers_contact_or_a_new_incident_report_is_not_captured(db, monkeypatch, team, message):
    _client, bot, _cap = _urgent_bot(db, monkeypatch, "contact-other")
    await _drive_stream(bot, URGENT, "contact-other")

    frames = await _drive_stream(bot, message, "contact-other")

    assert "Thanks, the team will reach you" not in _answer_text(frames)
    lead = _lead(db, "contact-other")
    assert (lead.email, lead.phone) == (None, None)
    assert team["contact_emails"] == [] and team["updates"] == []


@pytest.mark.asyncio
async def test_a_contact_with_a_question_is_acknowledged_and_the_question_answered(db, monkeypatch, team):
    _client, bot, cap = _urgent_bot(db, monkeypatch, "contact-and-question")
    await _drive_stream(bot, URGENT, "contact-and-question")

    frames = await _drive_stream(bot, "+91 98765 43210. what should we do first?", "contact-and-question")

    answer = _answer_text(frames)
    assert answer.startswith("Thanks, the team will reach you on +91 98765 43210.\n\n")
    assert answer.endswith("Our hours are 9 to 5.")
    assert len(cap["prompts"]) == 1, "the question reaches the normal pipeline"
    assert _messages(db, "contact-and-question", role="bot")[-1].content == answer
    assert _lead(db, "contact-and-question").phone == "+91 98765 43210"
    assert [(email["email"], email["phone"]) for email in team["contact_emails"]] == [(None, "+91 98765 43210")]


@pytest.mark.asyncio
async def test_a_message_without_contact_details_goes_on_as_usual(db, monkeypatch, team):
    _client, bot, _cap = _urgent_bot(db, monkeypatch, "contact-none")
    await _drive_stream(bot, URGENT, "contact-none")

    frames = await _drive_stream(bot, "what should we do first?", "contact-none")

    assert "Thanks, the team will reach you" not in _answer_text(frames)
    assert team["contact_emails"] == [] and team["updates"] == []
    lead = _lead(db, "contact-none")
    assert (lead.email, lead.phone) == (None, None)


@pytest.mark.asyncio
async def test_contact_details_in_a_conversation_without_an_urgent_alert_are_left_alone(db, monkeypatch, team):
    """Normal lead capture is the form's job, not this route's."""
    _client, bot, _cap = _urgent_bot(db, monkeypatch, "contact-plain")

    frames = await _drive_stream(bot, "my email is eva@acme.test, what are your hours?", "contact-plain")

    assert "Thanks, the team will reach you" not in _answer_text(frames)
    assert _lead(db, "contact-plain").email is None
    assert team["contact_emails"] == [] and team["updates"] == [] and team["alerts"] == []


@pytest.mark.asyncio
async def test_a_visitor_whose_lead_has_an_email_is_not_asked_and_gets_no_follow_up_job(db, monkeypatch, team):
    _client, bot, _cap = _urgent_bot(db, monkeypatch, "contact-known")
    db.query(LeadInfo).filter(LeadInfo.session_id == "contact-known").update({"email": "eva@acme.test"})
    db.commit()

    frames = await _drive_stream(bot, URGENT, "contact-known")

    assert "phone number" not in _answer_text(frames)
    assert team["alerts"][0]["no_contact"] is False
    assert [task for task, _args, _kwargs in team["enqueue"]] == ["task_dispatch_handoff_push"]


@pytest.mark.asyncio
async def test_the_follow_up_job_is_delayed_and_keyed_to_the_conversation(db, monkeypatch, team):
    _client, bot, _cap = _urgent_bot(db, monkeypatch, "contact-job", name=None)

    await _drive_stream(bot, URGENT, "contact-job")

    (job,) = [entry for entry in team["enqueue"] if entry[0] == FOLLOW_UP_TASK]
    _task, args, kwargs = job
    assert args[:2] == ("contact-job", bot.id)
    assert isinstance(args[2], float)
    assert kwargs["_defer_by"].total_seconds() == urgent_followup.NO_CONTACT_FOLLOW_UP_DELAY_SECONDS == 180
    assert kwargs["_job_id"] == "urgent-no-contact:contact-job"


@pytest.mark.asyncio
async def test_an_owner_preview_saves_and_acknowledges_but_pages_no_one(db, monkeypatch, team):
    _client, bot, _cap = _urgent_bot(db, monkeypatch, "contact-preview")
    bot._is_preview = True

    await _drive_stream(bot, URGENT, "contact-preview")
    frames = await _drive_stream(bot, "+91 98765 43210", "contact-preview")

    assert _answer_text(frames) == "Thanks, the team will reach you on +91 98765 43210."
    assert _lead(db, "contact-preview").phone == "+91 98765 43210"
    assert team["alerts"] == [] and team["enqueue"] == []
    assert team["contact_emails"] == [] and team["updates"] == []


@pytest.mark.asyncio
async def test_an_unnamed_visitor_is_named_a_visitor(db, monkeypatch, team):
    _client, bot, _cap = _urgent_bot(db, monkeypatch, "contact-anon", name=None)
    await _drive_stream(bot, URGENT, "contact-anon")

    await _drive_stream(bot, "+91 98765 43210", "contact-anon")

    assert team["contact_emails"][0]["name"] is None
    assert team["updates"][0]["title"] == "Contact details for a visitor: +91 98765 43210"
    shown = db.get(ChatSession, "contact-anon").inline_cards_shown
    assert shown[urgent_followup.CONTACTS_SENT_KEY] == ["phone:+919876543210"]


@pytest.mark.asyncio
async def test_a_contact_with_a_support_request_leads_the_support_reply(db, monkeypatch, team):
    _client, bot, cap = _urgent_bot(db, monkeypatch, "contact-support")
    await _drive_stream(bot, URGENT, "contact-support")
    monkeypatch.setattr("app.services.support_route._classify_support_request_raw", lambda _question: True)

    frames = await _drive_stream(
        bot, "9876543210. also our client portal is not loading since morning", "contact-support"
    )

    answer = _answer_text(frames)
    assert answer.startswith("Thanks, the team will reach you on 9876543210.\n\n")
    assert "Our team already knows about this." in answer, "the support route follows the acknowledgement"
    assert cap["prompts"] == []
    assert _messages(db, "contact-support", role="bot")[-1].content == answer
    assert _lead(db, "contact-support").phone == "9876543210"


# ── When the presence heartbeat is written ───────────────────────────────────


def _awaits(db, session_id):
    db.expire_all()
    return urgent_followup.awaits_follow_up(db.get(ChatSession, session_id))


@pytest.mark.asyncio
async def test_an_alert_that_enqueued_the_follow_up_records_when_it_is_due(db, monkeypatch, team):
    _client, bot, _cap = _urgent_bot(db, monkeypatch, "beat-due")

    await _drive_stream(bot, URGENT, "beat-due")

    (job,) = [entry for entry in team["enqueue"] if entry[0] == FOLLOW_UP_TASK]
    alerted_at = job[1][2]
    shown = db.get(ChatSession, "beat-due").inline_cards_shown
    assert shown[urgent_followup.FOLLOW_UP_DUE_KEY] == alerted_at + urgent_followup.NO_CONTACT_FOLLOW_UP_DELAY_SECONDS
    assert _awaits(db, "beat-due") is True


@pytest.mark.asyncio
async def test_no_heartbeat_when_the_alert_already_had_a_contact(db, monkeypatch, team):
    _client, bot, _cap = _urgent_bot(db, monkeypatch, "beat-known")
    db.query(LeadInfo).filter(LeadInfo.session_id == "beat-known").update({"phone": "+91 98765 43210"})
    db.commit()

    await _drive_stream(bot, URGENT, "beat-known")

    assert _awaits(db, "beat-known") is False


@pytest.mark.asyncio
async def test_no_heartbeat_when_the_follow_up_could_not_be_enqueued(db, monkeypatch, team):
    _client, bot, _cap = _urgent_bot(db, monkeypatch, "beat-enqueue")

    def enqueue(task, *args, **kwargs):
        if task == FOLLOW_UP_TASK:
            raise ConnectionError("queue unavailable")
        team["enqueue"].append((task, args, kwargs))

    monkeypatch.setattr(rs, "enqueue_sync", enqueue)

    frames = await _drive_stream(bot, URGENT, "beat-enqueue")

    assert ASK in _answer_text(frames)
    assert _awaits(db, "beat-enqueue") is False


@pytest.mark.asyncio
async def test_no_heartbeat_for_an_owner_preview(db, monkeypatch, team):
    _client, bot, _cap = _urgent_bot(db, monkeypatch, "beat-preview")
    bot._is_preview = True

    await _drive_stream(bot, URGENT, "beat-preview")

    assert _awaits(db, "beat-preview") is False


@pytest.mark.asyncio
async def test_a_captured_contact_stops_the_heartbeat(db, monkeypatch, team):
    _client, bot, _cap = _urgent_bot(db, monkeypatch, "beat-captured")
    await _drive_stream(bot, URGENT, "beat-captured")
    assert _awaits(db, "beat-captured") is True

    await _drive_stream(bot, "+91 98765 43210", "beat-captured")

    assert _awaits(db, "beat-captured") is False
