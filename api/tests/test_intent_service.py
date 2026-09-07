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


# ── detect_handoff_intent (hybrid keyword + LLM) ────────────────────────────

_KEYWORD_MSG = "I want to talk to a human"
_PLAIN_MSG = "what is the weather today"


def _spy_llm(monkeypatch, answer: str) -> list[dict]:
    """Replace the LLM seam with a spy that records every call's kwargs."""
    calls: list[dict] = []

    def fake_generate_response(prompt, **kwargs):
        calls.append({"prompt": prompt, **kwargs})
        return answer

    monkeypatch.setattr(svc, "generate_response", fake_generate_response)
    return calls


class TestHandoffHybrid:
    """A keyword match is the decision. The previous version still asked the
    LLM on a keyword match and then overrode its NO with the keyword result,
    so the LLM call was pure latency and cost on exactly the turns where the
    answer was already known. Every keyword-path test therefore asserts the
    LLM is NOT called."""

    def test_keyword_match_returns_true_without_calling_the_llm(self, monkeypatch):
        calls = _spy_llm(monkeypatch, "YES")
        assert svc.detect_handoff_intent(_KEYWORD_MSG) is True
        assert calls == []

    def test_keyword_match_wins_even_where_the_llm_would_say_no(self, monkeypatch):
        calls = _spy_llm(monkeypatch, "NO")
        assert svc.detect_handoff_intent(_KEYWORD_MSG) is True
        assert calls == []

    def test_keyword_match_is_immune_to_llm_failure(self, monkeypatch):
        def boom(*a, **k):
            raise AssertionError("the LLM must not be consulted on a keyword match")

        monkeypatch.setattr(svc, "generate_response", boom)
        assert svc.detect_handoff_intent(_KEYWORD_MSG) is True

    def test_no_keyword_llm_yes_returns_true(self, monkeypatch):
        calls = _spy_llm(monkeypatch, "YES")
        assert svc.detect_handoff_intent(_PLAIN_MSG) is True
        assert len(calls) == 1

    def test_no_keyword_llm_no_returns_false(self, monkeypatch):
        calls = _spy_llm(monkeypatch, "NO")
        assert svc.detect_handoff_intent(_PLAIN_MSG) is False
        assert len(calls) == 1

    def test_llm_failure_without_keyword_returns_false(self, monkeypatch):
        def boom(*a, **k):
            raise RuntimeError("timeout")

        monkeypatch.setattr(svc, "generate_response", boom)
        assert svc.detect_handoff_intent(_PLAIN_MSG) is False


class TestHandoffLlmRouting:
    """The YES/NO classifier is gate-tier work (AR-10). It ran on the PRIMARY
    model with the default 60s × 3-attempt budget on every turn, awaited by
    ``rag_service`` under a 4s ceiling that a single retry could never meet."""

    def test_llm_call_is_routed_to_the_gate_model_with_a_tight_budget(self, monkeypatch):
        calls = _spy_llm(monkeypatch, "NO")
        monkeypatch.setattr(svc.runtime_config, "get_gate_model", lambda: "gemini/gate-model-under-test")

        svc.detect_handoff_intent(_PLAIN_MSG)

        (call,) = calls
        assert call["model"] == "gemini/gate-model-under-test"
        assert call["timeout"] == 3.0
        assert call["num_retries"] == 0
        assert call["max_tokens"] == 16
        assert call["temperature"] == 0
        assert call["metadata"] == {"generation_name": "handoff-intent-detection"}

    def test_gate_model_is_resolved_per_call_not_at_import(self, monkeypatch):
        """An admin swapping the gate model from the dashboard must take effect
        on the next turn, exactly as it does for the relevance gate."""
        calls = _spy_llm(monkeypatch, "NO")

        monkeypatch.setattr(svc.runtime_config, "get_gate_model", lambda: "model-before-swap")
        svc.detect_handoff_intent(_PLAIN_MSG)
        monkeypatch.setattr(svc.runtime_config, "get_gate_model", lambda: "model-after-swap")
        svc.detect_handoff_intent(_PLAIN_MSG)

        assert [c["model"] for c in calls] == ["model-before-swap", "model-after-swap"]
