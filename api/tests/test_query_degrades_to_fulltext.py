"""Query embedding outage must degrade to keyword-only retrieval, not crash.

Covers the extracted guards used by both the sync and streaming answer paths.
"""

import asyncio

import app.services.rag_service as rag


def test_embed_success_returns_vector(monkeypatch):
    monkeypatch.setattr(rag, "cache_get", lambda *_a, **_k: None)
    monkeypatch.setattr(rag, "cache_set", lambda *_a, **_k: None)
    monkeypatch.setattr(rag, "embed_chunks", lambda _q: [[0.1] * 768])
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

    async def ok(_q):
        return [[0.3] * 768]

    monkeypatch.setattr(rag, "embed_chunks_async", ok)
    assert asyncio.run(rag._embed_query_cached_async(1, 2, "hi")) == [0.3] * 768
