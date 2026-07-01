"""Heartbeat keeps a long-but-alive crawl from being falsely reaped, while a
genuinely dead worker (no heartbeat) is still reaped.
"""

import time

import pytest

import app.services.crawler_service as cs


def _running_row(heartbeat_age_s: float) -> dict:
    return {"status": "running", "urls": [], "heartbeat_at": time.time() - heartbeat_age_s}


def test_reap_kills_stale_running_row(monkeypatch):
    # No heartbeat refresh → old row is reaped as failed ("worker died").
    row = _running_row(cs._HEARTBEAT_STALE_SECONDS + 5)
    monkeypatch.setattr(cs, "get_redis", lambda: None)  # local-fallback path, no real Redis
    out = cs._reap_if_stale(1, dict(row))
    assert out["status"] == "failed"
    assert "worker" in (out.get("error") or "").lower()


def test_reap_keeps_fresh_running_row():
    row = _running_row(5)  # 5s old → healthy
    out = cs._reap_if_stale(1, dict(row))
    assert out["status"] == "running"


def test_refresh_heartbeat_prevents_reap(monkeypatch):
    # Simulate the local (no-Redis) progress store holding a nearly-stale row.
    monkeypatch.setattr(cs, "get_redis", lambda: None)
    cs._local_progress[1] = _running_row(cs._HEARTBEAT_STALE_SECONDS - 1)
    cs.refresh_crawl_heartbeat(1)  # <- what the orchestrator's heartbeat loop calls
    refreshed = cs._local_progress[1]
    # heartbeat is now ~now, so the reaper leaves it running.
    out = cs._reap_if_stale(1, dict(refreshed))
    assert out["status"] == "running"
    del cs._local_progress[1]


def test_refresh_heartbeat_noop_on_terminal_row(monkeypatch):
    monkeypatch.setattr(cs, "get_redis", lambda: None)
    cs._local_progress[2] = {"status": "done", "heartbeat_at": time.time() - 1000}
    before = cs._local_progress[2]["heartbeat_at"]
    cs.refresh_crawl_heartbeat(2)  # only refreshes running rows
    assert cs._local_progress[2]["heartbeat_at"] == before
    del cs._local_progress[2]


@pytest.mark.asyncio
async def test_crawl_heartbeat_context_ticks(monkeypatch):
    calls = []
    monkeypatch.setattr(cs, "refresh_crawl_heartbeat", lambda cid: calls.append(cid))
    import asyncio

    async with cs.crawl_heartbeat(7, interval=0.01):
        await asyncio.sleep(0.05)
    assert calls and all(c == 7 for c in calls)  # ticked at least once for client 7


@pytest.mark.asyncio
async def test_crawl_heartbeat_context_stops_after_exit(monkeypatch):
    calls = []
    monkeypatch.setattr(cs, "refresh_crawl_heartbeat", lambda cid: calls.append(cid))
    import asyncio

    async with cs.crawl_heartbeat(7, interval=0.01):
        await asyncio.sleep(0.03)
    n = len(calls)
    await asyncio.sleep(0.05)
    assert len(calls) == n  # no ticks after the context exits (dead worker → no heartbeat)
