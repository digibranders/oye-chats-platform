"""The handoff form opens only when the visitor asked for it, and a later question is answered.

Drives the real ``rag_pipeline_stream`` against the throwaway Postgres with the
outside-world stubs from ``test_rag_pipeline_defects``. Each case is a
transcript from the prompt-focus eval of 2026-09-17:

* CleanStart x-tech-mttd-sla: a grounded answer closing "I can connect you with
  them if you want the exact figure." set ``suggest_handoff`` from the model's
  own words, and the widget opened the form 600 ms later with no "yes".
* x-support-escalation on both bots: "i need the escalation matrix now" after
  the support reply got the repeat form line instead of an answer.
* A bare "yes" to the greeting's "Want to hear about our services, see recent
  work, or chat with the team?" got "Got it."
"""

from __future__ import annotations

import pytest

from app.db.models import ChatSession
from app.services import rag_service as rs
from app.services import support_route
from app.services.handoff_reply import handoff_reply
from app.services.intent_router import route_intent as real_route_intent
from tests.test_rag_pipeline_defects import (
    _anonymous_visitor,
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

_MODEL_OFFER = (
    "We publish P1 response within 1 hour.\n\n"
    "MTTD is not in what I have here. Want me to connect you with our team for the exact figure?"
)
_OFFER_MID_ANSWER = "Our team will reach out once you book a demo. The demo takes 30 minutes."
_KNOWLEDGE = "Acme publishes P1 response within 1 hour."
_SERVICES_ANSWER = "Acme offers managed SOC, incident response and GRC."

UNRESPONSIVE = "our account manager isnt responding for 3 days"
ESCALATION = "i need the escalation matrix now"


def _bot(db, monkeypatch, session_id, *, chunks=(_MODEL_OFFER,), team_online=True):
    client = _make_client(db)
    bot = _make_bot(db, client, live_chat_enabled=True)
    _make_session(db, bot, client, session_id)
    cap = _stub_pipeline(monkeypatch, chunks=chunks, retrieved=(_doc(_KNOWLEDGE),), support=True)
    monkeypatch.setattr(rs, "_live_team_reachable", lambda *_a, **_k: team_online)
    # No by-name opener, so each reply is exactly what the model or the route wrote.
    _anonymous_visitor(monkeypatch)
    return bot, cap


def _cards(db, session_id) -> dict:
    db.expire_all()
    return db.query(ChatSession).filter(ChatSession.id == session_id).one().inline_cards_shown or {}


class TestAnOfferInTheAnswerWaitsForTheVisitor:
    @pytest.mark.asyncio
    async def test_a_model_offer_does_not_open_the_form(self, db, monkeypatch):
        bot, cap = _bot(db, monkeypatch, "consent-1")

        frames = await _drive_stream(bot, "whats ur MTTD and MTTR sla", "consent-1")

        meta = _final_meta(frames)
        assert _answer_text(frames) == _MODEL_OFFER
        assert len(cap["prompts"]) == 1
        assert not meta.get("suggest_handoff"), meta
        assert not _cards(db, "consent-1").get("handoff_offered"), "no form was shown"

    @pytest.mark.asyncio
    @pytest.mark.parametrize("reply", ["yes", "ok", "sure", "yes please"])
    async def test_yes_to_the_offer_opens_the_form(self, db, monkeypatch, reply):
        session_id = f"consent-yes-{reply.replace(' ', '-')}"
        bot, cap = _bot(db, monkeypatch, session_id)
        monkeypatch.setattr(rs, "route_intent", real_route_intent)
        await _drive_stream(bot, "whats ur MTTD and MTTR sla", session_id)

        frames = await _drive_stream(bot, reply, session_id)

        meta = _final_meta(frames)
        assert _answer_text(frames) == handoff_reply(team_available=True, repeat=False)
        assert meta["suggest_handoff"] is True
        assert len(cap["prompts"]) == 1, "the handoff reply is not a model call"
        assert _cards(db, session_id).get("handoff_offered") is True

    @pytest.mark.asyncio
    async def test_a_new_question_after_the_offer_is_answered_without_the_form(self, db, monkeypatch):
        bot, cap = _bot(db, monkeypatch, "consent-next")
        await _drive_stream(bot, "whats ur MTTD and MTTR sla", "consent-next")

        frames = await _drive_stream(bot, "do you support aws", "consent-next")

        assert len(cap["prompts"]) == 2
        assert not _final_meta(frames).get("suggest_handoff")

    @pytest.mark.asyncio
    async def test_a_callback_sentence_in_the_body_is_no_offer_to_say_yes_to(self, db, monkeypatch):
        bot, _cap = _bot(db, monkeypatch, "consent-body", chunks=(_OFFER_MID_ANSWER,))
        await _drive_stream(bot, "how do demos work", "consent-body")

        frames = await _drive_stream(bot, "ok", "consent-body")

        assert not _final_meta(frames).get("suggest_handoff")

    @pytest.mark.asyncio
    async def test_an_explicit_request_still_opens_the_form(self, db, monkeypatch):
        bot, cap = _bot(db, monkeypatch, "consent-ask")
        monkeypatch.setattr(rs, "detect_handoff_intent", lambda q, **_k: q == "connect me to a person")

        frames = await _drive_stream(bot, "connect me to a person", "consent-ask")

        assert _answer_text(frames) == handoff_reply(team_available=True, repeat=False)
        assert _final_meta(frames)["suggest_handoff"] is True
        assert cap["prompts"] == []

    @pytest.mark.asyncio
    async def test_an_explicit_request_in_another_language_still_opens_the_form(self, db, monkeypatch):
        """The fixed reply is English only, so the model answers and the flag carries the handoff."""
        bot, cap = _bot(db, monkeypatch, "consent-hi", chunks=("Main aapko team se jod deta hoon.",))
        monkeypatch.setattr(rs, "_english_judges_bypassed", lambda *_a, **_k: True)
        monkeypatch.setattr(rs, "detect_handoff_intent", lambda _q, **_k: True)

        frames = await _drive_stream(bot, "mujhe team se baat karni hai", "consent-hi")

        assert len(cap["prompts"]) == 1
        assert _final_meta(frames)["suggest_handoff"] is True

    @pytest.mark.asyncio
    @pytest.mark.parametrize(("answer", "cached"), [(_MODEL_OFFER, False), (_KNOWLEDGE, True)])
    async def test_a_model_offer_is_not_cached(self, db, monkeypatch, answer, cached):
        """Kept out of the QA cache, as it was while the offer set the flag: the
        offer is worded for the conversation that asked, not for every visitor."""
        session_id = f"consent-cache-{cached}"
        bot, cap = _bot(db, monkeypatch, session_id, chunks=(answer,))

        await _drive_stream(bot, "what is your p1 response time", session_id)

        stored = [value.get("answer") for value in cap["cache"].store.values()]
        assert (answer in stored) is cached, stored


class TestAQuestionAfterTheSupportReplyIsAnswered:
    @pytest.fixture(autouse=True)
    def _support_classifier(self, monkeypatch):
        calls: list[str] = []

        def classify(question: str) -> bool:
            calls.append(question)
            return True

        monkeypatch.setattr(support_route, "_classify_support_request_raw", classify)
        monkeypatch.setattr(support_route, "alert_team_of_support_request", lambda *_a, **_k: None)
        return calls

    @pytest.mark.asyncio
    async def test_the_escalation_matrix_request_reaches_the_model(self, db, monkeypatch, _support_classifier):
        bot, cap = _bot(db, monkeypatch, "support-next", chunks=(_KNOWLEDGE,))
        first = await _drive_stream(bot, UNRESPONSIVE, "support-next")
        assert _final_meta(first)["suggest_handoff"] is True, "precondition: the support reply opened the form"

        frames = await _drive_stream(bot, ESCALATION, "support-next")

        assert _answer_text(frames) == _KNOWLEDGE
        assert len(cap["prompts"]) == 1
        assert not _final_meta(frames).get("suggest_handoff")
        assert _support_classifier == [UNRESPONSIVE], "a repeat that is not a person request asks no classifier"
        assert "already knows" not in _messages(db, "support-next", role="bot")[-1].content

    @pytest.mark.asyncio
    async def test_a_problem_reported_again_still_points_at_the_form(self, db, monkeypatch):
        """A failing service needs the team, not the knowledge base's DIY steps."""
        bot, cap = _bot(db, monkeypatch, "support-again", chunks=(_KNOWLEDGE,))
        await _drive_stream(bot, UNRESPONSIVE, "support-again")

        frames = await _drive_stream(bot, "our portal is still down", "support-again")

        assert _answer_text(frames).startswith("Our team already knows about this.")
        assert _final_meta(frames)["suggest_handoff"] is True
        assert cap["prompts"] == []

    @pytest.mark.asyncio
    async def test_asking_for_a_person_again_still_points_at_the_form(self, db, monkeypatch):
        bot, cap = _bot(db, monkeypatch, "support-person", chunks=(_KNOWLEDGE,))
        await _drive_stream(bot, UNRESPONSIVE, "support-person")

        frames = await _drive_stream(
            bot, "i want to talk to someone, my account manager is not responding", "support-person"
        )

        assert _answer_text(frames) == (
            "Our team already knows about this. The form is just below: share your details there and "
            "I'll connect you with our team."
        )
        assert _final_meta(frames)["suggest_handoff"] is True
        assert cap["prompts"] == []


class TestYesToTheGreetingOfferContinuesWithItsFirstOption:
    @pytest.mark.asyncio
    @pytest.mark.parametrize("reply", ["yes", "yeah", "sure", "ok", "yes please"])
    async def test_yes_after_the_greeting_gets_the_services_overview(self, db, monkeypatch, reply):
        session_id = f"greet-{reply.replace(' ', '-')}"
        bot, cap = _bot(db, monkeypatch, session_id, chunks=(_SERVICES_ANSWER,))
        monkeypatch.setattr(rs, "route_intent", real_route_intent)
        greeting = await _drive_stream(bot, "hi", session_id)
        assert "Want to hear about our services" in _answer_text(greeting), "precondition: the greeting offer"
        asked: list[str] = []

        async def resolve(session_id, question, history, bid, cid, company_name, embedding_profile=None):
            asked.append(question)
            return question, None

        monkeypatch.setattr(rs, "_resolve_search_query_and_embedding", resolve)

        frames = await _drive_stream(bot, reply, session_id)

        assert _answer_text(frames) == _SERVICES_ANSWER
        assert asked == ["what services do you offer"]
        assert len(cap["prompts"]) == 1
        assert not _final_meta(frames).get("suggest_handoff")
        users = _messages(db, session_id, role="user")
        assert users[-1].content == reply, "the transcript keeps what the visitor typed"

    @pytest.mark.asyncio
    async def test_yes_after_the_name_welcome_gets_the_services_overview(self, db, monkeypatch):
        bot, cap = _bot(db, monkeypatch, "greet-name", chunks=(_SERVICES_ANSWER,))
        monkeypatch.setattr(rs, "route_intent", real_route_intent)
        rs.add_chat_message(
            db,
            "greet-name",
            client_id=bot.client_id,
            role="bot",
            content=rs._name_ack_message("Eva", "Acme"),
            bot_id=bot.id,
        )
        db.commit()

        frames = await _drive_stream(bot, "yes", "greet-name")

        assert _answer_text(frames) == _SERVICES_ANSWER
        assert len(cap["prompts"]) == 1

    @pytest.mark.asyncio
    async def test_yes_to_a_team_only_offer_opens_the_form(self, db, monkeypatch):
        bot, cap = _bot(db, monkeypatch, "greet-team", chunks=(_SERVICES_ANSWER,))
        monkeypatch.setattr(rs, "route_intent", real_route_intent)
        rs.add_chat_message(
            db,
            "greet-team",
            client_id=bot.client_id,
            role="bot",
            content="That detail sits with our sales team. Want me to connect you with them?",
            bot_id=bot.id,
        )
        db.commit()

        frames = await _drive_stream(bot, "yes", "greet-team")

        assert _answer_text(frames) == handoff_reply(team_available=True, repeat=False)
        assert _final_meta(frames)["suggest_handoff"] is True
        assert cap["prompts"] == []

    @pytest.mark.asyncio
    @pytest.mark.parametrize("reply", ["ok", "thanks"])
    async def test_an_ack_after_an_ordinary_answer_stays_an_ack(self, db, monkeypatch, reply):
        session_id = f"greet-ack-{reply}"
        bot, cap = _bot(db, monkeypatch, session_id, chunks=(_SERVICES_ANSWER,))
        await _drive_stream(bot, "what do you offer", session_id)
        monkeypatch.setattr(rs, "route_intent", real_route_intent)

        frames = await _drive_stream(bot, reply, session_id)

        assert "Glad that helped" in _answer_text(frames)
        assert len(cap["prompts"]) == 1
