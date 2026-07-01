import json

import httpx
import pytest

from app.services import gemini_embedding as ge


def _client(handler):
    return httpx.Client(transport=httpx.MockTransport(handler))


def test_embeds_batch_normalized(monkeypatch):
    monkeypatch.setattr(ge, "GOOGLE_API_KEY", "k")
    monkeypatch.setattr(ge, "EMBED_DIMENSIONS", 4)

    def handler(request):
        body = json.loads(request.content)
        n = len(body["requests"])
        # Every request must carry the truncation dimension.
        assert all(r["outputDimensionality"] == 4 for r in body["requests"])
        # Raw (un-normalized) 3-4-0-0 vectors, mirroring the live API.
        return httpx.Response(200, json={"embeddings": [{"values": [3.0, 4.0, 0.0, 0.0]} for _ in range(n)]})

    out = ge.embed_texts(["a", "b"], _client=_client(handler))
    assert len(out) == 2 and len(out[0]) == 4
    # 3-4-0-0 L2-normalized → 0.6, 0.8, 0, 0
    assert out[0][0] == pytest.approx(0.6)
    assert out[0][1] == pytest.approx(0.8)


def test_batches_over_max(monkeypatch):
    monkeypatch.setattr(ge, "GOOGLE_API_KEY", "k")
    monkeypatch.setattr(ge, "EMBED_DIMENSIONS", 2)
    monkeypatch.setattr(ge, "_MAX_BATCH", 2)
    seen_batches = []

    def handler(request):
        body = json.loads(request.content)
        seen_batches.append(len(body["requests"]))
        return httpx.Response(200, json={"embeddings": [{"values": [1.0, 0.0]} for _ in body["requests"]]})

    out = ge.embed_texts(["a", "b", "c", "d", "e"], _client=_client(handler))
    assert len(out) == 5
    assert seen_batches == [2, 2, 1]  # 5 inputs chunked at _MAX_BATCH=2


def test_empty_returns_empty():
    assert ge.embed_texts([]) == []


def test_missing_key_raises(monkeypatch):
    monkeypatch.setattr(ge, "GOOGLE_API_KEY", None)
    with pytest.raises(RuntimeError):
        ge.embed_texts(["a"])


def test_retries_then_raises_on_5xx(monkeypatch):
    monkeypatch.setattr(ge, "GOOGLE_API_KEY", "k")
    monkeypatch.setattr(ge, "_RETRY_ATTEMPTS", 2)
    monkeypatch.setattr(ge, "_RETRY_BASE", 0.0)
    monkeypatch.setattr(ge, "time", type("T", (), {"sleep": staticmethod(lambda *_: None)}))
    calls = {"n": 0}

    def handler(request):
        calls["n"] += 1
        return httpx.Response(503, json={"error": "unavailable"})

    with pytest.raises(RuntimeError):
        ge.embed_texts(["a"], _client=_client(handler))
    assert calls["n"] == 2  # retried up to _RETRY_ATTEMPTS
