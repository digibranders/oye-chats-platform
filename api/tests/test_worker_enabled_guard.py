"""Production refuses to boot without a durable queue.

``WORKER_ENABLED`` defaults to false and the deploy sets it. Unset, every
enqueue silently degrades: outbound webhooks become fire-and-forget with no
delivery row, and lead qualification falls back to a three-thread pool the next
restart drops. Nothing failed and nothing alerted; the loss was only visible as
data that never arrived.
"""

from __future__ import annotations

import pytest

from app.main import _require_a_durable_queue_in_production


@pytest.mark.asyncio
async def test_production_without_a_worker_refuses_to_start(monkeypatch):
    monkeypatch.setattr("app.worker.enqueue.WORKER_ENABLED", False)
    monkeypatch.setattr("app.config.APP_ENV", "production")

    with pytest.raises(RuntimeError, match="WORKER_ENABLED"):
        await _require_a_durable_queue_in_production()


@pytest.mark.asyncio
async def test_production_with_a_worker_starts(monkeypatch):
    monkeypatch.setattr("app.worker.enqueue.WORKER_ENABLED", True)
    monkeypatch.setattr("app.config.APP_ENV", "production")

    await _require_a_durable_queue_in_production()


@pytest.mark.asyncio
async def test_local_development_only_warns(monkeypatch, caplog):
    """Running the API without a worker is a normal local setup."""
    monkeypatch.setattr("app.worker.enqueue.WORKER_ENABLED", False)
    monkeypatch.setattr("app.config.APP_ENV", "development")

    await _require_a_durable_queue_in_production()

    assert any("WORKER_ENABLED" in record.message for record in caplog.records)
