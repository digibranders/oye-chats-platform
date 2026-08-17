"""Tests for ``app.services.live_chat_routing_service.select_operator``.

Presence lookups and the Redis round-robin cursor are monkeypatched at the
module seam so each routing strategy's decision is asserted directly on a
controlled candidate set. Operators are lightweight stand-ins carrying only the
``id`` the strategies sort/compare on.
"""

from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from app.services import live_chat_routing_service as svc


def _op(op_id: int) -> SimpleNamespace:
    return SimpleNamespace(id=op_id)


def _bot(strategy=None, bot_id=1, client_id=1) -> SimpleNamespace:
    return SimpleNamespace(id=bot_id, client_id=client_id, live_chat_routing_strategy=strategy)


@pytest.fixture()
def patch_presence(monkeypatch):
    """Return a helper that installs candidates + per-operator chat counts and
    stubs the Redis cursor read/write so no real Redis is required."""
    state = {"cursor": None, "written": []}

    def install(candidates, chat_counts=None, cursor=None):
        state["cursor"] = cursor
        monkeypatch.setattr(
            svc.presence,
            "get_online_operators_with_capacity",
            lambda client_id, db: list(candidates),
        )
        counts = chat_counts or {}
        monkeypatch.setattr(
            svc.presence,
            "get_active_chat_count",
            lambda op_id, db: counts.get(op_id, 0),
        )
        monkeypatch.setattr(svc, "_read_rr_cursor", lambda bot_id: state["cursor"])
        monkeypatch.setattr(svc, "_write_rr_cursor", lambda bot_id, op_id: state["written"].append(op_id))
        return state

    return install


class TestNoCandidates:
    def test_returns_none_when_nobody_available(self, patch_presence):
        patch_presence([])
        assert svc.select_operator(_bot(), MagicMock()) is None


class TestFirstAvailable:
    def test_picks_lowest_id(self, patch_presence):
        patch_presence([_op(9), _op(3), _op(7)])
        chosen = svc.select_operator(_bot("first_available"), MagicMock())
        assert chosen.id == 3


class TestRoundRobin:
    def test_no_cursor_picks_first_sorted(self, patch_presence):
        patch_presence([_op(5), _op(2), _op(8)], cursor=None)
        chosen = svc.select_operator(_bot("round_robin"), MagicMock())
        assert chosen.id == 2

    def test_cursor_advances_to_next_greater_id(self, patch_presence):
        patch_presence([_op(2), _op(5), _op(8)], cursor=5)
        chosen = svc.select_operator(_bot("round_robin"), MagicMock())
        assert chosen.id == 8

    def test_cursor_past_last_wraps_to_first(self, patch_presence):
        patch_presence([_op(2), _op(5), _op(8)], cursor=99)
        chosen = svc.select_operator(_bot("round_robin"), MagicMock())
        assert chosen.id == 2

    def test_writes_cursor_of_chosen_operator(self, patch_presence):
        state = patch_presence([_op(2), _op(5)], cursor=2)
        chosen = svc.select_operator(_bot("round_robin"), MagicMock())
        assert chosen.id == 5
        assert state["written"] == [5]


class TestLeastBusy:
    def test_picks_operator_with_fewest_active_chats(self, patch_presence):
        patch_presence([_op(1), _op(2), _op(3)], chat_counts={1: 4, 2: 1, 3: 7})
        chosen = svc.select_operator(_bot("least_busy"), MagicMock())
        assert chosen.id == 2

    def test_default_strategy_is_least_busy(self, patch_presence):
        # No strategy set on the bot → falls through to least_busy.
        patch_presence([_op(1), _op(2)], chat_counts={1: 3, 2: 0})
        chosen = svc.select_operator(_bot(None), MagicMock())
        assert chosen.id == 2

    def test_tie_broken_by_round_robin_cursor(self, patch_presence):
        # Everyone idle (tie) → round-robin within the tied pool honours cursor.
        patch_presence([_op(1), _op(2), _op(3)], chat_counts={1: 0, 2: 0, 3: 0}, cursor=1)
        chosen = svc.select_operator(_bot("least_busy"), MagicMock())
        assert chosen.id == 2

    def test_unknown_strategy_falls_back_to_least_busy(self, patch_presence):
        patch_presence([_op(1), _op(2)], chat_counts={1: 5, 2: 2})
        chosen = svc.select_operator(_bot("nonsense_strategy"), MagicMock())
        assert chosen.id == 2
