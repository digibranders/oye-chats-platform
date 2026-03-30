"""Tests for resolving duplicate agent emails during login."""

from datetime import UTC, datetime
from types import SimpleNamespace

from app.api.auth_routes import _choose_best_agent_candidate


class TestAgentLoginSelection:
    def test_prefers_workspace_with_bots(self):
        newer_empty_workspace = SimpleNamespace(id=7, client_id=70, created_at=datetime(2026, 3, 1, tzinfo=UTC))
        older_active_workspace = SimpleNamespace(id=3, client_id=30, created_at=datetime(2026, 2, 1, tzinfo=UTC))

        selected = _choose_best_agent_candidate(
            [newer_empty_workspace, older_active_workspace],
            client_bot_counts={70: 0, 30: 1},
            client_agent_counts={70: 1, 30: 2},
        )

        assert selected is older_active_workspace

    def test_prefers_larger_team_when_no_bots_exist(self):
        smaller_team = SimpleNamespace(id=4, client_id=40, created_at=datetime(2026, 3, 5, tzinfo=UTC))
        larger_team = SimpleNamespace(id=5, client_id=50, created_at=datetime(2026, 3, 4, tzinfo=UTC))

        selected = _choose_best_agent_candidate(
            [smaller_team, larger_team],
            client_bot_counts={40: 0, 50: 0},
            client_agent_counts={40: 1, 50: 4},
        )

        assert selected is larger_team

    def test_falls_back_to_newer_record_when_workspace_counts_match(self):
        older_agent = SimpleNamespace(id=11, client_id=11, created_at=datetime(2026, 1, 10, tzinfo=UTC))
        newer_agent = SimpleNamespace(id=12, client_id=12, created_at=datetime(2026, 3, 10, tzinfo=UTC))

        selected = _choose_best_agent_candidate(
            [older_agent, newer_agent],
            client_bot_counts={11: 1, 12: 1},
            client_agent_counts={11: 2, 12: 2},
        )

        assert selected is newer_agent
