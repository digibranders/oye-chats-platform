"""Tests for app.db.repository — database operations."""

from types import SimpleNamespace
from unittest.mock import MagicMock


class _ScalarExecResult:
    def __init__(self, value):
        self._value = value

    def scalar(self):
        return self._value


class _FirstExecResult:
    def __init__(self, value):
        self._value = value

    def first(self):
        return self._value


class _AllExecResult:
    def __init__(self, rows):
        self._rows = rows

    def all(self):
        return self._rows


# ── Owner filter helpers ─────────────────────────────────────────────────────


class TestOwnerFilters:
    def test_resolve_owner_passthrough(self):
        from app.db.repository import _resolve_owner

        bid, cid = _resolve_owner(bot_id=5, client_id=10)
        assert bid == 5
        assert cid == 10

    def test_resolve_owner_none(self):
        from app.db.repository import _resolve_owner

        bid, cid = _resolve_owner()
        assert bid is None
        assert cid is None


# ── ensure_chat_session ──────────────────────────────────────────────────────


class TestEnsureChatSession:
    def test_creates_new_session(self):
        from app.db.repository import ensure_chat_session

        session = MagicMock()
        # ensure_chat_session calls session.execute(stmt).scalar_one_or_none()
        session.execute.return_value.scalar_one_or_none.return_value = None

        ensure_chat_session(session, "new-session-id", client_id=1, bot_id=5)

        session.add.assert_called_once()
        session.flush.assert_called_once()

    def test_updates_existing_session(self):
        from app.db.repository import ensure_chat_session

        existing = MagicMock()
        existing.bot_id = 5
        session = MagicMock()
        session.execute.return_value.scalar_one_or_none.return_value = existing

        ensure_chat_session(session, "existing-id", client_id=1, bot_id=5, location="NYC")

        session.add.assert_not_called()
        assert existing.location == "NYC"

    def test_backfills_bot_id(self):
        from app.db.repository import ensure_chat_session

        existing = MagicMock()
        existing.bot_id = None
        session = MagicMock()
        session.execute.return_value.scalar_one_or_none.return_value = existing

        ensure_chat_session(session, "old-id", client_id=1, bot_id=7)

        assert existing.bot_id == 7


# ── add_chat_message ─────────────────────────────────────────────────────────


class TestAddChatMessage:
    def test_adds_message_and_flushes(self):
        from app.db.repository import add_chat_message

        session = MagicMock()
        # add_chat_message calls ensure_chat_session internally, which uses
        # session.execute(stmt).scalar_one_or_none()
        session.execute.return_value.scalar_one_or_none.return_value = MagicMock(bot_id=1)

        add_chat_message(session, "s1", client_id=1, role="user", content="Hello", bot_id=1)

        session.add.assert_called()
        session.flush.assert_called()


# ── get_chat_history ─────────────────────────────────────────────────────────


class TestGetChatHistory:
    def test_returns_empty_for_missing_session(self):
        from app.db.repository import get_chat_history

        session = MagicMock()
        # get_chat_history first checks session existence via
        # session.execute(stmt_check).first() — returns None for missing
        session.execute.return_value.first.return_value = None

        result = get_chat_history(session, "no-session", client_id=1, bot_id=1)
        assert result == []

    def test_returns_chronological_order(self):
        from app.db.repository import get_chat_history

        session = MagicMock()

        # Messages returned in DESC order (newest first)
        msg1 = SimpleNamespace(id=1, role="user", content="First")
        msg2 = SimpleNamespace(id=2, role="bot", content="Second")

        # get_chat_history makes two session.execute() calls:
        #   1) session.execute(stmt_check).first()  → existence check
        #   2) session.execute(stmt).scalars().all() → fetch messages
        check_result = MagicMock()
        check_result.first.return_value = ("s1",)  # session exists

        messages_result = MagicMock()
        messages_result.scalars.return_value.all.return_value = [msg2, msg1]

        session.execute.side_effect = [check_result, messages_result]

        result = get_chat_history(session, "s1", client_id=1, bot_id=1)
        # Should be reversed to chronological
        assert result == [msg1, msg2]


# ── update_session_bant ──────────────────────────────────────────────────────


class TestUpdateSessionBant:
    def test_updates_bant_fields(self):
        from app.db.repository import update_session_bant

        cs = MagicMock()
        session = MagicMock()
        # update_session_bant calls session.execute(stmt).scalar_one_or_none()
        session.execute.return_value.scalar_one_or_none.return_value = cs

        result = update_session_bant(
            session,
            "s1",
            client_id=1,
            bant_data={"bant_need": "Scale ops", "bant_need_score": 15},
            bot_id=1,
        )

        assert result is True

    def test_returns_false_for_missing_session(self):
        from app.db.repository import update_session_bant

        session = MagicMock()
        session.execute.return_value.scalar_one_or_none.return_value = None

        result = update_session_bant(session, "missing", bant_data={"bant_need": "X"})
        assert result is False

    def test_returns_false_for_none_data(self):
        from app.db.repository import update_session_bant

        session = MagicMock()
        result = update_session_bant(session, "s1", bant_data=None)
        assert result is False


# ── create_or_update_lead_info ───────────────────────────────────────────────


class TestLeadInfo:
    def test_creates_new_lead(self):
        from app.db.repository import create_or_update_lead_info

        session = MagicMock()
        # create_or_update_lead_info calls
        # session.execute(...).scalar_one_or_none()
        session.execute.return_value.scalar_one_or_none.return_value = None

        create_or_update_lead_info(
            session,
            "s1",
            bot_id=1,
            name="John",
            email="j@x.com",
        )

        session.add.assert_called_once()
        session.flush.assert_called_once()

    def test_updates_existing_lead(self):
        from app.db.repository import create_or_update_lead_info

        existing = MagicMock()
        existing.name = "Old Name"
        session = MagicMock()
        session.execute.return_value.scalar_one_or_none.return_value = existing

        create_or_update_lead_info(
            session,
            "s1",
            bot_id=1,
            name="New Name",
        )

        assert existing.name == "New Name"

    def test_skips_none_fields_on_update(self):
        from app.db.repository import create_or_update_lead_info

        existing = MagicMock()
        existing.name = "Keep This"
        existing.email = "keep@x.com"
        session = MagicMock()
        session.execute.return_value.scalar_one_or_none.return_value = existing

        create_or_update_lead_info(session, "s1", bot_id=1, name=None, email=None, phone="+1")

        assert existing.name == "Keep This"
        assert existing.email == "keep@x.com"
        assert existing.phone == "+1"


# ── is_document_processed ───────────────────────────────────────────────────


class TestIsDocumentProcessed:
    def test_returns_true_when_exists(self):
        from app.db.repository import is_document_processed

        session = MagicMock()
        # is_document_processed calls session.execute(stmt).first()
        session.execute.return_value.first.return_value = (42,)

        assert is_document_processed(session, client_id=1, file_hash="abc123") is True

    def test_returns_false_when_not_exists(self):
        from app.db.repository import is_document_processed

        session = MagicMock()
        session.execute.return_value.first.return_value = None

        assert is_document_processed(session, client_id=1, file_hash="xyz") is False


# ── delete_chunks_for_url ────────────────────────────────────────────────────


class TestDeleteChunksForUrl:
    def test_returns_deleted_count(self):
        from app.db.repository import delete_chunks_for_url

        session = MagicMock()
        session.query.return_value.filter.return_value.delete.return_value = 5

        result = delete_chunks_for_url(session, "https://example.com/page", bot_id=1, client_id=1)
        assert result == 5

    def test_returns_zero_when_none_match(self):
        from app.db.repository import delete_chunks_for_url

        session = MagicMock()
        session.query.return_value.filter.return_value.delete.return_value = 0

        result = delete_chunks_for_url(session, "https://nothing.com", bot_id=1)
        assert result == 0


# ── count_documents_for_bot ──────────────────────────────────────────────────


class TestCountDocuments:
    def test_returns_count(self):
        from app.db.repository import count_documents_for_bot

        session = MagicMock()
        # count_documents_for_bot calls session.execute(stmt).scalar_one()
        session.execute.return_value.scalar_one.return_value = 42

        result = count_documents_for_bot(session, bot_id=1)
        assert result == 42


# ── get_dashboard_stats ──────────────────────────────────────────────────────


class TestDashboardStats:
    def test_includes_demo_growth_metrics_and_days_filter(self):
        from app.db.repository import get_dashboard_stats

        session = MagicMock()
        session.execute.side_effect = [
            _ScalarExecResult(14),
            _ScalarExecResult(62),
            _ScalarExecResult(5),
            _ScalarExecResult(3),
            _FirstExecResult(SimpleNamespace(total=8, positive=6)),
            _AllExecResult(
                [
                    SimpleNamespace(event_type="demo_share_clicked", count=4),
                    SimpleNamespace(event_type="demo_link_opened", count=10),
                ]
            ),
        ]

        result = get_dashboard_stats(session, client_id=1, bot_id=7, days=30)

        assert result == {
            "total_conversations": 14,
            "total_messages": 62,
            "total_documents": 5,
            "active_users": 3,
            "success_rate": 75,
            "demo_shares": 4,
            "demo_opens": 10,
            "demo_open_rate": 250.0,
        }

        session_query = str(session.execute.call_args_list[0].args[0])
        growth_query = str(session.execute.call_args_list[-1].args[0])
        assert "chat_sessions.created_at" in session_query
        assert "bot_growth_events.created_at" in growth_query

    def test_returns_zero_demo_open_rate_without_shares(self):
        from app.db.repository import get_dashboard_stats

        session = MagicMock()
        session.execute.side_effect = [
            _ScalarExecResult(0),
            _ScalarExecResult(0),
            _ScalarExecResult(0),
            _ScalarExecResult(0),
            _FirstExecResult(SimpleNamespace(total=0, positive=0)),
            _AllExecResult([SimpleNamespace(event_type="demo_link_opened", count=3)]),
        ]

        result = get_dashboard_stats(session, client_id=1, bot_id=7)

        assert result["demo_shares"] == 0
        assert result["demo_opens"] == 3
        assert result["demo_open_rate"] == 0


# ── update_message_feedback ──────────────────────────────────────────────────


class TestUpdateMessageFeedback:
    def test_updates_feedback(self):
        from app.db.repository import update_message_feedback

        msg = MagicMock()
        msg.feedback = None
        session = MagicMock()
        # update_message_feedback calls
        # session.execute(stmt).scalar_one_or_none()
        session.execute.return_value.scalar_one_or_none.return_value = msg

        result = update_message_feedback(session, message_id=1, feedback_value=1, bot_id=1)
        assert result is True

    def test_returns_false_for_missing_message(self):
        from app.db.repository import update_message_feedback

        session = MagicMock()
        session.execute.return_value.scalar_one_or_none.return_value = None

        result = update_message_feedback(session, message_id=999, feedback_value=1)
        assert result is False


# ── get_lead_info_by_session ─────────────────────────────────────────────────


class TestGetLeadInfoBySession:
    def test_returns_lead(self):
        from app.db.repository import get_lead_info_by_session

        lead = SimpleNamespace(name="Jane", email="j@x.com")
        session = MagicMock()
        # get_lead_info_by_session calls
        # session.execute(...).scalar_one_or_none()
        session.execute.return_value.scalar_one_or_none.return_value = lead

        result = get_lead_info_by_session(session, "s1")
        assert result.name == "Jane"

    def test_returns_none_when_not_found(self):
        from app.db.repository import get_lead_info_by_session

        session = MagicMock()
        session.execute.return_value.scalar_one_or_none.return_value = None

        result = get_lead_info_by_session(session, "no-session")
        assert result is None
