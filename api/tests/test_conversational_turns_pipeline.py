"""Conversational turns end to end: follow-ups, waiting, frustration, off-topic.

Drives the real ``rag_pipeline_stream`` against the throwaway Postgres with the
outside-world stubs from ``test_rag_pipeline_defects``. Every case here is a
transcript reported from production on 2026-09-11, where the relevance judge
scored a message 0.00 and the visitor got an off-topic refusal:

* "tell me moer about " after a company overview;
* "hello?? nobody is replying" after the handoff form;
* "wow very helpful answer 🙄" and "cool so ill just sit here and get hacked
  then" after a reply that did not help;
* "how r u better than crowdstrike" on a first turn.

The judge stub below refuses whenever told to, so each test shows what the
pipeline does with a refusal it should not pass on, and, for genuinely
off-topic messages, that the refusal still goes out.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from app.db.models import ChatSession
from app.services import rag_service as rs
from app.services import visitor_reaction as vr
from app.services.handoff_reply import handoff_reply, unhelped_offer
from app.services.intent_router import route_intent as real_route_intent
from app.services.relevance_gate import ConversationContext
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

_ANSWER = "Acme builds widgets for factories across India."


class _Judge:
    """A relevance judge that records what it was asked and answers as told."""

    def __init__(self) -> None:
        self.relevant = True
        self.calls: list[SimpleNamespace] = []

    def __call__(self, query, chunks, **kwargs):
        self.calls.append(SimpleNamespace(query=query, chunks=chunks, **kwargs))
        return self.relevant, 1.0 if self.relevant else 0.0


class _Classifier:
    """Stands in for the dissatisfaction model and records every question put to it."""

    def __init__(self, verdict: bool) -> None:
        self.verdict = verdict
        self.calls: list[tuple[str, str]] = []

    def __call__(self, message: str, previous_reply: str) -> bool:
        self.calls.append((message, previous_reply))
        return self.verdict


def _bot(db, monkeypatch, session_id, *, support=True, live_chat=True, team_online=True, verdict=False):
    client = _make_client(db)
    bot = _make_bot(db, client, live_chat_enabled=live_chat)
    _make_session(db, bot, client, session_id)
    cap = _stub_pipeline(
        monkeypatch, retrieved=(_doc("Acme builds widgets for factories."),), support=support, chunks=(_ANSWER,)
    )
    judge = _Judge()
    classifier = _Classifier(verdict)
    monkeypatch.setattr(rs, "check_relevance", judge)
    monkeypatch.setattr(rs, "_live_team_reachable", lambda *_a, **_k: team_online)
    monkeypatch.setattr(vr, "classify_dissatisfaction", classifier)
    # "get hacked" is security vocabulary; the incident classifier is a model call.
    monkeypatch.setattr(rs.urgent_route, "classify_urgent_incident", lambda _q: False)
    return bot, cap, judge, classifier


async def _answered_first(db, bot, session_id, judge, question="tell me about your company") -> str:
    """Answer a first turn, then turn the judge against everything after it.

    Returns the stored reply, which carries the first turn's by-name opener."""
    frames = await _drive_stream(bot, question, session_id)
    assert _answer_text(frames).endswith(_ANSWER), "precondition: the first turn was answered"
    judge.relevant = False
    db.expire_all()
    return _messages(db, session_id, role="bot")[-1].content


def _cards(db, session_id) -> dict:
    db.expire_all()
    return db.query(ChatSession).filter(ChatSession.id == session_id).one().inline_cards_shown or {}


def _last_paragraph(frames) -> str:
    return _answer_text(frames).split("\n\n")[-1]


class TestAFollowUpReachesTheModel:
    @pytest.mark.asyncio
    async def test_tell_me_more_after_an_answer_is_answered_and_judged_in_context(self, db, monkeypatch):
        bot, cap, judge, _classifier = _bot(db, monkeypatch, "fu-1")
        first_reply = await _answered_first(db, bot, "fu-1", judge)

        frames = await _drive_stream(bot, "tell me moer about ", "fu-1")

        assert len(cap["prompts"]) == 2, "the follow-up reached generation"
        assert _answer_text(frames) == _ANSWER
        context = judge.calls[-1].context
        assert isinstance(context, ConversationContext)
        assert context.previous_reply == first_reply
        assert context.visitor_message == "tell me moer about "

    @pytest.mark.asyncio
    async def test_with_nothing_retrieved_it_gets_the_pivot_not_the_refusal(self, db, monkeypatch):
        bot, cap, judge, _classifier = _bot(db, monkeypatch, "fu-2", support=False)
        await _answered_first(db, bot, "fu-2", judge)
        monkeypatch.setattr(rs, "reciprocal_rank_fusion", lambda *a, **k: [])
        # With no chunks the real judge has nothing to score and passes the turn.
        judge.relevant = True

        frames = await _drive_stream(bot, "tell me moer about ", "fu-2")

        answer = _answer_text(frames)
        assert not rs._is_known_refusal(answer, "Acme"), answer
        assert answer == rs._no_info_pivot("Acme", support_enabled=False)
        assert len(cap["prompts"]) == 1

    @pytest.mark.asyncio
    async def test_an_elliptical_follow_up_is_judged_in_context_and_skips_the_qa_cache(self, db, monkeypatch):
        """Neither read nor written: the answer depends on the conversation, and
        "paid or unpaid?" means something else after a plans answer."""
        bot, cap, judge, _classifier = _bot(db, monkeypatch, "fu-3")
        question = "paid or unpaid? and is remote ok"
        stored = {"answer": "CACHED FROM ANOTHER CONVERSATION", "sources": []}
        key = rs.qa_response_key(
            bot.id, rs.hashlib.sha256(rs._normalize_question_for_cache(question).encode()).hexdigest()[:32], None
        )
        cap["cache"].store[key] = dict(stored)
        first_reply = await _answered_first(db, bot, "fu-3", judge, question="do u offer internships")
        judge.relevant = True

        frames = await _drive_stream(bot, question, "fu-3")

        assert _answer_text(frames) == _ANSWER
        assert len(cap["prompts"]) == 2, "generated, not served from the cache"
        assert judge.calls[-1].context == ConversationContext(previous_reply=first_reply, visitor_message=question)
        assert cap["cache"].store[key] == stored, "and the turn-two answer is not written over it"

        standalone = "Can you walk me through how onboarding works for a two hundred person company?"
        await _drive_stream(bot, standalone, "fu-3")
        standalone_key = rs.qa_response_key(
            bot.id, rs.hashlib.sha256(rs._normalize_question_for_cache(standalone).encode()).hexdigest()[:32], None
        )
        assert standalone_key in cap["cache"].store, "control: a later standalone answer on this path is written"

    @pytest.mark.asyncio
    async def test_a_short_fragment_after_an_answer_costs_no_rewrite(self, db, monkeypatch):
        """The rewrite is a 3s-capped model call. A fragment skips it; a pronoun
        follow-up in the same conversation still pays for it."""
        bot, _cap, judge, _classifier = _bot(db, monkeypatch, "fu-6")
        rewrites: list[str] = []

        def spy_generate(prompt, **_k):
            if "FOLLOW-UP QUESTION:" in prompt:
                rewrites.append(prompt)
            return "rewritten query"

        async def resolve_with_the_real_rewrite(session_id, question, history, *_a, **_k):
            return await rs.asyncio.to_thread(rs.rewrite_query, session_id, question, history), None

        monkeypatch.setattr(rs, "generate_response", spy_generate)
        monkeypatch.setattr(rs, "_resolve_search_query_and_embedding", resolve_with_the_real_rewrite)
        await _answered_first(db, bot, "fu-6", judge)
        judge.relevant = True

        await _drive_stream(bot, "parking available?", "fu-6")
        assert rewrites == []

        await _drive_stream(bot, "tell me more about it", "fu-6")
        assert len(rewrites) == 1, "control: a follow-up on the same path is rewritten"

    @pytest.mark.asyncio
    async def test_a_first_turn_and_a_standalone_question_are_judged_without_context(self, db, monkeypatch):
        bot, _cap, judge, _classifier = _bot(db, monkeypatch, "fu-4")

        await _drive_stream(bot, "tell me more", "fu-4")
        await _drive_stream(
            bot, "Can you walk me through how onboarding works for a two hundred person company?", "fu-4"
        )

        assert [call.context for call in judge.calls] == [None, None]

    @pytest.mark.asyncio
    async def test_a_company_comparison_on_a_first_turn_reaches_the_model(self, db, monkeypatch):
        bot, cap, judge, _classifier = _bot(db, monkeypatch, "fu-5")
        judge.relevant = False

        await _drive_stream(bot, "how r u better than crowdstrike", "fu-5")

        assert len(cap["prompts"]) == 1


class TestOffTopicIsStillRefused:
    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        "question",
        [
            "who won ipl last season",
            "write me a python function to reverse a string",
            "what dose of paracetamol should i take",
            "when was crowdstrike founded",
            "can you help me with my math homework",
        ],
    )
    async def test_after_an_answer(self, db, monkeypatch, question):
        session_id = f"ot-after-{abs(hash(question))}"
        bot, cap, judge, classifier = _bot(db, monkeypatch, session_id)
        await _answered_first(db, bot, session_id, judge)

        frames = await _drive_stream(bot, question, session_id)

        assert rs._is_known_refusal(_answer_text(frames), "Acme"), _answer_text(frames)
        assert len(cap["prompts"]) == 1
        assert classifier.calls == [], "no dissatisfaction vocabulary, so no model call"
        assert (judge.calls[-1].context is not None) == rs._leans_on_the_last_reply(question)

    @pytest.mark.asyncio
    @pytest.mark.parametrize("question", ["who won ipl last season", "write me a python function to reverse a string"])
    async def test_on_a_first_turn(self, db, monkeypatch, question):
        session_id = f"ot-first-{abs(hash(question))}"
        bot, cap, judge, _classifier = _bot(db, monkeypatch, session_id)
        judge.relevant = False

        frames = await _drive_stream(bot, question, session_id)

        assert rs._is_known_refusal(_last_paragraph(frames), "Acme"), _answer_text(frames)
        assert cap["prompts"] == []


class TestWaitingOnTheTeamGetsTheForm:
    @pytest.mark.asyncio
    @pytest.mark.parametrize("message", ["hello?? nobody is replying", "anyone there?", "still waiting", "hellooo??"])
    async def test_after_the_form_was_offered(self, db, monkeypatch, message):
        session_id = f"wait-{abs(hash(message))}"
        bot, cap, judge, _classifier = _bot(db, monkeypatch, session_id)
        monkeypatch.setattr(rs, "detect_handoff_intent", lambda q, **_k: q == "connect me to someone from sales")
        first = await _drive_stream(bot, "connect me to someone from sales", session_id)
        assert _final_meta(first)["suggest_handoff"] is True, "precondition: the form was offered"
        # "hellooo??" is a greeting to the router, which runs after this check.
        monkeypatch.setattr(rs, "route_intent", real_route_intent)
        judge.relevant = False

        frames = await _drive_stream(bot, message, session_id)

        meta = _final_meta(frames)
        assert _answer_text(frames) == handoff_reply(team_available=True, repeat=True)
        assert meta["suggest_handoff"] is True
        assert meta["qualification_pending"] is False
        assert cap["prompts"] == [] and judge.calls == []
        persisted = _messages(db, session_id, role="bot")
        assert persisted[-1].id == meta["message_id"]
        assert persisted[-1].content == _answer_text(frames)

    @pytest.mark.asyncio
    async def test_a_real_question_after_the_form_is_answered(self, db, monkeypatch):
        bot, cap, _judge, _classifier = _bot(db, monkeypatch, "wait-question")
        monkeypatch.setattr(rs, "detect_handoff_intent", lambda q, **_k: q == "connect me to someone from sales")
        first = await _drive_stream(bot, "connect me to someone from sales", "wait-question")
        assert _final_meta(first)["suggest_handoff"] is True, "precondition: the form was offered"

        frames = await _drive_stream(bot, "where is your team located", "wait-question")

        assert _answer_text(frames) == _ANSWER
        assert len(cap["prompts"]) == 1

    @pytest.mark.asyncio
    async def test_nobody_available_gets_the_waiting_wording(self, db, monkeypatch):
        bot, _cap, _judge, _classifier = _bot(db, monkeypatch, "wait-away", team_online=False)
        monkeypatch.setattr(rs, "detect_handoff_intent", lambda q, **_k: q == "connect me")
        await _drive_stream(bot, "connect me", "wait-away")

        frames = await _drive_stream(bot, "anyone there?", "wait-away")

        assert _answer_text(frames) == handoff_reply(team_available=False, repeat=True)

    @pytest.mark.asyncio
    async def test_without_a_form_offered_the_message_is_not_intercepted(self, db, monkeypatch):
        bot, _cap, judge, _classifier = _bot(db, monkeypatch, "wait-none")
        await _answered_first(db, bot, "wait-none", judge)

        frames = await _drive_stream(bot, "anyone there?", "wait-none")

        assert handoff_reply(team_available=True, repeat=True) not in _answer_text(frames)
        assert not (_final_meta(frames) or {}).get("suggest_handoff")

    @pytest.mark.asyncio
    async def test_a_bot_with_live_chat_off_is_not_intercepted(self, db, monkeypatch):
        bot, _cap, _judge, _classifier = _bot(db, monkeypatch, "wait-off", live_chat=False)
        cs = db.query(ChatSession).filter(ChatSession.id == "wait-off").one()
        cs.inline_cards_shown = {"handoff_offered": True}
        db.commit()

        frames = await _drive_stream(bot, "anyone there?", "wait-off")

        assert handoff_reply(team_available=True, repeat=True) not in _answer_text(frames)


class TestFrustrationGetsAnApologyAndThePerson:
    @pytest.mark.asyncio
    async def test_sarcasm_after_an_answer_offers_the_team(self, db, monkeypatch):
        bot, cap, judge, classifier = _bot(db, monkeypatch, "fr-1", verdict=True)
        first_reply = await _answered_first(db, bot, "fr-1", judge)

        frames = await _drive_stream(bot, "wow very helpful answer 🙄", "fr-1")

        offer = unhelped_offer(live_chat_enabled=True, team_available=True)
        meta = _final_meta(frames)
        assert _answer_text(frames) == "Sorry about that. " + offer.text
        assert meta["suggest_handoff"] is True
        assert classifier.calls == [("wow very helpful answer 🙄", first_reply)]
        assert len(cap["prompts"]) == 1
        cards = _cards(db, "fr-1")
        assert cards.get("handoff_offered") is True
        assert "unhelped_streak" not in cards
        assert _messages(db, "fr-1", role="bot")[-1].is_unanswered is True

    @pytest.mark.asyncio
    async def test_after_the_form_was_offered_it_points_back_at_the_form(self, db, monkeypatch):
        bot, cap, judge, _classifier = _bot(db, monkeypatch, "fr-2", verdict=True)
        monkeypatch.setattr(rs, "detect_handoff_intent", lambda q, **_k: q == "is someone available right now")
        await _drive_stream(bot, "is someone available right now", "fr-2")
        judge.relevant = False

        frames = await _drive_stream(bot, "cool so ill just sit here and get hacked then", "fr-2")

        assert _answer_text(frames) == "Sorry about that. " + handoff_reply(team_available=True, repeat=True)
        assert _final_meta(frames)["suggest_handoff"] is True
        assert cap["prompts"] == []

    @pytest.mark.asyncio
    async def test_live_chat_off_opens_the_message_card(self, db, monkeypatch):
        bot, _cap, judge, _classifier = _bot(db, monkeypatch, "fr-3", live_chat=False, verdict=True)
        await _answered_first(db, bot, "fr-3", judge)

        frames = await _drive_stream(bot, "useless answer", "fr-3")

        meta = _final_meta(frames)
        assert (
            _answer_text(frames)
            == "Sorry about that. " + unhelped_offer(live_chat_enabled=False, team_available=True).text
        )
        assert meta.get("show_leave_message") is True
        assert not meta.get("suggest_handoff")
        assert _cards(db, "fr-3").get("leave_message") is True

    @pytest.mark.asyncio
    async def test_a_plan_with_no_human_never_offers_one(self, db, monkeypatch):
        bot, _cap, judge, _classifier = _bot(db, monkeypatch, "fr-4", support=False, verdict=True)
        await _answered_first(db, bot, "fr-4", judge)

        frames = await _drive_stream(bot, "useless answer", "fr-4")

        meta = _final_meta(frames) or {}
        assert _answer_text(frames) == (
            "Sorry about that. Tell me a little more about what you're looking for, and I'll do my best to help."
        )
        assert not meta.get("suggest_handoff") and not meta.get("show_leave_message")

    @pytest.mark.asyncio
    async def test_when_the_model_says_no_the_refusal_stands(self, db, monkeypatch):
        bot, _cap, judge, classifier = _bot(db, monkeypatch, "fr-5", verdict=False)
        await _answered_first(db, bot, "fr-5", judge)

        frames = await _drive_stream(bot, "wow very helpful answer 🙄", "fr-5")

        assert len(classifier.calls) == 1
        assert rs._is_known_refusal(_answer_text(frames), "Acme"), _answer_text(frames)

    @pytest.mark.asyncio
    async def test_a_turn_the_judge_passed_is_left_to_the_model(self, db, monkeypatch):
        bot, cap, judge, classifier = _bot(db, monkeypatch, "fr-6", verdict=True)
        await _answered_first(db, bot, "fr-6", judge)
        judge.relevant = True

        await _drive_stream(bot, "wow very helpful answer 🙄", "fr-6")

        assert classifier.calls == []
        assert len(cap["prompts"]) == 2
