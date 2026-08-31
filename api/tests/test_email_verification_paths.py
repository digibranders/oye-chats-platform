"""Reoon email verification: what it costs a visitor, and where it is applied.

Three defects, all of them about the boundary rather than the vendor:

* the interactive blur check inherited the BACKGROUND timeout (90s), so a slow
  vendor blew past the 60s global middleware and the widget, which retries a
  504, kept the visitor's form spinning for roughly two minutes;
* ``attendee_email`` on the meeting-booking path was the one visitor-supplied
  address nobody verified, while every form was gated on the verdict;
* a missing ``REOON_API_KEY`` turned the whole feature into a silent no-op,
  observable only as a per-call warning.
"""

from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.auth import get_current_bot
from app.api.chat_routes import router
from app.services import reoon_service

SESSION_ID = "0194eb38-1234-7000-8000-000000000abc"


@contextmanager
def _session_ctx(session):
    yield session


def _bot():
    return SimpleNamespace(id=1, client_id=1, bot_key="bot-test-key", name="Test Bot", is_active=True)


def _app(bot):
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_current_bot] = lambda: bot
    return app


@pytest.fixture
def verification_on(monkeypatch):
    """Every gate in front of the Reoon call answers yes, and the cache is cold.

    Leaves the real ``_email_verdict`` in the path, so these tests exercise the
    plan gate, the budget, the cache and the vendor call as they actually run.
    """
    from app.core import cache as core_cache
    from app.services import credit_service

    monkeypatch.setattr("app.api.chat_routes.is_email_validation_enabled_for_bot", lambda bot_id, session: True)
    monkeypatch.setattr(credit_service, "is_feature_enabled", lambda session, action: True)
    monkeypatch.setattr("app.api.chat_routes._agent_enrichment_opt_in", lambda bot_id, action: True)
    monkeypatch.setattr("app.api.chat_routes.consume_vendor_budget", lambda *a, **k: True)
    monkeypatch.setattr(core_cache, "cache_get", lambda key: None)
    monkeypatch.setattr(core_cache, "cache_set", lambda key, value, ttl: True)
    monkeypatch.setattr("app.api.chat_routes.get_session", lambda: _session_ctx(MagicMock()))


def _record_verify(monkeypatch, verdict):
    """Replace the vendor call, recording the timeout each caller asked for."""
    calls = []

    def _verify(email, **kwargs):
        calls.append({"email": email, **kwargs})
        return verdict

    monkeypatch.setattr(reoon_service, "verify_email", _verify)
    return calls


_INVALID = {
    "status": "invalid",
    "overall_score": 5,
    "is_safe_to_send": False,
    "is_disposable": False,
    "is_deliverable": False,
    "is_valid_syntax": True,
    "is_spamtrap": False,
    "mx_accepts_mail": True,
}

_VALID = {**_INVALID, "status": "valid", "overall_score": 95, "is_safe_to_send": True, "is_deliverable": True}


# ── 9.1 the visitor's own wait ───────────────────────────────────────────────


class TestInteractiveTimeout:
    def test_blur_check_uses_the_short_budget(self, monkeypatch, verification_on):
        """A visitor is waiting on this call; 90s guarantees a 504 and a retry."""
        calls = _record_verify(monkeypatch, _VALID)

        response = TestClient(_app(_bot())).post("/chat/validate-email", json={"email": "asha@example.com"})

        assert response.status_code == 200
        assert calls[0]["timeout"] == reoon_service.REOON_INTERACTIVE_TIMEOUT_S
        # Must clear the 60s global request timeout with room to spare, or the
        # widget sees a 504 (a retryable status) instead of a verdict.
        assert calls[0]["timeout"] <= 10.0

    def test_the_background_budget_is_left_long(self, monkeypatch):
        """Lowering it globally would truncate power mode where nothing waits."""
        captured = {}

        class _Response:
            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

            def read(self):
                return b'{"status": "valid"}'

        def _urlopen(req, timeout=None):
            captured["timeout"] = timeout
            return _Response()

        monkeypatch.setenv("REOON_API_KEY", "k")
        monkeypatch.setattr(reoon_service.urllib.request, "urlopen", _urlopen)

        reoon_service.verify_email("asha@example.com")
        assert captured["timeout"] == reoon_service.REOON_BACKGROUND_TIMEOUT_S
        assert captured["timeout"] >= 60.0

        reoon_service.verify_email("asha@example.com", timeout=reoon_service.REOON_INTERACTIVE_TIMEOUT_S)
        assert captured["timeout"] == reoon_service.REOON_INTERACTIVE_TIMEOUT_S


# ── 9.2 the path that skipped the gate ───────────────────────────────────────


class TestMeetingBookingVerifiesAttendee:
    def _post(self, monkeypatch, email):
        session = MagicMock()
        monkeypatch.setattr("app.api.chat_routes.get_session", lambda: _session_ctx(session))
        monkeypatch.setattr("app.api.chat_routes.ensure_chat_session", MagicMock())
        monkeypatch.setattr("app.services.webhook_service.fire_webhook", MagicMock())
        response = TestClient(_app(_bot())).post(
            "/chat/meeting-booked",
            json={"session_id": SESSION_ID, "attendee_email": email},
        )
        return response, session

    def test_an_undeliverable_attendee_email_is_refused(self, monkeypatch, verification_on):
        _record_verify(monkeypatch, _INVALID)
        response, session = self._post(monkeypatch, "nobody@invalid.example")

        assert response.status_code == 400
        # And nothing was written: a 400 that still stored the row would be a
        # rejection in name only.
        session.add.assert_not_called()

    def test_a_good_attendee_email_books_normally(self, monkeypatch, verification_on):
        _record_verify(monkeypatch, _VALID)
        response, session = self._post(monkeypatch, "asha@example.com")

        assert response.status_code == 200
        assert session.add.called

    def test_a_vendor_outage_never_costs_the_booking(self, monkeypatch, verification_on):
        """Fail-open, identical to every other capture path."""
        _record_verify(monkeypatch, None)
        response, session = self._post(monkeypatch, "asha@example.com")

        assert response.status_code == 200
        assert session.add.called

    def test_a_booking_without_an_attendee_email_calls_no_vendor(self, monkeypatch, verification_on):
        calls = _record_verify(monkeypatch, _INVALID)
        session = MagicMock()
        monkeypatch.setattr("app.api.chat_routes.get_session", lambda: _session_ctx(session))
        monkeypatch.setattr("app.api.chat_routes.ensure_chat_session", MagicMock())
        monkeypatch.setattr("app.services.webhook_service.fire_webhook", MagicMock())

        response = TestClient(_app(_bot())).post("/chat/meeting-booked", json={"session_id": SESSION_ID})

        assert response.status_code == 200
        assert calls == []


# ── 9.4 the silent no-op ─────────────────────────────────────────────────────


class TestMissingApiKeyIsObservable:
    def test_a_missing_key_emits_one_warning_and_one_metric(self, monkeypatch, caplog):
        counters = []
        monkeypatch.delenv("REOON_API_KEY", raising=False)
        monkeypatch.setattr(reoon_service, "_missing_key_reported", False)
        monkeypatch.setattr(reoon_service, "increment_metric_counter", lambda name, **k: counters.append(name))
        monkeypatch.setattr(reoon_service, "forward_to_sentry_if_alertable", lambda name, **k: None)

        with caplog.at_level("WARNING", logger="app.services.reoon_service"):
            assert reoon_service.verify_email("asha@example.com") is None
            assert reoon_service.verify_email("bo@example.com") is None

        # Reported, so the state is discoverable...
        assert counters == [reoon_service._MISSING_KEY_METRIC]
        # ...and reported ONCE, so it is not a per-call log flood.
        assert sum(reoon_service._MISSING_KEY_METRIC in r.message for r in caplog.records) == 1

    def test_a_present_key_reports_nothing(self, monkeypatch):
        counters = []
        monkeypatch.setenv("REOON_API_KEY", "a-real-key")
        monkeypatch.setattr(reoon_service, "_missing_key_reported", False)
        monkeypatch.setattr(reoon_service, "increment_metric_counter", lambda name, **k: counters.append(name))

        assert reoon_service.check_configuration() is True
        assert counters == []
