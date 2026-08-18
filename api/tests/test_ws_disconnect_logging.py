"""A visitor closing their browser tab must not look like a production incident.

Observed in production for a single, entirely normal tab-close::

    WARNING  Failed to send to visitor session_<id>:          <- empty detail
    INFO     Visitor disconnected: ... (was_waiting=False, was_live=False)
    INFO     Chat session_<id> closed
    ERROR    Visitor WS error: RuntimeError: WebSocket is not connected...
    INFO     Visitor disconnected: ... (was_waiting=False, was_live=False)   <- twice

Three defects, all cosmetic but all corrosive: they bury real failures and
inflate Sentry volume.

1. A routine client-side close logged at ERROR.
2. ``disconnect_visitor`` ran twice for one disconnect (``_send_to_visitor``
   cleans up, then the exception bubbles to the route's handler which cleans
   up again).
3. The WARNING interpolated an exception whose ``str()`` is empty
   (``WebSocketDisconnect`` never passes a message to ``Exception.__init__``),
   producing a message that trails off after the colon.
"""

from __future__ import annotations

import asyncio
import logging

import pytest
from starlette.websockets import WebSocketDisconnect

from app.services.live_chat_service import ConnectionManager, is_client_gone


class _DeadSocket:
    """A socket that fails the way a closed one does."""

    def __init__(self, exc: BaseException):
        self._exc = exc

    async def send_json(self, _data):
        raise self._exc


# ── is_client_gone ───────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "exc",
    [
        WebSocketDisconnect(code=1001),
        RuntimeError('WebSocket is not connected. Need to call "accept" first.'),
        RuntimeError('Cannot call "send" once a close message has been sent.'),
        ConnectionResetError(),
        BrokenPipeError(),
    ],
)
def test_client_gone_exceptions_are_recognised(exc):
    assert is_client_gone(exc) is True


@pytest.mark.parametrize(
    "exc",
    [
        RuntimeError("Event loop is closed"),
        ValueError("bad payload"),
        KeyError("session_id"),
        TypeError("Function.__init__() got an unexpected keyword argument"),
    ],
)
def test_genuine_errors_are_not_mistaken_for_a_closed_socket(exc):
    """The guard must stay narrow, a real bug hidden at DEBUG is worse than
    the noise this change removes."""
    assert is_client_gone(exc) is False


# ── disconnect_visitor idempotency ───────────────────────────────────────────


def test_disconnect_visitor_logs_once_for_a_single_disconnect(caplog):
    m = ConnectionManager()
    sid = "sess-idempotent"
    m.visitor_connections[sid] = object()

    with caplog.at_level(logging.INFO, logger="app.services.live_chat_service"):
        m.disconnect_visitor(sid)
        m.disconnect_visitor(sid)  # the duplicate call seen in production

    disconnects = [r for r in caplog.records if "Visitor disconnected" in r.message]
    assert len(disconnects) == 1


def test_repeat_disconnect_is_a_no_op_for_an_untracked_session(caplog):
    m = ConnectionManager()
    with caplog.at_level(logging.INFO, logger="app.services.live_chat_service"):
        m.disconnect_visitor("never-seen")
    assert not [r for r in caplog.records if "Visitor disconnected" in r.message]


def test_disconnect_still_cleans_up_a_queued_visitor_with_no_socket():
    """A visitor can be in the waiting queue after their socket dropped, the
    idempotency guard must not skip that cleanup."""
    m = ConnectionManager()
    sid = "sess-queued"
    m.waiting_queue.append(sid)
    m._session_client_ids[sid] = 7

    m.disconnect_visitor(sid)

    assert sid not in m.waiting_queue
    assert sid not in m._session_client_ids


# ── _send_to_visitor logging ─────────────────────────────────────────────────


def test_send_failure_from_a_closed_socket_does_not_warn(caplog):
    m = ConnectionManager()
    sid = "sess-gone"
    m.visitor_connections[sid] = _DeadSocket(WebSocketDisconnect(code=1001))

    with caplog.at_level(logging.DEBUG, logger="app.services.live_chat_service"):
        asyncio.run(m._send_to_visitor(sid, {"type": "ping"}))

    assert not [r for r in caplog.records if r.levelno >= logging.WARNING]


def test_send_failure_from_a_real_error_still_warns_and_names_the_exception(caplog):
    m = ConnectionManager()
    sid = "sess-broken"
    m.visitor_connections[sid] = _DeadSocket(ValueError("payload is not serialisable"))

    with caplog.at_level(logging.DEBUG, logger="app.services.live_chat_service"):
        asyncio.run(m._send_to_visitor(sid, {"type": "ping"}))

    warnings = [r for r in caplog.records if r.levelno >= logging.WARNING]
    assert len(warnings) == 1
    # The old message interpolated only str(e); for WebSocketDisconnect that is
    # empty, so the class name must always be present.
    assert "ValueError" in warnings[0].message
    assert "payload is not serialisable" in warnings[0].message


def test_send_failure_message_is_never_left_dangling_after_the_colon(caplog):
    """WebSocketDisconnect.str() is empty, the exact bug that produced
    'Failed to send to visitor <id>:' with nothing after it."""
    m = ConnectionManager()
    sid = "sess-empty-detail"
    m.visitor_connections[sid] = _DeadSocket(WebSocketDisconnect(code=1001))

    with caplog.at_level(logging.DEBUG, logger="app.services.live_chat_service"):
        asyncio.run(m._send_to_visitor(sid, {"type": "ping"}))

    for record in caplog.records:
        assert not record.message.rstrip().endswith(":"), record.message
