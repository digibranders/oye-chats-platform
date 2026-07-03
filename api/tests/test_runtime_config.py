"""Tests for app.services.runtime_config typed getters.

Focused on get_embed_concurrency — the runtime-tunable embed fan-out knob
(super-admin Models & RAG card → pricing_config: embed.concurrency).
"""

from app.config import EMBED_CONCURRENCY
from app.services import runtime_config


def _stub_get(monkeypatch, value):
    """Make runtime_config.get return ``value`` for embed.concurrency only,
    and the caller-supplied default for every other key."""

    def fake_get(key, default=None):
        return value if key == "embed.concurrency" else default

    monkeypatch.setattr(runtime_config, "get", fake_get)


def test_embed_concurrency_defaults_to_env(monkeypatch):
    # No DB override → the getter falls back to the EMBED_CONCURRENCY default.
    def fake_get(key, default=None):
        return default

    monkeypatch.setattr(runtime_config, "get", fake_get)
    assert runtime_config.get_embed_concurrency() == EMBED_CONCURRENCY


def test_embed_concurrency_override(monkeypatch):
    _stub_get(monkeypatch, 20)
    assert runtime_config.get_embed_concurrency() == 20


def test_embed_concurrency_override_string(monkeypatch):
    # pricing_config values are JSON — a numeric string must still coerce.
    _stub_get(monkeypatch, "24")
    assert runtime_config.get_embed_concurrency() == 24


def test_embed_concurrency_clamped_high(monkeypatch):
    _stub_get(monkeypatch, 999)
    assert runtime_config.get_embed_concurrency() == runtime_config._EMBED_CONCURRENCY_MAX


def test_embed_concurrency_clamped_low(monkeypatch):
    _stub_get(monkeypatch, 0)
    assert runtime_config.get_embed_concurrency() == runtime_config._EMBED_CONCURRENCY_MIN


def test_embed_concurrency_bad_value_falls_back(monkeypatch):
    # A corrupt DB row must never crash embedding — fall back to the env default.
    _stub_get(monkeypatch, "not-a-number")
    assert runtime_config.get_embed_concurrency() == EMBED_CONCURRENCY
