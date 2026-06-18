"""Tests for app.services.live_chat_availability_service.

Each of the seven states gets one happy-path test so a regression in the
priority order (e.g. accidentally checking queue size before operator count)
fails loudly. The resolver is intentionally side-effect free, which makes
these unit tests fast — no Redis or DB required, just a mocked Session and
patched presence module.
"""

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from app.services.live_chat_availability_service import (
    LiveChatState,
    SuggestedAction,
    _compute,
)


def _bot(**overrides):
    """Build a SimpleNamespace bot with the defaults needed by the resolver."""
    return SimpleNamespace(
        id=overrides.get("id", 42),
        client_id=overrides.get("client_id", 1),
        live_chat_enabled=overrides.get("live_chat_enabled", True),
        business_hours=overrides.get("business_hours"),
        live_chat_queue_timeout_seconds=overrides.get("queue_timeout", 20),
        live_chat_max_queue_size=overrides.get("max_queue", 10),
    )


def _mock_session_with_operator_count_and_queue_size(operator_count: int, queue_size: int):
    """Mock the two scalar_one() calls the resolver makes — operator count and
    queue size — in the order they're called.
    """
    session = MagicMock()
    scalar_results = [operator_count, queue_size]
    side_effect_iter = iter(scalar_results)
    session.execute.return_value.scalar_one.side_effect = lambda: next(side_effect_iter)
    return session


# ── 1. FEATURE_DISABLED ────────────────────────────────────────────────────


def test_returns_feature_disabled_when_bot_toggle_off():
    """When ``bot.live_chat_enabled`` is False, the resolver short-circuits
    before touching presence or the DB — no operators are queried."""
    bot = _bot(live_chat_enabled=False)
    session = MagicMock()

    result = _compute(bot, session)

    assert result.state == LiveChatState.FEATURE_DISABLED
    assert result.suggested_action == SuggestedAction.OFFLINE_FORM
    # Critical: should NOT have queried operator count when feature is off
    session.execute.assert_not_called()


# ── 2. NO_OPERATORS ────────────────────────────────────────────────────────


def test_returns_no_operators_when_workspace_empty():
    """Zero operators in the workspace → instant fallback to offline form
    with the no_operators message_key so widget shows the admin nudge."""
    bot = _bot()
    session = _mock_session_with_operator_count_and_queue_size(operator_count=0, queue_size=0)

    result = _compute(bot, session)

    assert result.state == LiveChatState.NO_OPERATORS
    assert result.suggested_action == SuggestedAction.OFFLINE_FORM
    assert result.message_key == "no_operators"


# ── 3. OUT_OF_HOURS ────────────────────────────────────────────────────────


@patch("app.services.live_chat_availability_service._within_business_hours", return_value=False)
@patch("app.services.live_chat_availability_service._next_business_hour_iso", return_value="2026-06-19T09:00:00+00:00")
def test_returns_out_of_hours_when_outside_window(_mock_next, _mock_within):
    """Operators exist but we're outside business hours → offline form + the
    next-open ISO timestamp so the widget can render 'back at 9am tomorrow'."""
    bot = _bot(business_hours={"timezone": "UTC", "mon": {"start": "09:00", "end": "17:00"}})
    session = _mock_session_with_operator_count_and_queue_size(operator_count=2, queue_size=0)

    result = _compute(bot, session)

    assert result.state == LiveChatState.OUT_OF_HOURS
    assert result.suggested_action == SuggestedAction.OFFLINE_FORM
    assert result.next_available_at == "2026-06-19T09:00:00+00:00"


# ── 4. ALL_OFFLINE ─────────────────────────────────────────────────────────


@patch("app.services.live_chat_availability_service.presence.get_online_operator_ids", return_value=set())
def test_returns_all_offline_when_no_operator_presence(_mock_presence):
    """Operators configured, within business hours, but presence service shows
    nobody is currently connected. Widget falls back to offline form."""
    bot = _bot()
    session = _mock_session_with_operator_count_and_queue_size(operator_count=3, queue_size=0)

    result = _compute(bot, session)

    assert result.state == LiveChatState.ALL_OFFLINE
    assert result.suggested_action == SuggestedAction.OFFLINE_FORM


# ── 5. QUEUE_FULL ──────────────────────────────────────────────────────────


@patch("app.services.live_chat_availability_service.presence.get_online_operator_ids", return_value={1, 2})
def test_returns_queue_full_when_queue_at_capacity(_mock_presence):
    """Operators online + queue at ``max_queue_size`` → reject new entries
    via offline form so the existing queue doesn't grow unbounded."""
    bot = _bot(max_queue=5)
    # max_queue is 5, so a queue_size of 5 means full
    session = _mock_session_with_operator_count_and_queue_size(operator_count=2, queue_size=5)

    result = _compute(bot, session)

    assert result.state == LiveChatState.QUEUE_FULL
    assert result.suggested_action == SuggestedAction.OFFLINE_FORM
    assert result.message_key == "queue_full"


# ── 6. ALL_BUSY ────────────────────────────────────────────────────────────


@patch("app.services.live_chat_availability_service.presence.get_online_operators_with_capacity", return_value=[])
@patch("app.services.live_chat_availability_service.presence.get_online_operator_ids", return_value={1, 2})
def test_returns_all_busy_when_operators_at_capacity(_mock_ids, _mock_capacity):
    """Operators online but all at ``max_concurrent_chats`` → visitor enters
    queue with the 20s timeout so the widget shows the WAIT screen."""
    bot = _bot(queue_timeout=20, max_queue=10)
    # queue_size 2 means new visitor would be position 3
    session = _mock_session_with_operator_count_and_queue_size(operator_count=2, queue_size=2)

    result = _compute(bot, session)

    assert result.state == LiveChatState.ALL_BUSY
    assert result.suggested_action == SuggestedAction.WAIT
    assert result.queue_position == 3
    assert result.queue_timeout_seconds == 20
    assert result.online_operator_count == 2


# ── 7. AVAILABLE ───────────────────────────────────────────────────────────


@patch("app.services.live_chat_availability_service.presence.get_online_operators_with_capacity")
@patch("app.services.live_chat_availability_service.presence.get_online_operator_ids", return_value={1})
def test_returns_available_when_operator_ready_to_route(_mock_ids, mock_capacity):
    """The happy path — at least one operator online with capacity → ROUTE.
    No queue position needed because routing happens immediately."""
    mock_capacity.return_value = [SimpleNamespace(id=1, max_concurrent_chats=5)]

    bot = _bot()
    session = _mock_session_with_operator_count_and_queue_size(operator_count=1, queue_size=0)

    result = _compute(bot, session)

    assert result.state == LiveChatState.AVAILABLE
    assert result.suggested_action == SuggestedAction.ROUTE
    assert result.online_operator_count == 1


# ── Priority ordering ──────────────────────────────────────────────────────


def test_feature_disabled_beats_no_operators():
    """If both feature_disabled AND no_operators apply, feature_disabled
    should win — the bot toggle is the higher-priority signal."""
    bot = _bot(live_chat_enabled=False)
    # Session is irrelevant since feature_disabled short-circuits, but we
    # still pass a mock to satisfy the type contract.
    session = _mock_session_with_operator_count_and_queue_size(operator_count=0, queue_size=0)

    result = _compute(bot, session)

    assert result.state == LiveChatState.FEATURE_DISABLED


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
