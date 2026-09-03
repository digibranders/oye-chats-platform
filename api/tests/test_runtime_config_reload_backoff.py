"""A failed runtime_config reload must back off (audit R10).

``_cache_loaded_at`` was left untouched when the reload raised, so every
subsequent ``get()`` re-entered ``_load_cache`` and serialised the whole
process behind one blocking SELECT under ``_cache_lock`` for as long as the
database was unreachable. The hot chat path calls ``get`` several times per
turn.
"""

from __future__ import annotations

import pytest

from app.services import runtime_config


@pytest.fixture(autouse=True)
def _isolate_cache(monkeypatch):
    monkeypatch.setattr(runtime_config, "_cache", {})
    monkeypatch.setattr(runtime_config, "_cache_loaded_at", 0.0)
    yield
    runtime_config.invalidate_runtime_config_cache()


def test_failed_reload_is_retried_only_after_the_backoff_window(monkeypatch):
    attempts = []

    def boom():
        attempts.append(1)
        raise RuntimeError("database unreachable")

    monkeypatch.setattr(runtime_config, "get_session", boom)

    for _ in range(20):
        assert runtime_config.get("model.primary", "env-default") == "env-default"

    assert len(attempts) == 1, "a failed reload must not be retried on every get()"

    # The stamp is advanced by exactly the retry window, not by the full TTL.
    age = runtime_config._TTL_SECONDS - (runtime_config.time.time() - runtime_config._cache_loaded_at)
    assert 0 < age <= runtime_config._RETRY_AFTER_SECONDS


def test_reload_is_retried_once_the_backoff_window_elapses(monkeypatch):
    attempts = []

    def boom():
        attempts.append(1)
        raise RuntimeError("database unreachable")

    monkeypatch.setattr(runtime_config, "get_session", boom)
    runtime_config.get("model.primary")
    assert len(attempts) == 1

    # Pretend the retry window has passed.
    monkeypatch.setattr(
        runtime_config,
        "_cache_loaded_at",
        runtime_config._cache_loaded_at - runtime_config._RETRY_AFTER_SECONDS - 1,
    )
    runtime_config.get("model.primary")
    assert len(attempts) == 2


def test_previous_values_survive_a_failed_reload(monkeypatch):
    monkeypatch.setattr(runtime_config, "_cache", {"model.primary": "openai/pinned"})
    monkeypatch.setattr(runtime_config, "_cache_loaded_at", 0.0)

    def boom():
        raise RuntimeError("database unreachable")

    monkeypatch.setattr(runtime_config, "get_session", boom)

    assert runtime_config.get("model.primary", "env-default") == "openai/pinned"
