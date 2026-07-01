"""Tests for app.ingestion.embedder — Google Gemini as the sole provider."""

import asyncio

import pytest

from app.ingestion import embedder


def test_embed_chunks_uses_google(monkeypatch):
    monkeypatch.setattr(embedder, "EMBED_PROVIDER", "google")
    captured = {}

    def fake_embed(texts, *, progress_cb=None):
        captured["texts"] = texts
        return [[0.1] * 768 for _ in texts]

    monkeypatch.setattr(embedder, "_google_embed", fake_embed)
    out = embedder.embed_chunks(["x", "y"])
    assert captured["texts"] == ["x", "y"]
    assert len(out) == 2 and len(out[0]) == 768


def test_embed_chunks_empty_returns_empty():
    assert embedder.embed_chunks([]) == []


def test_unsupported_provider_raises(monkeypatch):
    monkeypatch.setattr(embedder, "EMBED_PROVIDER", "fastembed")
    with pytest.raises(RuntimeError):
        embedder.embed_chunks(["x"])


def test_embed_chunks_async(monkeypatch):
    monkeypatch.setattr(embedder, "EMBED_PROVIDER", "google")
    monkeypatch.setattr(embedder, "_google_embed", lambda texts, **kw: [[0.2] * 768 for _ in texts])
    out = asyncio.run(embedder.embed_chunks_async(["a"]))
    assert len(out) == 1 and len(out[0]) == 768
