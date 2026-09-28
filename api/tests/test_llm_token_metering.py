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

from app.core import langfuse_client
from app.core.metrics import increment_metric_counter_by
from app.services.llm_service import _meter_token_usage, _stream_from_model


class TestIncrementMetricCounterBy:
    def test_incrbys_by_the_given_amount(self):
        mock_redis = MagicMock()
        mock_pipe = MagicMock()
        mock_redis.pipeline.return_value = mock_pipe

        with patch("app.core.metrics.get_redis", return_value=mock_redis):
            increment_metric_counter_by("llm_tokens_prompt", 250, bot_id=7)

        # Per-bot key AND the global key, in one pipeline: the platform-wide
        # token total is the per-bot events summed, and the super-admin read
        # defaults to the global scope.
        assert mock_pipe.incrby.call_count == 2
        (key_arg, amount_arg), (global_key, global_amount) = (c[0] for c in mock_pipe.incrby.call_args_list)
        assert "llm_tokens_prompt" in key_arg
        assert "b7" in key_arg
        assert amount_arg == 250
        assert "llm_tokens_prompt" in global_key and "global" in global_key
        assert global_amount == 250

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
    """The streamed chat reply (``rag-stream-generation``) is the production
    answer path. Its generation first recorded no usage at all, then sent it as
    ``usage=``, which the Langfuse v4 SDK drops: the token counts production
    showed were Langfuse's own tokenisation of the text, and a Gemini fallback
    stream showed none. The final usage chunk now goes through the same
    ``record_litellm`` as a non-streaming response."""

    class _Span:
        def __init__(self):
            self.updates: list[dict] = []

        def update(self, **kw):
            self.updates.append(kw)

    @classmethod
    def _enable_langfuse(cls, monkeypatch):
        span = cls._Span()

        @contextlib.contextmanager
        def _observation(**_kwargs):
            yield span

        fake = SimpleNamespace(start_as_current_observation=lambda **kw: _observation(**kw))
        monkeypatch.setattr(langfuse_client, "get_langfuse", lambda: fake)
        return span

    @staticmethod
    def _usage_chunk(*, model: str, provider: str, prompt_tokens: int, completion_tokens: int):
        from litellm.types.utils import ModelResponseStream, Usage

        chunk = ModelResponseStream(model=model, choices=[])
        chunk.usage = Usage(
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            total_tokens=prompt_tokens + completion_tokens,
        )
        chunk._hidden_params = {"custom_llm_provider": provider}
        return chunk

    @pytest.mark.asyncio
    async def test_the_final_usage_chunk_records_usage_and_cost(self, monkeypatch):
        span = self._enable_langfuse(monkeypatch)
        final = self._usage_chunk(
            model="gpt-5.4-mini-2026-03-17", provider="openai", prompt_tokens=8000, completion_tokens=300
        )

        with patch(
            "app.services.llm_service.litellm.acompletion", side_effect=_stream_of(_content_chunk("hello"), final)
        ):
            chunks = [c async for c in _stream_from_model("openai/gpt-5.4-mini", "hi", None, None)]

        assert chunks == ["hello"]
        sent = span.updates[-1]
        assert sent["output"] == "hello"
        assert sent["model"] == "gpt-5.4-mini"
        # The provider's counts, not a tokenisation of the five visible characters.
        assert sent["usage_details"] == {"input": 8000, "output": 300, "total": 8300}
        assert sent["cost_details"]["total"] == pytest.approx(8000 * 0.75e-6 + 300 * 4.5e-6)
        assert "usage" not in sent

    @pytest.mark.asyncio
    async def test_a_gemini_fallback_stream_records_its_tokens(self, monkeypatch):
        span = self._enable_langfuse(monkeypatch)
        final = self._usage_chunk(model="gemini-2.5-flash", provider="gemini", prompt_tokens=5000, completion_tokens=90)

        with patch("app.services.llm_service.litellm.acompletion", side_effect=_stream_of(_content_chunk("hi"), final)):
            [c async for c in _stream_from_model("gemini/gemini-2.5-flash", "hi", None, None)]

        sent = span.updates[-1]
        assert sent["model"] == "gemini-2.5-flash"
        assert sent["usage_details"] == {"input": 5000, "output": 90, "total": 5090}
        assert sent["cost_details"]["total"] == pytest.approx(5000 * 0.3e-6 + 90 * 2.5e-6)

    @pytest.mark.asyncio
    @pytest.mark.allow_real_llm_call
    async def test_real_litellm_stream_output_tokens_come_from_the_usage_chunk(self, monkeypatch):
        """End to end through LiteLLM's own stream wrapper: the usage chunk it
        emits for ``include_usage`` is the one recorded, so output tokens are
        the count for the whole answer. ``mock_response`` makes LiteLLM answer
        locally, so the real client is used without reaching a provider."""
        import litellm

        span = self._enable_langfuse(monkeypatch)
        answer = "We offer managed detection and response, with a 24x7 SOC and monthly reporting. " * 4
        real_acompletion = litellm.acompletion
        seen_chunks: list = []

        async def _mocked(**kwargs):
            stream = await real_acompletion(**kwargs, mock_response=answer, api_key="test-key")

            async def _tap():
                async for chunk in stream:
                    seen_chunks.append(chunk)
                    yield chunk

            return _tap()

        with patch("app.services.llm_service.litellm.acompletion", side_effect=_mocked):
            chunks = [c async for c in _stream_from_model("openai/gpt-5.4-mini", "hi", None, None)]

        assert "".join(chunks) == answer
        final_usage = next(c.usage for c in reversed(seen_chunks) if getattr(c, "usage", None) is not None)
        sent = span.updates[-1]
        assert sent["usage_details"]["output"] == final_usage.completion_tokens > 50
        assert sent["usage_details"]["input"] == final_usage.prompt_tokens
        assert sent["cost_details"]["total"] > 0

    @pytest.mark.asyncio
    async def test_no_usage_chunk_records_the_text_and_flags_unreported_usage(self, monkeypatch):
        span = self._enable_langfuse(monkeypatch)

        with patch("app.services.llm_service.litellm.acompletion", side_effect=_stream_of(_content_chunk("hello"))):
            [c async for c in _stream_from_model("openai/gpt-5.4-mini", "hi", None, None)]

        sent = span.updates[-1]
        assert sent["output"] == "hello"
        assert sent["metadata"]["usage_reported"] is False
        assert "usage_details" not in sent
