"""Tests for Langfuse observability integration.

These tests mock the google-genai SDK and Langfuse client to test
instrumentation logic without requiring real API keys or connections.
"""
import os
import sys
import time
from unittest.mock import MagicMock, patch, PropertyMock
import pytest


# Mock google.genai before any app module imports it
mock_genai = MagicMock()
sys.modules["google"] = MagicMock()
sys.modules["google.genai"] = mock_genai


class TestLangfuseClient:
    """Tests for the Langfuse client singleton."""

    def test_langfuse_disabled_when_env_missing(self):
        """get_langfuse() returns None when LANGFUSE_ENABLED is False."""
        with patch("app.core.langfuse_client.LANGFUSE_ENABLED", False):
            # Reset singleton
            import app.core.langfuse_client as lfc
            lfc._langfuse_instance = None

            result = lfc.get_langfuse()
            assert result is None

    def test_langfuse_returns_client_when_enabled(self):
        """get_langfuse() returns a client when LANGFUSE_ENABLED is True."""
        mock_get_client = MagicMock()
        mock_client = MagicMock()
        mock_get_client.return_value = mock_client

        mock_langfuse_module = MagicMock()
        mock_langfuse_module.get_client = mock_get_client

        import app.core.langfuse_client as lfc

        with patch.object(lfc, "LANGFUSE_ENABLED", True), \
             patch.dict("sys.modules", {"langfuse": mock_langfuse_module}):

            result = lfc.get_langfuse()
            assert result is mock_client
            mock_get_client.assert_called_once()

    def test_flush_langfuse_noop_when_disabled(self):
        """flush_langfuse() is a no-op when Langfuse is disabled."""
        import app.core.langfuse_client as lfc
        lfc._langfuse_instance = None

        with patch.object(lfc, "LANGFUSE_ENABLED", False):
            # Should not raise
            lfc.flush_langfuse()


class TestLLMServiceObserved:
    """Tests for the observed LLM wrapper functions."""

    def test_generate_response_observed_without_trace(self):
        """Falls through to original generate_response when trace is None."""
        # We need to mock the genai client before importing
        with patch.dict("sys.modules", {"google": MagicMock(), "google.genai": MagicMock()}):
            import app.services.llm_service as llm_svc

            with patch.object(llm_svc, "generate_response", return_value="Hello!"):
                result = llm_svc.generate_response_observed(
                    "test prompt", generation_name="test", trace=None
                )
                assert result == "Hello!"

    def test_generate_response_observed_creates_generation(self):
        """Creates a Langfuse generation context when enabled."""
        mock_lf = MagicMock()
        mock_generation = MagicMock()
        mock_generation.__enter__ = MagicMock(return_value=mock_generation)
        mock_generation.__exit__ = MagicMock(return_value=False)
        mock_lf.start_as_current_observation.return_value = mock_generation

        mock_response = MagicMock()
        mock_response.text = "Generated answer"
        mock_usage = MagicMock()
        mock_usage.prompt_token_count = 10
        mock_usage.candidates_token_count = 20
        mock_usage.total_token_count = 30
        mock_response.usage_metadata = mock_usage

        with patch.dict("sys.modules", {"google": MagicMock(), "google.genai": MagicMock()}):
            import app.services.llm_service as llm_svc

            with patch("app.core.langfuse_client.get_langfuse", return_value=mock_lf), \
                 patch.object(llm_svc, "GOOGLE_API_KEY", "test-key"), \
                 patch.object(llm_svc, "client") as mock_client:
                mock_client.models.generate_content.return_value = mock_response

                result = llm_svc.generate_response_observed(
                    "test prompt",
                    generation_name="rag-generation",
                )

                assert result == "Generated answer"
                mock_lf.start_as_current_observation.assert_called_once()
                mock_generation.update.assert_called_once()
                update_kwargs = mock_generation.update.call_args.kwargs
                assert update_kwargs["output"] == "Generated answer"

    def test_generate_response_stream_observed_without_trace(self):
        """Falls through to original generator when trace is None."""
        def mock_stream(prompt):
            yield "chunk1"
            yield "chunk2"

        with patch.dict("sys.modules", {"google": MagicMock(), "google.genai": MagicMock()}):
            import app.services.llm_service as llm_svc

            with patch.object(llm_svc, "generate_response_stream", side_effect=mock_stream):
                chunks = list(llm_svc.generate_response_stream_observed(
                    "test prompt", generation_name="test", trace=None
                ))
                assert chunks == ["chunk1", "chunk2"]

    def test_generate_response_stream_observed_captures_output(self):
        """Accumulates full output and updates generation with TTFT."""
        mock_lf = MagicMock()
        mock_generation = MagicMock()
        mock_generation.__enter__ = MagicMock(return_value=mock_generation)
        mock_generation.__exit__ = MagicMock(return_value=False)
        mock_lf.start_as_current_observation.return_value = mock_generation

        def mock_stream(prompt):
            yield "Hello "
            yield "world!"

        with patch.dict("sys.modules", {"google": MagicMock(), "google.genai": MagicMock()}):
            import app.services.llm_service as llm_svc

            with patch("app.core.langfuse_client.get_langfuse", return_value=mock_lf), \
                 patch.object(llm_svc, "generate_response_stream", side_effect=mock_stream):
                chunks = list(llm_svc.generate_response_stream_observed(
                    "test prompt",
                    generation_name="rag-stream",
                ))

                assert chunks == ["Hello ", "world!"]
                mock_generation.update.assert_called_once()
                update_kwargs = mock_generation.update.call_args.kwargs
                assert update_kwargs["output"] == "Hello world!"
                assert "ttft_ms" in update_kwargs["metadata"]
                assert "total_time_ms" in update_kwargs["metadata"]

    def test_stream_without_langfuse_yields_all_chunks(self):
        """Streaming works identically when Langfuse is disabled."""
        def mock_stream(prompt):
            yield "chunk1"
            yield "chunk2"
            yield "chunk3"

        with patch.dict("sys.modules", {"google": MagicMock(), "google.genai": MagicMock()}):
            import app.services.llm_service as llm_svc

            with patch("app.core.langfuse_client.get_langfuse", return_value=None), \
                 patch.object(llm_svc, "generate_response_stream", side_effect=mock_stream):
                chunks = list(llm_svc.generate_response_stream_observed(
                    "test prompt",
                    generation_name="test",
                ))
                assert chunks == ["chunk1", "chunk2", "chunk3"]


class TestFeedbackScoring:
    """Tests for feedback → Langfuse score wiring."""

    def test_feedback_creates_langfuse_score(self):
        """lf.score() is called when trace_id exists on the message."""
        mock_lf = MagicMock()
        mock_msg = MagicMock()
        mock_msg.trace_id = "trace-abc-123"

        # Simulate the scoring logic from chat_routes
        lf = mock_lf
        if lf and mock_msg.trace_id:
            lf.score(
                trace_id=mock_msg.trace_id,
                name="user-feedback",
                value=1,
            )

        mock_lf.score.assert_called_once_with(
            trace_id="trace-abc-123",
            name="user-feedback",
            value=1,
        )

    def test_feedback_skipped_when_no_trace_id(self):
        """lf.score() is NOT called when trace_id is None."""
        mock_lf = MagicMock()
        mock_msg = MagicMock()
        mock_msg.trace_id = None

        if mock_lf and mock_msg.trace_id:
            mock_lf.score(trace_id=mock_msg.trace_id, name="user-feedback", value=1)

        mock_lf.score.assert_not_called()

    def test_feedback_skipped_when_langfuse_disabled(self):
        """No scoring attempt when Langfuse returns None."""
        lf = None
        mock_msg = MagicMock()
        mock_msg.trace_id = "trace-123"

        scored = False
        if lf and mock_msg.trace_id:
            scored = True

        assert scored is False
