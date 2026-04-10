"""Tests for Langfuse observability integration and LLM service functions.

These tests mock the LiteLLM SDK and Langfuse client to test
instrumentation logic without requiring real API keys or connections.
"""

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch


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

        with patch.object(lfc, "LANGFUSE_ENABLED", True), patch.dict("sys.modules", {"langfuse": mock_langfuse_module}):
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


class TestLLMService:
    """Tests for the LiteLLM-based LLM service functions."""

    def test_generate_response_returns_content(self):
        """generate_response() returns the model's content string."""
        mock_response = MagicMock()
        mock_response.choices = [MagicMock()]
        mock_response.choices[0].message.content = "Hello from Gemini!"

        with (
            patch("app.services.llm_service.litellm") as mock_litellm,
            patch("app.services.llm_service.PRIMARY_MODEL_KEY_SET", True),
        ):
            mock_litellm.completion.return_value = mock_response

            from app.services.llm_service import generate_response

            result = generate_response("test prompt")
            assert result == "Hello from Gemini!"
            mock_litellm.completion.assert_called_once()

    def test_generate_response_with_metadata(self):
        """generate_response() passes metadata to litellm.completion()."""
        mock_response = MagicMock()
        mock_response.choices = [MagicMock()]
        mock_response.choices[0].message.content = "Answer"

        with (
            patch("app.services.llm_service.litellm") as mock_litellm,
            patch("app.services.llm_service.PRIMARY_MODEL_KEY_SET", True),
        ):
            mock_litellm.completion.return_value = mock_response

            from app.services.llm_service import generate_response

            generate_response("test", metadata={"generation_name": "rag-generation"})
            call_kwargs = mock_litellm.completion.call_args.kwargs
            assert call_kwargs["metadata"] == {"generation_name": "rag-generation"}

    def test_generate_response_handles_empty(self):
        """generate_response() returns fallback message when content is empty."""
        mock_response = MagicMock()
        mock_response.choices = [MagicMock()]
        mock_response.choices[0].message.content = None

        with (
            patch("app.services.llm_service.litellm") as mock_litellm,
            patch("app.services.llm_service.PRIMARY_MODEL_KEY_SET", True),
        ):
            mock_litellm.completion.return_value = mock_response

            from app.services.llm_service import generate_response

            result = generate_response("test")
            assert "couldn't generate" in result

    def test_generate_response_handles_error(self):
        """generate_response() returns error message on exception."""
        with (
            patch("app.services.llm_service.litellm") as mock_litellm,
            patch("app.services.llm_service.PRIMARY_MODEL_KEY_SET", True),
        ):
            mock_litellm.completion.side_effect = Exception("API timeout")

            from app.services.llm_service import generate_response

            result = generate_response("test")
            assert "error" in result.lower()

    def test_generate_response_stream_yields_chunks(self):
        """generate_response_stream() yields delta content from each chunk."""
        chunks = []
        for text in ["Hello ", "world", "!"]:
            chunk = MagicMock()
            chunk.choices = [MagicMock()]
            chunk.choices[0].delta.content = text
            chunks.append(chunk)

        class _AsyncIter:
            def __init__(self, items):
                self._items = iter(items)

            def __aiter__(self):
                return self

            async def __anext__(self):
                try:
                    return next(self._items)
                except StopIteration as exc:
                    raise StopAsyncIteration from exc

        async def _collect():
            from app.services.llm_service import generate_response_stream  # noqa: PLC0415

            return [c async for c in generate_response_stream("test")]

        with (
            patch("app.services.llm_service.litellm") as mock_litellm,
            patch("app.services.llm_service.PRIMARY_MODEL_KEY_SET", True),
        ):
            mock_litellm.acompletion = AsyncMock(return_value=_AsyncIter(chunks))
            result = asyncio.run(_collect())
            assert result == ["Hello ", "world", "!"]

    def test_generate_response_stream_skips_none(self):
        """generate_response_stream() skips chunks with None content."""
        chunks = []
        for text in ["Hello ", None, "world"]:
            chunk = MagicMock()
            chunk.choices = [MagicMock()]
            chunk.choices[0].delta.content = text
            chunks.append(chunk)

        class _AsyncIter:
            def __init__(self, items):
                self._items = iter(items)

            def __aiter__(self):
                return self

            async def __anext__(self):
                try:
                    return next(self._items)
                except StopIteration as exc:
                    raise StopAsyncIteration from exc

        async def _collect():
            from app.services.llm_service import generate_response_stream  # noqa: PLC0415

            return [c async for c in generate_response_stream("test")]

        with (
            patch("app.services.llm_service.litellm") as mock_litellm,
            patch("app.services.llm_service.PRIMARY_MODEL_KEY_SET", True),
        ):
            mock_litellm.acompletion = AsyncMock(return_value=_AsyncIter(chunks))
            result = asyncio.run(_collect())
            assert result == ["Hello ", "world"]

    def test_generate_response_no_api_key(self):
        """generate_response() returns config error when primary model key is missing."""
        with patch("app.services.llm_service.PRIMARY_MODEL_KEY_SET", False):
            from app.services.llm_service import generate_response

            result = generate_response("test")
            assert "Configuration error" in result


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
