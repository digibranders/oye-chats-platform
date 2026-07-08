"""Tests for output-side moderation (AR-46).

Before this, moderation ran only on visitor input plus a narrow system-
prompt-leak string check on output. A jailbreak or an unusual retrieval
context could coax the model into generating content that would flag under
moderation categories even with clean visitor input, and it reached the
visitor unfiltered since only inbound moderation ran.
"""

from unittest.mock import patch

from app.services.rag_service import check_generated_answer_safety


class TestCheckGeneratedAnswerSafety:
    def test_safe_answer_passes_through(self):
        with patch("app.services.rag_service.check_visitor_safety", return_value=(True, None)) as mock_check:
            is_safe, category = check_generated_answer_safety(
                "Our standard plan is $49/month.", bot_id=5, session_id="s1", path="nonstream"
            )

        mock_check.assert_called_once_with("Our standard plan is $49/month.")
        assert is_safe is True
        assert category is None

    def test_flagged_answer_emits_distinct_output_metric(self):
        with (
            patch("app.services.rag_service.check_visitor_safety", return_value=(False, "violence")),
            patch("app.services.rag_service._safety_net_metric") as mock_metric,
        ):
            is_safe, category = check_generated_answer_safety(
                "flagged content", bot_id=5, session_id="s1", path="nonstream"
            )

        assert is_safe is False
        assert category == "violence"
        mock_metric.assert_called_once_with(
            "output_moderation_block", path="nonstream", session="s1", bot_id=5, category="violence"
        )

    def test_safe_answer_does_not_emit_metric(self):
        with (
            patch("app.services.rag_service.check_visitor_safety", return_value=(True, None)),
            patch("app.services.rag_service._safety_net_metric") as mock_metric,
        ):
            check_generated_answer_safety("clean answer", bot_id=5, session_id="s1", path="stream")

        mock_metric.assert_not_called()

    def test_fails_open_when_moderation_check_itself_errors(self):
        """check_visitor_safety already fails open (returns True, None) on
        any internal error — this wrapper must not add a new failure mode
        on top of that fail-open contract."""
        with patch("app.services.rag_service.check_visitor_safety", return_value=(True, None)):
            is_safe, category = check_generated_answer_safety(
                "some answer", bot_id=None, session_id=None, path="nonstream"
            )

        assert is_safe is True
        assert category is None
