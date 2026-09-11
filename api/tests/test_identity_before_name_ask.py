"""An identity question is answered before the name question, and a later turn still asks.

Production, 2026-09-11: a fresh conversation opening with "r u a bot or real"
got "Before I help you out, may I know your name so I can address you
properly?", with the question ignored. A visitor asking whether a person is
there is deciding whether to share anything at all, so the answer comes
first; the name question moves to the next turn that needs answering.
"""

from unittest.mock import MagicMock, patch

import pytest

from app.db.models import LeadInfo
from app.db.repository import get_lead_info_by_session
from app.services import rag_service as rs
from app.services.intent_router import route_intent as real_route_intent
from tests.test_rag_pipeline_defects import (
    _answer_text,
    _doc,
    _drive_stream,
    _make_bot,
    _make_client,
    _make_session,
    _stub_pipeline,
)

_IS_AI = real_route_intent("are you a bot", "Acme").answer


def _history(*turns):
    return [{"role": role, "content": content} for role, content in turns]


class TestResolveNameFlow:
    def _run(self, question, history):
        with (
            patch.object(rs, "get_lead_info_by_session", return_value=None),
            patch.object(rs, "get_chat_history", return_value=history),
            patch.object(rs, "create_or_update_lead_info"),
        ):
            return rs.resolve_name_flow(MagicMock(), "s1", 3, 9, question, company_name="Acme")

    @pytest.mark.parametrize(
        "question", ["r u a bot or real", "is this chatgpt?", "who made you", "is this conversation recorded"]
    )
    def test_an_identity_question_on_a_fresh_conversation_is_not_held(self, question):
        assert self._run(question, _history(("user", question))) == (None, None, None, False)

    def test_the_next_question_after_an_identity_answer_gets_the_name_question(self):
        history = _history(
            ("user", "r u a bot or real"),
            ("bot", _IS_AI),
            ("user", "what services do you offer?"),
        )
        ask, deferred, name, _just = self._run("what services do you offer?", history)
        assert rs._is_name_ask_message(ask)
        assert (deferred, name) == (None, None)

    def test_a_name_recall_on_a_fresh_conversation_is_still_held(self):
        ask, _deferred, _name, _just = self._run("what's my name?", _history(("user", "what's my name?")))
        assert rs._is_name_ask_message(ask)

    def test_a_non_identity_bot_turn_still_ends_the_first_reply(self):
        history = _history(
            ("user", "we are under attack"),
            ("bot", "This sounds urgent."),
            ("user", "please hurry"),
        )
        assert self._run("please hurry", history) == (None, None, None, False)


def test_the_router_reply_to_an_identity_question_carries_no_name_question():
    with (
        patch.object(rs, "get_lead_info_by_session", return_value=None),
        patch.object(rs, "create_or_update_lead_info"),
    ):
        out = rs._maybe_append_name_ask(
            _IS_AI, MagicMock(), "s1", 3, 9, "r u a bot or real", history=_history(("user", "r u a bot or real"))
        )
    assert out == _IS_AI


def _real_name_flow(monkeypatch, real):
    resolve_name_flow, resolve_visitor_name, should_ask = real
    monkeypatch.setattr(rs, "resolve_name_flow", resolve_name_flow)
    monkeypatch.setattr(rs, "resolve_visitor_name", resolve_visitor_name)
    monkeypatch.setattr(rs, "_should_ask_visitor_name", should_ask)
    monkeypatch.setattr(rs, "route_intent", real_route_intent)


def _saved_real_functions():
    return rs.resolve_name_flow, rs.resolve_visitor_name, rs._should_ask_visitor_name


@pytest.mark.asyncio
@pytest.mark.parametrize("question", ["r u a bot or real", "is this chatgpt?"])
async def test_a_first_identity_question_is_answered_then_the_name_is_asked_later(db, monkeypatch, question):
    client = _make_client(db)
    bot = _make_bot(db, client)
    _make_session(db, bot, client, "identity-first")
    real = _saved_real_functions()
    knowledge = "Acme sells commercial cleaning."
    cap = _stub_pipeline(monkeypatch, chunks=(knowledge,), retrieved=(_doc(knowledge),))
    _real_name_flow(monkeypatch, real)

    first = _answer_text(await _drive_stream(bot, question, "identity-first"))
    assert first.startswith("I'm an AI assistant for **Acme**."), first
    assert not rs._is_name_ask_message(first), first
    assert cap["prompts"] == []

    second = _answer_text(await _drive_stream(bot, "what services do you offer?", "identity-first"))
    assert rs._is_name_ask_message(second), second

    third = _answer_text(await _drive_stream(bot, "Priya", "identity-first"))
    assert knowledge in third
    assert "I'm an AI assistant" not in third
    assert get_lead_info_by_session(db, "identity-first").name == "Priya"


@pytest.mark.asyncio
async def test_a_correction_is_recalled_by_the_corrected_name(db, monkeypatch):
    client = _make_client(db)
    bot = _make_bot(db, client)
    _make_session(db, bot, client, "name-correction")
    db.add(LeadInfo(session_id="name-correction", bot_id=bot.id, name="Eva"))
    db.commit()
    real = _saved_real_functions()
    _stub_pipeline(monkeypatch, retrieved=(_doc("Acme sells widgets."),))
    _real_name_flow(monkeypatch, real)

    await _drive_stream(bot, "hi", "name-correction")
    await _drive_stream(bot, "actually my name is not eva, its priya. typo earlier", "name-correction")
    db.expire_all()
    assert get_lead_info_by_session(db, "name-correction").name == "Priya"

    recall = _answer_text(await _drive_stream(bot, "so what name do u have for me now", "name-correction"))
    assert "You're Priya." in recall, recall


@pytest.mark.asyncio
async def test_a_callback_request_after_the_name_question_is_not_a_name(db, monkeypatch):
    client = _make_client(db)
    bot = _make_bot(db, client)
    _make_session(db, bot, client, "callback")
    real = _saved_real_functions()
    _stub_pipeline(monkeypatch, retrieved=(_doc("Acme hardens container images."),))
    _real_name_flow(monkeypatch, real)

    asked = _answer_text(await _drive_stream(bot, "is anyone there right now", "callback"))
    assert rs._is_name_ask_message(asked)
    reply = _answer_text(
        await _drive_stream(
            bot, "ok then take a message, i need someone to call me back about hardened container images", "callback"
        )
    )

    assert "Back About" not in reply
    lead = get_lead_info_by_session(db, "callback")
    assert lead is None or lead.name is None


@pytest.mark.asyncio
async def test_hinglish_frustration_on_an_english_only_bot_gets_the_english_reply(db, monkeypatch):
    client = _make_client(db)
    bot = _make_bot(db, client)
    _make_session(db, bot, client, "hinglish")
    cap = _stub_pipeline(monkeypatch, chunks=("Samjha.",), retrieved=(_doc("Acme sells widgets."),))
    monkeypatch.setattr(rs, "route_intent", real_route_intent)

    answer = _answer_text(await _drive_stream(bot, "bakwas bot hai yaar", "hinglish"))

    assert "Sorry that wasn't helpful." in answer, answer
    assert "Samjha" not in answer
    assert cap["prompts"] == []
