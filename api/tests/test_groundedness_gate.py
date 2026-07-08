"""Tests for the post-generation groundedness gate (AR-12).

Mirrors test_relevance_gate_model_config.py's mocking style — no real
network/API calls, litellm.completion is mocked throughout.
"""

import json
from unittest.mock import MagicMock, patch

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
        — this check is observability-only, so failing open costs nothing
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

    def test_score_clamped_to_valid_range(self):
        chunk = MagicMock(content="content")
        with patch("litellm.completion", return_value=_mock_completion(5.0)):  # out-of-range judge output
            _, score = check_groundedness("Q", "A", [chunk])
        assert score == 1.0


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
