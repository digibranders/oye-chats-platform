"""Regression tests for the 2026-09 answer-path hardening in ``rag_service``.

Each class pins one fix from the AI-system review of that date:

* the shared, per-bot QA cache must never hold personalised or
  context-dependent text (visitor names were being replayed to strangers);
* the English-tuned judges stand down for a non-English-script message on
  ANY bot, not only on a bot with multilingual enabled;
* the strict extraction schema follows the bot's rubric ceiling instead of
  the default preset's 25;
* the qualification counters follow the active framework's dimensions;
* the media-card rulebook is in the prompt only when a catalog is present;
* the request-path LLM helpers degrade on a deadline instead of holding the
  visitor's stream.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from pydantic import ValidationError

from app.services import rag_service as rs

# ── QA cache: personalisation and context guards ─────────────────────────────


class TestAnswerMentionsVisitorName:
    def test_whole_word_case_insensitive(self):
        assert rs._answer_mentions_visitor_name("Sure, priya. Our Pro plan is $49.", "Priya")
        assert rs._answer_mentions_visitor_name("Thanks Al, all good.", "Al")

    def test_substring_of_a_longer_word_does_not_count(self):
        assert not rs._answer_mentions_visitor_name("All plans include support.", "Al")

    def test_initials_are_ignored(self):
        assert not rs._answer_mentions_visitor_name("A plan for every team.", "A")

    def test_empty_inputs(self):
        assert not rs._answer_mentions_visitor_name("", "Priya")
        assert not rs._answer_mentions_visitor_name("Hello", None)


class TestAnswerIsCacheable:
    _BASE = {
        "question": "What do you charge?",
        "visitor_name": None,
        "opener": "",
        "probe_active": False,
        "prior_turns": False,
    }

    def test_plain_impersonal_answer_is_cacheable(self):
        assert rs._answer_is_cacheable(answer="Our Pro plan is $49/month.", **self._BASE)

    def test_by_name_opener_blocks_caching(self):
        assert not rs._answer_is_cacheable(
            answer="Thanks, Priya!\n\nOur Pro plan is $49/month.", **{**self._BASE, "opener": "Thanks, Priya!\n\n"}
        )

    def test_probe_turn_blocks_caching(self):
        # The probing instruction asks the model to reflect a concrete fact the
        # visitor just stated; that text belongs to one conversation only.
        assert not rs._answer_is_cacheable(
            answer="Two months is a comfortable runway.", **{**self._BASE, "probe_active": True}
        )

    def test_follow_up_shaped_question_blocks_caching_once_there_is_history(self):
        assert not rs._answer_is_cacheable(
            answer="It costs $49.", **{**self._BASE, "question": "tell me more about it", "prior_turns": True}
        )

    def test_follow_up_shaped_first_turn_still_caches(self):
        # "How much does it cost?" as an opening message has nothing for "it"
        # to refer back to; it is the plain FAQ the cache exists for.
        assert rs._answer_is_cacheable(
            answer="Pro is $49/month.", **{**self._BASE, "question": "how much does it cost?"}
        )

    def test_answer_using_the_visitor_name_blocks_caching(self):
        assert not rs._answer_is_cacheable(
            answer="Sure Priya, the Pro plan is $49/month.", **{**self._BASE, "visitor_name": "Priya"}
        )

    def test_known_name_that_the_answer_does_not_use_still_caches(self):
        assert rs._answer_is_cacheable(answer="The Pro plan is $49/month.", **{**self._BASE, "visitor_name": "Priya"})


class TestLooksLikeFollowUp:
    @pytest.mark.parametrize(
        "question",
        ["tell me more about it", "how about pricing?", "who is he?", "and the timeline?", "What about them"],
    )
    def test_context_dependent_questions(self, question):
        assert rs._looks_like_follow_up(question)

    @pytest.mark.parametrize("question", ["What's your price?", "Do you offer SEO services?", "office hours", ""])
    def test_standalone_questions(self, question):
        assert not rs._looks_like_follow_up(question)


# ── Non-English judge bypass ─────────────────────────────────────────────────


class TestEnglishJudgesBypassed:
    def test_english_question_on_a_disabled_bot_keeps_the_judges(self):
        assert not rs._english_judges_bypassed(None, "What services do you offer?")

    def test_devanagari_question_on_a_disabled_bot_skips_the_judges(self):
        assert rs._english_judges_bypassed(None, "आपकी सेवाएं क्या हैं?")

    def test_romanised_hinglish_is_latin_and_keeps_the_judges(self):
        # Script detection is Latin-blind by design; the fix is scoped to what
        # it can see, and English traffic stays byte-identical.
        assert not rs._english_judges_bypassed(None, "aapki services kya hain")

    def test_devanagari_on_an_english_settled_session_skips_the_judges(self):
        assert rs._english_judges_bypassed(SimpleNamespace(language="en", locale="en-IN"), "कीमत क्या है?")

    def test_non_english_session_skips_regardless_of_script(self):
        assert rs._english_judges_bypassed(SimpleNamespace(language="hi", locale="hi-IN"), "price?")

    def test_single_stray_glyph_is_not_trusted(self):
        assert not rs._english_judges_bypassed(None, "price of the प plan")


# ── Extraction schema follows the rubric ceiling ─────────────────────────────


class TestExtractionResultModel:
    def test_default_ceiling_returns_the_module_class(self):
        assert rs._extraction_result_model(25) is rs.QualificationExtractionResult

    def test_custom_ceiling_is_emitted_into_the_strict_schema(self):
        schema = rs._extraction_result_model(100).model_json_schema()
        props = schema["$defs"]["QualificationSignalExtraction"]["properties"]
        assert props["score"]["maximum"] == 100
        assert schema["$defs"]["QualificationSignalExtraction"]["additionalProperties"] is False
        assert schema["additionalProperties"] is False

    def test_same_ceiling_is_cached(self):
        assert rs._extraction_result_model(60) is rs._extraction_result_model(60)

    def test_parse_accepts_scores_above_the_default_ceiling(self):
        payload = (
            '{"signals": [{"dimension": "budget", "signal_text": "50k approved", '
            '"extracted_value": "$50k", "confidence": "high", "score": 80}]}'
        )
        signals = rs._parse_qualification_signals(payload, rs._extraction_result_model(100))
        assert signals[0]["score"] == 80

    def test_parse_still_rejects_scores_above_the_rubric(self):
        payload = (
            '{"signals": [{"dimension": "budget", "signal_text": "x", '
            '"extracted_value": "x", "confidence": "high", "score": 101}]}'
        )
        with pytest.raises(ValidationError):
            rs._parse_qualification_signals(payload, rs._extraction_result_model(100))


# ── Framework-aware qualification counters ───────────────────────────────────


_MEDDIC_CONFIG = {
    "framework": "meddic",
    "conversation_order": ["metrics", "champion", "decision_criteria"],
    "metrics": {"label": "Metrics", "options": [{"label": "Clear KPI", "score": 25}]},
    "champion": {"label": "Champion", "options": [{"label": "Named", "score": 25}]},
    "decision_criteria": {"label": "Decision criteria", "options": []},
}


class TestCountMarkedDimensions:
    def test_without_config_counts_the_legacy_bant_four(self):
        state = {"need": "CRM", "need_score": 10, "budget": None, "budget_score": 0, "metrics_score": 25}
        assert rs._count_marked_bant_dimensions(state) == 1

    def test_framework_config_counts_its_own_dimensions(self):
        # A MEDDIC bot: its signals live under its own dimension names and the
        # legacy BANT keys (always present in the state dict) must not count.
        state = {
            "need": "CRM",
            "need_score": 10,
            "metrics": "Cut churn 20%",
            "metrics_score": 25,
            "champion": "CTO",
            "champion_score": 25,
        }
        assert rs._count_marked_bant_dimensions(state, _MEDDIC_CONFIG) == 2

    def test_empty_state(self):
        assert rs._count_marked_bant_dimensions(None, _MEDDIC_CONFIG) == 0


# ── Media rulebook only when a catalog is present ────────────────────────────


class TestMediaRulebookGating:
    _CLIENT = type("C", (), {"name": "Acme Corp"})()

    def test_no_catalog_means_no_media_rules(self):
        system, _user = rs.build_hybrid_prompt(
            self._CLIENT,
            "What do you offer?",
            "<<<DOCUMENT 1 | services.md>>>\nWe offer SEO.\n<<<END DOCUMENT 1>>>",
            "",
        )
        assert "MEDIA CARDS (inline cards" not in system

    def test_catalog_present_keeps_the_media_rules(self):
        context = "<<<DOCUMENT 1 | a.md>>>\nx\n<<<END DOCUMENT 1>>>\n" + rs._build_media_catalog(
            [{"youtube": [{"video_id": "abc123XYZ00", "url": "https://youtu.be/abc123XYZ00", "title": "Intro"}]}]
        )
        assert rs._MEDIA_CATALOG_MARKER in context
        system, _user = rs.build_hybrid_prompt(self._CLIENT, "Do you have a video?", context, "")
        assert "MEDIA CARDS:" in system


# ── Deadlines on request-path helpers ────────────────────────────────────────


class TestBoundedHelpers:
    @pytest.mark.asyncio
    async def test_await_rewrite_returns_raw_question_on_deadline(self, monkeypatch):
        monkeypatch.setattr(rs, "_QUERY_REWRITE_TIMEOUT_S", 0.05)
        slow = asyncio.create_task(asyncio.sleep(5, result="rewritten"))
        with patch.object(rs, "_safety_net_metric") as metric:
            assert await rs._await_rewrite(slow, "and pricing?") == "and pricing?"
        metric.assert_called_once_with("query_rewrite_timeout")

    @pytest.mark.asyncio
    async def test_await_rewrite_returns_the_rewrite_when_in_time(self, monkeypatch):
        monkeypatch.setattr(rs, "_QUERY_REWRITE_TIMEOUT_S", 1.0)
        fast = asyncio.create_task(asyncio.sleep(0, result="pricing of the Pro plan"))
        assert await rs._await_rewrite(fast, "and pricing?") == "pricing of the Pro plan"

    @pytest.mark.asyncio
    async def test_handoff_deadline_degrades_to_keyword_signal(self, monkeypatch):
        import time

        monkeypatch.setattr(rs, "_HANDOFF_INTENT_TIMEOUT_S", 0.05)
        monkeypatch.setattr(rs, "detect_handoff_intent", lambda q, **_kw: (time.sleep(0.5), False)[1])
        monkeypatch.setattr(rs, "detect_handoff_intent_keywords", lambda q: True)
        assert await rs._detect_handoff_bounded("connect me with your team") is True

    @pytest.mark.asyncio
    async def test_handoff_classifier_result_is_used_when_in_time(self, monkeypatch):
        monkeypatch.setattr(rs, "_HANDOFF_INTENT_TIMEOUT_S", 1.0)
        monkeypatch.setattr(rs, "detect_handoff_intent", lambda q, **_kw: True)
        monkeypatch.setattr(rs, "detect_handoff_intent_keywords", lambda q: False)
        assert await rs._detect_handoff_bounded("I want a human") is True


# ── Qualified-lead email rows follow the active framework ───────────────────


class TestQualificationRows:
    @staticmethod
    def _session(**dimension_scores):
        return SimpleNamespace(
            bant_need="CRM migration",
            bant_timeline=None,
            bant_authority=None,
            bant_budget=None,
            bant_need_score=10,
            bant_budget_score=0,
            bant_authority_score=0,
            bant_timeline_score=0,
            dimension_scores=dimension_scores or None,
        )

    def test_meddic_bot_renders_its_own_dimensions_in_conversation_order(self):
        rows = rs._qualification_rows(self._session(metrics={"value": "Cut churn 20%", "score": 25}), _MEDDIC_CONFIG)
        assert rows == [("Metrics", "Cut churn 20%"), ("Champion", None), ("Decision criteria", None)]

    def test_bant_bot_without_config_renders_the_legacy_four(self):
        rows = rs._qualification_rows(self._session(), None)
        assert [label for label, _ in rows] == ["Budget", "Authority", "Need", "Timeline"]
        assert dict(rows)["Need"] == "CRM migration"

    def test_framework_display_names(self):
        assert rs._framework_display_name(_MEDDIC_CONFIG) == "MEDDIC"
        assert rs._framework_display_name(None) == "BANT"
        assert rs._framework_display_name({"framework": "gpctba_ci"}) == "GPCTBA/C&I"
        assert rs._framework_display_name({"framework": "custom_x"}) == "CUSTOM_X"
