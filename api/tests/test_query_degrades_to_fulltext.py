"""Query embedding outage must degrade to keyword-only retrieval, not crash.

Covers the extracted guards used by both the sync and streaming answer paths.
"""

import asyncio
import time

import app.services.rag_service as rag


def test_embed_success_returns_vector(monkeypatch):
    monkeypatch.setattr(rag, "cache_get", lambda *_a, **_k: None)
    monkeypatch.setattr(rag, "cache_set", lambda *_a, **_k: None)
    monkeypatch.setattr(rag, "embed_chunks", lambda _q, **_kw: [[0.1] * 768])
    out = rag._embed_query_cached(1, 2, "hello")
    assert out == [0.1] * 768


def test_embed_failure_returns_none(monkeypatch):
    monkeypatch.setattr(rag, "cache_get", lambda *_a, **_k: None)
    monkeypatch.setattr(rag, "cache_set", lambda *_a, **_k: None)

    def boom(_q):
        raise RuntimeError("embed down")

    monkeypatch.setattr(rag, "embed_chunks", boom)
    # None → caller runs keyword-only search instead of crashing.
    assert rag._embed_query_cached(1, 2, "hello") is None


def test_embed_uses_cache(monkeypatch):
    monkeypatch.setattr(rag, "cache_get", lambda *_a, **_k: [0.9] * 768)

    def fail(_q):
        raise AssertionError("should not embed when cached")

    monkeypatch.setattr(rag, "embed_chunks", fail)
    assert rag._embed_query_cached(1, 2, "hello") == [0.9] * 768


def test_async_embed_failure_returns_none(monkeypatch):
    monkeypatch.setattr(rag, "cache_get", lambda *_a, **_k: None)
    monkeypatch.setattr(rag, "cache_set", lambda *_a, **_k: None)

    async def boom(_q):
        raise RuntimeError("embed down")

    monkeypatch.setattr(rag, "embed_chunks_async", boom)
    assert asyncio.run(rag._embed_query_cached_async(1, 2, "hi")) is None


def test_async_embed_success(monkeypatch):
    monkeypatch.setattr(rag, "cache_get", lambda *_a, **_k: None)
    monkeypatch.setattr(rag, "cache_set", lambda *_a, **_k: None)

    async def ok(_q, **_kw):
        return [[0.3] * 768]

    monkeypatch.setattr(rag, "embed_chunks_async", ok)
    assert asyncio.run(rag._embed_query_cached_async(1, 2, "hi")) == [0.3] * 768


def test_async_embed_cache_call_does_not_block_event_loop(monkeypatch):
    """AR-02 regression: cache_get/cache_set are sync redis-py calls. Before
    the fix they ran directly on the event loop thread; a slow Redis
    round-trip would stall every concurrent chat session under
    WEB_CONCURRENCY=1. They must now run via asyncio.to_thread so a blocking
    cache call doesn't prevent other coroutines from making progress
    concurrently."""
    SLEEP_S = 0.2

    def slow_cache_get(*_a, **_k):
        time.sleep(SLEEP_S)  # simulates a slow synchronous Redis round-trip
        return None

    monkeypatch.setattr(rag, "cache_get", slow_cache_get)
    monkeypatch.setattr(rag, "cache_set", lambda *_a, **_k: None)

    async def ok(_q, **_kw):
        return [[0.3] * 768]

    monkeypatch.setattr(rag, "embed_chunks_async", ok)

    ticks = []

    async def ticker():
        # If the event loop were blocked by the sync sleep above, this
        # wouldn't get to run until the blocking call finished.
        for _ in range(10):
            ticks.append(time.monotonic())
            await asyncio.sleep(SLEEP_S / 20)

    async def main():
        await asyncio.gather(
            rag._embed_query_cached_async(1, 2, "hi"),
            ticker(),
        )

    start = time.monotonic()
    asyncio.run(main())

    # The ticker must have made progress *during* the blocking cache call,
    # not only before/after it — i.e. at least one tick landed inside the
    # sleep window while the cache call was still in flight.
    ticks_during_sleep = [t for t in ticks if start < t < start + SLEEP_S]
    assert ticks_during_sleep, "event loop was blocked by the sync cache_get call"
