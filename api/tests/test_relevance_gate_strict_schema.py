"""Tests for the relevance gate's strict-schema structured output (AR-33).

Before this, the gate used the loose ``json_object`` format with no schema
enforcement — a malformed/wrong-shaped response fell through to the blanket
``except Exception`` and failed open, identically to a chunk that
successfully manipulated the score to 1.0. Combined with AR-18's chunk-
content injection gap, a chunk engineered to break JSON parsing bypassed the
gate exactly like one that manipulated the score directly.
"""

import json
from unittest.mock import MagicMock, patch

from app.services.relevance_gate import check_relevance


def _mock_completion(content: str):
    response = MagicMock()
    response.choices = [MagicMock(message=MagicMock(content=content))]
    return response


class TestStrictSchemaRequest:
    def test_requests_json_schema_strict_mode(self, monkeypatch):
        monkeypatch.setattr("app.services.relevance_gate.cache_get", lambda *_a, **_k: None)
        monkeypatch.setattr("app.services.relevance_gate.cache_set", lambda *_a, **_k: None)
        chunk = MagicMock(content="Our standard plan costs $49/month.")

        with patch("litellm.completion", return_value=_mock_completion(json.dumps({"score": 0.9}))) as mock_completion:
            check_relevance("What does the plan cost?", [chunk], bot_id=1)

        _, kwargs = mock_completion.call_args
        response_format = kwargs["response_format"]
        assert response_format["type"] == "json_schema"
        assert response_format["json_schema"]["strict"] is True
        schema = response_format["json_schema"]["schema"]
        assert schema["properties"]["score"]["type"] == "number"
        assert schema.get("additionalProperties") is False


class TestFailsOpenOnMalformedResponse:
    def test_extra_unexpected_field_fails_open(self, monkeypatch):
        """A response with an extra field the schema forbids must not crash
        the pipeline — falls back to the safe fail-open default."""
        monkeypatch.setattr("app.services.relevance_gate.cache_get", lambda *_a, **_k: None)
        monkeypatch.setattr("app.services.relevance_gate.cache_set", lambda *_a, **_k: None)
        chunk = MagicMock(content="irrelevant")

        malformed = json.dumps({"score": 0.9, "reasoning": "injected extra field"})
        with patch("litellm.completion", return_value=_mock_completion(malformed)):
            is_relevant, score = check_relevance("Q", [chunk], bot_id=1)

        assert (is_relevant, score) == (True, 1.0)

    def test_non_numeric_score_fails_open(self, monkeypatch):
        monkeypatch.setattr("app.services.relevance_gate.cache_get", lambda *_a, **_k: None)
        monkeypatch.setattr("app.services.relevance_gate.cache_set", lambda *_a, **_k: None)
        chunk = MagicMock(content="irrelevant")

        with patch("litellm.completion", return_value=_mock_completion('{"score": "not a number"}')):
            is_relevant, score = check_relevance("Q", [chunk], bot_id=1)

        assert (is_relevant, score) == (True, 1.0)

    def test_malformed_json_fails_open(self, monkeypatch):
        """The exact injection-bypass scenario AR-33 targets: a chunk (or a
        provider hiccup) produces text that isn't valid JSON at all."""
        monkeypatch.setattr("app.services.relevance_gate.cache_get", lambda *_a, **_k: None)
        monkeypatch.setattr("app.services.relevance_gate.cache_set", lambda *_a, **_k: None)
        chunk = MagicMock(content="irrelevant")

        with patch("litellm.completion", return_value=_mock_completion("not json at all {{{")):
            is_relevant, score = check_relevance("Q", [chunk], bot_id=1)

        assert (is_relevant, score) == (True, 1.0)

    def test_out_of_range_score_fails_open_not_silently_clamped(self, monkeypatch):
        """Before AR-33, an out-of-range score was silently clamped via
        max(0.0, min(1.0, score)) — masking a judge that returned a garbage
        value as if it were a legitimate boundary score. The schema's
        ge=0.0/le=1.0 constraint now makes this a validation failure (fails
        open) instead of a silent clamp."""
        monkeypatch.setattr("app.services.relevance_gate.cache_get", lambda *_a, **_k: None)
        monkeypatch.setattr("app.services.relevance_gate.cache_set", lambda *_a, **_k: None)
        chunk = MagicMock(content="irrelevant")

        with patch("litellm.completion", return_value=_mock_completion('{"score": 5.0}')):
            is_relevant, score = check_relevance("Q", [chunk], bot_id=1)

        assert (is_relevant, score) == (True, 1.0)


class TestWellFormedResponseStillWorks:
    def test_valid_score_parses_and_applies_threshold(self, monkeypatch):
        monkeypatch.setattr("app.services.relevance_gate.cache_get", lambda *_a, **_k: None)
        monkeypatch.setattr("app.services.relevance_gate.cache_set", lambda *_a, **_k: None)
        chunk = MagicMock(content="Our standard plan costs $49/month.")

        with patch("litellm.completion", return_value=_mock_completion(json.dumps({"score": 0.9}))):
            is_relevant, score = check_relevance("What does the plan cost?", [chunk], bot_id=1)

        assert is_relevant is True
        assert score == 0.9
