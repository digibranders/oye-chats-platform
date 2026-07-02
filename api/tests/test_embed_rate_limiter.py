"""Tests for the project-wide Gemini embedding rate limiter."""

import pytest

from app.core import embed_rate_limiter as rl


@pytest.fixture(autouse=True)
def _reset_local_bucket(monkeypatch):
    """Each test starts from a fresh in-process bucket and known limits."""
    monkeypatch.setattr(rl, "_local_bucket", None)
    yield
    rl._local_bucket = None


# ── Pure token-bucket math (deterministic — no sleeping) ─────────────────────


def test_bucket_allows_burst_up_to_capacity_without_wait():
    bucket = rl._TokenBucket(rate=10.0, capacity=10.0)
    assert bucket.acquire(10, now=0.0) == 0.0
    assert bucket.tokens == pytest.approx(0.0)


def test_bucket_waits_when_depleted_proportional_to_deficit():
    bucket = rl._TokenBucket(rate=10.0, capacity=10.0)
    bucket.acquire(10, now=0.0)  # drains the bucket
    # No time has passed: 10 more units cost the full 10/rate = 1.0s.
    assert bucket.acquire(10, now=0.0) == pytest.approx(1.0)
    assert bucket.tokens == pytest.approx(-10.0)  # reserved into debt


def test_bucket_refills_by_elapsed_time():
    bucket = rl._TokenBucket(rate=10.0, capacity=10.0)
    bucket.acquire(10, now=0.0)
    # 0.5s later, 5 tokens have refilled → a 5-unit acquire is free.
    assert bucket.acquire(5, now=0.5) == pytest.approx(0.0)
    assert bucket.tokens == pytest.approx(0.0)


def test_bucket_refill_capped_at_capacity():
    bucket = rl._TokenBucket(rate=10.0, capacity=10.0)
    bucket.acquire(10, now=0.0)
    # A long idle period cannot bank more than capacity.
    bucket.acquire(0, now=1000.0)
    assert bucket.tokens == pytest.approx(10.0)


def test_bucket_sustained_rate_converges_to_ceiling():
    # From empty at 10/s with no clock advance, each successive 1-unit reserve
    # goes deeper into debt: the n-th acquire waits n/rate. Total for 20 = 21s.
    bucket = rl._TokenBucket(rate=10.0, capacity=0.0)
    total_wait = sum(bucket.acquire(1, now=0.0) for _ in range(20))
    assert total_wait == pytest.approx(sum((i + 1) / 10.0 for i in range(20)))


# ── acquire(): Redis path ────────────────────────────────────────────────────


class _FakeRedis:
    def __init__(self, wait_value: str):
        self._wait = wait_value
        self.calls: list[tuple] = []

    def eval(self, script, numkeys, *args):
        self.calls.append((numkeys, args))
        return self._wait


def test_acquire_uses_redis_and_passes_batch_cost(monkeypatch):
    fake = _FakeRedis("0")
    monkeypatch.setattr(rl, "get_redis", lambda: fake)
    slept: list[float] = []
    monkeypatch.setattr(rl.time, "sleep", lambda d: slept.append(d))

    rl.acquire(100)

    assert len(fake.calls) == 1
    numkeys, args = fake.calls[0]
    assert numkeys == 1
    key, rate, capacity, cost, _now, _ttl = args
    assert key == rl._KEY
    assert cost == 100
    assert rate == pytest.approx(rl.EMBED_RPM_LIMIT / 60.0)
    assert not slept  # wait was 0 → no sleep


def test_acquire_sleeps_the_redis_reported_wait(monkeypatch):
    monkeypatch.setattr(rl, "get_redis", lambda: _FakeRedis("1.5"))
    slept: list[float] = []
    monkeypatch.setattr(rl.time, "sleep", lambda d: slept.append(d))

    rl.acquire(50)

    assert slept == [pytest.approx(1.5)]


def test_acquire_falls_back_to_local_bucket_when_redis_errors(monkeypatch):
    class _Boom:
        def eval(self, *_a, **_k):
            raise RuntimeError("redis down")

    monkeypatch.setattr(rl, "get_redis", lambda: _Boom())
    monkeypatch.setattr(rl, "EMBED_RPM_LIMIT", 600)  # 10/s
    monkeypatch.setattr(rl, "EMBED_RATE_BURST", 0)
    slept: list[float] = []
    monkeypatch.setattr(rl.time, "sleep", lambda d: slept.append(d))
    monkeypatch.setattr(rl.time, "monotonic", lambda: 0.0)

    rl.acquire(10)  # 10 units at 10/s from an empty bucket → ~1s wait

    assert slept and slept[0] == pytest.approx(1.0)


# ── acquire(): no-ops and safety cap ─────────────────────────────────────────


def test_acquire_noop_for_nonpositive_cost(monkeypatch):
    called = {"redis": False}
    monkeypatch.setattr(rl, "get_redis", lambda: called.__setitem__("redis", True) or None)
    rl.acquire(0)
    rl.acquire(-5)
    assert called["redis"] is False


def test_acquire_noop_when_limit_disabled(monkeypatch):
    monkeypatch.setattr(rl, "EMBED_RPM_LIMIT", 0)
    called = {"redis": False}
    monkeypatch.setattr(rl, "get_redis", lambda: called.__setitem__("redis", True) or None)
    rl.acquire(100)
    assert called["redis"] is False


def test_acquire_caps_pathological_wait(monkeypatch):
    monkeypatch.setattr(rl, "get_redis", lambda: _FakeRedis("99999"))
    slept: list[float] = []
    monkeypatch.setattr(rl.time, "sleep", lambda d: slept.append(d))

    rl.acquire(1)

    assert slept == [rl._MAX_WAIT_SECONDS]
