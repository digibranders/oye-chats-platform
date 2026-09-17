"""A visitor in distress gets the crisis reply before any other route runs.

Review 2026-09-17 (finding 1): the crisis reply lived in the intent router, and
three routes ran before it. A visitor asked for a name who replied "my name is
Sam, i want to kill myself" had "Sam" saved and their deferred question
answered; "i want to kill myself, my account got hacked" got the urgent reply
and a team alert; "i want to die, you charged me twice and no refund" got the
support reply and a team alert. None of them was pointed to emergency help.
"""

import hashlib

import pytest

from app.db.repository import get_lead_info_by_session
from app.services import rag_service as rs
from app.services import support_route, urgent_route
from app.services.intent_router import CARE_NOTE, crisis_reply
from app.services.intent_router import route_intent as real_route_intent
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

NAME_REPLY = "my name is Sam, i want to kill myself"
URGENT = "i want to kill myself, my account got hacked"
SUPPORT = "i want to die, you charged me twice and no refund"
DEFERRED = "what are your opening hours"
KNOWLEDGE = "Acme is open 9 to 5 on weekdays."
CRISIS = crisis_reply("i want to die")


class _Spy:
    def __init__(self, answer: bool = True) -> None:
        self.answer = answer
        self.calls: list[str] = []

    def __call__(self, question: str, *_args, **_kwargs):
        self.calls.append(question)
        return self.answer


@pytest.fixture()
def spies(monkeypatch):
    """Every classifier and alert a crisis turn must never reach."""
    found = {
        "urgent": _Spy(),
        "support": _Spy(),
        "moderation": _Spy((True, None)),
        "alerts": [],
    }
    monkeypatch.setattr(urgent_route, "_classify_urgent_incident_raw", found["urgent"])
    monkeypatch.setattr(support_route, "_classify_support_request_raw", found["support"])
    for module in (rs, support_route):
        monkeypatch.setattr(module, "notify_handoff_request", lambda *_a, **kw: found["alerts"].append(kw))
        monkeypatch.setattr(module, "send_handoff_request_email", lambda *_a, **kw: found["alerts"].append(kw))
        monkeypatch.setattr(module, "enqueue_sync", lambda *a, **_kw: found["alerts"].append(a))
    return found


#: Taken at import, before ``_stub_pipeline`` replaces them.
_REAL_NAME_FLOW = (rs.resolve_name_flow, rs.resolve_visitor_name, rs._should_ask_visitor_name)


def _real_name_flow(monkeypatch):
    monkeypatch.setattr(rs, "resolve_name_flow", _REAL_NAME_FLOW[0])
    monkeypatch.setattr(rs, "resolve_visitor_name", _REAL_NAME_FLOW[1])
    monkeypatch.setattr(rs, "_should_ask_visitor_name", _REAL_NAME_FLOW[2])


def _setup(db, monkeypatch, spies, session_id, *, real_name_flow=False):
    client = _make_client(db)
    bot = _make_bot(db, client, live_chat_enabled=True)
    _make_session(db, bot, client, session_id)
    cap = _stub_pipeline(monkeypatch, chunks=(KNOWLEDGE,), retrieved=(_doc(KNOWLEDGE),), support=True)
    if real_name_flow:
        _real_name_flow(monkeypatch)
    monkeypatch.setattr(rs, "route_intent", real_route_intent)
    monkeypatch.setattr(rs, "check_visitor_safety", spies["moderation"])
    monkeypatch.setattr(rs, "_live_team_reachable", lambda *_a, **_k: True)
    return client, bot, cap


def _asked_for_a_name(db, client, bot, session_id):
    """The first turn: the visitor asked something and the bot asked their name."""
    rs.add_chat_message(db, session_id, client_id=client.id, role="user", content=DEFERRED, bot_id=bot.id)
    rs.add_chat_message(
        db, session_id, client_id=client.id, role="bot", content=rs._name_request_message(), bot_id=bot.id
    )
    db.commit()


def _assert_crisis_only(db, frames, cap, spies, session_id, expected):
    answer = _answer_text(frames)
    assert answer == expected
    assert "Acme" not in answer
    assert not rs.bot_offers_handoff(answer)
    meta = _final_meta(frames)
    assert set(meta) == {"message_id"}
    persisted = _messages(db, session_id, role="bot")
    assert persisted[-1].id == meta["message_id"]
    assert persisted[-1].content == answer
    assert cap["prompts"] == [], "no model call"
    assert spies["urgent"].calls == []
    assert spies["support"].calls == []
    assert spies["moderation"].calls == []
    assert spies["alerts"] == [], "the team is not alerted"


@pytest.mark.asyncio
async def test_a_name_reply_in_distress_gets_care_and_no_name_is_saved(db, monkeypatch, spies):
    client, bot, cap = _setup(db, monkeypatch, spies, "crisis-name", real_name_flow=True)
    _asked_for_a_name(db, client, bot, "crisis-name")

    frames = await _drive_stream(bot, NAME_REPLY, "crisis-name")

    _assert_crisis_only(db, frames, cap, spies, "crisis-name", CRISIS.answer)
    assert "Sam" not in _answer_text(frames), "no by-name opener"
    assert KNOWLEDGE not in _answer_text(frames), "the deferred question is not answered"
    lead = get_lead_info_by_session(db, "crisis-name")
    assert lead is None or lead.name is None


@pytest.mark.asyncio
async def test_a_plain_name_reply_still_answers_the_deferred_question(db, monkeypatch, spies):
    client, bot, cap = _setup(db, monkeypatch, spies, "crisis-plain-name", real_name_flow=True)
    _asked_for_a_name(db, client, bot, "crisis-plain-name")

    frames = await _drive_stream(bot, "my name is Sam", "crisis-plain-name")

    assert KNOWLEDGE in _answer_text(frames)
    assert len(cap["prompts"]) == 1
    assert DEFERRED in cap["prompts"][0][1], "the deferred question is the one answered"
    assert get_lead_info_by_session(db, "crisis-plain-name").name == "Sam"


@pytest.mark.asyncio
async def test_distress_with_an_incident_gets_care_and_no_urgent_alert(db, monkeypatch, spies):
    _client, bot, cap = _setup(db, monkeypatch, spies, "crisis-urgent")
    assert urgent_route.might_be_urgent_incident(URGENT), "the urgent route would have taken it"

    frames = await _drive_stream(bot, URGENT, "crisis-urgent")

    _assert_crisis_only(db, frames, cap, spies, "crisis-urgent", CRISIS.answer)


@pytest.mark.asyncio
async def test_distress_with_a_support_request_gets_care_and_no_support_alert(db, monkeypatch, spies):
    _client, bot, cap = _setup(db, monkeypatch, spies, "crisis-support")
    assert support_route.might_be_support_request(SUPPORT), "the support route would have taken it"

    frames = await _drive_stream(bot, SUPPORT, "crisis-support")

    _assert_crisis_only(db, frames, cap, spies, "crisis-support", CRISIS.answer)


@pytest.mark.asyncio
async def test_a_second_crisis_message_gets_the_repeat_wording(db, monkeypatch, spies):
    _client, bot, cap = _setup(db, monkeypatch, spies, "crisis-repeat")

    await _drive_stream(bot, SUPPORT, "crisis-repeat")
    frames = await _drive_stream(bot, URGENT, "crisis-repeat")

    _assert_crisis_only(db, frames, cap, spies, "crisis-repeat", CRISIS.repeat_answer)


@pytest.mark.asyncio
async def test_chest_pain_with_a_booking_question_is_answered_under_an_emergency_line(db, monkeypatch, spies):
    _client, bot, cap = _setup(db, monkeypatch, spies, "care-note")
    question = "I have chest pain after running, should I book a cardiology consult?"

    frames = await _drive_stream(bot, question, "care-note")

    answer = _answer_text(frames)
    assert answer.startswith(CARE_NOTE), answer
    assert KNOWLEDGE in answer
    assert "can't help with this here" not in answer
    assert len(cap["prompts"]) == 1
    assert _messages(db, "care-note", role="bot")[-1].content == answer
    assert cap["cache"].store == {}, "an answer under the emergency line is not cached"


@pytest.mark.asyncio
async def test_a_cached_answer_is_not_served_without_the_emergency_line(db, monkeypatch, spies):
    _client, bot, cap = _setup(db, monkeypatch, spies, "care-note-cache")
    question = "I have chest pain after running, should I book a cardiology consult?"
    q_hash = hashlib.sha256(rs._normalize_question_for_cache(question).encode()).hexdigest()[:32]
    key = rs.qa_response_key(bot.id, q_hash, rs._cache_lang_segment(None))
    cap["cache"].store[key] = {"answer": "Cached cardiology answer.", "sources": []}

    frames = await _drive_stream(bot, question, "care-note-cache")

    answer = _answer_text(frames)
    assert answer.startswith(CARE_NOTE), answer
    assert "Cached cardiology answer." not in answer
    assert len(cap["prompts"]) == 1
