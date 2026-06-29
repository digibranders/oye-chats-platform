"""Feature-flag plumbing for the payment remediation work (Phase 0).

These flags gate behaviour that changes the money path, so each one must have
a well-defined default and be overridable from the environment. Tests reload
``app.config`` under a patched environment because the flags are resolved at
import time (module-level constants), mirroring the reload pattern used by the
Razorpay service tests.
"""

from __future__ import annotations

from importlib import reload


def _reloaded_config(monkeypatch, **env):
    """Reload app.config with the given env overrides applied."""
    for key, value in env.items():
        if value is None:
            monkeypatch.delenv(key, raising=False)
        else:
            monkeypatch.setenv(key, value)
    import app.config as config

    return reload(config)


# ── WEBHOOK_RETRY_ON_ERROR ────────────────────────────────────────────────────
#
# Gates the C1 fix: when on, a webhook whose processing raises returns 5xx (so
# Razorpay retries — safe because of event-id idempotency) and the raw event is
# dead-lettered. Default ON: the legacy "return 200 on error" behaviour silently
# drops paid events, so the corrected behaviour is the desired default; the flag
# exists only as an emergency rollback switch.


def test_webhook_retry_on_error_defaults_true(monkeypatch):
    config = _reloaded_config(monkeypatch, WEBHOOK_RETRY_ON_ERROR=None)
    assert config.WEBHOOK_RETRY_ON_ERROR is True


def test_webhook_retry_on_error_can_be_disabled(monkeypatch):
    config = _reloaded_config(monkeypatch, WEBHOOK_RETRY_ON_ERROR="false")
    assert config.WEBHOOK_RETRY_ON_ERROR is False


def test_webhook_retry_on_error_accepts_truthy_aliases(monkeypatch):
    for raw in ("1", "true", "TRUE", "yes"):
        config = _reloaded_config(monkeypatch, WEBHOOK_RETRY_ON_ERROR=raw)
        assert config.WEBHOOK_RETRY_ON_ERROR is True


# ── PRORATED_UPGRADES_ENABLED ─────────────────────────────────────────────────
#
# Gates the Phase 6 prorated-upgrade feature. Default OFF: the feature is not
# built yet, and the current cancel-and-recreate upgrade path stays in effect
# until it is explicitly enabled.


def test_prorated_upgrades_defaults_false(monkeypatch):
    config = _reloaded_config(monkeypatch, PRORATED_UPGRADES_ENABLED=None)
    assert config.PRORATED_UPGRADES_ENABLED is False


def test_prorated_upgrades_can_be_enabled(monkeypatch):
    config = _reloaded_config(monkeypatch, PRORATED_UPGRADES_ENABLED="true")
    assert config.PRORATED_UPGRADES_ENABLED is True
