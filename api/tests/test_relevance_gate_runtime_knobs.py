"""The relevance gate's tunables must actually be read, and its fail-open counted.

Three findings, one module:

* ``_resolve_threshold`` ignored the super-admin runtime knob
  (``rag.relevance_threshold``). The dashboard control saved a value nothing
  read, so an admin loosening the gate during an incident saw a successful
  save and no change in behaviour, the same decorative-control shape as the
  AR-05 gate-model bug. Order is now per-bot → runtime knob → env default.
* The judge saw a hardcoded 3 chunks × 300 characters while generation
  received the full top-k of ~1000-character chunks. ``GATE_MAX_CHUNKS`` and
  ``GATE_CHUNK_PREVIEW_CHARS`` (5 × 500) bring the judge's view closer to what
  the generator answers from.
* The fail-open branch was a WARNING and nothing else, which is how a
  41-fail-open outage went unnoticed. It now increments ``gate_failed_open``.
"""

import importlib
import json
from unittest.mock import MagicMock, patch

import pytest

import app.services.relevance_gate as relevance_gate
from app.services import runtime_config


@pytest.fixture
def no_cache(monkeypatch):
    """Force every call through to the judge."""
    monkeypatch.setattr(relevance_gate, "cache_get", lambda *_a, **_k: None)
    monkeypatch.setattr(relevance_gate, "cache_set", lambda *_a, **_k: None)


def _verdict(score: float) -> MagicMock:
    response = MagicMock()
    response.choices = [MagicMock(message=MagicMock(content=json.dumps({"score": score})))]
    return response


# ── Threshold resolution ─────────────────────────────────────────────────────


class TestThresholdResolution:
    def test_per_bot_override_wins_over_the_runtime_knob(self, monkeypatch):
        monkeypatch.setattr(relevance_gate.runtime_config, "get_relevance_threshold", lambda default: 0.9)
        assert relevance_gate._resolve_threshold(0.3) == 0.3

    def test_runtime_knob_wins_over_the_env_default(self, monkeypatch):
        monkeypatch.setattr(relevance_gate, "RELEVANCE_THRESHOLD", 0.55)
        monkeypatch.setattr(relevance_gate.runtime_config, "get_relevance_threshold", lambda default: 0.7)
        assert relevance_gate._resolve_threshold(None) == 0.7

    def test_env_default_applies_when_the_knob_is_unset(self, monkeypatch):
        """``runtime_config.get`` returns the supplied default when the key is
        absent from pricing_config; that default must be THIS module's env
        value, not runtime_config's own 0.5 placeholder."""
        monkeypatch.setattr(relevance_gate, "RELEVANCE_THRESHOLD", 0.55)
        monkeypatch.setattr(runtime_config, "get", lambda key, default=None: default)
        assert relevance_gate._resolve_threshold(None) == 0.55

    def test_knob_is_read_from_the_right_key(self, monkeypatch):
        seen: dict = {}

        def fake_get(key, default=None):
            seen["key"] = key
            return default

        monkeypatch.setattr(runtime_config, "get", fake_get)
        relevance_gate._resolve_threshold(None)
        assert seen["key"] == "rag.relevance_threshold"

    def test_knob_is_not_consulted_when_a_bot_override_is_present(self, monkeypatch):
        def boom(default):
            raise AssertionError("runtime knob must not be read when the bot overrides it")

        monkeypatch.setattr(relevance_gate.runtime_config, "get_relevance_threshold", boom)
        assert relevance_gate._resolve_threshold(0.4) == 0.4

    @pytest.mark.parametrize(("raw", "expected"), [(1.7, 1.0), (-0.2, 0.0), ("0.4", 0.4), (0, 0.0), (1, 1.0)])
    def test_bot_values_are_clamped_and_coerced(self, raw, expected):
        assert relevance_gate._resolve_threshold(raw) == expected

    @pytest.mark.parametrize(("raw", "expected"), [(1.7, 1.0), (-0.2, 0.0), ("0.4", 0.4)])
    def test_knob_values_are_clamped_and_coerced(self, monkeypatch, raw, expected):
        monkeypatch.setattr(runtime_config, "get", lambda key, default=None: raw)
        assert relevance_gate._resolve_threshold(None) == expected

    @pytest.mark.parametrize("raw", ["garbage", float("nan")])
    def test_unusable_bot_values_fall_back_to_the_env_default(self, monkeypatch, raw):
        monkeypatch.setattr(relevance_gate, "RELEVANCE_THRESHOLD", 0.55)
        assert relevance_gate._resolve_threshold(raw) == 0.55

    def test_unusable_knob_value_falls_back_to_the_env_default(self, monkeypatch):
        monkeypatch.setattr(relevance_gate, "RELEVANCE_THRESHOLD", 0.55)
        monkeypatch.setattr(runtime_config, "get", lambda key, default=None: "not-a-number")
        assert relevance_gate._resolve_threshold(None) == 0.55

    def test_check_relevance_applies_the_runtime_knob(self, monkeypatch, no_cache):
        """The exact regression: the same 0.6 verdict must flip with the knob."""
        chunk = MagicMock(content="Our standard plan costs $49/month.")

        monkeypatch.setattr(relevance_gate.runtime_config, "get_relevance_threshold", lambda default: 0.7)
        with patch("litellm.completion", return_value=_verdict(0.6)):
            assert relevance_gate.check_relevance("Q", [chunk], bot_id=1) == (False, 0.6)

        monkeypatch.setattr(relevance_gate.runtime_config, "get_relevance_threshold", lambda default: 0.5)
        with patch("litellm.completion", return_value=_verdict(0.6)):
            assert relevance_gate.check_relevance("Q", [chunk], bot_id=1) == (True, 0.6)

    def test_check_relevance_bot_override_beats_the_runtime_knob(self, monkeypatch, no_cache):
        chunk = MagicMock(content="Our standard plan costs $49/month.")
        monkeypatch.setattr(relevance_gate.runtime_config, "get_relevance_threshold", lambda default: 0.9)

        with patch("litellm.completion", return_value=_verdict(0.6)):
            assert relevance_gate.check_relevance("Q", [chunk], bot_id=1, threshold=0.5) == (True, 0.6)


# ── Judge input size ─────────────────────────────────────────────────────────


class TestJudgeInputKnobs:
    def test_defaults(self):
        assert relevance_gate.GATE_MAX_CHUNKS == 5
        # A whole default-size chunk (CHUNK_SIZE=1000), so the judge and the
        # generator read the same text.
        assert relevance_gate.GATE_CHUNK_PREVIEW_CHARS == 1000

    def test_prompt_shows_five_chunks_of_500_characters(self, monkeypatch):
        monkeypatch.setattr(relevance_gate, "GATE_MAX_CHUNKS", 5)
        monkeypatch.setattr(relevance_gate, "GATE_CHUNK_PREVIEW_CHARS", 500)
        chunks = [MagicMock(content=str(i) * 800) for i in range(1, 8)]

        prompt = relevance_gate._build_gate_prompt("q", chunks)

        assert "Chunk 5: " in prompt
        assert "Chunk 6: " not in prompt
        first = next(line for line in prompt.splitlines() if line.startswith("Chunk 1: "))
        assert len(first) == len("Chunk 1: ") + 500

    def test_knobs_are_read_at_call_time(self, monkeypatch):
        monkeypatch.setattr(relevance_gate, "GATE_MAX_CHUNKS", 2)
        monkeypatch.setattr(relevance_gate, "GATE_CHUNK_PREVIEW_CHARS", 10)
        chunks = [MagicMock(content="x" * 50) for _ in range(4)]

        prompt = relevance_gate._build_gate_prompt("q", chunks)

        assert "Chunk 2: " in prompt
        assert "Chunk 3: " not in prompt
        assert "Chunk 1: " + "x" * 10 + "\n" in prompt

    def test_env_override_and_empty_value(self, monkeypatch):
        """An empty-but-present value is what the deploy writes for an unset
        repo variable (see the ``RELEVANCE_GATE_ENABLED`` history); it must
        mean the default, not an ``int('')`` crash on import."""
        monkeypatch.setenv("GATE_MAX_CHUNKS", "2")
        monkeypatch.setenv("GATE_CHUNK_PREVIEW_CHARS", "")
        try:
            reloaded = importlib.reload(relevance_gate)
            assert reloaded.GATE_MAX_CHUNKS == 2
            assert reloaded.GATE_CHUNK_PREVIEW_CHARS == 1000
        finally:
            monkeypatch.delenv("GATE_MAX_CHUNKS", raising=False)
            monkeypatch.delenv("GATE_CHUNK_PREVIEW_CHARS", raising=False)
            importlib.reload(relevance_gate)

    def test_zero_is_floored_so_the_judge_always_sees_something(self, monkeypatch):
        monkeypatch.setenv("GATE_MAX_CHUNKS", "0")
        try:
            assert importlib.reload(relevance_gate).GATE_MAX_CHUNKS == 1
        finally:
            monkeypatch.delenv("GATE_MAX_CHUNKS", raising=False)
            importlib.reload(relevance_gate)


# ── Fail-open metric ─────────────────────────────────────────────────────────


class TestFailedOpenMetric:
    def test_a_judge_error_increments_gate_failed_open(self, no_cache):
        chunk = MagicMock(content="x")
        with (
            patch("litellm.completion", side_effect=TimeoutError("gate timed out")),
            patch.object(relevance_gate, "increment_metric_counter") as incr,
        ):
            assert relevance_gate.check_relevance("Q", [chunk], bot_id=1) == (True, 1.0)
        incr.assert_called_once_with("gate_failed_open")

    def test_a_malformed_verdict_increments_gate_failed_open(self, no_cache):
        """The empty-string production symptom: the call succeeds, parsing
        fails, the answer goes through unjudged. That is a fail-open too."""
        chunk = MagicMock(content="x")
        empty = MagicMock()
        empty.choices = [MagicMock(message=MagicMock(content=""))]
        with (
            patch("litellm.completion", return_value=empty),
            patch.object(relevance_gate, "increment_metric_counter") as incr,
        ):
            assert relevance_gate.check_relevance("Q", [chunk], bot_id=1) == (True, 1.0)
        incr.assert_called_once_with("gate_failed_open")

    def test_a_real_verdict_does_not_increment(self, no_cache):
        chunk = MagicMock(content="x")
        with (
            patch("litellm.completion", return_value=_verdict(0.2)),
            patch.object(relevance_gate, "increment_metric_counter") as incr,
        ):
            relevance_gate.check_relevance("Q", [chunk], bot_id=1)
        incr.assert_not_called()

    def test_metric_failure_never_breaks_the_fail_open_path(self, no_cache):
        """The real counter swallows Redis errors itself; the gate must still
        fail open if the metric hook is somehow broken."""
        chunk = MagicMock(content="x")
        with (
            patch("litellm.completion", side_effect=RuntimeError("provider down")),
            patch.object(relevance_gate, "increment_metric_counter", lambda *_a, **_k: None),
        ):
            assert relevance_gate.check_relevance("Q", [chunk], bot_id=1) == (True, 1.0)
