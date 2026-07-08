"""Tests for LLM error-type classification and retry wiring (AR-15).

Before this, every LLM call site caught bare `except Exception`, collapsing
429/5xx/401/400 into the same canned error/fail-open, and no litellm
retry/backoff was configured anywhere. These tests pin: (1) transient errors
(rate limit, timeout) are tagged distinctly from config errors (auth,
bad request) from truly unknown errors, (2) config errors forward to Sentry,
and (3) litellm.completion/acompletion are called with num_retries so a
transient blip doesn't immediately downgrade to the fallback model.
"""

from unittest.mock import MagicMock, patch

import litellm
import pytest

from app.services.llm_service import _classify_and_log_llm_error, _generate_response


class TestClassifyAndLogLlmError:
    def test_config_error_forwards_to_sentry_and_meters_distinctly(self):
        with (
            patch("app.services.llm_service.increment_metric_counter") as mock_incr,
            patch("app.services.llm_service.forward_to_sentry_if_alertable") as mock_forward,
        ):
            _classify_and_log_llm_error(
                litellm.AuthenticationError("bad key", llm_provider="openai", model="gpt-5.4-mini"),
                context="test",
            )
        mock_incr.assert_called_once_with("llm_config_error")
        mock_forward.assert_called_once_with("llm_config_error")

    def test_transient_error_meters_without_sentry_forward(self):
        with (
            patch("app.services.llm_service.increment_metric_counter") as mock_incr,
            patch("app.services.llm_service.forward_to_sentry_if_alertable") as mock_forward,
        ):
            _classify_and_log_llm_error(
                litellm.RateLimitError("quota exceeded", llm_provider="openai", model="gpt-5.4-mini"),
                context="test",
            )
        mock_incr.assert_called_once_with("llm_transient_error")
        mock_forward.assert_not_called()

    def test_unknown_error_meters_as_unknown(self):
        with (
            patch("app.services.llm_service.increment_metric_counter") as mock_incr,
            patch("app.services.llm_service.forward_to_sentry_if_alertable") as mock_forward,
        ):
            _classify_and_log_llm_error(ValueError("something weird"), context="test")
        mock_incr.assert_called_once_with("llm_unknown_error")
        mock_forward.assert_not_called()

    def test_bad_request_is_classified_as_config_error(self):
        """BadRequestError (malformed request, unsupported params) is a config
        problem, not a transient one — retrying it is pointless."""
        with (
            patch("app.services.llm_service.increment_metric_counter") as mock_incr,
            patch("app.services.llm_service.forward_to_sentry_if_alertable"),
        ):
            _classify_and_log_llm_error(
                litellm.BadRequestError("invalid param", llm_provider="openai", model="gpt-5.4-mini"),
                context="test",
            )
        mock_incr.assert_called_once_with("llm_config_error")

    def test_context_window_exceeded_is_its_own_distinct_tag_not_config_error(self):
        """AR-20: ContextWindowExceededError IS a BadRequestError subclass in
        litellm, so it must be checked BEFORE the generic config-error branch
        — otherwise a retryable-with-trimmed-prompt overflow gets silently
        lumped in with "someone revoked the API key"."""
        with (
            patch("app.services.llm_service.increment_metric_counter") as mock_incr,
            patch("app.services.llm_service.forward_to_sentry_if_alertable") as mock_forward,
        ):
            _classify_and_log_llm_error(
                litellm.ContextWindowExceededError(
                    "context length exceeded", llm_provider="openai", model="gpt-5.4-mini"
                ),
                context="test",
            )
        mock_incr.assert_called_once_with("llm_context_overflow")
        mock_incr.assert_called_once()  # never ALSO counted as llm_config_error
        mock_forward.assert_not_called()  # not a config error — no Sentry page needed


class TestContextOverflowMessage:
    def test_generate_response_returns_distinct_message_on_context_overflow(self):
        """Must not say 'please try again' — see LLM_CONTEXT_OVERFLOW_MESSAGE
        docstring for why. This test wholesale-mocks `litellm` (the same
        pattern used throughout this test file/codebase) specifically to
        prove the except clause survives that — a live `litellm.XxxError`
        attribute lookup inside `except` would raise TypeError against a
        Mock instead of catching the raised exception."""
        from app.services.llm_service import LLM_API_ERROR_MESSAGE, LLM_CONTEXT_OVERFLOW_MESSAGE

        with (
            patch("app.services.llm_service.litellm") as mock_litellm,
            patch("app.services.llm_service.PRIMARY_MODEL_KEY_SET", True),
        ):
            mock_litellm.completion.side_effect = litellm.ContextWindowExceededError(
                "too long", llm_provider="openai", model="gpt-5.4-mini"
            )
            text, failed = _generate_response("a very long prompt")

        assert failed is True
        assert text == LLM_CONTEXT_OVERFLOW_MESSAGE
        assert text != LLM_API_ERROR_MESSAGE


class TestNumRetriesWiring:
    def test_generate_response_passes_num_retries(self):
        mock_response = MagicMock()
        mock_response.choices = [MagicMock()]
        mock_response.choices[0].message.content = "answer"

        with (
            patch("app.services.llm_service.litellm") as mock_litellm,
            patch("app.services.llm_service.PRIMARY_MODEL_KEY_SET", True),
        ):
            mock_litellm.completion.return_value = mock_response
            _generate_response("test prompt")

        call_kwargs = mock_litellm.completion.call_args.kwargs
        assert call_kwargs["num_retries"] >= 1

    def test_num_retries_configurable_via_env(self, monkeypatch):
        import importlib

        monkeypatch.setenv("LLM_NUM_RETRIES", "5")
        import app.services.llm_service as llm_service

        importlib.reload(llm_service)
        try:
            assert llm_service._LLM_NUM_RETRIES == 5
        finally:
            monkeypatch.delenv("LLM_NUM_RETRIES", raising=False)
            importlib.reload(llm_service)  # restore default for subsequent tests


@pytest.mark.parametrize(
    "exc_cls",
    [litellm.AuthenticationError, litellm.BadRequestError, litellm.PermissionDeniedError],
)
def test_all_config_error_types_are_classified_as_config(exc_cls):
    with (
        patch("app.services.llm_service.increment_metric_counter") as mock_incr,
        patch("app.services.llm_service.forward_to_sentry_if_alertable"),
    ):
        kwargs = {"llm_provider": "openai", "model": "m"}
        if exc_cls is litellm.PermissionDeniedError:
            kwargs["response"] = MagicMock()
        _classify_and_log_llm_error(exc_cls("x", **kwargs), context="test")
    mock_incr.assert_called_once_with("llm_config_error")


@pytest.mark.parametrize(
    "exc_cls",
    [litellm.RateLimitError, litellm.APIConnectionError, litellm.ServiceUnavailableError, litellm.InternalServerError],
)
def test_all_transient_error_types_are_classified_as_transient(exc_cls):
    with (
        patch("app.services.llm_service.increment_metric_counter") as mock_incr,
        patch("app.services.llm_service.forward_to_sentry_if_alertable"),
    ):
        _classify_and_log_llm_error(exc_cls("x", llm_provider="openai", model="m"), context="test")
    mock_incr.assert_called_once_with("llm_transient_error")
