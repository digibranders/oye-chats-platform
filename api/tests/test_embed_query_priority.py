"""Latency-priority lane for query-time embeddings (audit F38).

The embed rate limiter is a single project-wide bucket shared by bulk
ingestion and the chat query path. Under crawl contention the bucket runs into
deep token debt, and a query embed could be told to sleep up to
``_MAX_WAIT_SECONDS`` (5 minutes) — pinning a request-serving thread while the
visitor stares at a spinner. The fix: ``acquire`` accepts a per-caller wait
ceiling; the query path passes a small one and, when the ceiling is exceeded,
gets ``EmbedWaitExceeded`` instead of a sleep — which the RAG layer already
degrades to keyword-only retrieval.
"""

import pytest

from app.core import embed_rate_limiter as rl


@pytest.fixture(autouse=True)
def _reset_local_bucket(monkeypatch):
    monkeypatch.setattr(rl, "_local_bucket", None)
    yield
    rl._local_bucket = None


class _FakeRedis:
    def __init__(self, wait_value: str):
        self._wait = wait_value
        self.refunds: list[float] = []

    def eval(self, script, numkeys, *args):
        return self._wait

    def hincrbyfloat(self, key, field, amount):
        self.refunds.append(amount)
        return amount


def test_acquire_raises_when_wait_exceeds_ceiling(monkeypatch):
    monkeypatch.setattr(rl, "get_redis", lambda: _FakeRedis("30"))
    slept: list[float] = []
    monkeypatch.setattr(rl.time, "sleep", lambda d: slept.append(d))

    with pytest.raises(rl.EmbedWaitExceeded):
        rl.acquire(1, max_wait=2.0)

    assert not slept  # fail fast — the whole point is not to pin the thread


def test_acquire_refunds_reservation_on_abort(monkeypatch):
    # An aborted acquire must hand its reserved tokens back, or every timed-out
    # query would deepen the debt that ingestion then sleeps off.
    fake = _FakeRedis("30")
    monkeypatch.setattr(rl, "get_redis", lambda: fake)

    with pytest.raises(rl.EmbedWaitExceeded):
        rl.acquire(3, max_wait=2.0)

    assert fake.refunds == [pytest.approx(3.0)]


def test_acquire_sleeps_normally_under_the_ceiling(monkeypatch):
    monkeypatch.setattr(rl, "get_redis", lambda: _FakeRedis("1.5"))
    slept: list[float] = []
    monkeypatch.setattr(rl.time, "sleep", lambda d: slept.append(d))

    rl.acquire(1, max_wait=2.0)  # 1.5s ≤ 2.0s ceiling → normal throttle

    assert slept == [pytest.approx(1.5)]


def test_default_acquire_keeps_failopen_semantics(monkeypatch):
    # Ingestion (no ceiling) must keep the old behavior: cap + proceed, never raise.
    monkeypatch.setattr(rl, "get_redis", lambda: _FakeRedis("99999"))
    slept: list[float] = []
    monkeypatch.setattr(rl.time, "sleep", lambda d: slept.append(d))

    rl.acquire(1)

    assert slept == [rl._MAX_WAIT_SECONDS]


def test_local_bucket_abort_refunds_debt(monkeypatch):
    monkeypatch.setattr(rl, "get_redis", lambda: None)
    monkeypatch.setattr(rl, "EMBED_RPM_LIMIT", 600)  # 10/s
    monkeypatch.setattr(rl, "EMBED_RATE_BURST", 0)
    monkeypatch.setattr(rl.time, "monotonic", lambda: 0.0)

    with pytest.raises(rl.EmbedWaitExceeded):
        rl.acquire(100, max_wait=0.5)  # 100 units at 10/s → 10s wait > 0.5s

    # Debt was refunded: an ingestion-sized acquire right after sees only its
    # own deficit (10s), not 10s + the aborted 10s.
    slept: list[float] = []
    monkeypatch.setattr(rl.time, "sleep", lambda d: slept.append(d))
    rl.acquire(100)
    assert slept == [pytest.approx(10.0)]


# ── ceiling threads through the embedding stack to the query path ────────────


def test_embed_texts_passes_ceiling_to_limiter(monkeypatch):
    import httpx

    from app.services import gemini_embedding as ge

    seen: list[float | None] = []

    def _fake_acquire(cost, *, max_wait=None):
        seen.append(max_wait)

    monkeypatch.setattr(ge.embed_rate_limiter, "acquire", _fake_acquire)
    monkeypatch.setattr(ge, "GOOGLE_API_KEY", "test-key")

    def _handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"embeddings": [{"values": [1.0, 0.0]} for _ in range(1)]})

    client = httpx.Client(transport=httpx.MockTransport(_handler))
    ge.embed_texts(["hello"], max_wait_s=2.0, _client=client)
    assert seen == [2.0]


def test_query_embed_degrades_to_keyword_only_when_limiter_is_saturated(monkeypatch):
    from app.services import rag_service

    def _saturated(texts, **kw):
        raise rl.EmbedWaitExceeded("bucket debt 240s > ceiling 2s")

    monkeypatch.setattr(rag_service, "embed_chunks", _saturated)
    monkeypatch.setattr(rag_service, "cache_get", lambda k: None)
    monkeypatch.setattr(rag_service, "cache_set", lambda *a, **k: None)

    # None → hybrid retrieval degrades to keyword-only; chat stays fast.
    assert rag_service._embed_query_cached(1, None, "what are your prices?") is None
