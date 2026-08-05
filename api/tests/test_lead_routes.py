"""Tests for lead routes — unread tracking, mark-viewed, mark-all-viewed.

Covers the "unread leads" contract that backs the sidebar badge:
  - GET  /leads/stats     exposes `unread`
  - POST /leads/{id}/view is idempotent & sets `lead_viewed_at`
  - POST /leads/mark-all-viewed  bulk-clears unread for a bot
  - build_lead_response includes `unread` + `lead_viewed_at`
  - Legacy tier aliases (cold/warm/hot/qualified) still returned
"""

from contextlib import contextmanager
from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.auth import get_current_client_or_operator
from app.api.lead_routes import router


@pytest.fixture(autouse=True)
def _allow_leads_dashboard(monkeypatch):
    """Every route in this file assumes the caller has paid-tier leads
    access — the plan gates are exercised in ``test_plan_entitlements_service``
    and in ``TestFreePlanIntelligenceStripping`` below. Stub them here so we
    don't have to mock a full entitlements resolver in every test's session
    fixture. ``patch`` at import site so both the router-level dependency and
    the in-handler checks see the stub.
    """
    from app.api import lead_routes as _lead_routes

    monkeypatch.setattr(_lead_routes, "is_leads_dashboard_enabled", lambda *_a, **_k: True)
    monkeypatch.setattr(_lead_routes, "is_lead_intelligence_enabled", lambda *_a, **_k: True)


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
        # The transcript itself is the free surface — it must survive.
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
