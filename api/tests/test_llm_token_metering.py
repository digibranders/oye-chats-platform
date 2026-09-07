"""Tests for LLM token-usage metering (AR-26).

The credit ledger charges a flat 1 credit per `ai_chat` reply regardless of
actual token volume. Cross-subsidizing heavy-context bots off light ones.
Changing the credit model itself is a pricing/product decision requiring
business sign-off, so this pass only adds the measurement half: real
per-bot prompt/completion token counts, both for non-streaming responses
(`response.usage` is available directly) and streaming ones (via
`stream_options={"include_usage": True}`, which litellm surfaces as a final
chunk with empty `choices` and populated `usage`).
"""

import contextlib
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from app.core.metrics import increment_metric_counter_by
from app.services import llm_service
from app.services.llm_service import _meter_token_usage, _stream_from_model


class TestIncrementMetricCounterBy:
    def test_incrbys_by_the_given_amount(self):
        mock_redis = MagicMock()
        mock_pipe = MagicMock()
        mock_redis.pipeline.return_value = mock_pipe

        with patch("app.core.metrics.get_redis", return_value=mock_redis):
            increment_metric_counter_by("llm_tokens_prompt", 250, bot_id=7)

        mock_pipe.incrby.assert_called_once()
        key_arg, amount_arg = mock_pipe.incrby.call_args[0]
        assert "llm_tokens_prompt" in key_arg
        assert "b7" in key_arg
        assert amount_arg == 250

    def test_skips_redis_call_for_zero_or_negative_amount(self):
        mock_redis = MagicMock()
        with patch("app.core.metrics.get_redis", return_value=mock_redis):
            increment_metric_counter_by("llm_tokens_prompt", 0, bot_id=1)
            increment_metric_counter_by("llm_tokens_prompt", -5, bot_id=1)
        mock_redis.pipeline.assert_not_called()

    def test_never_raises_on_redis_error(self):
        mock_redis = MagicMock()
        mock_redis.pipeline.side_effect = RuntimeError("boom")
        with patch("app.core.metrics.get_redis", return_value=mock_redis):
            increment_metric_counter_by("llm_tokens_prompt", 100, bot_id=1)  # must not raise


class TestMeterTokenUsage:
    def test_logs_prompt_and_completion_tokens_scoped_to_bot(self):
        response = MagicMock(usage=MagicMock(prompt_tokens=120, completion_tokens=45))
        with patch("app.services.llm_service.increment_metric_counter_by") as mock_incr:
            _meter_token_usage(response, {"bot_id": 9})

        mock_incr.assert_any_call("llm_tokens_prompt", 120, bot_id=9)
        mock_incr.assert_any_call("llm_tokens_completion", 45, bot_id=9)

    def test_uses_none_bot_id_when_metadata_missing_it(self):
        response = MagicMock(usage=MagicMock(prompt_tokens=10, completion_tokens=5))
        with patch("app.services.llm_service.increment_metric_counter_by") as mock_incr:
            _meter_token_usage(response, {"generation_name": "x"})

        mock_incr.assert_any_call("llm_tokens_prompt", 10, bot_id=None)

    def test_never_raises_when_response_has_no_usage(self):
        response = object()  # no .usage attribute
        with patch("app.services.llm_service.increment_metric_counter_by") as mock_incr:
            _meter_token_usage(response, {"bot_id": 1})  # must not raise
        mock_incr.assert_not_called()

    def test_never_raises_on_metering_error(self):
        response = MagicMock(usage=MagicMock(prompt_tokens=10, completion_tokens=5))
        with patch("app.services.llm_service.increment_metric_counter_by", side_effect=RuntimeError("boom")):
            _meter_token_usage(response, {"bot_id": 1})  # must not raise


class TestStreamRequestsUsageAndMetersFinalChunk:
    @pytest.mark.asyncio
    async def test_stream_options_include_usage_is_requested(self):
        captured_kwargs = {}

        async def fake_acompletion(**kwargs):
            captured_kwargs.update(kwargs)

            async def _empty_aiter():
                return
                yield  # pragma: no cover - unreachable, makes this an async generator

            mock_stream = MagicMock()
            mock_stream.__aiter__ = lambda self=None: _empty_aiter()
            return mock_stream

        with patch("app.services.llm_service.litellm.acompletion", side_effect=fake_acompletion):
            async for _ in _stream_from_model("openai/gpt-5.4-mini", "hi", None, None):
                pass

        assert captured_kwargs["stream_options"] == {"include_usage": True}

    @pytest.mark.asyncio
    async def test_final_usage_only_chunk_is_metered_and_not_yielded_as_content(self):
        content_chunk = MagicMock(usage=None)
        content_chunk.choices = [MagicMock(delta=MagicMock(content="hello"))]

        usage_chunk = MagicMock(usage=MagicMock(prompt_tokens=80, completion_tokens=12))
        usage_chunk.choices = []

        async def fake_aiter():
            yield content_chunk
            yield usage_chunk

        async def fake_acompletion(**kwargs):
            mock_stream = MagicMock()
            mock_stream.__aiter__ = lambda self=None: fake_aiter()
            return mock_stream

        with (
            patch("app.services.llm_service.litellm.acompletion", side_effect=fake_acompletion),
            patch("app.services.llm_service._meter_token_usage") as mock_meter,
        ):
            chunks = [c async for c in _stream_from_model("openai/gpt-5.4-mini", "hi", None, {"bot_id": 3})]

        assert chunks == ["hello"]
        mock_meter.assert_called_once_with(usage_chunk, {"bot_id": 3})


def _content_chunk(text: str, *, prompt_tokens: int | None = None, completion_tokens: int | None = None):
    usage = (
        MagicMock(prompt_tokens=prompt_tokens, completion_tokens=completion_tokens)
        if prompt_tokens is not None
        else None
    )
    chunk = MagicMock(usage=usage)
    chunk.choices = [MagicMock(delta=MagicMock(content=text))]
    return chunk


def _stream_of(*chunks):
    async def fake_aiter():
        for chunk in chunks:
            yield chunk

    async def fake_acompletion(**kwargs):
        mock_stream = MagicMock()
        mock_stream.__aiter__ = lambda self=None: fake_aiter()
        return mock_stream

    return fake_acompletion


class TestStreamMetersUsageOnceFromTheLastUsageChunk:
    """OpenAI reports usage on one final chunk, but a provider that attaches
    CUMULATIVE usage to every chunk used to be metered once per chunk, so a
    reply of N chunks was billed to FinOps roughly N/2 times over."""

    @pytest.mark.asyncio
    async def test_cumulative_per_chunk_usage_is_metered_once_from_the_last_chunk(self):
        first = _content_chunk("a", prompt_tokens=80, completion_tokens=1)
        second = _content_chunk("b", prompt_tokens=80, completion_tokens=2)
        final = MagicMock(usage=MagicMock(prompt_tokens=80, completion_tokens=3))
        final.choices = []

        with (
            patch("app.services.llm_service.litellm.acompletion", side_effect=_stream_of(first, second, final)),
            patch("app.services.llm_service._meter_token_usage") as mock_meter,
        ):
            chunks = [c async for c in _stream_from_model("openai/gpt-5.4-mini", "hi", None, {"bot_id": 3})]

        assert chunks == ["a", "b"]
        mock_meter.assert_called_once_with(final, {"bot_id": 3})

    @pytest.mark.asyncio
    async def test_a_stream_without_usage_is_not_metered(self):
        with (
            patch(
                "app.services.llm_service.litellm.acompletion",
                side_effect=_stream_of(_content_chunk("a"), _content_chunk("b")),
            ),
            patch("app.services.llm_service._meter_token_usage") as mock_meter,
        ):
            chunks = [c async for c in _stream_from_model("openai/gpt-5.4-mini", "hi", None, {"bot_id": 3})]

        assert chunks == ["a", "b"]
        mock_meter.assert_not_called()

    @pytest.mark.asyncio
    async def test_usage_seen_before_a_mid_stream_failure_is_still_metered_once(self):
        """The tokens were consumed whether or not the stream finished cleanly,
        so the last usage seen is metered from the cleanup path, once."""
        first = _content_chunk("a", prompt_tokens=80, completion_tokens=1)

        async def fake_aiter():
            yield first
            raise RuntimeError("connection reset")

        async def fake_acompletion(**kwargs):
            mock_stream = MagicMock()
            mock_stream.__aiter__ = lambda self=None: fake_aiter()
            return mock_stream

        with (
            patch("app.services.llm_service.litellm.acompletion", side_effect=fake_acompletion),
            patch("app.services.llm_service._meter_token_usage") as mock_meter,
            pytest.raises(RuntimeError, match="connection reset"),
        ):
            async for _ in _stream_from_model("openai/gpt-5.4-mini", "hi", None, {"bot_id": 3}):
                pass

        mock_meter.assert_called_once_with(first, {"bot_id": 3})


class TestStreamUsageReachesLangfuse:
    """The streaming generation used to be recorded with output only, so every
    streamed reply (the production chat path) showed no token usage in
    Langfuse while the non-streaming calls did."""

    @staticmethod
    def _capturing_generation(updates: list):
        @contextlib.contextmanager
        def _gen(*args, **kwargs):
            yield SimpleNamespace(update=lambda **kw: updates.append(kw), record_litellm=lambda *a, **k: None)

        return _gen

    @pytest.mark.asyncio
    async def test_last_usage_chunk_is_attached_to_the_generation(self, monkeypatch):
        updates: list = []
        monkeypatch.setattr(llm_service, "langfuse_generation", self._capturing_generation(updates))
        final = MagicMock(usage=MagicMock(prompt_tokens=80, completion_tokens=12))
        final.choices = []

        with patch(
            "app.services.llm_service.litellm.acompletion", side_effect=_stream_of(_content_chunk("hello"), final)
        ):
            chunks = [c async for c in _stream_from_model("openai/gpt-5.4-mini", "hi", None, None)]

        assert chunks == ["hello"]
        assert updates[-1]["output"] == "hello"
        assert updates[-1]["model"] == "openai/gpt-5.4-mini"
        # Same shape ``record_litellm`` produces for non-streaming calls.
        assert updates[-1]["usage"] == {"input": 80, "output": 12}

    @pytest.mark.asyncio
    async def test_no_usage_chunk_records_none(self, monkeypatch):
        updates: list = []
        monkeypatch.setattr(llm_service, "langfuse_generation", self._capturing_generation(updates))

        with patch("app.services.llm_service.litellm.acompletion", side_effect=_stream_of(_content_chunk("hello"))):
            [c async for c in _stream_from_model("openai/gpt-5.4-mini", "hi", None, None)]

        assert updates[-1]["usage"] is None
