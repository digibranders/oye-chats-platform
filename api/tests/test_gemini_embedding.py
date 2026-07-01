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


def test_429_honors_body_retry_delay(monkeypatch):
    # A large crawl transiently exceeds the per-minute quota; we must honour the
    # server-supplied "retry in Xs" (Gemini puts it in the body, not a header)
    # and then succeed, instead of hard-failing the whole crawl.
    monkeypatch.setattr(ge, "GOOGLE_API_KEY", "k")
    monkeypatch.setattr(ge, "EMBED_DIMENSIONS", 2)
    slept: list[float] = []
    monkeypatch.setattr(ge, "time", type("T", (), {"sleep": staticmethod(lambda d: slept.append(d))}))
    calls = {"n": 0}

    def handler(request):
        calls["n"] += 1
        if calls["n"] == 1:
            return httpx.Response(
                429,
                json={
                    "error": {
                        "message": "You exceeded your quota. Please retry in 0.2s",
                        "details": [{"@type": "type.googleapis.com/google.rpc.RetryInfo", "retryDelay": "0.2s"}],
                    }
                },
            )
        return httpx.Response(200, json={"embeddings": [{"values": [1.0, 0.0]}]})

    out = ge.embed_texts(["a"], _client=_client(handler))
    assert len(out) == 1 and calls["n"] == 2
    assert slept and abs(slept[0] - 0.7) < 1e-6  # honoured 0.2s + 0.5s cushion


def test_retry_delay_parses_retryinfo_and_message():
    with_detail = httpx.Response(
        429,
        json={"error": {"message": "x", "details": [{"@type": ".../RetryInfo", "retryDelay": "11.5s"}]}},
    )
    assert ge._retry_delay_from_429(with_detail) == 11.5
    message_only = httpx.Response(429, json={"error": {"message": "quota. Please retry in 7s."}})
    assert ge._retry_delay_from_429(message_only) == 7.0
    none = httpx.Response(429, json={"error": {"message": "no delay here"}})
    assert ge._retry_delay_from_429(none) is None


def test_non_retryable_4xx_raises_immediately(monkeypatch):
    monkeypatch.setattr(ge, "GOOGLE_API_KEY", "k")
    calls = {"n": 0}

    def handler(request):
        calls["n"] += 1
        return httpx.Response(400, json={"error": {"message": "bad request"}})

    with pytest.raises(RuntimeError):
        ge.embed_texts(["a"], _client=_client(handler))
    assert calls["n"] == 1  # 400 is not retried


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
