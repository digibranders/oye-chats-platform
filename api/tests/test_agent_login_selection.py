"""Tests for resolving duplicate agent emails during login."""

from datetime import UTC, datetime
from types import SimpleNamespace

from app.api.auth_routes import _choose_best_agent_candidate, _choose_default_workspace_bot


class TestAgentLoginSelection:
    def test_prefers_workspace_with_bots(self):
        newer_empty_workspace = SimpleNamespace(id=7, client_id=70, created_at=datetime(2026, 3, 1, tzinfo=UTC))
        older_active_workspace = SimpleNamespace(id=3, client_id=30, created_at=datetime(2026, 2, 1, tzinfo=UTC))

        selected = _choose_best_agent_candidate(
            [newer_empty_workspace, older_active_workspace],
            workspace_stats={
                70: {"bot_count": 0, "agent_count": 1, "website_bot_count": 0, "document_count": 0, "session_count": 0},
                30: {"bot_count": 1, "agent_count": 2, "website_bot_count": 0, "document_count": 0, "session_count": 0},
            },
        )

        assert selected is older_active_workspace

    def test_prefers_larger_team_when_no_bots_exist(self):
        smaller_team = SimpleNamespace(id=4, client_id=40, created_at=datetime(2026, 3, 5, tzinfo=UTC))
        larger_team = SimpleNamespace(id=5, client_id=50, created_at=datetime(2026, 3, 4, tzinfo=UTC))

        selected = _choose_best_agent_candidate(
            [smaller_team, larger_team],
            workspace_stats={
                40: {"bot_count": 0, "agent_count": 1, "website_bot_count": 0, "document_count": 0, "session_count": 0},
                50: {"bot_count": 0, "agent_count": 4, "website_bot_count": 0, "document_count": 0, "session_count": 0},
            },
        )

        assert selected is larger_team

    def test_falls_back_to_newer_record_when_workspace_counts_match(self):
        older_agent = SimpleNamespace(id=11, client_id=11, created_at=datetime(2026, 1, 10, tzinfo=UTC))
        newer_agent = SimpleNamespace(id=12, client_id=12, created_at=datetime(2026, 3, 10, tzinfo=UTC))

        selected = _choose_best_agent_candidate(
            [older_agent, newer_agent],
            workspace_stats={
                11: {"bot_count": 1, "agent_count": 2, "website_bot_count": 0, "document_count": 0, "session_count": 0},
                12: {"bot_count": 1, "agent_count": 2, "website_bot_count": 0, "document_count": 0, "session_count": 0},
            },
        )

        assert selected is newer_agent

    def test_prefers_workspace_with_connected_bot_signals_when_counts_tie(self):
        newer_unlinked_workspace = SimpleNamespace(id=14, client_id=140, created_at=datetime(2026, 3, 20, tzinfo=UTC))
        older_connected_workspace = SimpleNamespace(id=9, client_id=90, created_at=datetime(2026, 2, 10, tzinfo=UTC))

        selected = _choose_best_agent_candidate(
            [newer_unlinked_workspace, older_connected_workspace],
            workspace_stats={
                140: {
                    "bot_count": 1,
                    "agent_count": 2,
                    "website_bot_count": 0,
                    "document_count": 0,
                    "session_count": 0,
                },
                90: {"bot_count": 1, "agent_count": 2, "website_bot_count": 1, "document_count": 3, "session_count": 8},
            },
        )

        assert selected is older_connected_workspace


class TestDefaultWorkspaceBotSelection:
    def test_prefers_bot_with_live_website_and_activity(self):
        dormant_bot = SimpleNamespace(
            id=10,
            website=None,
            created_at=datetime(2026, 3, 15, tzinfo=UTC),
        )
        connected_bot = SimpleNamespace(
            id=11,
            website="https://example.com",
            created_at=datetime(2026, 3, 1, tzinfo=UTC),
        )

        selected = _choose_default_workspace_bot(
            [dormant_bot, connected_bot],
            {
                10: {"document_count": 0, "session_count": 0},
                11: {"document_count": 4, "session_count": 12},
            },
        )

        assert selected is connected_bot
