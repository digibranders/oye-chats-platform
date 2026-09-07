"""Tests for LLM fallback-rate metering (AR-16).

Before this, primary->fallback stream degradation only logged warning/error
with no counter, a primary provider flaky for an hour silently recovered
via fallback on every request, health stayed green, and nobody knew without
manually grepping logs.

The non-streaming half then over-corrected: LiteLLM reports ``response.model``
under the PROVIDER's name (``gpt-5.4-mini-2026-03-01`` for a request of
``openai/gpt-5.4-mini``), and comparing that verbatim to the prefixed request
id metered a "fallback" on every successful primary call, so
``/health/full``'s ``fallback_count_1h`` was noise. The unit tests below pin
the comparison that replaced it.
"""

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from app.services.llm_service import _meter_fallback_if_used, generate_response_stream

REQUESTED = "openai/gpt-5.4-mini"


def _meter(requested: str, response) -> MagicMock:
    with patch("app.services.llm_service.increment_metric_counter") as mock_incr:
        _meter_fallback_if_used(requested, response)
    return mock_incr


class TestMeterFallbackIfUsed:
    @pytest.mark.parametrize(
        "actual",
        [
            # What LiteLLM actually returns for the primary: bare, snapshot-dated.
            "gpt-5.4-mini-2026-03-01",
            # The prefixed id, as some providers/proxies echo it back.
            "openai/gpt-5.4-mini",
            # Bare alias, and case noise.
            "gpt-5.4-mini",
            "GPT-5.4-Mini-2026-03-01",
        ],
    )
    def test_primary_answering_under_its_own_or_snapshot_name_is_not_metered(self, actual):
        mock_incr = _meter(REQUESTED, MagicMock(model=actual))
        mock_incr.assert_not_called()

    @pytest.mark.parametrize("actual", ["gemini-2.5-flash", "gemini/gemini-2.5-flash"])
    def test_the_fallback_model_answering_is_metered(self, actual):
        mock_incr = _meter(REQUESTED, MagicMock(model=actual))
        mock_incr.assert_called_once_with("llm_fallback_triggered")

    def test_pinned_snapshot_request_served_under_the_alias_is_not_metered(self):
        """Snapshot matching runs in both directions."""
        mock_incr = _meter("openai/gpt-5.4-mini-2026-03-01", MagicMock(model="gpt-5.4-mini"))
        mock_incr.assert_not_called()

    def test_hidden_provider_alone_marks_a_fallback_when_the_model_name_is_missing(self):
        """LiteLLM stamps ``_hidden_params["custom_llm_provider"]`` on every
        completion; a provider other than the requested prefix is a fallback
        even when ``response.model`` is empty."""
        response = SimpleNamespace(model=None, _hidden_params={"custom_llm_provider": "gemini"})
        mock_incr = _meter(REQUESTED, response)
        mock_incr.assert_called_once_with("llm_fallback_triggered")

    def test_hidden_model_is_used_when_response_model_is_missing(self):
        response = SimpleNamespace(model="", _hidden_params={"model": "gemini-2.5-flash"})
        mock_incr = _meter(REQUESTED, response)
        mock_incr.assert_called_once_with("llm_fallback_triggered")

    def test_matching_provider_with_a_snapshot_name_is_not_metered(self):
        response = SimpleNamespace(model="gpt-5.4-mini-2026-03-01", _hidden_params={"custom_llm_provider": "openai"})
        mock_incr = _meter(REQUESTED, response)
        mock_incr.assert_not_called()

    def test_a_different_provider_serving_the_same_model_name_is_metered(self):
        """Same-name-different-route (e.g. an Azure deployment of the same
        model) is a fallback the name comparison alone cannot see."""
        response = SimpleNamespace(model="gpt-5.4-mini", _hidden_params={"custom_llm_provider": "azure"})
        mock_incr = _meter(REQUESTED, response)
        mock_incr.assert_called_once_with("llm_fallback_triggered")

    def test_provider_signal_is_skipped_when_the_request_had_no_prefix(self):
        """Without a requested prefix there is nothing to compare the provider
        against; only the name comparison applies."""
        response = SimpleNamespace(model="gpt-5.4-mini-2026-03-01", _hidden_params={"custom_llm_provider": "openai"})
        mock_incr = _meter("gpt-5.4-mini", response)
        mock_incr.assert_not_called()

    def test_both_signals_together_meter_exactly_once(self):
        response = SimpleNamespace(model="gemini-2.5-flash", _hidden_params={"custom_llm_provider": "gemini"})
        mock_incr = _meter(REQUESTED, response)
        mock_incr.assert_called_once_with("llm_fallback_triggered")

    def test_non_dict_hidden_params_are_ignored(self):
        """A MagicMock response auto-creates ``_hidden_params``; anything that is
        not a real dict must not be read as a signal."""
        mock_incr = _meter(REQUESTED, MagicMock(model="gpt-5.4-mini-2026-03-01"))
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

    def test_never_raises_when_model_is_not_a_string(self):
        """A MagicMock without an explicit ``model`` yields a MagicMock attribute;
        anything non-string is treated as "unknown", not compared."""
        mock_incr = _meter(REQUESTED, MagicMock())  # must not raise
        mock_incr.assert_not_called()


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
