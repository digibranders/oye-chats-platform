"""Razorpay webhook signature verification (remediation L1).

The signature must be computed over the **exact raw request bytes** with a
timing-safe comparison — not over a ``decode("utf-8")`` round-trip, which both
risks divergence and (for non-UTF-8 bytes) raises before verification can run.
"""

from __future__ import annotations

import hashlib
import hmac

import pytest


@pytest.fixture(autouse=True)
def _razorpay_secret(monkeypatch):
    monkeypatch.setenv("RAZORPAY_KEY_ID", "rzp_test_dummy")
    monkeypatch.setenv("RAZORPAY_KEY_SECRET", "secret_dummy")
    monkeypatch.setenv("RAZORPAY_WEBHOOK_SECRET", "whsec_dummy")
    from importlib import reload

    import app.config

    reload(app.config)
    import app.services.razorpay_service as svc

    reload(svc)
    yield


def _sign(payload: bytes) -> str:
    from app.services import razorpay_service

    return hmac.new(
        razorpay_service.RAZORPAY_WEBHOOK_SECRET.encode("utf-8"),
        payload,
        hashlib.sha256,
    ).hexdigest()


def test_valid_signature_passes():
    from app.services import razorpay_service

    payload = b'{"event":"payment.captured","id":"evt_1"}'
    razorpay_service.verify_webhook_signature(payload=payload, signature=_sign(payload))


def test_tampered_signature_raises():
    from app.services import razorpay_service

    payload = b'{"event":"payment.captured"}'
    with pytest.raises(razorpay_service.SignatureMismatch):
        razorpay_service.verify_webhook_signature(payload=payload, signature="deadbeef")


def test_tampered_payload_raises():
    from app.services import razorpay_service

    sig = _sign(b'{"amount":100}')
    with pytest.raises(razorpay_service.SignatureMismatch):
        # Same signature, mutated body → must fail.
        razorpay_service.verify_webhook_signature(payload=b'{"amount":999999}', signature=sig)


def test_verifies_over_raw_bytes_not_utf8_decode():
    """Non-UTF-8 raw bytes must verify against an HMAC computed over those bytes.

    The previous implementation did ``payload.decode("utf-8")`` before handing
    the body to the SDK, which raises ``UnicodeDecodeError`` on bytes like this
    and so could never verify them. Computing the HMAC over the raw bytes does.
    """
    from app.services import razorpay_service

    payload = b'{"x":"\xff\xfe-not-utf8"}'
    razorpay_service.verify_webhook_signature(payload=payload, signature=_sign(payload))


def test_missing_secret_raises_runtime(monkeypatch):
    from importlib import reload

    monkeypatch.setenv("RAZORPAY_WEBHOOK_SECRET", "")
    import app.config

    reload(app.config)
    import app.services.razorpay_service as svc

    reload(svc)
    with pytest.raises(RuntimeError):
        svc.verify_webhook_signature(payload=b"{}", signature="x")


def test_signature_failure_burst_escalates_to_error(caplog):
    """P1-6a — one bad signature is scanner noise (WARNING); a burst means a
    rotated/mistyped RAZORPAY_WEBHOOK_SECRET is rejecting EVERY billing event
    before dead-lettering, and must reach ERROR (→ Sentry)."""
    import logging as _logging

    from app.api import webhook_billing_routes as wbr

    wbr._note_signature_success()  # clean slate

    def _errors():
        return [r for r in caplog.records if r.levelno >= _logging.ERROR]

    with caplog.at_level(_logging.ERROR, logger="app.api.webhook_billing_routes"):
        wbr._note_signature_failure(1000.0)
        wbr._note_signature_failure(1010.0)
        assert not _errors(), "below threshold must stay quiet"
        wbr._note_signature_failure(1020.0)
        assert any("RAZORPAY_WEBHOOK_SECRET" in r.getMessage() for r in _errors())

    # A verified event resets the streak.
    wbr._note_signature_success()
    caplog.clear()
    with caplog.at_level(_logging.ERROR, logger="app.api.webhook_billing_routes"):
        wbr._note_signature_failure(2000.0)
        assert not _errors()
        # Window expiry also resets: a failure far outside the window starts
        # a fresh count instead of accumulating stale ones.
        wbr._note_signature_failure(2000.0 + wbr._SIG_FAILURE_WINDOW_SECS + 1)
        assert not _errors()
    wbr._note_signature_success()
