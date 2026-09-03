"""The backplane subscriber must survive a Redis error (audit R7).

``_listen`` used to end on the first exception: cross-process live-chat
delivery then stayed dark until the process was restarted, with one log line
and no other symptom. It now reconnects with bounded exponential backoff, and
still stops cleanly on shutdown.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from app.services import ws_backplane


@pytest.mark.asyncio
async def test_listen_reconnects_after_a_failure(monkeypatch):
    attempts: list[int] = []
    third_attempt = asyncio.Event()

    async def flaky_listen_once(manager):
        attempts.append(len(attempts) + 1)
        if len(attempts) >= 3:
            third_attempt.set()
            await asyncio.sleep(3600)  # a healthy, long-lived subscription
        raise ConnectionError("redis went away")

    monkeypatch.setattr(ws_backplane, "_listen_once", flaky_listen_once)
    monkeypatch.setattr(ws_backplane, "_RECONNECT_MIN_DELAY_S", 0.01)
    monkeypatch.setattr(ws_backplane, "_RECONNECT_MAX_DELAY_S", 0.05)

    task = asyncio.create_task(ws_backplane._listen(object()))
    await asyncio.wait_for(third_attempt.wait(), timeout=5)

    assert len(attempts) >= 3, "the subscriber must keep retrying after Redis errors"

    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task


@pytest.mark.asyncio
async def test_reconnect_delay_is_bounded(monkeypatch):
    delays: list[float] = []
    done = asyncio.Event()

    async def always_fails(manager):
        if len(delays) >= 6:
            done.set()
            raise asyncio.CancelledError
        raise ConnectionError("redis still down")

    async def fake_sleep(delay):
        delays.append(delay)
        await asyncio.sleep(0)

    # Shim only the module reference so the real ``asyncio.sleep`` (used by the
    # test itself, and by ``wait_for``) is left alone.
    monkeypatch.setattr(
        ws_backplane,
        "asyncio",
        SimpleNamespace(sleep=fake_sleep, CancelledError=asyncio.CancelledError),
    )
    monkeypatch.setattr(ws_backplane, "_listen_once", always_fails)
    monkeypatch.setattr(ws_backplane, "_RECONNECT_MIN_DELAY_S", 1.0)
    monkeypatch.setattr(ws_backplane, "_RECONNECT_MAX_DELAY_S", 4.0)

    task = asyncio.create_task(ws_backplane._listen(object()))
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(task, timeout=5)
    assert done.is_set()

    assert delays[:4] == [1.0, 2.0, 4.0, 4.0], "backoff must double and then cap"
    assert max(delays) <= 4.0


@pytest.mark.asyncio
async def test_stop_cancels_the_subscriber(monkeypatch):
    monkeypatch.setattr(ws_backplane, "_enabled", lambda: True)

    async def parked(manager):
        await asyncio.sleep(3600)

    monkeypatch.setattr(ws_backplane, "_listen_once", parked)

    await ws_backplane.start(object())
    task = ws_backplane._subscriber_task
    assert task is not None and not task.done()

    await ws_backplane.stop()
    assert ws_backplane._subscriber_task is None
    assert task.cancelled() or task.done()
