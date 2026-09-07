"""Tests for the post-generation groundedness gate (AR-12).

Mirrors test_relevance_gate_model_config.py's mocking style, no real
network/API calls, litellm.completion is mocked throughout.

The judge now uses the same strict ``json_schema`` structured output as the
relevance gate (AR-33) instead of the loose ``json_object`` format, and its
input size is governed by ``GROUNDEDNESS_MAX_CHUNKS`` /
``GROUNDEDNESS_CHUNK_PREVIEW_CHARS`` rather than a hardcoded 3 × 500.
"""

import importlib
import json
from unittest.mock import MagicMock, patch

import pytest

import app.services.groundedness_gate as groundedness_gate
from app.services.groundedness_gate import check_groundedness, should_sample


def _mock_completion(score: float):
    response = MagicMock()
    response.choices = [MagicMock(message=MagicMock(content=json.dumps({"score": score})))]
    return response


class TestCheckGroundedness:
    def test_high_score_is_grounded(self):
        chunk = MagicMock(content="Our standard plan costs $49/month.")
        with patch("litellm.completion", return_value=_mock_completion(0.9)):
            is_grounded, score = check_groundedness("What's the price?", "It costs $49/month.", [chunk])
        assert is_grounded is True
        assert score == 0.9

    def test_low_score_is_not_grounded(self):
        """The fabrication scenario: answer invents a fact not in the chunks."""
        chunk = MagicMock(content="Our standard plan costs $49/month.")
        with patch("litellm.completion", return_value=_mock_completion(0.1)):
            is_grounded, score = check_groundedness(
                "What's the price?", "It costs $999/month and includes a free car.", [chunk]
            )
        assert is_grounded is False
        assert score == 0.1

    def test_fails_open_on_llm_error(self):
        """A slow/flaky judge call must never be mistaken for a hallucination
        . This check is observability-only, so failing open costs nothing
         but a missed metric point."""
        chunk = MagicMock(content="Our standard plan costs $49/month.")
        with patch("litellm.completion", side_effect=TimeoutError("gate timed out")):
            is_grounded, score = check_groundedness("What's the price?", "It costs $49/month.", [chunk])
        assert is_grounded is True
        assert score == 1.0

    def test_fails_open_on_malformed_json(self):
        chunk = MagicMock(content="content")
        response = MagicMock()
        response.choices = [MagicMock(message=MagicMock(content="not valid json"))]
        with patch("litellm.completion", return_value=response):
            is_grounded, score = check_groundedness("Q", "A", [chunk])
        assert is_grounded is True
        assert score == 1.0

    def test_empty_answer_short_circuits_without_llm_call(self):
        with patch("litellm.completion") as mock_completion:
            is_grounded, score = check_groundedness("Q", "", [])
        assert is_grounded is True
        assert score == 1.0
        mock_completion.assert_not_called()

    def test_disabled_short_circuits_without_llm_call(self):
        with (
            patch("app.services.groundedness_gate.GROUNDEDNESS_CHECK_ENABLED", False),
            patch("litellm.completion") as mock_completion,
        ):
            is_grounded, score = check_groundedness("Q", "a real answer", [MagicMock(content="x")])
        assert is_grounded is True
        mock_completion.assert_not_called()

    def test_uses_gate_tier_model_not_primary(self):
        chunk = MagicMock(content="content")
        with (
            patch("app.services.runtime_config.get_gate_model", return_value="gemini/gemini-2.5-flash"),
            patch("litellm.completion", return_value=_mock_completion(0.9)) as mock_completion,
        ):
            check_groundedness("Q", "A", [chunk])
        assert mock_completion.call_args.kwargs["model"] == "gemini/gemini-2.5-flash"

    def test_out_of_range_score_fails_open_not_silently_clamped(self, caplog):
        """Before the strict schema an out-of-range verdict was clamped via
        max(0.0, min(1.0, score)), turning a judge that returned garbage into
        a "legitimate" boundary metric point. The schema's ge/le bounds make
        it a validation failure: fail open, and say so."""
        import logging

        chunk = MagicMock(content="content")
        with (
            caplog.at_level(logging.WARNING, logger="app.services.groundedness_gate"),
            patch("litellm.completion", return_value=_mock_completion(5.0)),
        ):
            is_grounded, score = check_groundedness("Q", "A", [chunk])
        assert (is_grounded, score) == (True, 1.0)
        assert any("fail-open" in record.message for record in caplog.records)


class TestStrictSchemaRequest:
    """Same contract as ``test_relevance_gate_strict_schema``: the provider is
    held to a schema, so no generated text can force a parse-exception
    fail-open that looks identical to a manipulated score."""

    def test_requests_json_schema_strict_mode(self):
        chunk = MagicMock(content="Our standard plan costs $49/month.")
        with patch("litellm.completion", return_value=_mock_completion(0.9)) as mock_completion:
            check_groundedness("What's the price?", "It costs $49/month.", [chunk])

        response_format = mock_completion.call_args.kwargs["response_format"]
        assert response_format["type"] == "json_schema"
        assert response_format["json_schema"]["strict"] is True
        assert response_format["json_schema"]["name"] == "GroundednessScoreResult"
        schema = response_format["json_schema"]["schema"]
        assert schema["properties"]["score"]["type"] == "number"
        assert schema["properties"]["score"]["minimum"] == 0.0
        assert schema["properties"]["score"]["maximum"] == 1.0
        assert schema["required"] == ["score"]
        assert schema.get("additionalProperties") is False

    def test_extra_unexpected_field_fails_open(self):
        chunk = MagicMock(content="content")
        response = MagicMock()
        response.choices = [
            MagicMock(message=MagicMock(content=json.dumps({"score": 0.9, "reasoning": "injected extra field"})))
        ]
        with patch("litellm.completion", return_value=response):
            assert check_groundedness("Q", "A", [chunk]) == (True, 1.0)

    def test_non_numeric_score_fails_open(self):
        chunk = MagicMock(content="content")
        response = MagicMock()
        response.choices = [MagicMock(message=MagicMock(content='{"score": "not a number"}'))]
        with patch("litellm.completion", return_value=response):
            assert check_groundedness("Q", "A", [chunk]) == (True, 1.0)

    def test_missing_score_fails_open_instead_of_defaulting_to_grounded(self):
        """The loose parser read ``data.get("score", 1.0)``, so ``{}`` scored a
        perfect 1.0. A verdict with no score is not a verdict."""
        chunk = MagicMock(content="content")
        response = MagicMock()
        response.choices = [MagicMock(message=MagicMock(content="{}"))]
        with patch("litellm.completion", return_value=response):
            assert check_groundedness("Q", "A", [chunk]) == (True, 1.0)


class TestJudgeInputKnobs:
    def test_defaults(self):
        assert groundedness_gate.GROUNDEDNESS_MAX_CHUNKS == 5
        assert groundedness_gate.GROUNDEDNESS_CHUNK_PREVIEW_CHARS == 500

    def test_prompt_shows_five_chunks_of_500_characters(self, monkeypatch):
        monkeypatch.setattr(groundedness_gate, "GROUNDEDNESS_MAX_CHUNKS", 5)
        monkeypatch.setattr(groundedness_gate, "GROUNDEDNESS_CHUNK_PREVIEW_CHARS", 500)
        chunks = [MagicMock(content=str(i) * 800) for i in range(1, 8)]

        prompt = groundedness_gate._build_groundedness_prompt("q", "a", chunks)

        assert "Chunk 5: " in prompt
        assert "Chunk 6: " not in prompt
        first = next(line for line in prompt.splitlines() if line.startswith("Chunk 1: "))
        assert len(first) == len("Chunk 1: ") + 500

    def test_knobs_are_read_at_call_time(self, monkeypatch):
        monkeypatch.setattr(groundedness_gate, "GROUNDEDNESS_MAX_CHUNKS", 2)
        monkeypatch.setattr(groundedness_gate, "GROUNDEDNESS_CHUNK_PREVIEW_CHARS", 10)
        chunks = [MagicMock(content="x" * 50) for _ in range(4)]

        prompt = groundedness_gate._build_groundedness_prompt("q", "a", chunks)

        assert "Chunk 2: " in prompt
        assert "Chunk 3: " not in prompt
        assert "Chunk 1: " + "x" * 10 + "\n" in prompt

    def test_env_override_and_empty_value(self, monkeypatch):
        """An empty-but-present value (what the deploy writes for an unset repo
        variable) must mean the default, not an ``int('')`` crash on import."""
        monkeypatch.setenv("GROUNDEDNESS_MAX_CHUNKS", "3")
        monkeypatch.setenv("GROUNDEDNESS_CHUNK_PREVIEW_CHARS", "")
        try:
            reloaded = importlib.reload(groundedness_gate)
            assert reloaded.GROUNDEDNESS_MAX_CHUNKS == 3
            assert reloaded.GROUNDEDNESS_CHUNK_PREVIEW_CHARS == 500
        finally:
            monkeypatch.delenv("GROUNDEDNESS_MAX_CHUNKS", raising=False)
            monkeypatch.delenv("GROUNDEDNESS_CHUNK_PREVIEW_CHARS", raising=False)
            importlib.reload(groundedness_gate)

    @pytest.mark.parametrize("name", ["GROUNDEDNESS_MAX_CHUNKS", "GROUNDEDNESS_CHUNK_PREVIEW_CHARS"])
    def test_zero_is_floored_so_the_judge_always_sees_something(self, monkeypatch, name):
        monkeypatch.setenv(name, "0")
        try:
            assert getattr(importlib.reload(groundedness_gate), name) == 1
        finally:
            monkeypatch.delenv(name, raising=False)
            importlib.reload(groundedness_gate)


class TestShouldSample:
    def test_sample_rate_one_always_true(self):
        with patch("app.services.groundedness_gate.GROUNDEDNESS_CHECK_SAMPLE_RATE", 1.0):
            assert should_sample() is True

    def test_sample_rate_zero_always_false(self):
        with patch("app.services.groundedness_gate.GROUNDEDNESS_CHECK_SAMPLE_RATE", 0.0):
            assert should_sample() is False

    def test_sample_rate_mid_range_is_probabilistic(self):
        with patch("app.services.groundedness_gate.GROUNDEDNESS_CHECK_SAMPLE_RATE", 0.5):
            results = {should_sample() for _ in range(200)}
        # With 200 draws at p=0.5, both outcomes should appear.
        assert results == {True, False}
