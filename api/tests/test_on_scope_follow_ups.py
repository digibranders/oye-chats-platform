"""On-scope turns still refused as off-topic in the 2026-09-17 evaluation.

Defect 2 of the review (production commit 54a3b9f9, CleanStart and Eventus):

* "do you have a reseller program" was answered, then "whats the margin for
  channel partners" got the scope line on both bots;
* "do u offer internships" was answered, then "paid or unpaid? and is remote
  ok" got the scope line on both bots, although the judge read it beside the
  internships reply: retrieval had searched the fragment's own words, so no
  chunk bore on it;
* "d'accord, et c'est disponible en France ?" after a product answer got the
  scope line;
* "what certifications do you have" got the scope line on a bot whose knowledge
  base says it is CERT-In empanelled.

The pipeline cases reuse the harness of ``test_conversational_turns_pipeline``,
whose judge refuses whenever told to.
"""

from __future__ import annotations

import pytest

from app.services import rag_service as rs
from app.services.relevance_gate import ConversationContext, _build_gate_prompt
from tests.test_conversational_turns_pipeline import _answered_first, _bot
from tests.test_rag_pipeline_defects import _answer_text, _drive_stream

_COMPANY = "Eventus Security"


class TestPartnershipQuestionsAreOnScope:
    @pytest.mark.parametrize(
        "question",
        [
            "whats the margin for channel partners",
            "do you have a reseller program",
            "can i resell your services",
            "is there a referral program",
            "do you offer white label soc",
            "how do i become a partner",
        ],
    )
    def test_on_scope(self, question):
        assert rs._question_is_clearly_on_scope(question, _COMPANY) is True


class TestCredentialQuestionsAreOnScope:
    @pytest.mark.parametrize(
        "question",
        [
            "what certifications do you have",
            "which certifications do u hold",
            "what accreditations does your company have",
            "are you cert-in empanelled",
            "any awards do you have",
            "do you hold iso 27001",
        ],
    )
    def test_on_scope(self, question):
        assert rs._question_is_clearly_on_scope(question, _COMPANY) is True

    @pytest.mark.parametrize(
        "question",
        [
            "what certifications do i need to become a pentester",
            "can you explain what gdpr is",
            "is it legal to scrape linkedin under gdpr",
        ],
    )
    def test_a_general_question_stays_unknown(self, question):
        assert rs._question_is_clearly_on_scope(question, _COMPANY) is False


class TestAContinuation:
    @pytest.mark.parametrize(
        "question",
        [
            "paid or unpaid? and is remote ok",
            "paid or unpaid?",
            "d'accord, et c'est disponible en France ?",
            "ok and for startups",
            "got it, but what about weekends",
        ],
    )
    def test_continues(self, question):
        assert rs._continues_the_conversation(question) is True

    @pytest.mark.parametrize(
        "question",
        [
            "what is the capital of france",
            "write me a poem",
            "whats the weather",
            "brandon sanderson books",
            "",
        ],
    )
    def test_starts_something_new(self, question):
        assert rs._continues_the_conversation(question) is False

    def test_linear_on_long_input(self):
        import time

        started = time.perf_counter()
        for text in ("a or " * 5000, ", and" * 4000, "x" * 20_000 + " or"):
            rs._continues_the_conversation(text)
        assert time.perf_counter() - started < 0.5


class TestTheJudgeScoresAFollowUpOnItsSubject:
    def test_the_rule_is_in_the_conversation_block_only(self):
        context = ConversationContext(
            previous_reply="We have open roles on our careers page, including internships.",
            visitor_message="paid or unpaid? and is remote ok",
        )
        with_context = _build_gate_prompt("paid or unpaid? and is remote ok", [], context=context)
        without = _build_gate_prompt("paid or unpaid? and is remote ok", [])

        assert "miss the subject a follow-up leaves out" in with_context
        assert "scores at least 0.5" in with_context
        assert "miss the subject a follow-up leaves out" not in without


class TestThePipeline:
    @pytest.mark.asyncio
    async def test_the_partner_margin_follow_up_reaches_the_model(self, db, monkeypatch):
        bot, cap, judge, _classifier = _bot(db, monkeypatch, "osf-1")
        await _answered_first(db, bot, "osf-1", judge, question="do you have a reseller program")

        frames = await _drive_stream(bot, "whats the margin for channel partners", "osf-1")

        assert len(cap["prompts"]) == 2, "the follow-up reached generation"
        assert not rs._is_known_refusal(_answer_text(frames), "Acme")

    @pytest.mark.asyncio
    async def test_the_certifications_question_reaches_the_model(self, db, monkeypatch):
        bot, cap, judge, _classifier = _bot(db, monkeypatch, "osf-2")
        judge.relevant = False

        await _drive_stream(bot, "what certifications do you have", "osf-2")

        assert len(cap["prompts"]) == 1

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        ("session_id", "question"),
        [("osf-3", "paid or unpaid? and is remote ok"), ("osf-4", "d'accord, et c'est disponible en France ?")],
    )
    async def test_a_rejected_continuation_gets_the_pivot_not_the_scope_line(
        self, db, monkeypatch, session_id, question
    ):
        bot, cap, judge, _classifier = _bot(db, monkeypatch, session_id, support=False)
        await _answered_first(db, bot, session_id, judge, question="do u offer internships")

        frames = await _drive_stream(bot, question, session_id)

        answer = _answer_text(frames)
        assert judge.calls[-1].context is not None, "precondition: judged in context"
        assert answer.endswith(rs._no_info_pivot("Acme", support_enabled=False)), answer
        assert not rs._is_known_refusal(answer, "Acme")
        assert len(cap["prompts"]) == 1

    @pytest.mark.asyncio
    async def test_an_unrelated_fragment_after_an_answer_is_still_refused(self, db, monkeypatch):
        bot, cap, judge, _classifier = _bot(db, monkeypatch, "osf-5", support=False)
        await _answered_first(db, bot, "osf-5", judge)

        frames = await _drive_stream(bot, "what is the capital of france", "osf-5")

        answer = _answer_text(frames)
        assert rs._no_info_pivot("Acme", support_enabled=False) not in answer
        assert len(cap["prompts"]) == 1
