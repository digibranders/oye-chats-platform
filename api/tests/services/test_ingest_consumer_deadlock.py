"""Streaming-ingest deadlock regression test.

``run_full_crawl`` streams scraped pages through a **bounded** ``asyncio.Queue``
to a single consumer that embeds them in waves. The producer's
``await queue.put(page)`` suspends when the queue is full (backpressure). If an
embed/ingest wave raised, the consumer used to die with the exception and stop
draining, the producer then blocked on ``put()`` *forever* once the queue
filled, so the crawl hung "running" until the ARQ job timeout (~27 min) with the
UI stuck on the spinner.

The fix (``_consume_ingest_stream``) records the first ingest error and switches
to *drain mode*: it keeps ``get``-ing and discarding pages until the ``None``
sentinel, so the producer's bounded ``put`` is always released. These tests pin
that behaviour:

* :func:`test_consumer_drains_queue_when_ingest_fails`, the deadlock test. The
  producer emits far more pages than the queue can hold, and the first ingest
  wave raises. Everything must finish inside a hard timeout. Against the
  *unfixed* code (no try/except, no drain) the consumer dies, the producer
  blocks on a full queue, and this test hangs → fails via the timeout.
* :func:`test_consumer_accumulates_totals_on_success`. Happy path: totals
  accumulate across waves and no error is recorded.
"""

from __future__ import annotations

import asyncio

import pytest

from app.services.crawl_orchestrator import _consume_ingest_stream

# Small wave size so a handful of pages exercises multiple waves + a tail flush.
_WAVE_PAGES = 2
# maxsize mirrors production (``CRAWL_INGEST_WAVE_PAGES * 2``). The producer
# below enqueues well beyond this, so a consumer that stops draining strands it.
_MAXSIZE = _WAVE_PAGES * 2


def _page(i: int) -> dict:
    return {"url": f"https://example.test/{i}", "content": f"content {i}"}


async def _drive(queue: asyncio.Queue, count: int) -> None:
    """Producer: emit ``count`` pages then the end-of-stream sentinel.

    ``put`` suspends whenever the bounded queue is full, it only makes forward
    progress if the consumer keeps draining.
    """
    for i in range(count):
        await queue.put(_page(i))
    await queue.put(None)


@pytest.mark.asyncio
async def test_consumer_drains_queue_when_ingest_fails() -> None:
    queue: asyncio.Queue[dict | None] = asyncio.Queue(maxsize=_MAXSIZE)
    totals = {"chunks": 0, "pages_charged": 0, "credits_deducted": 0}
    state: dict = {"billing_aborted": False, "consumer_error": None}
    calls = {"n": 0}

    def failing_ingest(wave: list[dict], offset: int) -> dict:
        calls["n"] += 1
        raise RuntimeError("embedding backend blew up")

    consumer_task = asyncio.create_task(
        _consume_ingest_stream(
            queue,
            wave_pages=_WAVE_PAGES,
            ingest_wave=failing_ingest,
            cancel_requested=lambda: False,
            totals=totals,
            state=state,
            client_id=1,
        )
    )

    # Enqueue 5x the queue capacity. On the UNFIXED code the consumer dies on
    # the first wave and this producer blocks forever on a full queue → the
    # wait_for below times out and the test fails. On the fixed code the
    # consumer drains everything, so the producer completes promptly.
    await asyncio.wait_for(_drive(queue, count=_MAXSIZE * 5), timeout=5)
    await asyncio.wait_for(consumer_task, timeout=5)

    # The failure was captured (not swallowed, not re-raised out of the task).
    assert isinstance(state["consumer_error"], RuntimeError)
    # Only the first wave attempted ingestion; the rest were drained + dropped.
    assert calls["n"] == 1
    # Queue fully drained, nothing stranded, no leaked backpressure.
    assert queue.empty()
    # No partial totals credited for a failed ingest.
    assert totals == {"chunks": 0, "pages_charged": 0, "credits_deducted": 0}


@pytest.mark.asyncio
async def test_consumer_accumulates_totals_on_success() -> None:
    queue: asyncio.Queue[dict | None] = asyncio.Queue(maxsize=_MAXSIZE)
    totals = {"chunks": 0, "pages_charged": 0, "credits_deducted": 0}
    state: dict = {"billing_aborted": False, "consumer_error": None}

    def ok_ingest(wave: list[dict], offset: int) -> dict:
        return {
            "chunks": len(wave),
            "pages_changed": len(wave),
            "pages_charged": len(wave),
            "pages_failed": 0,
            "credits_deducted": len(wave) * 5,
        }

    consumer_task = asyncio.create_task(
        _consume_ingest_stream(
            queue,
            wave_pages=_WAVE_PAGES,
            ingest_wave=ok_ingest,
            cancel_requested=lambda: False,
            totals=totals,
            state=state,
            client_id=1,
        )
    )

    # 5 pages → waves of 2, 2, then a 1-page tail flushed on the sentinel.
    await asyncio.wait_for(_drive(queue, count=5), timeout=5)
    await asyncio.wait_for(consumer_task, timeout=5)

    assert state["consumer_error"] is None
    assert state["billing_aborted"] is False
    # ``pages_ingested`` / ``pages_failed`` are what the crawl summary reports
    # to the customer, so they accumulate here alongside the billing totals.
    assert totals == {
        "chunks": 5,
        "pages_charged": 5,
        "credits_deducted": 25,
        "pages_ingested": 5,
        "pages_failed": 0,
    }
    assert queue.empty()
