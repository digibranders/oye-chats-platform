"""The operator socket asserts its own presence, rather than trusting the client.

Presence carries a 60-second Redis TTL and used to be refreshed ONLY when the
operator's client sent a ``{"type": "heartbeat"}`` message. Any client that did
not send it (the mobile app, or a web client in a tab the browser throttled)
went invisible one minute after connecting, while its socket stayed open and its
own UI still read "connected". Every handoff after that minute resolved to
``all_offline``, so visitors were shown the offline form with an operator
sitting right there.

Observed in production on 2026-08-11: operator 7 connected at 13:03:35, the key
expired around 13:04:35, and the visitor's request at 13:08:43 logged
``reason=all_offline``. The socket was open the whole time.

An open socket IS the presence signal. These tests pin that the server asserts
it, and that the DB fallback its own docstring promises is actually fed.
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from app.api import ws_routes


class _StopLoop(Exception):
    """Breaks the heartbeat's infinite loop after a set number of beats."""


class _AsyncNoop:
    def __init__(self):
        self.calls = 0

    async def __call__(self, *_args, **_kwargs):
        self.calls += 1


async def _run_beats(n: int):
    """Drive `_operator_presence_heartbeat` for exactly ``n`` beats.

    Returns the websocket stub so callers can assert on the pings too, the
    presence write must never come at the cost of the keep-alive.
    """
    ws = MagicMock()
    ws.send_json = _AsyncNoop()
    beats = {"n": 0}

    async def _fake_sleep(_seconds):
        beats["n"] += 1
        if beats["n"] > n:
            raise _StopLoop

    with patch.object(ws_routes.asyncio, "sleep", _fake_sleep), pytest.raises(_StopLoop):
        await ws_routes._operator_presence_heartbeat(ws, operator_id=7, client_id=8)
    return ws


@pytest.fixture
def presence():
    with (
        patch("app.services.operator_presence_service.mark_online") as mark_online,
        patch("app.services.operator_presence_service.touch_last_seen") as touch,
        patch("app.db.session.get_session"),
    ):
        yield mark_online, touch


class TestTheServerStampsPresenceItself:
    @pytest.mark.asyncio
    async def test_every_beat_refreshes_the_redis_key(self, presence):
        """The 60s TTL is re-stamped on the server's own 30s cadence, so it can
        never lapse while the socket is open."""
        mark_online, _ = presence

        await _run_beats(3)

        assert mark_online.call_count == 3
        assert mark_online.call_args_list[0].args == (7, 8)

    @pytest.mark.asyncio
    async def test_the_keep_alive_ping_still_goes_out(self, presence):
        """Presence is added to the heartbeat, not swapped in for it. Losing
        the ping would drop the connection this exists to keep."""
        ws = await _run_beats(3)

        assert ws.send_json.calls == 3

    @pytest.mark.asyncio
    async def test_last_seen_is_written_on_a_slower_cadence(self, presence):
        """`touch_last_seen` had ZERO callers, so `last_seen_at` was NULL for
        every operator and `is_online`'s Redis-outage fallback could never
        return True. It is fed here, but less often than Redis, because it is
        a write to the primary."""
        mark_online, touch = presence

        await _run_beats(4)

        assert mark_online.call_count == 4
        assert touch.call_count == 2  # every second beat
        assert touch.call_count < mark_online.call_count

    def test_the_db_write_stays_inside_the_fallback_window(self):
        """The fallback treats `last_seen_at` as online for 120s. The write
        cadence has to sit inside that or the column is stale exactly when it
        is needed."""
        from app.services.operator_presence_service import DB_FALLBACK_FRESHNESS_SECONDS

        write_interval = ws_routes._HEARTBEAT_INTERVAL * ws_routes._LAST_SEEN_EVERY_N_BEATS

        assert write_interval < DB_FALLBACK_FRESHNESS_SECONDS


class TestPresenceNeverBreaksTheSocket:
    @pytest.mark.asyncio
    async def test_a_redis_failure_does_not_stop_the_pings(self, presence):
        """This coroutine owns the keep-alive. If a presence write could kill
        it, a Redis blip would take the CONNECTION down. Strictly worse than
        the stale-presence bug being fixed."""
        mark_online, _ = presence
        mark_online.side_effect = RuntimeError("redis down")

        ws = await _run_beats(3)

        assert ws.send_json.calls == 3

    @pytest.mark.asyncio
    async def test_a_db_failure_does_not_stop_the_pings(self, presence):
        _, touch = presence
        touch.side_effect = RuntimeError("postgres down")

        ws = await _run_beats(4)

        assert ws.send_json.calls == 4


class TestTheOperatorSocketUsesIt:
    def test_the_operator_endpoint_wires_the_presence_heartbeat(self):
        """The plain `_heartbeat` only pings. An operator socket wired to it
        would reintroduce the exact bug, silently, nothing else in the system
        notices a missing presence stamp.
        """
        import inspect

        source = inspect.getsource(ws_routes.operator_websocket)

        assert "_operator_presence_heartbeat(" in source, "the operator socket must assert its own presence"
