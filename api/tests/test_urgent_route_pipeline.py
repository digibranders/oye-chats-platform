"""The urgent reply is fixed wording, opens the form and alerts the team once per conversation."""

import pytest
from sqlalchemy import text

from app.db.models import ChatSession, LeadInfo
from app.db.repository import get_lead_info_by_session
from app.services import rag_service as rs
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
PUSH_TASK = "task_dispatch_handoff_push"
TEAM_EMAILS = {"default": ["soc@acme.test"]}


@pytest.fixture()
def alerts(monkeypatch):
    sent: dict[str, list] = {"notify": [], "emails": [], "enqueue": []}
    monkeypatch.setattr(rs, "notify_handoff_request", lambda *_a, **kwargs: sent["notify"].append(kwargs))
    monkeypatch.setattr(
        rs,
        "send_handoff_request_email",
        lambda recipient, _bot_name, reason, contact=None, **kwargs: sent["emails"].append(
            {"to": recipient, "reason": reason, "contact": contact, **kwargs}
        ),
    )
    monkeypatch.setattr(rs, "enqueue_sync", lambda task, *args, **_kwargs: sent["enqueue"].append((task, args)))
    return sent


def _push_jobs(alerts):
    return [args for task, args in alerts["enqueue"] if task == PUSH_TASK]


def _cards_shown(db, session_id):
    db.expire_all()
    return db.get(ChatSession, session_id).inline_cards_shown or {}


def _use_the_real_name_flow(monkeypatch, real):
    """``_stub_pipeline`` answers every name question with a returning "Tester".
    These tests need the first-message name question itself, so the real
    functions saved before stubbing are put back."""
    resolve_name_flow, resolve_visitor_name, should_ask_visitor_name = real
    monkeypatch.setattr(rs, "resolve_name_flow", resolve_name_flow)
    monkeypatch.setattr(rs, "resolve_visitor_name", resolve_visitor_name)
    monkeypatch.setattr(rs, "_should_ask_visitor_name", should_ask_visitor_name)


def _real_name_functions():
    return rs.resolve_name_flow, rs.resolve_visitor_name, rs._should_ask_visitor_name


@pytest.mark.asyncio
async def test_urgent_turn_is_fixed_wording_with_the_form_and_one_alert(db, monkeypatch, alerts):
    client = _make_client(db)
    bot = _make_bot(db, client, live_chat_enabled=True, notification_emails=TEAM_EMAILS)
    _make_session(db, bot, client, "urgent-1")
    db.add(LeadInfo(session_id="urgent-1", bot_id=bot.id, name="Eva", email="eva@x.test"))
    db.commit()
    cap = _stub_pipeline(monkeypatch, retrieved=(_doc("Acme runs incident response."),), support=True)
    # ``_team_online`` asks presence only on a live-chat bot inside hours (no
    # hours configured means always open), so this makes the team offline.
    monkeypatch.setattr(rs, "_live_team_reachable", lambda *_a, **_k: False)

    frames = await _drive_stream(bot, URGENT, "urgent-1")
    answer = _answer_text(frames)
    meta = _final_meta(frames)

    assert answer.startswith("This sounds urgent. Our team is offline right now"), answer
    assert "Eva" not in answer, "no cheerful by-name opener above an incident"
    assert meta["suggest_handoff"] is True
    assert meta["qualification_pending"] is False
    assert "show_leave_message" not in meta
    persisted = _messages(db, "urgent-1", role="bot")
    assert [m.id for m in persisted] == [meta["message_id"]]
    assert persisted[0].content == answer

    again = await _drive_stream(bot, "please hurry, we are still under attack right now", "urgent-1")
    again_answer = _answer_text(again)

    assert again_answer == (
        "I've already flagged this to **Acme** as a priority. The form is just below: "
        "share your details there so they can reach you as soon as possible."
    )
    assert _final_meta(again)["suggest_handoff"] is True
    assert cap["prompts"] == [], "the urgent reply is not a model call"
    assert len(alerts["notify"]) == 1
    assert alerts["notify"][0]["urgent"] is True
    assert alerts["notify"][0]["session_id"] == "urgent-1"
    assert alerts["notify"][0]["visitor_name"] == "Eva"
    assert alerts["emails"] == [
        {
            "to": "soc@acme.test",
            "reason": URGENT,
            "contact": {"name": "Eva", "email": "eva@x.test", "phone": None},
            "reply_to": None,
            "urgent": True,
            "session_id": "urgent-1",
        }
    ]
    assert _push_jobs(alerts) == [("urgent-1", bot.id, None, "Eva", "URGENT: active incident reported in chat", 20)]
    shown = _cards_shown(db, "urgent-1")
    assert shown.get("urgent_notified") is True
    assert shown.get("handoff_offered") is True


@pytest.mark.asyncio
async def test_a_reachable_team_is_offered_a_connection_right_away(db, monkeypatch, alerts):
    client = _make_client(db)
    bot = _make_bot(db, client, live_chat_enabled=True)
    _make_session(db, bot, client, "urgent-team")
    _stub_pipeline(monkeypatch, retrieved=(_doc("Acme runs incident response."),), support=True)
    monkeypatch.setattr(rs, "_live_team_reachable", lambda *_a, **_k: True)

    frames = await _drive_stream(bot, URGENT, "urgent-team")
    meta = _final_meta(frames)

    assert _answer_text(frames) == (
        "This sounds urgent, so I've flagged it to **Acme** as a priority. Share your details in the form "
        "below and I'll connect you with them right away."
    )
    assert meta["suggest_handoff"] is True
    assert "show_leave_message" not in meta

    again = await _drive_stream(bot, "our servers have been hacked, please hurry", "urgent-team")

    assert _answer_text(again) == (
        "I've already flagged this to **Acme** as a priority. The form is just below: "
        "share your details there and I'll connect you with them right away."
    )
    assert _final_meta(again)["suggest_handoff"] is True
    assert len(alerts["notify"]) == 1 and len(_push_jobs(alerts)) == 1


@pytest.mark.asyncio
async def test_a_bot_without_live_chat_opens_the_message_card(db, monkeypatch, alerts):
    client = _make_client(db)
    bot = _make_bot(db, client, live_chat_enabled=False)
    _make_session(db, bot, client, "urgent-3")
    _stub_pipeline(monkeypatch, retrieved=(_doc("Acme runs incident response."),), support=True)

    frames = await _drive_stream(bot, URGENT, "urgent-3")
    meta = _final_meta(frames)

    assert "I'll open a quick message form" in _answer_text(frames)
    assert meta["suggest_handoff"] is False
    assert meta["show_leave_message"] is True
    assert len(alerts["notify"]) == 1
    shown = _cards_shown(db, "urgent-3")
    assert shown.get("leave_message") is True
    assert not shown.get("handoff_offered")

    again = await _drive_stream(bot, URGENT, "urgent-3")

    assert _answer_text(again) == (
        "I've already flagged this to **Acme** as a priority. Leave your details in the message form "
        "so they can reach you as soon as possible."
    )
    assert _final_meta(again)["show_leave_message"] is True
    assert _final_meta(again)["suggest_handoff"] is False
    assert len(alerts["notify"]) == 1


@pytest.mark.asyncio
async def test_a_plan_without_a_human_sends_no_alert(db, monkeypatch, alerts):
    client = _make_client(db)
    bot = _make_bot(db, client, live_chat_enabled=True, notification_emails=TEAM_EMAILS)
    _make_session(db, bot, client, "urgent-2")
    _stub_pipeline(monkeypatch, retrieved=(_doc("Acme runs incident response."),), support=False)

    frames = await _drive_stream(bot, URGENT, "urgent-2")
    answer = _answer_text(frames)

    assert "This sounds urgent" in answer
    assert "flagged" not in answer
    assert not (_final_meta(frames) or {}).get("suggest_handoff")
    again = await _drive_stream(bot, URGENT, "urgent-2")
    assert _answer_text(again) == answer
    assert alerts["notify"] == [] and alerts["emails"] == [] and alerts["enqueue"] == []
    assert not _cards_shown(db, "urgent-2").get("urgent_notified")


@pytest.mark.asyncio
async def test_an_enqueue_failure_still_delivers_the_reply_and_the_email(db, monkeypatch, alerts):
    client = _make_client(db)
    bot = _make_bot(db, client, live_chat_enabled=True, notification_emails=TEAM_EMAILS)
    _make_session(db, bot, client, "urgent-4")
    _stub_pipeline(monkeypatch, retrieved=(_doc("Acme runs incident response."),), support=True)

    def _broken_enqueue(*_a, **_k):
        raise RuntimeError("REDIS_URL required for task queue")

    monkeypatch.setattr(rs, "enqueue_sync", _broken_enqueue)

    frames = await _drive_stream(bot, URGENT, "urgent-4")

    assert "This sounds urgent" in _answer_text(frames)
    assert _final_meta(frames)["suggest_handoff"] is True
    assert len(alerts["notify"]) == 1
    assert [email["to"] for email in alerts["emails"]] == ["soc@acme.test"]


@pytest.mark.asyncio
async def test_a_notification_that_breaks_the_transaction_still_delivers_the_reply(db, monkeypatch, alerts):
    """``create_notification`` writes on the request session. A database error
    there aborts the transaction, which must not take the saved reply with it."""
    client = _make_client(db)
    bot = _make_bot(db, client, live_chat_enabled=True, notification_emails=TEAM_EMAILS)
    _make_session(db, bot, client, "urgent-5")
    _stub_pipeline(monkeypatch, retrieved=(_doc("Acme runs incident response."),), support=True)

    def _failing_notification(session, **_kwargs):
        session.execute(text("SELECT 1 / 0"))

    monkeypatch.setattr(rs, "notify_handoff_request", _failing_notification)

    frames = await _drive_stream(bot, URGENT, "urgent-5")
    meta = _final_meta(frames)

    assert meta is not None and meta["suggest_handoff"] is True
    assert [m.id for m in _messages(db, "urgent-5", role="bot")] == [meta["message_id"]]
    assert len(alerts["emails"]) == 1
    assert len(_push_jobs(alerts)) == 1
    shown = _cards_shown(db, "urgent-5")
    assert shown.get("urgent_notified") is True and shown.get("handoff_offered") is True


@pytest.mark.asyncio
async def test_the_reply_and_the_alert_are_saved_before_the_first_frame(db, monkeypatch, alerts):
    """The reply text is fixed, so nothing waits on the stream. A visitor who
    closes the tab after the first frame still leaves a saved reply and an
    alerted team."""
    client = _make_client(db)
    bot = _make_bot(db, client, live_chat_enabled=True, notification_emails=TEAM_EMAILS)
    _make_session(db, bot, client, "urgent-6")
    _stub_pipeline(monkeypatch, retrieved=(_doc("Acme runs incident response."),), support=True)

    stream = rs.rag_pipeline_stream(bot, URGENT, "urgent-6", bot_id=bot.id)
    first = await stream.__anext__()
    await stream.aclose()

    assert first.startswith("METADATA:")
    db.expire_all()
    persisted = _messages(db, "urgent-6", role="bot")
    assert len(persisted) == 1 and persisted[0].content.startswith("This sounds urgent")
    assert len(alerts["notify"]) == 1
    assert len(alerts["emails"]) == 1
    assert _cards_shown(db, "urgent-6").get("urgent_notified") is True


@pytest.mark.asyncio
async def test_an_incident_in_the_first_message_is_not_held_behind_the_name_question(db, monkeypatch, alerts):
    client = _make_client(db)
    bot = _make_bot(db, client, live_chat_enabled=True)
    _make_session(db, bot, client, "urgent-first")
    real = _real_name_functions()
    _stub_pipeline(monkeypatch, retrieved=(_doc("Acme runs incident response."),), support=True)
    _use_the_real_name_flow(monkeypatch, real)

    frames = await _drive_stream(bot, URGENT, "urgent-first")
    answer = _answer_text(frames)

    assert answer.startswith("This sounds urgent"), answer
    assert not rs._is_name_ask_message(answer)
    assert len(alerts["notify"]) == 1
    assert alerts["notify"][0]["visitor_name"] is None


@pytest.mark.asyncio
async def test_the_turn_after_an_urgent_first_reply_is_not_taken_as_a_name(db, monkeypatch, alerts):
    client = _make_client(db)
    bot = _make_bot(db, client, live_chat_enabled=True)
    _make_session(db, bot, client, "urgent-first-2")
    real = _real_name_functions()
    _stub_pipeline(monkeypatch, retrieved=(_doc("Acme runs incident response."),), support=True)
    _use_the_real_name_flow(monkeypatch, real)

    await _drive_stream(bot, URGENT, "urgent-first-2")
    frames = await _drive_stream(bot, "please hurry", "urgent-first-2")
    answer = _answer_text(frames)

    lead = get_lead_info_by_session(db, "urgent-first-2")
    assert lead is None or lead.name is None
    assert answer.strip(), "the visitor still gets a reply"
    assert not rs._is_name_ask_message(answer), answer


@pytest.mark.asyncio
async def test_a_name_question_before_the_incident_does_not_take_the_next_message_as_a_name(db, monkeypatch, alerts):
    client = _make_client(db)
    bot = _make_bot(db, client, live_chat_enabled=True)
    _make_session(db, bot, client, "urgent-after-ask")
    real = _real_name_functions()
    _stub_pipeline(monkeypatch, retrieved=(_doc("Acme runs incident response."),), support=True)
    _use_the_real_name_flow(monkeypatch, real)

    asked = await _drive_stream(bot, "what services do you offer?", "urgent-after-ask")
    assert rs._is_name_ask_message(_answer_text(asked))
    urgent = await _drive_stream(bot, URGENT, "urgent-after-ask")
    assert _answer_text(urgent).startswith("This sounds urgent")
    frames = await _drive_stream(bot, "please hurry", "urgent-after-ask")

    lead = get_lead_info_by_session(db, "urgent-after-ask")
    assert lead is None or lead.name is None
    assert not rs._is_name_ask_message(_answer_text(frames))
    assert len(alerts["notify"]) == 1


@pytest.mark.asyncio
async def test_a_normal_first_question_still_gets_the_name_question(db, monkeypatch, alerts):
    client = _make_client(db)
    bot = _make_bot(db, client, live_chat_enabled=True)
    _make_session(db, bot, client, "urgent-normal-first")
    real = _real_name_functions()
    _stub_pipeline(monkeypatch, retrieved=(_doc("Acme runs incident response."),), support=True)
    _use_the_real_name_flow(monkeypatch, real)

    frames = await _drive_stream(bot, "what services do you offer?", "urgent-normal-first")

    assert rs._is_name_ask_message(_answer_text(frames))
    assert alerts["notify"] == []
