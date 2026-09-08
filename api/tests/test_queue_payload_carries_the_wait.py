"""The payload is the whole reason the lobby card's escalation never ran.

``_visible_queue_for_operator`` built rows carrying session_id, name, reason,
bot_id and bot_name. ``LobbyCard`` derives its band from a timestamp that was
never in there, so ``since`` was always null, the band pinned itself to
``fresh``, and the wait number did not render at all. Every lobby card in
production was the same calm blue card whether the visitor had been waiting two
seconds or nine minutes.
"""

import inspect

from app.services.live_chat_service import ConnectionManager


def _builder_source() -> str:
    return inspect.getsource(ConnectionManager._visible_queue_for_operator)


def test_the_row_carries_the_wait():
    assert '"waiting_since"' in _builder_source(), (
        "without a timestamp the card cannot tell a 5-second wait from a 5-minute one"
    )


def test_the_row_carries_why_they_are_queued():
    assert '"requeue_reason"' in _builder_source(), (
        "without this the card cannot say a visitor was dropped rather than newly arrived"
    )


def test_the_timestamp_is_serialised_for_a_browser():
    """The card parses this with ``Date.parse``.

    A raw ``datetime`` would reach the browser as a Python repr, parse to NaN,
    and render as no timer at all -- the same symptom as the missing field,
    which is exactly the sort of fix that looks like it worked.
    """
    assert "isoformat()" in _builder_source()
