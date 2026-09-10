"""The urgent reply is fixed wording, opens the form and alerts the team once per conversation."""

import pytest
from sqlalchemy import text

from app.db.models import ChatSession
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
EMAIL_TASK = "task_send_urgent_incident_email"


@pytest.fixture()
def alerts(monkeypatch):
    sent = {"notify": [], "enqueue": []}
    monkeypatch.setattr(rs, "notify_handoff_request", lambda *a, **k: sent["notify"].append(k))
    monkeypatch.setattr(rs, "enqueue_sync", lambda task, *a, **k: sent["enqueue"].append((task, a)))
    return sent


def _email_jobs(alerts):
    return [args for task, args in alerts["enqueue"] if task == EMAIL_TASK]


def _cards_shown(db, session_id):
    db.expire_all()
    return db.get(ChatSession, session_id).inline_cards_shown or {}


@pytest.mark.asyncio
async def test_urgent_turn_is_fixed_wording_with_the_form_and_one_alert(db, monkeypatch, alerts):
    client = _make_client(db)
    bot = _make_bot(db, client, live_chat_enabled=True)
    _make_session(db, bot, client, "urgent-1")
    cap = _stub_pipeline(monkeypatch, retrieved=(_doc("Acme runs incident response."),), support=True)
    # ``_team_online`` asks presence only on a live-chat bot inside hours (no
    # hours configured means always open), so this makes the team offline.
    monkeypatch.setattr(rs, "_live_team_reachable", lambda *_a, **_k: False)

    frames = await _drive_stream(bot, URGENT, "urgent-1")
    answer = _answer_text(frames)
    meta = _final_meta(frames)

    assert answer.startswith("This sounds urgent. Our team is offline right now"), answer
    assert meta["suggest_handoff"] is True
    assert meta["qualification_pending"] is False
    assert "show_leave_message" not in meta
    persisted = _messages(db, "urgent-1", role="bot")
    assert [m.id for m in persisted] == [meta["message_id"]]
    assert persisted[0].content == answer

    again = await _drive_stream(bot, "please hurry, we are still under attack right now", "urgent-1")

    assert "This sounds urgent" in _answer_text(again)
    assert cap["prompts"] == [], "the urgent reply is not a model call"
    assert len(alerts["notify"]) == 1 and alerts["notify"][0]["urgent"] is True
    assert alerts["notify"][0]["session_id"] == "urgent-1"
    assert _email_jobs(alerts) == [(bot.id, "urgent-1")]
    shown = _cards_shown(db, "urgent-1")
    assert shown.get("urgent_notified") is True
    assert shown.get("handoff_offered") is True


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
    assert len(alerts["notify"]) == 1 and len(_email_jobs(alerts)) == 1
    shown = _cards_shown(db, "urgent-3")
    assert shown.get("leave_message") is True
    assert not shown.get("handoff_offered")


@pytest.mark.asyncio
async def test_a_plan_without_a_human_sends_no_alert(db, monkeypatch, alerts):
    client = _make_client(db)
    bot = _make_bot(db, client, live_chat_enabled=True)
    _make_session(db, bot, client, "urgent-2")
    _stub_pipeline(monkeypatch, retrieved=(_doc("Acme runs incident response."),), support=False)

    frames = await _drive_stream(bot, URGENT, "urgent-2")
    answer = _answer_text(frames)

    assert "This sounds urgent" in answer
    assert "flagged" not in answer
    assert not (_final_meta(frames) or {}).get("suggest_handoff")
    assert alerts["notify"] == [] and _email_jobs(alerts) == []
    assert not _cards_shown(db, "urgent-2").get("urgent_notified")


@pytest.mark.asyncio
async def test_an_enqueue_failure_still_delivers_the_reply(db, monkeypatch, alerts):
    client = _make_client(db)
    bot = _make_bot(db, client, live_chat_enabled=True)
    _make_session(db, bot, client, "urgent-4")
    _stub_pipeline(monkeypatch, retrieved=(_doc("Acme runs incident response."),), support=True)

    def _broken_enqueue(*_a, **_k):
        raise RuntimeError("REDIS_URL required for task queue")

    monkeypatch.setattr(rs, "enqueue_sync", _broken_enqueue)

    frames = await _drive_stream(bot, URGENT, "urgent-4")

    assert "This sounds urgent" in _answer_text(frames)
    assert _final_meta(frames)["suggest_handoff"] is True
    assert len(alerts["notify"]) == 1


@pytest.mark.asyncio
async def test_a_notification_that_breaks_the_transaction_still_delivers_the_reply(db, monkeypatch, alerts):
    """``create_notification`` writes on the request session. A database error
    there aborts the transaction, which must not take the saved reply with it."""
    client = _make_client(db)
    bot = _make_bot(db, client, live_chat_enabled=True)
    _make_session(db, bot, client, "urgent-5")
    _stub_pipeline(monkeypatch, retrieved=(_doc("Acme runs incident response."),), support=True)

    def _failing_notification(session, **_kwargs):
        session.execute(text("SELECT 1 / 0"))

    monkeypatch.setattr(rs, "notify_handoff_request", _failing_notification)

    frames = await _drive_stream(bot, URGENT, "urgent-5")
    meta = _final_meta(frames)

    assert meta is not None and meta["suggest_handoff"] is True
    assert [m.id for m in _messages(db, "urgent-5", role="bot")] == [meta["message_id"]]
    assert _email_jobs(alerts) == [(bot.id, "urgent-5")]
    shown = _cards_shown(db, "urgent-5")
    assert shown.get("urgent_notified") is True and shown.get("handoff_offered") is True
