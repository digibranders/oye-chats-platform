"""ARQ retry behavior for email tasks (audit F13, tightened by I12).

ARQ only re-runs a job when it raises ``arq.worker.Retry`` (or is cancelled),
a plain exception is logged and the job is marked permanently failed. The email
tasks previously raised ``RuntimeError`` on a Brevo failure, so a transient 5xx
dropped an OTP / trial-lifecycle / invoice email with no retry (F13).

The other half is I12: they then retried on ANY falsy result, including the 10s
read timeout that fires *after* the request body was written — at which point
Brevo may already hold the message and a retry sends the customer a second OTP
or a second invoice. Only a failure that never reached the provider may be
re-sent, which is what ``SendOutcome.can_retry`` marks.
"""

import asyncio
from urllib.error import HTTPError, URLError

import pytest
from arq.worker import Retry

from app.services.email_service import SendOutcome
from app.worker import tasks


def _outcome_for(exc: Exception) -> SendOutcome:
    """Run a Brevo send whose transport raises ``exc`` and return the outcome."""
    import app.services.email_service as email_service

    def _raise(*_a, **_k):
        raise exc

    original = email_service.urlopen
    email_service.urlopen = _raise
    try:
        return email_service._send_brevo_email_result("to@example.com", "S", "<p>b</p>")
    finally:
        email_service.urlopen = original


def test_connection_phase_failure_is_marked_retryable(monkeypatch):
    import app.services.email_service as email_service

    monkeypatch.setattr(email_service, "EMAIL_ENABLED", True)
    outcome = _outcome_for(URLError(ConnectionRefusedError("connection refused")))
    assert outcome == SendOutcome(False, can_retry=True)


def test_read_timeout_after_the_request_was_sent_is_not_retryable(monkeypatch):
    """The exact I12 case: urllib raises the raw socket timeout from
    ``getresponse``, so the body was already on the wire."""
    import app.services.email_service as email_service

    monkeypatch.setattr(email_service, "EMAIL_ENABLED", True)
    outcome = _outcome_for(TimeoutError("timed out"))
    assert outcome == SendOutcome(False, can_retry=False)


def test_server_rejection_is_not_retryable(monkeypatch):
    import app.services.email_service as email_service

    monkeypatch.setattr(email_service, "EMAIL_ENABLED", True)
    outcome = _outcome_for(HTTPError("https://api.brevo.com", 400, "Bad Request", {}, None))
    assert outcome.can_retry is False


def test_rate_limit_is_retryable(monkeypatch):
    """429 states outright that nothing was queued, so re-sending is safe."""
    import app.services.email_service as email_service

    monkeypatch.setattr(email_service, "EMAIL_ENABLED", True)
    outcome = _outcome_for(HTTPError("https://api.brevo.com", 429, "Too Many Requests", {}, None))
    assert outcome.can_retry is True


def test_public_bool_contract_is_unchanged(monkeypatch):
    """Every other caller still sees plain True/False."""
    import app.services.email_service as email_service

    monkeypatch.setattr(email_service, "EMAIL_PROVIDER", "brevo")
    monkeypatch.setattr(email_service, "_send_brevo_email_result", lambda *a, **k: SendOutcome(False, can_retry=True))
    assert email_service._send_raw_email("to@example.com", "S", "<p>b</p>") is False

    monkeypatch.setattr(email_service, "_send_brevo_email_result", lambda *a, **k: SendOutcome(True))
    assert email_service._send_raw_email("to@example.com", "S", "<p>b</p>") is True


def test_task_send_email_retries_on_transient_failure(monkeypatch):
    import app.services.email_service as email_service

    # Pin EMAIL_PROVIDER rather than relying on the ambient .env: task_send_email
    # calls _send_raw_email_result, which routes on EMAIL_PROVIDER, so mocking the
    # Brevo function without pinning "brevo" would silently no-op if the
    # environment happens to have EMAIL_PROVIDER=ses.
    monkeypatch.setattr(email_service, "EMAIL_PROVIDER", "brevo")
    monkeypatch.setattr(email_service, "_send_brevo_email_result", lambda *a, **k: SendOutcome(False, can_retry=True))

    with pytest.raises(Retry):
        asyncio.run(tasks.task_send_email({"job_try": 1}, "to@example.com", "Subject", "<p>Body</p>"))


def test_task_send_email_does_not_retry_an_ambiguous_failure(monkeypatch):
    import app.services.email_service as email_service

    monkeypatch.setattr(email_service, "EMAIL_PROVIDER", "brevo")
    monkeypatch.setattr(email_service, "_send_brevo_email_result", lambda *a, **k: SendOutcome(False))

    result = asyncio.run(tasks.task_send_email({"job_try": 1}, "to@example.com", "Subject", "<p>Body</p>"))
    assert result is False


def test_task_send_template_email_retries_on_transient_failure(monkeypatch):
    import app.services.email_service as email_service

    monkeypatch.setattr(
        email_service, "_send_brevo_template_result", lambda *a, **k: SendOutcome(False, can_retry=True)
    )

    with pytest.raises(Retry):
        asyncio.run(tasks.task_send_template_email({"job_try": 2}, "to@example.com", 7, {}))


def test_task_send_template_email_does_not_retry_an_ambiguous_failure(monkeypatch):
    import app.services.email_service as email_service

    monkeypatch.setattr(email_service, "_send_brevo_template_result", lambda *a, **k: SendOutcome(False))

    assert asyncio.run(tasks.task_send_template_email({"job_try": 2}, "to@example.com", 7, {})) is False


def test_task_send_email_returns_true_on_success(monkeypatch):
    import app.services.email_service as email_service

    monkeypatch.setattr(email_service, "EMAIL_PROVIDER", "brevo")
    monkeypatch.setattr(email_service, "_send_brevo_email_result", lambda *a, **k: SendOutcome(True))

    result = asyncio.run(tasks.task_send_email({"job_try": 1}, "to@example.com", "Subject", "<p>Body</p>"))
    assert result is True
