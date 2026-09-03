"""Socket-identity and cross-loop rules for the live-chat ConnectionManager.

Two defects live here (audit R1, R2):

* A reconnect (multi-tab operator, visitor network blip) replaces the socket
  stored under a key. The replaced socket's handler then reports its own
  disconnect, which used to tear down the connection that had just replaced
  it: the operator was marked offline 60s later and their live chats were
  re-queued with "Your operator disconnected".
* Work running on the shared background thread pool has no event loop, and
  used ``asyncio.run`` to push operator-console broadcasts. That closes the
  temporary loop (and with it the lazily-built backplane publisher) and writes
  to sockets owned by the main loop. ``schedule_from_thread`` is the supported
  hand-off, and it must refuse rather than improvise when nothing is bound.
"""

from __future__ import annotations

import asyncio

import pytest

from app.services import live_chat_service as lcs


class _FakeWS:
    """Minimal stand-in for a Starlette WebSocket."""

    def __init__(self, name: str) -> None:
        self.name = name
        self.closed: tuple | None = None
        self.sent: list[dict] = []

    async def accept(self, subprotocol=None):
        return None

    async def close(self, code=None, reason=None):
        self.closed = (code, reason)

    async def send_json(self, data):
        self.sent.append(data)


async def _noop(*args, **kwargs):
    return None


def _quiet_manager(monkeypatch) -> lcs.ConnectionManager:
    """A manager with every DB / fan-out side effect of connect stubbed out."""
    mgr = lcs.ConnectionManager()
    monkeypatch.setattr(mgr, "_ensure_background_tasks", lambda: None)
    monkeypatch.setattr(mgr, "_send_to_operator", _noop)
    monkeypatch.setattr(mgr, "_notify_operator_queue", _noop)
    monkeypatch.setattr(mgr, "_send_active_chats", _noop)
    monkeypatch.setattr(mgr, "broadcast_operators_update", _noop)
    monkeypatch.setattr(mgr, "_restore_visitor_state", _noop)
    return mgr


# ── R2: a superseded socket must not tear down its replacement ───────────────


@pytest.mark.asyncio
async def test_second_operator_tab_survives_the_first_tabs_disconnect(monkeypatch):
    mgr = _quiet_manager(monkeypatch)
    first, second = _FakeWS("tab-1"), _FakeWS("tab-2")

    await mgr.connect_operator(7, first, operator_name="Ops")
    await mgr.connect_operator(7, second, operator_name="Ops")

    assert first.closed == (4001, "Session opened in another tab")

    # The first tab's handler now reports its disconnect. Older call sites pass
    # no socket, so the superseded marker is what has to save the new tab.
    await mgr.disconnect_operator_and_broadcast(7)

    assert mgr.operator_connections.get(7) is second, "the live tab must keep its socket"
    assert 7 not in mgr._operator_disconnect_tasks, "no grace timer for a superseded socket"

    # And the surviving tab's own disconnect is still handled normally.
    await mgr.disconnect_operator_and_broadcast(7, second)
    assert 7 not in mgr.operator_connections
    assert 7 in mgr._operator_disconnect_tasks
    mgr._cancel_operator_disconnect_task(7)


@pytest.mark.asyncio
async def test_operator_disconnect_with_the_current_socket_is_never_ignored(monkeypatch):
    mgr = _quiet_manager(monkeypatch)
    only = _FakeWS("tab-1")
    await mgr.connect_operator(9, only, operator_name="Ops")

    assert mgr.disconnect_operator(9, only) is True
    assert 9 not in mgr.operator_connections


@pytest.mark.asyncio
async def test_visitor_reconnect_survives_the_old_sockets_disconnect(monkeypatch):
    mgr = _quiet_manager(monkeypatch)
    first, second = _FakeWS("v1"), _FakeWS("v2")

    await mgr.connect_visitor("sess-1", first)
    mgr.assignments["sess-1"] = 42
    await mgr.connect_visitor("sess-1", second)

    mgr.disconnect_visitor("sess-1")

    assert mgr.visitor_connections.get("sess-1") is second
    assert mgr.assignments.get("sess-1") == 42, "the live assignment must not be torn down"

    mgr.disconnect_visitor("sess-1", second)
    assert "sess-1" not in mgr.visitor_connections


@pytest.mark.asyncio
async def test_superseded_marker_expires_and_does_not_swallow_a_later_disconnect(monkeypatch):
    mgr = _quiet_manager(monkeypatch)
    first, second = _FakeWS("tab-1"), _FakeWS("tab-2")
    await mgr.connect_operator(11, first, operator_name="Ops")
    await mgr.connect_operator(11, second, operator_name="Ops")

    # The old tab never reported; the marker must not protect the new socket forever.
    mgr._superseded_operator_sockets[11] = 0.0

    assert mgr.disconnect_operator(11) is True
    assert 11 not in mgr.operator_connections


# ── R1: cross-loop hand-off from the background thread pool ─────────────────


@pytest.mark.asyncio
async def test_schedule_from_thread_runs_the_coroutine_on_the_bound_loop():
    mgr = lcs.ConnectionManager()
    mgr.bind_loop(asyncio.get_running_loop())
    ran: list[int] = []

    async def work():
        ran.append(id(asyncio.get_running_loop()))

    accepted = await asyncio.to_thread(mgr.schedule_from_thread, work())

    assert accepted is True
    for _ in range(50):
        if ran:
            break
        await asyncio.sleep(0.01)
    assert ran == [id(asyncio.get_running_loop())]


def test_schedule_from_thread_declines_when_no_loop_is_bound(recwarn):
    mgr = lcs.ConnectionManager()

    async def work():  # pragma: no cover - must never run
        raise AssertionError("must not run without a bound loop")

    assert mgr.schedule_from_thread(work()) is False
    # The coroutine is closed, so nothing leaks a "never awaited" warning.
    assert not [w for w in recwarn.list if issubclass(w.category, RuntimeWarning)]
