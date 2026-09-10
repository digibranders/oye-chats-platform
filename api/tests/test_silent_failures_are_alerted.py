"""The three failures that used to be one log line each.

Each of these is deliberately non-blocking, and each was therefore invisible:

* a refund that fails leaves the visitor charged for an answer they did not
  get, and the ledger wrong;
* a relevance-gate fail-open means the answer went out with no scope check at
  all, which is how a 41-request outage ran unnoticed once already;
* a moderation fail-open means unfiltered visitor text reached the model.

Staying non-blocking is right. Staying invisible is not.
"""

from __future__ import annotations

import pytest

from app.core.metrics import _SENTRY_FORWARD_METRICS
from app.services import rag_service as rs
from app.services import relevance_gate


class _Chunk:
    def __init__(self, content: str) -> None:
        self.content = content


class TestTheyArePageable:
    @pytest.mark.parametrize(
        "metric",
        ["credit_refund_failed", "gate_failed_open", "moderation_failed_open"],
    )
    def test_the_metric_reaches_the_alert_channel(self, metric):
        assert metric in _SENTRY_FORWARD_METRICS

    def test_a_failed_qualification_enqueue_pages(self):
        """The turn falls back to the in-process pool and completes, so
        nothing downstream fails. That is exactly why it has to page: a
        broken queue would otherwise be discovered only when the pool
        saturated."""
        assert "qualification_enqueue_failed" in _SENTRY_FORWARD_METRICS


class TestTheRelevanceGateFailOpen:
    def test_it_still_fails_open(self, monkeypatch):
        """The behaviour must not change: a provider blip cannot start
        refusing every question on the platform."""
        monkeypatch.setattr(relevance_gate, "RELEVANCE_GATE_ENABLED", True)
        monkeypatch.setattr(relevance_gate, "cache_get", lambda _k: None)
        monkeypatch.setattr(relevance_gate, "increment_metric_counter", lambda *a, **k: None)
        monkeypatch.setattr(relevance_gate, "forward_to_sentry_if_alertable", lambda *a, **k: None)
        monkeypatch.setattr(relevance_gate.litellm, "completion", _raise)

        assert relevance_gate.check_relevance("q", [_Chunk("c")], bot_id=1) == (True, 1.0)

    def test_it_counts_and_pages(self, monkeypatch):
        counted: list = []
        paged: list = []
        monkeypatch.setattr(relevance_gate, "RELEVANCE_GATE_ENABLED", True)
        monkeypatch.setattr(relevance_gate, "cache_get", lambda _k: None)
        monkeypatch.setattr(relevance_gate, "increment_metric_counter", lambda name, **k: counted.append(name))
        monkeypatch.setattr(relevance_gate, "forward_to_sentry_if_alertable", lambda name, **k: paged.append((name, k)))
        monkeypatch.setattr(relevance_gate.litellm, "completion", _raise)

        relevance_gate.check_relevance("q", [_Chunk("c")], bot_id=7, client_id=3)

        assert counted == ["gate_failed_open"]
        assert paged and paged[0][0] == "gate_failed_open"
        assert paged[0][1]["bot_id"] == 7


class TestTheModerationFailOpen:
    def test_it_still_fails_open_and_is_counted(self, monkeypatch):
        seen: list = []
        monkeypatch.setattr(rs, "MODERATION_ENABLED", True)
        monkeypatch.setattr(rs, "_safety_net_metric", lambda name, **k: seen.append(name))
        monkeypatch.setattr(rs.litellm, "moderation", _raise)

        assert rs.check_visitor_safety("hello") == (True, None)
        assert "moderation_failed_open" in seen


def _raise(*_args, **_kwargs):
    raise RuntimeError("provider is down")
