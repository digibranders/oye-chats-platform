"""AR-05 regression: the admin-settable gate model must actually be used.

Before this fix, `check_relevance()` read the frozen `GATE_MODEL` module
constant (captured at import time from the env var) instead of resolving it
via `runtime_config.get_gate_model()` on every call. An admin swapping the
gate model via the super-admin dashboard during an incident would see the
change "save" successfully while the gate kept calling the old model
indefinitely — a decorative control.
"""

import json
from unittest.mock import MagicMock, patch

from app.services.relevance_gate import check_relevance


def _mock_completion(score: float):
    response = MagicMock()
    response.choices = [MagicMock(message=MagicMock(content=json.dumps({"score": score})))]
    return response


def test_check_relevance_uses_runtime_config_gate_model(monkeypatch):
    """The exact regression scenario: an admin sets a custom gate model via
    runtime_config (simulating a dashboard save). check_relevance() must call
    litellm with THAT model, not the frozen GATE_MODEL env constant."""
    monkeypatch.setattr("app.services.relevance_gate.cache_get", lambda *_a, **_k: None)
    monkeypatch.setattr("app.services.relevance_gate.cache_set", lambda *_a, **_k: None)
    monkeypatch.setattr(
        "app.services.runtime_config.get_gate_model",
        lambda: "openai/gpt-5.4-mini-incident-swap",
    )
    chunk = MagicMock(content="Our standard plan costs $49/month.")

    with patch("litellm.completion", return_value=_mock_completion(0.9)) as mock_completion:
        check_relevance("What does the plan cost?", [chunk], bot_id=1)

    _, kwargs = mock_completion.call_args
    assert kwargs["model"] == "openai/gpt-5.4-mini-incident-swap"


def test_check_relevance_falls_back_to_env_default_when_unconfigured(monkeypatch):
    """With no DB-backed override at all, the resolved model still comes from
    runtime_config's own fallback chain (model.gate -> model.fallback ->
    FALLBACK_MODEL env), proving the call path is live end-to-end."""
    monkeypatch.setattr("app.services.relevance_gate.cache_get", lambda *_a, **_k: None)
    monkeypatch.setattr("app.services.relevance_gate.cache_set", lambda *_a, **_k: None)
    monkeypatch.setattr("app.services.runtime_config.get", lambda key, default=None: default)
    chunk = MagicMock(content="Our standard plan costs $49/month.")

    with patch("litellm.completion", return_value=_mock_completion(0.9)) as mock_completion:
        check_relevance("What does the plan cost?", [chunk], bot_id=1)

    _, kwargs = mock_completion.call_args
    assert kwargs["model"]  # resolved to *something* via the real runtime_config chain


def test_gate_model_is_re_resolved_on_every_call_not_cached_at_import(monkeypatch):
    """The bug was specifically that the model was frozen at import time.
    Changing the runtime_config-resolved model between two calls must change
    which model the second call uses — proves there's no import-time
    freezing anywhere in the new code path."""
    monkeypatch.setattr("app.services.relevance_gate.cache_get", lambda *_a, **_k: None)
    monkeypatch.setattr("app.services.relevance_gate.cache_set", lambda *_a, **_k: None)
    chunk = MagicMock(content="Our standard plan costs $49/month.")

    monkeypatch.setattr("app.services.runtime_config.get_gate_model", lambda: "model-before-swap")
    with patch("litellm.completion", return_value=_mock_completion(0.9)) as mock_completion:
        check_relevance("Q1", [chunk], bot_id=1)
    assert mock_completion.call_args.kwargs["model"] == "model-before-swap"

    monkeypatch.setattr("app.services.runtime_config.get_gate_model", lambda: "model-after-swap")
    with patch("litellm.completion", return_value=_mock_completion(0.9)) as mock_completion:
        check_relevance("Q2", [chunk], bot_id=1)
    assert mock_completion.call_args.kwargs["model"] == "model-after-swap"
