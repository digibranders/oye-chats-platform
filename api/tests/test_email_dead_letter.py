"""An email the platform accepted and then lost now leaves a row.

Every send here is fire-and-forget: the caller hands the message to
``send_email_async`` and returns. Three paths dropped a message with no record
anywhere, so "I never got the password reset" had no answer and nothing could
be replayed:

  * the enqueue failed, so the ARQ job never existed;
  * the provider refused it, which is deliberately not retried because a retry
    can deliver an OTP twice;
  * the retry budget ran out.

The audit called this "22 synchronous sends from request code". That was wrong:
all 42 call sites already go through ARQ. What was missing was not durability
of the send, it was any record of the send that failed.
"""

from __future__ import annotations

import pytest

from app.core.metrics import _SENTRY_FORWARD_METRICS
from app.db.models import FailedEmail
from app.services import email_service


@pytest.fixture
def recorded(monkeypatch):
    """Capture rows instead of writing them, so these stay unit tests."""
    rows: list[FailedEmail] = []

    class _Session:
        def add(self, row):
            rows.append(row)

        def commit(self):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *_exc):
            return False

    monkeypatch.setattr(email_service, "EMAIL_ENABLED", True)
    monkeypatch.setattr("app.db.session.get_session", lambda: _Session())
    return rows


class TestTheRowIsWritten:
    def test_a_failed_enqueue_is_recorded_and_not_raised(self, monkeypatch, recorded):
        """Four sync routes called send_email_async with no try/except, so a
        Redis blip surfaced to the customer as a 500 on an action that had
        otherwise succeeded."""
        monkeypatch.setattr("app.worker.enqueue.WORKER_ENABLED", True)

        def _no_redis(*_a, **_k):
            raise ConnectionError("redis is unreachable")

        monkeypatch.setattr("app.worker.enqueue.enqueue_sync", _no_redis)

        email_service.send_email_async("visitor@example.com", "Your quote", "<p>hi</p>")

        assert len(recorded) == 1
        assert recorded[0].reason == "enqueue_failed"
        assert "redis is unreachable" in recorded[0].error

    def test_the_body_is_kept_so_the_message_can_be_replayed(self, monkeypatch, recorded):
        monkeypatch.setattr("app.worker.enqueue.WORKER_ENABLED", True)
        monkeypatch.setattr("app.worker.enqueue.enqueue_sync", lambda *a, **k: (_ for _ in ()).throw(OSError("x")))

        email_service.send_email_async("buyer@example.com", "Your invoice INV-1", "<p>total</p>")

        assert recorded[0].body_html == "<p>total</p>"
        assert recorded[0].replayable is True


class TestCredentialsAreNotParkedInATable:
    """A password-reset link sitting in a table an operator can read is a
    privilege-escalation path, not a support workflow. Those rows record that
    the message was lost and nothing else; the customer asks for a new one."""

    @pytest.mark.parametrize(
        "subject",
        [
            "Your verification code",
            "Reset your password",
            "Your OTP for OyeChats",
            "You have been invited to a workspace",
        ],
    )
    def test_the_body_is_dropped(self, monkeypatch, recorded, subject):
        monkeypatch.setattr("app.worker.enqueue.WORKER_ENABLED", True)
        monkeypatch.setattr("app.worker.enqueue.enqueue_sync", lambda *a, **k: (_ for _ in ()).throw(OSError("x")))

        email_service.send_email_async("user@example.com", subject, "<p>token=abc123</p>")

        assert recorded[0].body_html is None
        assert recorded[0].replayable is False
        assert recorded[0].to_email == "user@example.com"
        assert recorded[0].subject == subject


class TestMailBeingOffIsNotALostMessage:
    def test_nothing_is_recorded_when_email_is_disabled(self, monkeypatch):
        """Otherwise any environment without provider credentials fills the
        table on every send and the alert becomes noise."""
        monkeypatch.setattr(email_service, "EMAIL_ENABLED", False)
        written: list = []
        monkeypatch.setattr("app.db.session.get_session", lambda: written.append(1))

        email_service.record_failed_email("a@example.com", "hi", "<p>x</p>", reason="provider_rejected")

        assert written == []


class TestItIsVisible:
    def test_the_metric_reaches_the_alert_channel(self):
        assert "email_dead_lettered" in _SENTRY_FORWARD_METRICS

    def test_a_send_outcome_carries_the_reason(self):
        outcome = email_service.SendOutcome(False, can_retry=False, error="HTTP 400")
        assert outcome.error == "HTTP 400"

    def test_recording_never_raises_into_the_caller(self, monkeypatch):
        monkeypatch.setattr(email_service, "EMAIL_ENABLED", True)
        monkeypatch.setattr("app.db.session.get_session", lambda: (_ for _ in ()).throw(RuntimeError("db down")))

        email_service.record_failed_email("a@example.com", "hi", "<p>x</p>", reason="enqueue_failed")


class TestTheWorkerRecordsWhatItGivesUpOn:
    """``task_send_email`` has two terminal states and both used to end at a
    log line: a provider rejection (never retried, so an OTP is not delivered
    twice) and an exhausted retry budget."""

    @staticmethod
    def _patch_send(monkeypatch, outcome):
        from app.services import email_service as es

        monkeypatch.setattr(es, "_send_raw_email_result", lambda *a, **k: outcome)

    def _run(self, ctx):
        import asyncio

        from app.worker import tasks

        return asyncio.run(tasks.task_send_email(ctx, "to@example.com", "Your invoice", "<p>body</p>"))

    def test_a_provider_rejection_is_dead_lettered(self, monkeypatch, recorded):
        self._patch_send(monkeypatch, email_service.SendOutcome(False, can_retry=False, error="HTTP 400"))

        assert self._run({"job_try": 1}) is False
        assert [r.reason for r in recorded] == ["provider_rejected"]
        assert recorded[0].error == "HTTP 400"

    def test_the_last_attempt_is_dead_lettered_instead_of_retried(self, monkeypatch, recorded):
        """On the final try, raising Retry has ARQ mark the job permanently
        failed and drop it, which is the silent loss this table exists to end."""
        from app.worker.settings import WorkerSettings

        self._patch_send(monkeypatch, email_service.SendOutcome(False, can_retry=True, error="URLError"))

        assert self._run({"job_try": WorkerSettings.max_tries}) is False
        assert [r.reason for r in recorded] == ["retries_exhausted"]
        assert recorded[0].attempts == WorkerSettings.max_tries

    def test_an_earlier_attempt_still_retries(self, monkeypatch, recorded):
        from arq.worker import Retry

        self._patch_send(monkeypatch, email_service.SendOutcome(False, can_retry=True, error="URLError"))

        with pytest.raises(Retry):
            self._run({"job_try": 1})
        assert recorded == []

    def test_a_successful_send_records_nothing(self, monkeypatch, recorded):
        self._patch_send(monkeypatch, email_service.SendOutcome(True))

        assert self._run({"job_try": 1}) is True
        assert recorded == []


class TestCredentialMailIsDeclaredNotGuessed:
    """The body was omitted on a subject-keyword guess. The email-change OTP's
    subject, "Confirm your new ... email address", matched none of the
    keywords, so a live six-digit code sat in the table marked replayable."""

    def test_the_email_change_otp_body_is_not_stored(self, monkeypatch, recorded):
        monkeypatch.setattr("app.worker.enqueue.WORKER_ENABLED", True)
        monkeypatch.setattr("app.worker.enqueue.enqueue_sync", lambda *a, **k: (_ for _ in ()).throw(OSError("x")))

        email_service.send_email_change_otp("person@example.com", "Person", "123456")

        assert len(recorded) == 1
        assert recorded[0].body_html is None
        assert recorded[0].replayable is False

    def test_a_declared_credential_wins_over_an_innocent_subject(self, monkeypatch, recorded):
        monkeypatch.setattr("app.worker.enqueue.WORKER_ENABLED", True)
        monkeypatch.setattr("app.worker.enqueue.enqueue_sync", lambda *a, **k: (_ for _ in ()).throw(OSError("x")))

        email_service.send_email_async("p@example.com", "Hello", "<p>code 999</p>", credential=True)

        assert recorded[0].body_html is None
        assert recorded[0].replayable is False


class TestTheAsyncEnqueuePathIsRecordedToo:
    """Inside a running loop ``enqueue_sync`` schedules the Redis call and
    returns before it runs, so its failure was caught in the background task
    and never reached the caller's try/except. Every send from an async route
    (offline messages, transcripts, live-chat mail) was in that window."""

    def test_a_redis_failure_after_the_response_went_out_leaves_a_row(self, monkeypatch, recorded):
        import asyncio

        from app.worker import enqueue as enqueue_module

        monkeypatch.setattr("app.worker.enqueue.WORKER_ENABLED", True)

        async def _no_redis(*_a, **_k):
            raise ConnectionError("redis is unreachable")

        monkeypatch.setattr(enqueue_module, "enqueue", _no_redis)

        async def _route():
            email_service.send_email_async("visitor@example.com", "Your transcript", "<p>hi</p>")
            await asyncio.gather(*list(enqueue_module._pending_enqueue_tasks))

        asyncio.run(_route())

        assert len(recorded) == 1
        assert recorded[0].reason == "enqueue_failed"
        assert "redis is unreachable" in recorded[0].error
