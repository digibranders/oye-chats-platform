"""Razorpay inbound webhook route — failure handling (remediation C1).

A verified webhook whose processing raises must NOT be ACKed with 200 (that
tells Razorpay to stop retrying and silently loses the paid event). Instead:

* the raw signed event is dead-lettered (persisted) in a separate transaction
  that survives the handler's rollback, and
* the route returns 5xx so Razorpay retries (safe — event-id idempotency makes
  the retry a no-op once processing eventually succeeds).

When ``WEBHOOK_RETRY_ON_ERROR`` is off, the legacy 200-on-error behaviour is
kept as an emergency escape hatch, but the event is STILL dead-lettered.
"""

from __future__ import annotations

from contextlib import contextmanager
from unittest.mock import MagicMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient


@contextmanager
def _fake_session_cm(session):
    yield session


def _make_client():
    from app.api import webhook_billing_routes

    app = FastAPI()
    app.include_router(webhook_billing_routes.router)
    return TestClient(app, raise_server_exceptions=False)


def _post(client, body=b'{"event":"payment.captured"}', event_id="evt_test_1"):
    return client.post(
        "/webhooks/razorpay",
        content=body,
        headers={"x-razorpay-signature": "sig", "x-razorpay-event-id": event_id},
    )


# ── Failure path: 5xx + dead-letter (flag ON) ────────────────────────────────


def test_processing_error_returns_5xx_when_retry_enabled():
    from app.api import webhook_billing_routes
    from app.services import razorpay_service

    mock_session = MagicMock()
    with (
        patch.object(webhook_billing_routes, "RAZORPAY_WEBHOOK_SECRET", "whsec"),
        patch.object(webhook_billing_routes, "WEBHOOK_RETRY_ON_ERROR", True),
        patch.object(webhook_billing_routes, "get_session", lambda: _fake_session_cm(mock_session)),
        patch.object(razorpay_service, "verify_webhook_signature", lambda **_: None),
        patch.object(razorpay_service, "handle_webhook_event", side_effect=RuntimeError("boom")),
    ):
        resp = _post(_make_client())

    assert resp.status_code >= 500


def test_processing_error_dead_letters_the_raw_event():
    from app.api import webhook_billing_routes
    from app.db.models import FailedWebhook
    from app.services import razorpay_service

    mock_session = MagicMock()
    raw = b'{"event":"payment.captured","note":"abc"}'
    with (
        patch.object(webhook_billing_routes, "RAZORPAY_WEBHOOK_SECRET", "whsec"),
        patch.object(webhook_billing_routes, "WEBHOOK_RETRY_ON_ERROR", True),
        patch.object(webhook_billing_routes, "get_session", lambda: _fake_session_cm(mock_session)),
        patch.object(razorpay_service, "verify_webhook_signature", lambda **_: None),
        patch.object(razorpay_service, "handle_webhook_event", side_effect=RuntimeError("boom")),
    ):
        _post(_make_client(), body=raw, event_id="evt_dl_1")

    added = [c.args[0] for c in mock_session.add.call_args_list]
    dead_letters = [o for o in added if isinstance(o, FailedWebhook)]
    assert len(dead_letters) == 1
    dl = dead_letters[0]
    assert dl.provider == "razorpay"
    assert dl.event_id == "evt_dl_1"
    assert dl.raw_payload == raw  # exact bytes preserved for replay


# ── Flag OFF: legacy 200, but still dead-lettered ────────────────────────────


def test_flag_off_returns_200_but_still_dead_letters():
    from app.api import webhook_billing_routes
    from app.db.models import FailedWebhook
    from app.services import razorpay_service

    mock_session = MagicMock()
    with (
        patch.object(webhook_billing_routes, "RAZORPAY_WEBHOOK_SECRET", "whsec"),
        patch.object(webhook_billing_routes, "WEBHOOK_RETRY_ON_ERROR", False),
        patch.object(webhook_billing_routes, "get_session", lambda: _fake_session_cm(mock_session)),
        patch.object(razorpay_service, "verify_webhook_signature", lambda **_: None),
        patch.object(razorpay_service, "handle_webhook_event", side_effect=RuntimeError("boom")),
    ):
        resp = _post(_make_client())

    assert resp.status_code == 200
    added = [c.args[0] for c in mock_session.add.call_args_list]
    assert any(isinstance(o, FailedWebhook) for o in added)


# ── Success / duplicate path: 200, no dead-letter ────────────────────────────


def test_success_returns_200_and_no_dead_letter():
    from app.api import webhook_billing_routes
    from app.db.models import FailedWebhook
    from app.services import razorpay_service

    mock_session = MagicMock()
    with (
        patch.object(webhook_billing_routes, "RAZORPAY_WEBHOOK_SECRET", "whsec"),
        patch.object(webhook_billing_routes, "get_session", lambda: _fake_session_cm(mock_session)),
        patch.object(razorpay_service, "verify_webhook_signature", lambda **_: None),
        patch.object(razorpay_service, "handle_webhook_event", return_value="ok"),
    ):
        resp = _post(_make_client())

    assert resp.status_code == 200
    added = [c.args[0] for c in mock_session.add.call_args_list]
    assert not any(isinstance(o, FailedWebhook) for o in added)


# ── Regression: signature + secret guards unchanged ──────────────────────────


def test_invalid_signature_returns_400():
    from app.api import webhook_billing_routes
    from app.services import razorpay_service

    def _raise(**_):
        raise razorpay_service.SignatureMismatch("bad")

    with (
        patch.object(webhook_billing_routes, "RAZORPAY_WEBHOOK_SECRET", "whsec"),
        patch.object(razorpay_service, "verify_webhook_signature", _raise),
    ):
        resp = _post(_make_client())

    assert resp.status_code == 400


def test_missing_secret_returns_503():
    from app.api import webhook_billing_routes

    with patch.object(webhook_billing_routes, "RAZORPAY_WEBHOOK_SECRET", ""):
        resp = _post(_make_client())

    assert resp.status_code == 503
