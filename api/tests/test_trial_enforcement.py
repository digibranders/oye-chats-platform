"""PR3 — Trial enforcement coverage.

Focused unit tests for the two new auth dependencies and the polite
offline helpers introduced for trial expiry. Routing-level tests (the
write endpoints' 403 path, the widget's offline payload shape) are
covered live in the smoke script that ships with PR3; this module
covers the pure logic so a CI regression catches a broken gate before
deploy.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from fastapi import HTTPException

from app.api import auth as auth_module
from app.api.chat_routes import _DEFAULT_OFFLINE_MESSAGE, _offline_stream, _polite_offline_payload


def _client(*, client_id: int = 1, is_superadmin: bool = False) -> SimpleNamespace:
    return SimpleNamespace(id=client_id, is_superadmin=is_superadmin)


def _sub(status: str) -> SimpleNamespace:
    """Build a minimal Subscription stand-in that survives the eager-load
    block in :func:`require_active_subscription`.
    """
    return SimpleNamespace(
        id=99,
        status=status,
        plan_id=5,
        trial_end=datetime.now(UTC) + timedelta(days=3),
        current_period_end=datetime.now(UTC) + timedelta(days=3),
    )


class _FakeQuery:
    """Tiny session stub that returns a single subscription row."""

    def __init__(self, subscription):
        self._sub = subscription

    def execute(self, _stmt):
        sub = self._sub

        class _Scalars:
            def first(self_inner):
                return sub

        class _Result:
            def scalars(self_inner):
                return _Scalars()

        return _Result()

    def expunge(self, _obj):
        pass


class _FakeSessionCtx:
    def __init__(self, sub):
        self._sub = sub

    def __enter__(self):
        return _FakeQuery(self._sub)

    def __exit__(self, *_exc):
        return False


@pytest.fixture
def patch_session():
    """Swap ``get_session`` inside auth.py for a fake that yields a configurable sub."""

    def _install(sub):
        return patch.object(auth_module, "get_session", lambda: _FakeSessionCtx(sub))

    return _install


# ── require_active_subscription ────────────────────────────────────────────


class TestRequireActiveSubscription:
    def test_allows_trialing(self, patch_session):
        client = _client()
        with patch_session(_sub("trialing")):
            result = auth_module.require_active_subscription(client=client)
        assert result is not None
        assert result.status == "trialing"

    def test_allows_active(self, patch_session):
        with patch_session(_sub("active")):
            result = auth_module.require_active_subscription(client=_client())
        assert result.status == "active"

    def test_allows_past_due(self, patch_session):
        """Dunning is a separate concern — past_due users keep service."""
        with patch_session(_sub("past_due")):
            result = auth_module.require_active_subscription(client=_client())
        assert result.status == "past_due"

    def test_blocks_trial_expired(self, patch_session):
        with patch_session(_sub("trial_expired")), pytest.raises(HTTPException) as excinfo:
            auth_module.require_active_subscription(client=_client())
        exc = excinfo.value
        assert exc.status_code == 403
        assert exc.detail["error"] == "subscription_required"
        assert exc.detail["subscription_status"] == "trial_expired"
        # Copy must be expiry-specific, not generic — the dashboard uses
        # this string when no client-side i18n is wired up.
        assert "trial has ended" in exc.detail["message"].lower()

    def test_blocks_canceled(self, patch_session):
        with patch_session(_sub("canceled")), pytest.raises(HTTPException) as excinfo:
            auth_module.require_active_subscription(client=_client())
        assert excinfo.value.detail["subscription_status"] == "canceled"

    def test_missing_subscription_blocks(self, patch_session):
        with patch_session(None), pytest.raises(HTTPException) as excinfo:
            auth_module.require_active_subscription(client=_client())
        assert excinfo.value.detail["subscription_status"] == "missing"

    def test_superadmin_bypasses_gate(self, patch_session):
        """Platform staff manage the system; no paying sub required."""
        # The fake session is wired but should not even be hit — the gate
        # returns early on ``is_superadmin``.
        with patch_session(_sub("trial_expired")):
            result = auth_module.require_active_subscription(client=_client(is_superadmin=True))
        assert result is None


# ── bot_subscription_status / is_bot_serving ──────────────────────────────


class TestBotSubscriptionStatus:
    def test_returns_status_string(self, patch_session):
        with patch_session(_sub("trialing")):
            assert auth_module.bot_subscription_status(1) == "trialing"

    def test_returns_missing_when_no_row(self, patch_session):
        with patch_session(None):
            assert auth_module.bot_subscription_status(999) == "missing"

    def test_is_bot_serving_true_when_active(self, patch_session):
        with patch_session(_sub("active")):
            assert auth_module.is_bot_serving(1) is True

    def test_is_bot_serving_false_when_expired(self, patch_session):
        with patch_session(_sub("trial_expired")):
            assert auth_module.is_bot_serving(1) is False


# ── Widget polite-offline payloads ────────────────────────────────────────


class TestPoliteOffline:
    def test_uses_configured_offline_message(self):
        bot = SimpleNamespace(offline_message="We're closed — leave a message.")
        payload = _polite_offline_payload(bot, reason="subscription_trial_expired")
        assert payload["answer"] == "We're closed — leave a message."
        assert payload["status"] == "service_unavailable"
        assert payload["metadata"]["offline"] is True
        assert payload["metadata"]["reason"] == "subscription_trial_expired"

    def test_falls_back_to_default_when_empty(self):
        bot = SimpleNamespace(offline_message="   ")
        payload = _polite_offline_payload(bot, reason="subscription_canceled")
        assert payload["answer"] == _DEFAULT_OFFLINE_MESSAGE

    def test_falls_back_to_default_when_none(self):
        bot = SimpleNamespace(offline_message=None)
        payload = _polite_offline_payload(bot, reason="subscription_missing")
        assert payload["answer"] == _DEFAULT_OFFLINE_MESSAGE

    def test_offline_stream_emits_protocol_frames(self):
        bot = SimpleNamespace(offline_message="See you soon!")
        chunks = list(_offline_stream(bot, reason="subscription_trial_expired"))
        # METADATA + body + FINAL_METADATA — the widget's parser depends
        # on all three being present, in order, in a single response.
        assert any(chunk.startswith("METADATA:") for chunk in chunks)
        assert "See you soon!" in "".join(chunks)
        assert any(chunk.startswith("\nFINAL_METADATA:") for chunk in chunks)
