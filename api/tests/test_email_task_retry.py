"""ARQ retry behavior for email tasks (audit F13).

ARQ only re-runs a job when it raises ``arq.worker.Retry`` (or is cancelled),
a plain exception is logged and the job is marked permanently failed. The email
tasks previously raised ``RuntimeError`` on a Brevo failure, so a transient 5xx
dropped an OTP / trial-lifecycle / invoice email with no retry. They must raise
``Retry`` so ``max_tries`` (3) actually applies.
"""

import asyncio

import pytest
from arq.worker import Retry

from app.worker import tasks


def test_task_send_email_retries_on_transient_failure(monkeypatch):
    import app.services.email_service as email_service

    # Pin EMAIL_PROVIDER rather than relying on the ambient .env: task_send_email
    # calls _send_raw_email, which routes on EMAIL_PROVIDER, so mocking the Brevo
    # function without pinning "brevo" would silently no-op if the environment
    # happens to have EMAIL_PROVIDER=ses.
    monkeypatch.setattr(email_service, "EMAIL_PROVIDER", "brevo")
    monkeypatch.setattr(email_service, "_send_brevo_email", lambda *a, **k: False)

    with pytest.raises(Retry):
        asyncio.run(tasks.task_send_email({"job_try": 1}, "to@example.com", "Subject", "<p>Body</p>"))


def test_task_send_template_email_retries_on_transient_failure(monkeypatch):
    import app.services.email_service as email_service

    monkeypatch.setattr(email_service, "_send_brevo_template", lambda *a, **k: False)

    with pytest.raises(Retry):
        asyncio.run(tasks.task_send_template_email({"job_try": 2}, "to@example.com", 7, {}))


def test_task_send_email_returns_true_on_success(monkeypatch):
    import app.services.email_service as email_service

    monkeypatch.setattr(email_service, "EMAIL_PROVIDER", "brevo")
    monkeypatch.setattr(email_service, "_send_brevo_email", lambda *a, **k: True)

    result = asyncio.run(tasks.task_send_email({"job_try": 1}, "to@example.com", "Subject", "<p>Body</p>"))
    assert result is True
