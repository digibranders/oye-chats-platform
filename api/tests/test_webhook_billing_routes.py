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


# ── Missing event-id: never silently dropped ─────────────────────────────────


def test_missing_event_id_is_dead_lettered_and_retried_not_dropped():
    """Finding #4: a delivery with no X-Razorpay-Event-Id can't be deduped, and
    the dispatcher used to treat a null id as a 'duplicate' → silent 200 ACK,
    losing a revenue event forever. It must instead route to the dead-letter +
    retry path (never reaching the handler)."""
    from app.api import webhook_billing_routes
    from app.db.models import FailedWebhook
    from app.services import razorpay_service

    mock_session = MagicMock()
    with (
        patch.object(webhook_billing_routes, "RAZORPAY_WEBHOOK_SECRET", "whsec"),
        patch.object(webhook_billing_routes, "WEBHOOK_RETRY_ON_ERROR", True),
        patch.object(webhook_billing_routes, "get_session", lambda: _fake_session_cm(mock_session)),
        patch.object(razorpay_service, "verify_webhook_signature", lambda **_: None),
        patch.object(razorpay_service, "handle_webhook_event", side_effect=AssertionError("must not dispatch")) as h,
    ):
        resp = _post(_make_client(), event_id="")

    # Retried, not ACK-dropped; the handler was never invoked (no false dedup).
    assert resp.status_code >= 500
    h.assert_not_called()
    # And the raw event is preserved for manual replay.
    added = [c.args[0] for c in mock_session.add.call_args_list]
    dead_letters = [o for o in added if isinstance(o, FailedWebhook)]
    assert len(dead_letters) == 1
    assert dead_letters[0].event_id is None


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


# ── Seat add-on events must be ACKed without granting plan credits (P0-3) ─────


def _seat_addon_event(event_name: str) -> dict:
    """Build a Razorpay subscription webhook event for the seat add-on sub.

    The add-on subscription is stamped ``notes.purpose == "seat_addon"`` by
    ``create_seat_addon_subscription`` and carries NO ``oyechats_plan_id`` —
    it must never be mistaken for a plan renewal that grants monthly credits.
    """
    return {
        "event": event_name,
        "payload": {
            "subscription": {
                "entity": {
                    "id": "sub_addon_123",
                    "quantity": 2,
                    "current_start": 1_700_000_000,
                    "current_end": 1_702_592_000,
                    "notes": {
                        "oyechats_client_id": "1",
                        "purpose": "seat_addon",
                    },
                }
            }
        },
    }


def test_seat_addon_charged_is_acked_without_plan_credit_grant():
    """``subscription.charged`` for a seat add-on must be handled (no raise,
    no dead-letter) and must NOT grant monthly plan credits (P0-3)."""
    from app.services import razorpay_service

    session = MagicMock()
    with (
        patch.object(razorpay_service, "_record_or_skip_event", return_value=True),
        patch.object(razorpay_service, "_grant_subscription_period") as grant_period,
        patch("app.services.credit_service.grant_for_subscription") as grant_sub,
    ):
        result = razorpay_service.handle_webhook_event(
            session, _seat_addon_event("subscription.charged"), "evt_seat_charged_1"
        )

    assert isinstance(result, str)
    assert grant_period.call_count == 0
    assert grant_sub.call_count == 0


def test_seat_addon_activated_is_acked_without_plan_credit_grant():
    """``subscription.activated`` for a seat add-on must be handled and must
    NOT grant plan credits or create a local plan subscription (P0-3)."""
    from app.services import razorpay_service

    session = MagicMock()
    with (
        patch.object(razorpay_service, "_record_or_skip_event", return_value=True),
        patch.object(razorpay_service, "_grant_subscription_period") as grant_period,
        patch("app.services.credit_service.grant_for_subscription") as grant_sub,
    ):
        result = razorpay_service.handle_webhook_event(
            session, _seat_addon_event("subscription.activated"), "evt_seat_activated_1"
        )

    assert isinstance(result, str)
    assert grant_period.call_count == 0
    assert grant_sub.call_count == 0


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
