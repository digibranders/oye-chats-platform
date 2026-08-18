"""Tests for ``app.services.intent_service``. Sales + handoff intent detection.

The LLM call (``generate_response``) is monkeypatched at the module seam so the
branch logic is exercised deterministically. The keyword regex is pure and is
tested directly. Every hybrid branch is covered so a test fails if any decision
is inverted.
"""

import pytest

from app.services import intent_service as svc

# ── detect_handoff_intent_keywords (pure regex) ─────────────────────────────


class TestHandoffKeywords:
    @pytest.mark.parametrize(
        "message",
        [
            "I want to talk to a human",
            "connect me with your team",
            "can I speak to someone?",
            "get me an agent",
            "let me talk to a rep",
            "I need a real person",
            "please escalate this",
            "transfer me to support",
            "how can I connect with the team?",
            "leave a message for the team",
            "I want to send a message to you",
            "give me a real human please",
        ],
    )
    def test_positive_phrases_match(self, message):
        assert svc.detect_handoff_intent_keywords(message) is True

    @pytest.mark.parametrize(
        "message",
        [
            "What is your pricing?",
            "hello there",
            "how do I reset my password",
            "does your product support webhooks",
            "",
            "tell me about your features",
        ],
    )
    def test_negative_phrases_do_not_match(self, message):
        assert svc.detect_handoff_intent_keywords(message) is False

    def test_noisy_whitespace_still_matches(self):
        # The regex uses \s+ so extra spaces between tokens still match.
        assert svc.detect_handoff_intent_keywords("talk   to    a   human") is True


# ── detect_sales_intent (LLM) ───────────────────────────────────────────────


class TestSalesIntent:
    def test_yes_response_is_true(self, monkeypatch):
        monkeypatch.setattr(svc, "generate_response", lambda *a, **k: "YES")
        assert svc.detect_sales_intent("what are your plans?") is True

    def test_no_response_is_false(self, monkeypatch):
        monkeypatch.setattr(svc, "generate_response", lambda *a, **k: "NO")
        assert svc.detect_sales_intent("what is the weather?") is False

    def test_response_is_case_and_whitespace_insensitive(self, monkeypatch):
        monkeypatch.setattr(svc, "generate_response", lambda *a, **k: "  yes\n")
        assert svc.detect_sales_intent("pricing?") is True

    def test_yes_embedded_in_longer_answer_counts(self, monkeypatch):
        # Parsing looks for the substring "YES" after upper()/strip().
        monkeypatch.setattr(svc, "generate_response", lambda *a, **k: "Definitely YES")
        assert svc.detect_sales_intent("can I get a demo?") is True

    def test_llm_exception_degrades_to_false(self, monkeypatch):
        def boom(*a, **k):
            raise RuntimeError("llm down")

        monkeypatch.setattr(svc, "generate_response", boom)
        assert svc.detect_sales_intent("pricing?") is False


# ── detect_handoff_intent (hybrid keyword + LLM) ────────────────────────────

_KEYWORD_MSG = "I want to talk to a human"
_PLAIN_MSG = "what is the weather today"


class TestHandoffHybrid:
    def test_keyword_and_llm_yes_returns_true(self, monkeypatch):
        monkeypatch.setattr(svc, "generate_response", lambda *a, **k: "YES")
        assert svc.detect_handoff_intent(_KEYWORD_MSG) is True

    def test_keyword_match_overrides_llm_no(self, monkeypatch):
        # Explicit keyword signal must win even when the LLM declines.
        monkeypatch.setattr(svc, "generate_response", lambda *a, **k: "NO")
        assert svc.detect_handoff_intent(_KEYWORD_MSG) is True

    def test_no_keyword_llm_yes_returns_true(self, monkeypatch):
        monkeypatch.setattr(svc, "generate_response", lambda *a, **k: "YES")
        assert svc.detect_handoff_intent(_PLAIN_MSG) is True

    def test_no_keyword_llm_no_returns_false(self, monkeypatch):
        monkeypatch.setattr(svc, "generate_response", lambda *a, **k: "NO")
        assert svc.detect_handoff_intent(_PLAIN_MSG) is False

    def test_llm_failure_with_keyword_trusts_keyword(self, monkeypatch):
        def boom(*a, **k):
            raise RuntimeError("timeout")

        monkeypatch.setattr(svc, "generate_response", boom)
        assert svc.detect_handoff_intent(_KEYWORD_MSG) is True

    def test_llm_failure_without_keyword_returns_false(self, monkeypatch):
        def boom(*a, **k):
            raise RuntimeError("timeout")

        monkeypatch.setattr(svc, "generate_response", boom)
        assert svc.detect_handoff_intent(_PLAIN_MSG) is False
