"""BANT extraction resilience against gemini structured-output flakiness.

The gate model (gemini-2.5-flash) intermittently returns malformed structured
output under load — a bare JSON array instead of the ``{"signals": [...]}``
object, or unparseable text. That silently dropped strong buying signals and
left hot leads unscored. These pin the two defenses:

1. ``_parse_qualification_signals`` tolerates a bare-array response.
2. ``extract_qualification_signals`` retries on the reliable primary model when
   the gate model's output can't be parsed.
"""

import json
from contextlib import contextmanager
from unittest.mock import MagicMock, patch

import pytest

import app.services.rag_service as rag
from app.services.qualification_service import get_framework_config
from app.services.rag_service import _parse_qualification_signals, extract_qualification_signals

BANT = get_framework_config(None)

_VALID_SIGNAL = {
    "dimension": "NEED",
    "signal_text": "we had a security incident from outdated images",
    "extracted_value": "Production shipping outdated images caused a security incident.",
    "confidence": "high",
    "score": 25,
}
_WRAPPED = json.dumps({"signals": [_VALID_SIGNAL]})
_BARE_ARRAY = json.dumps([_VALID_SIGNAL])


class TestParseQualificationSignals:
    def test_parses_wrapped_object(self):
        out = _parse_qualification_signals(_WRAPPED)
        assert out[0]["dimension"] == "NEED"
        assert out[0]["score"] == 25

    def test_tolerates_bare_array(self):
        # gemini's known malformation: a bare array instead of {"signals": [...]}.
        out = _parse_qualification_signals(_BARE_ARRAY)
        assert out[0]["dimension"] == "NEED"

    def test_empty_signals_object(self):
        assert _parse_qualification_signals('{"signals": []}') == []

    def test_unparseable_raises(self):
        with pytest.raises(json.JSONDecodeError):
            _parse_qualification_signals("not json at all")


def _resp(content):
    r = MagicMock()
    r.choices = [MagicMock()]
    r.choices[0].message.content = content
    return r


@contextmanager
def _fake_gen(*a, **k):
    g = MagicMock()
    yield g


class TestExtractionModelFallback:
    def test_retries_on_primary_when_gate_output_malformed(self):
        """Gate model returns garbage → retry on primary model recovers the signal."""
        with (
            patch.object(rag, "_bant_model", return_value="gate-model"),
            patch.object(rag.runtime_config, "get_primary_model", return_value="primary-model"),
            patch.object(rag, "langfuse_generation", _fake_gen),
            patch.object(rag, "litellm") as mock_litellm,
        ):
            # 1st call (gate): unparseable. 2nd call (primary): valid.
            mock_litellm.completion.side_effect = [_resp("garbage not json"), _resp(_WRAPPED)]
            out = extract_qualification_signals("h", "we had a security incident", "a", {"need_score": 0}, BANT)

        assert out and out[0]["dimension"] == "NEED"
        assert mock_litellm.completion.call_count == 2
        models_used = [c.kwargs["model"] for c in mock_litellm.completion.call_args_list]
        assert models_used == ["gate-model", "primary-model"]

    def test_gate_success_does_not_call_primary(self):
        with (
            patch.object(rag, "_bant_model", return_value="gate-model"),
            patch.object(rag.runtime_config, "get_primary_model", return_value="primary-model"),
            patch.object(rag, "langfuse_generation", _fake_gen),
            patch.object(rag, "litellm") as mock_litellm,
        ):
            mock_litellm.completion.side_effect = [_resp(_WRAPPED)]
            out = extract_qualification_signals("h", "we had a security incident", "a", {"need_score": 0}, BANT)

        assert out and out[0]["dimension"] == "NEED"
        assert mock_litellm.completion.call_count == 1  # gate succeeded, primary not needed

    def test_all_models_fail_returns_empty_and_flags_metric(self):
        with (
            patch.object(rag, "_bant_model", return_value="gate-model"),
            patch.object(rag.runtime_config, "get_primary_model", return_value="primary-model"),
            patch.object(rag, "langfuse_generation", _fake_gen),
            patch.object(rag, "litellm") as mock_litellm,
            patch.object(rag, "_safety_net_metric") as mock_metric,
        ):
            mock_litellm.completion.side_effect = [_resp("garbage"), _resp("also garbage")]
            out = extract_qualification_signals("h", "we had a security incident", "a", {"need_score": 0}, BANT)

        assert out == []
        assert mock_litellm.completion.call_count == 2
        assert any(c.args and c.args[0] == "bant_extraction_failed" for c in mock_metric.call_args_list)
