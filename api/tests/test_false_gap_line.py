"""The gap line given to questions the conversation or the knowledge base answers.

Reported from the 2026-09-17 evaluation on two production bots (CleanStart and
Eventus Security). Each of these got the canned "I don't have that detail here.
Want me to loop in the <company> team on this?" because the relevance judge
rejected the turn and nothing overruled it:

* "the third one. how exactly do u help them" right after the bot listed four
  industries;
* "sorry not hospital, we are a bank. what changes" after an answer written for
  a hospital (both bots);
* "so which one am i talking to" after a question about a similarly named
  company: the bot's own identity is in its configuration;
* "why should i pay, cant i just use free open source tools for this", a value
  question the site answers.

"whats the hr mail id" was the model's own gap: the careers address sits on the
contact page, which a contact question now pins.

The pipeline cases reuse the harness of ``test_conversational_turns_pipeline``,
whose judge refuses whenever told to.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from app.services import rag_service as rs
from tests.test_conversational_turns_pipeline import _answered_first, _bot
from tests.test_rag_pipeline_defects import _answer_text, _drive_stream

_COMPANY = "CleanStart"


class TestAReferenceToAnEarlierTurn:
    @pytest.mark.parametrize(
        "question",
        [
            "the third one. how exactly do u help them",
            "the last one",
            "tell me about the second option",
            "what about the 2nd one?",
            "the latter please",
            "sorry not hospital, we are a bank. what changes",
            "sorry i meant we are a bank, not insurance",
            "i meant banks",
            "actually we're a bank",
            "we are a bank, not an insurer",
            "not a hospital, a bank",
        ],
    )
    def test_refers_back(self, question):
        assert rs._refers_to_an_earlier_turn(question) is True

    @pytest.mark.parametrize(
        "question",
        [
            "what is the capital of france",
            "what's the first step to get started",
            "who won the second world war",
            "we are a bank",
            "not sure",
            "is it a one time payment",
            "",
        ],
    )
    def test_stands_alone(self, question):
        assert rs._refers_to_an_earlier_turn(question) is False

    def test_a_correction_is_rewritten_against_the_conversation(self):
        assert rs._looks_like_follow_up("sorry not hospital, we are a bank. what changes") is True

    def test_linear_on_long_input(self):
        import time

        started = time.perf_counter()
        for text in ("not " * 5000, "we are " * 4000, "the third " * 4000, "sorry " + "x " * 10_000):
            rs._refers_to_an_earlier_turn(text)
            rs._asks_which_business_this_is(text, _COMPANY)
        assert time.perf_counter() - started < 0.5


class TestAnIdentityQuestion:
    @pytest.mark.parametrize(
        "question",
        [
            "so which one am i talking to",
            "who am i talking to?",
            "which company is this",
            "who are you",
            "is this cleanstart or eventus",
            "who do you work for",
        ],
    )
    def test_asks_which_business_this_is(self, question):
        assert rs._asks_which_business_this_is(question, _COMPANY) is True

    @pytest.mark.parametrize(
        "question",
        [
            "who are your clients",
            "which one is cheaper",
            "who are you partnered with",
            "is this free or paid",
            "is this eventus or globex",
            "what is the capital of france",
            "",
        ],
    )
    def test_other_questions_are_not(self, question):
        assert rs._asks_which_business_this_is(question, _COMPANY) is False


class TestValueAndCareersQuestionsAreOnScope:
    @pytest.mark.parametrize(
        "question",
        [
            "why should i pay, cant i just use free open source tools for this",
            "why should we pay for this",
            "can't we just use open-source scanners instead",
            "want to apply for soc analyst l1 role, whats the hr mail id",
            "careers email?",
            "what is the hr email address",
        ],
    )
    def test_on_scope(self, question):
        assert rs._question_is_clearly_on_scope(question, _COMPANY) is True

    @pytest.mark.parametrize(
        "question",
        [
            "is open source software free",
            "how do i write a good email to hr",
            "what is the capital of france",
        ],
    )
    def test_a_general_question_stays_unknown(self, question):
        assert rs._question_is_clearly_on_scope(question, _COMPANY) is False

    def test_an_hr_address_question_pins_the_contact_pages(self):
        assert rs._asks_company_facts("whats the hr mail id", _COMPANY) == frozenset({"contact"})


class TestTheGapRule:
    def test_the_gap_line_is_only_for_a_fact_the_conversation_lacks_too(self):
        prompt, _user = rs.build_hybrid_prompt(
            SimpleNamespace(name="Acme", id=1), "the third one", "", "USER: hi\nBOT: hello", company_name="Acme"
        )

        assert "absent from both the REFERENCE INFORMATION and the CONVERSATION HISTORY" in prompt
        assert "never for an item you already listed" in prompt


class TestThePipeline:
    @pytest.mark.asyncio
    async def test_the_third_one_after_a_list_reaches_the_model(self, db, monkeypatch):
        bot, cap, judge, _classifier = _bot(db, monkeypatch, "fgl-1", support=False)
        await _answered_first(db, bot, "fgl-1", judge, question="which industries do you work with")

        frames = await _drive_stream(bot, "the third one. how exactly do u help them", "fgl-1")

        answer = _answer_text(frames)
        assert len(cap["prompts"]) == 2, "the follow-up reached generation"
        assert rs._no_info_pivot("Acme", support_enabled=False) not in answer
        assert judge.calls[-1].context is not None, "judged beside the list it points at"

    @pytest.mark.asyncio
    async def test_an_industry_correction_reaches_the_model_judged_in_context(self, db, monkeypatch):
        bot, cap, judge, _classifier = _bot(db, monkeypatch, "fgl-2", support=False)
        await _answered_first(
            db, bot, "fgl-2", judge, question="we are a hospital looking at hardened container images"
        )

        frames = await _drive_stream(bot, "sorry not hospital, we are a bank. what changes", "fgl-2")

        answer = _answer_text(frames)
        assert len(cap["prompts"]) == 2
        assert rs._no_info_pivot("Acme", support_enabled=False) not in answer
        assert judge.calls[-1].context is not None

    @pytest.mark.asyncio
    async def test_which_one_am_i_talking_to_reaches_the_model(self, db, monkeypatch):
        bot, cap, judge, _classifier = _bot(db, monkeypatch, "fgl-3", support=False)
        await _answered_first(db, bot, "fgl-3", judge, question="are acme and globex the same company?")

        frames = await _drive_stream(bot, "so which one am i talking to", "fgl-3")

        assert len(cap["prompts"]) == 2
        assert rs._no_info_pivot("Acme", support_enabled=False) not in _answer_text(frames)

    @pytest.mark.asyncio
    async def test_an_identity_question_is_answered_with_nothing_retrieved(self, db, monkeypatch):
        """The answer is the bot's own configuration, so an empty retrieval is no
        reason to withhold it."""
        bot, cap, judge, _classifier = _bot(db, monkeypatch, "fgl-4", support=False)
        monkeypatch.setattr(rs, "reciprocal_rank_fusion", lambda *a, **k: [])

        frames = await _drive_stream(bot, "who am i talking to?", "fgl-4")

        assert len(cap["prompts"]) == 1
        assert rs._no_info_pivot("Acme", support_enabled=False) not in _answer_text(frames)
        system_prompt, _user_prompt = cap["prompts"][0]
        assert "Acme" in (system_prompt or "")

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        ("session_id", "question"),
        [
            ("fgl-5", "why should i pay, cant i just use free open source tools for this"),
            ("fgl-6", "want to apply for soc analyst l1 role, whats the hr mail id"),
        ],
    )
    async def test_a_value_or_careers_question_the_judge_rejects_reaches_the_model(
        self, db, monkeypatch, session_id, question
    ):
        bot, cap, judge, _classifier = _bot(db, monkeypatch, session_id, support=False)
        judge.relevant = False

        frames = await _drive_stream(bot, question, session_id)

        assert len(cap["prompts"]) == 1
        assert rs._no_info_pivot("Acme", support_enabled=False) not in _answer_text(frames)

    @pytest.mark.asyncio
    async def test_an_ordinal_with_no_earlier_reply_is_still_judged(self, db, monkeypatch):
        """With no reply to point at, "the third one" names nothing, so the judge's
        refusal stands."""
        bot, cap, judge, _classifier = _bot(db, monkeypatch, "fgl-7", support=False)
        judge.relevant = False

        await _drive_stream(bot, "the third one", "fgl-7")

        assert cap["prompts"] == []

    @pytest.mark.asyncio
    async def test_an_unrelated_question_after_an_answer_is_still_refused(self, db, monkeypatch):
        bot, cap, judge, _classifier = _bot(db, monkeypatch, "fgl-8", support=False)
        await _answered_first(db, bot, "fgl-8", judge)

        frames = await _drive_stream(bot, "what is the capital of france", "fgl-8")

        assert len(cap["prompts"]) == 1
        assert rs._no_info_pivot("Acme", support_enabled=False) not in _answer_text(frames)
