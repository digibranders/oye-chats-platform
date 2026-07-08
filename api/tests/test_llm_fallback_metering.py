"""Tests for LLM fallback-rate metering (AR-16).

Before this, primary->fallback stream degradation only logged warning/error
with no counter — a primary provider flaky for an hour silently recovered
via fallback on every request, health stayed green, and nobody knew without
manually grepping logs.
"""

from unittest.mock import MagicMock, patch

import pytest

from app.services.llm_service import _meter_fallback_if_used, generate_response_stream


class TestMeterFallbackIfUsed:
    def test_meters_when_actual_model_differs_from_requested(self):
        response = MagicMock(model="gemini/gemini-2.5-flash")
        with patch("app.services.llm_service.increment_metric_counter") as mock_incr:
            _meter_fallback_if_used("openai/gpt-5.4-mini", response)
        mock_incr.assert_called_once_with("llm_fallback_triggered")

    def test_does_not_meter_when_actual_model_matches_requested(self):
        response = MagicMock(model="openai/gpt-5.4-mini")
        with patch("app.services.llm_service.increment_metric_counter") as mock_incr:
            _meter_fallback_if_used("openai/gpt-5.4-mini", response)
        mock_incr.assert_not_called()

    def test_never_raises_when_response_has_no_model_attr(self):
        response = object()  # no .model attribute at all
        with patch("app.services.llm_service.increment_metric_counter") as mock_incr:
            _meter_fallback_if_used("openai/gpt-5.4-mini", response)  # must not raise
        mock_incr.assert_not_called()

    def test_never_raises_on_metering_error(self):
        response = MagicMock(model="gemini/gemini-2.5-flash")
        with patch("app.services.llm_service.increment_metric_counter", side_effect=RuntimeError("boom")):
            _meter_fallback_if_used("openai/gpt-5.4-mini", response)  # must not raise


class TestStreamFallbackMetering:
    async def _drain(self, agen):
        return [chunk async for chunk in agen]

    async def _fake_stream_ok(self, model, prompt, max_tokens, metadata, temperature, system_prompt=None):
        yield f"chunk-from-{model}"

    async def _fake_stream_fails(self, model, prompt, max_tokens, metadata, temperature, system_prompt=None):
        raise RuntimeError("primary down")
        yield  # pragma: no cover - unreachable, makes this a generator

    @pytest.mark.asyncio
    async def test_meters_fallback_when_primary_stream_fails(self):
        with (
            patch("app.services.llm_service.PRIMARY_MODEL_KEY_SET", True),
            patch("app.services.llm_service.FALLBACK_MODEL_KEY_SET", True),
            patch("app.services.llm_service._primary_model", return_value="openai/gpt-5.4-mini"),
            patch("app.services.llm_service._fallback_model", return_value="gemini/gemini-2.5-flash"),
            patch("app.services.llm_service.increment_metric_counter") as mock_incr,
        ):

            async def stream_side_effect(model, prompt, max_tokens, metadata, temperature, system_prompt=None):
                if model == "openai/gpt-5.4-mini":
                    async for _ in self._fake_stream_fails(model, prompt, max_tokens, metadata, temperature):
                        yield _  # pragma: no cover
                else:
                    async for chunk in self._fake_stream_ok(model, prompt, max_tokens, metadata, temperature):
                        yield chunk

            with patch("app.services.llm_service._stream_from_model", side_effect=stream_side_effect):
                chunks = await self._drain(generate_response_stream("hi"))

        assert chunks == ["chunk-from-gemini/gemini-2.5-flash"]
        mock_incr.assert_any_call("llm_fallback_triggered")

    @pytest.mark.asyncio
    async def test_does_not_meter_fallback_when_primary_succeeds(self):
        with (
            patch("app.services.llm_service.PRIMARY_MODEL_KEY_SET", True),
            patch("app.services.llm_service._primary_model", return_value="openai/gpt-5.4-mini"),
            patch("app.services.llm_service.increment_metric_counter") as mock_incr,
            patch("app.services.llm_service._stream_from_model", side_effect=self._fake_stream_ok),
        ):
            chunks = await self._drain(generate_response_stream("hi"))

        assert chunks == ["chunk-from-openai/gpt-5.4-mini"]
        assert not any(c.args == ("llm_fallback_triggered",) for c in mock_incr.call_args_list)
