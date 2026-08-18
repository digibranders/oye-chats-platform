"""Unit tests for the SQL-backed event router in ``rag_service``.

Covers the keyword classifier, the prompt-block formatter, and the guarded
lookup wrapper, the three pure helpers that gate the Tier 2 branch. The
full ``rag_pipeline_stream`` integration is exercised by the existing
rag_service test suite.
"""

from __future__ import annotations

from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest


class TestIsEventQuestion:
    @pytest.mark.parametrize(
        "question",
        [
            "any upcoming webinars?",
            "when is the next event",
            "show me your schedule",
            "any events this month?",
            "what's on your calendar",
            "next workshop",
        ],
    )
    def test_matches_common_phrasings(self, question):
        from app.services.rag_service import _is_event_question

        assert _is_event_question(question) is True

    @pytest.mark.parametrize(
        "question",
        [
            "what is your pricing?",
            "tell me about your product",
            "how do refunds work",
            "",
            "   ",
        ],
    )
    def test_returns_false_on_non_event_questions(self, question):
        from app.services.rag_service import _is_event_question

        assert _is_event_question(question) is False


class TestBuildEventsContext:
    def test_empty_list_returns_empty_string(self):
        from app.services.rag_service import _build_events_context

        assert _build_events_context([]) == ""

    def test_formats_row_with_all_optional_fields(self):
        from app.services.rag_service import _build_events_context

        row = SimpleNamespace(
            title="AI in Retail",
            starts_at=datetime(2026, 8, 18, tzinfo=UTC),
            location="Online",
            url="https://acme.com/webinars/ai",
        )
        block = _build_events_context([row])
        assert "STRUCTURED UPCOMING EVENTS" in block
        assert '"AI in Retail"' in block
        assert "2026-08-18" in block
        assert "Online" in block
        assert "https://acme.com/webinars/ai" in block

    def test_omits_missing_optional_fields(self):
        from app.services.rag_service import _build_events_context

        row = SimpleNamespace(
            title="Solo Event",
            starts_at=datetime(2026, 9, 2, tzinfo=UTC),
            location=None,
            url=None,
        )
        block = _build_events_context([row])
        assert "Solo Event" in block
        # Should not contain a stray separator with nothing after it.
        assert "· ·" not in block


class TestMaybeEventsBlock:
    def test_flag_off_returns_empty_string(self):
        from app.services import rag_service

        with patch.object(rag_service.config, "EVENT_EXTRACTION_ENABLED", False):
            out = rag_service._maybe_events_block(MagicMock(), bot_id=1, question="any upcoming events?")
        assert out == ""

    def test_non_event_question_short_circuits_before_db(self):
        from app.services import rag_service

        session = MagicMock()
        with patch.object(rag_service.config, "EVENT_EXTRACTION_ENABLED", True):
            out = rag_service._maybe_events_block(session, bot_id=1, question="what's your pricing?")
        assert out == ""
        # Cheap way to prove we skipped the DB entirely.
        session.execute.assert_not_called()

    def test_missing_bot_id_returns_empty(self):
        from app.services import rag_service

        with patch.object(rag_service.config, "EVENT_EXTRACTION_ENABLED", True):
            out = rag_service._maybe_events_block(MagicMock(), bot_id=None, question="any upcoming events?")
        assert out == ""

    def test_db_error_degrades_gracefully(self):
        from app.services import rag_service

        with (
            patch.object(rag_service.config, "EVENT_EXTRACTION_ENABLED", True),
            patch.object(rag_service, "get_upcoming_events", side_effect=RuntimeError("db down")),
        ):
            out = rag_service._maybe_events_block(MagicMock(), bot_id=1, question="any upcoming events?")
        assert out == ""

    def test_returns_formatted_block_when_events_exist(self):
        from app.services import rag_service

        row = SimpleNamespace(
            title="AI in Retail",
            starts_at=datetime(2026, 8, 18, tzinfo=UTC),
            location=None,
            url=None,
        )
        with (
            patch.object(rag_service.config, "EVENT_EXTRACTION_ENABLED", True),
            patch.object(rag_service, "get_upcoming_events", return_value=[row]),
        ):
            out = rag_service._maybe_events_block(MagicMock(), bot_id=1, question="any upcoming webinars?")
        assert "AI in Retail" in out
        assert "2026-08-18" in out
