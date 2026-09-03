"""I10: an unexpected crash in ``task_deliver_webhook`` must not lose the event.

``process_pending_retries`` clears ``next_retry_at`` the moment the enqueue
returns, and that marker is the ONLY record that a redelivery is owed. So if
the delivery job then dies before ``_deliver_webhook`` writes its row (DB down,
un-serializable payload, rejected commit), nothing anywhere remembers the
event. ARQ re-runs a job only when it raises ``Retry``.
"""

import asyncio

import pytest
from arq.worker import Retry

from app.worker import tasks


def test_unexpected_failure_raises_retry(monkeypatch):
    import app.services.webhook_service as webhook_service

    def _boom(*_args, **_kwargs):
        raise RuntimeError("database is down")

    monkeypatch.setattr(webhook_service, "_deliver_webhook", _boom)

    with pytest.raises(Retry) as excinfo:
        asyncio.run(tasks.task_deliver_webhook({"job_try": 1}, 1, "lead_captured", {"k": "v"}, 2))

    # Bounded defer, so a persistent outage does not hot-loop the worker.
    assert 0 < excinfo.value.defer_score <= 300_000


def test_defer_grows_with_job_try(monkeypatch):
    import app.services.webhook_service as webhook_service

    monkeypatch.setattr(
        webhook_service, "_deliver_webhook", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("still down"))
    )

    defers = []
    for job_try in (1, 2, 3):
        with pytest.raises(Retry) as excinfo:
            asyncio.run(tasks.task_deliver_webhook({"job_try": job_try}, 1, "lead_captured", {}, 1))
        defers.append(excinfo.value.defer_score)

    assert defers == sorted(defers) and defers[0] < defers[-1]


def test_normal_delivery_does_not_retry(monkeypatch):
    """A refused endpoint is NOT an unexpected failure: ``_deliver_webhook``
    already recorded the attempt with its own ``next_retry_at`` rung, and the
    30s sweep owns the redelivery. Raising here would double up the ladder."""
    import app.services.webhook_service as webhook_service

    calls = []
    monkeypatch.setattr(webhook_service, "_deliver_webhook", lambda *a, **k: calls.append(a))

    assert asyncio.run(tasks.task_deliver_webhook({"job_try": 1}, 7, "chat_closed", {"a": 1}, 3)) is True
    assert calls == [(7, "chat_closed", {"a": 1}, 3)]
