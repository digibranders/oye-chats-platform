"""Tests for the Journeys analytics service + routes."""

from __future__ import annotations

from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from unittest.mock import MagicMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.analytics_routes import router
from app.api.auth import get_current_client_or_operator
from app.services import journey_analytics_service as jas


@contextmanager
def _session_ctx(session):
    yield session


def _build_app(auth_override=None):
    app = FastAPI()
    app.include_router(router)
    if auth_override:
        app.dependency_overrides[get_current_client_or_operator] = lambda: auth_override
    return app


# ── Service: aggregation logic ───────────────────────────────────────────────


class TestTopPages:
    def _mock_journeys(self, journeys):
        return patch.object(jas, "_fetch_journeys", return_value=journeys)

    def test_ranks_by_distinct_sessions(self):
        journeys = [
            [{"path": "/a", "phase": "pre"}, {"path": "/b", "phase": "pre"}],
            [{"path": "/a", "phase": "pre"}],
            [{"path": "/b", "phase": "pre"}, {"path": "/b", "phase": "pre"}],  # same-session dup
        ]
        with self._mock_journeys(journeys):
            rows = jas.top_pages(MagicMock(), bot_id=1, since=_ago(30), until=_now())
        by_path = {r["path"]: r for r in rows}
        assert by_path["/a"]["sessions"] == 2
        assert by_path["/b"]["sessions"] == 2
        # /b has 3 visits total (2 in one session + 1 in another)
        assert by_path["/b"]["visits"] == 3
        assert by_path["/a"]["visits"] == 2

    def test_filter_by_phase(self):
        journeys = [
            [
                {"path": "/pre", "phase": "pre"},
                {"path": "/post", "phase": "post"},
            ]
        ]
        with self._mock_journeys(journeys):
            pre_only = jas.top_pages(MagicMock(), 1, _ago(30), _now(), phase="pre")
            post_only = jas.top_pages(MagicMock(), 1, _ago(30), _now(), phase="post")
        assert [r["path"] for r in pre_only] == ["/pre"]
        assert [r["path"] for r in post_only] == ["/post"]

    def test_empty_returns_empty_list(self):
        with self._mock_journeys([]):
            assert jas.top_pages(MagicMock(), 1, _ago(30), _now()) == []


class TestPathsToConversion:
    def test_groups_identical_sequences(self):
        # Two sessions took /a → /b → chat → meeting_booked; one took /a → /c
        journeys = [
            [
                {"path": "/a", "phase": "pre"},
                {"path": "/b", "phase": "pre"},
                {"path": "/b", "phase": "chat", "event": "meeting_booked"},
            ],
            [
                {"path": "/a", "phase": "pre"},
                {"path": "/b", "phase": "pre"},
                {"path": "/b", "phase": "chat", "event": "meeting_booked"},
            ],
            [
                {"path": "/a", "phase": "pre"},
                {"path": "/c", "phase": "pre"},
                {"path": "/c", "phase": "chat", "event": "meeting_booked"},
            ],
            # Non-conversion session — should not appear in `paths`
            [
                {"path": "/a", "phase": "pre"},
                {"path": "/z", "phase": "post"},
            ],
        ]
        with patch.object(jas, "_fetch_journeys", return_value=journeys):
            out = jas.paths_to_conversion(MagicMock(), 1, "meeting_booked", _ago(30), _now())
        assert out["total_conversions"] == 3
        assert out["total_sessions"] == 4
        # Top path: /a → /b with 2 sessions
        top = out["paths"][0]
        assert top["sequence"] == ["/a", "/b"]
        assert top["sessions"] == 2
        # 2 / 4 total sessions = 0.5
        assert top["conversion_rate"] == 0.5

    def test_unknown_conversion_type_raises(self):
        with pytest.raises(ValueError):
            jas.paths_to_conversion(MagicMock(), 1, "signup", _ago(30), _now())

    def test_dedupes_consecutive_same_path(self):
        # /a → /a (SPA hash change, e.g.) collapses to just /a for sequences
        journeys = [
            [
                {"path": "/a", "phase": "pre"},
                {"path": "/a", "phase": "pre"},
                {"path": "/a", "phase": "chat", "event": "handoff_requested"},
            ]
        ]
        with patch.object(jas, "_fetch_journeys", return_value=journeys):
            out = jas.paths_to_conversion(MagicMock(), 1, "handoff_requested", _ago(30), _now())
        assert out["paths"][0]["sequence"] == ["/a"]


class TestPostChatDestinations:
    def test_first_hops_and_sequences(self):
        journeys = [
            [
                {"path": "/pricing", "phase": "pre"},
                {"path": "/pricing", "phase": "chat", "event": "chat_opened"},
                {"path": "/features", "phase": "post"},
                {"path": "/contact", "phase": "post"},
            ],
            [
                {"path": "/home", "phase": "pre"},
                {"path": "/home", "phase": "chat", "event": "chat_opened"},
                {"path": "/features", "phase": "post"},
            ],
            # No post-chat activity — excluded from both aggregates
            [{"path": "/x", "phase": "pre"}],
        ]
        with patch.object(jas, "_fetch_journeys", return_value=journeys):
            out = jas.post_chat_destinations(MagicMock(), 1, _ago(30), _now())
        assert out["sessions_with_post_chat_activity"] == 2
        # /features is the first hop in both post-chat sessions
        assert out["first_hops"][0] == {"path": "/features", "sessions": 2}
        # Full sequences are distinct
        sequences = {tuple(r["sequence"]) for r in out["full_sequences"]}
        assert ("/features", "/contact") in sequences
        assert ("/features",) in sequences


class TestTopPreChatSequences:
    def test_groups_identical_sequences(self):
        journeys = [
            [
                {"path": "/home", "phase": "pre"},
                {"path": "/about", "phase": "pre"},
                {"path": "/about", "phase": "chat", "event": "chat_opened"},
            ],
            [
                {"path": "/home", "phase": "pre"},
                {"path": "/about", "phase": "pre"},
                {"path": "/about", "phase": "chat", "event": "meeting_booked"},
            ],
            [
                {"path": "/home", "phase": "pre"},
                {"path": "/contact", "phase": "pre"},
                {"path": "/contact", "phase": "chat", "event": "chat_opened"},
            ],
        ]
        with patch.object(jas, "_fetch_journeys", return_value=journeys):
            out = jas.top_pre_chat_sequences(MagicMock(), 1, _ago(30), _now())
        assert out["total_sessions"] == 3
        assert out["sessions_with_pre_chat"] == 3
        top = out["sequences"][0]
        assert top["sequence"] == ["/home", "/about"]
        assert top["sessions"] == 2

    def test_includes_non_converted_sessions(self):
        # Unlike paths_to_conversion, non-converted sessions still count.
        journeys = [
            [
                {"path": "/a", "phase": "pre"},
                {"path": "/b", "phase": "pre"},
            ],
            [
                {"path": "/a", "phase": "pre"},
                {"path": "/b", "phase": "pre"},
            ],
        ]
        with patch.object(jas, "_fetch_journeys", return_value=journeys):
            out = jas.top_pre_chat_sequences(MagicMock(), 1, _ago(30), _now())
        assert out["sequences"][0]["sequence"] == ["/a", "/b"]
        assert out["sequences"][0]["sessions"] == 2

    def test_skips_sessions_without_pre_pages(self):
        journeys = [
            [{"path": "/a", "phase": "post"}],  # post only, no pre → skipped
            [{"path": "/b", "phase": "pre"}],
        ]
        with patch.object(jas, "_fetch_journeys", return_value=journeys):
            out = jas.top_pre_chat_sequences(MagicMock(), 1, _ago(30), _now())
        assert out["sessions_with_pre_chat"] == 1
        assert out["sequences"] == [{"sequence": ["/b"], "post_sequence": [], "post_sessions": 0, "sessions": 1}]

    def test_empty_returns_zero_sessions(self):
        with patch.object(jas, "_fetch_journeys", return_value=[]):
            out = jas.top_pre_chat_sequences(MagicMock(), 1, _ago(30), _now())
        assert out == {"total_sessions": 0, "sequences": []}

    def test_returns_matching_post_sequence_per_pattern(self):
        # Two sessions took /home → /about → chat → /features → /demo,
        # one session took /home → /about → chat with no post-chat.
        # The row for /home,/about should carry post_sequence
        # ['/features', '/demo'] since that's the top continuation.
        journeys = [
            [
                {"path": "/home", "phase": "pre"},
                {"path": "/about", "phase": "pre"},
                {"path": "/about", "phase": "chat", "event": "chat_opened"},
                {"path": "/features", "phase": "post"},
                {"path": "/demo", "phase": "post"},
            ],
            [
                {"path": "/home", "phase": "pre"},
                {"path": "/about", "phase": "pre"},
                {"path": "/about", "phase": "chat", "event": "chat_opened"},
                {"path": "/features", "phase": "post"},
                {"path": "/demo", "phase": "post"},
            ],
            [
                {"path": "/home", "phase": "pre"},
                {"path": "/about", "phase": "pre"},
                {"path": "/about", "phase": "chat", "event": "chat_opened"},
            ],
        ]
        with patch.object(jas, "_fetch_journeys", return_value=journeys):
            out = jas.top_pre_chat_sequences(MagicMock(), 1, _ago(30), _now())
        top = out["sequences"][0]
        assert top["sequence"] == ["/home", "/about"]
        assert top["sessions"] == 3
        assert top["post_sequence"] == ["/features", "/demo"]
        # Only 2 of the 3 sessions took the winning post-continuation;
        # the third had no post-chat activity at all. post_sessions must
        # reflect the winning continuation's count, not the row total —
        # otherwise the flow diagram labels post cards as if all 3
        # visitors went there.
        assert top["post_sessions"] == 2


class TestSummaryCounts:
    def test_counts_conversions_and_leads(self):
        journeys = [
            [
                {"path": "/a", "phase": "pre"},
                {"path": "/a", "phase": "chat", "event": "meeting_booked"},
            ],
            [
                {"path": "/a", "phase": "pre"},
                {"path": "/a", "phase": "chat", "event": "handoff_requested"},
                {"path": "/a", "phase": "chat", "event": "handoff_requested"},  # dup
            ],
            [
                {"path": "/a", "phase": "pre"},
                {"path": "/a", "phase": "chat", "event": "offline_message_sent"},
            ],
        ]
        db = MagicMock()
        db.execute.return_value.all.return_value = [("lead1",), ("lead2",), ("lead3",)]
        with patch.object(jas, "_fetch_journeys", return_value=journeys):
            out = jas.summary_counts(db, 1, _ago(30), _now())
        assert out["sessions_with_journey"] == 3
        assert out["meeting_booked"] == 1
        # Deduped: handoff_requested fires twice in one session, counts once
        assert out["handoff_requested"] == 1
        assert out["offline_message_sent"] == 1
        assert out["leads_captured"] == 3
        # Every session converted, none kept browsing → no "no activity" rows
        assert out["sessions_no_activity"] == 0
        assert out["sessions_browsed_no_conversion"] == 0

    def test_sessions_no_activity_counts_true_drop_offs(self):
        # Overlap case: a session that BOTH converted AND kept browsing
        # must not be counted as "no activity". Only the last session
        # (pre-only, no conversion, no post) qualifies.
        journeys = [
            [
                {"path": "/a", "phase": "pre"},
                {"path": "/a", "phase": "chat", "event": "meeting_booked"},
                {"path": "/thanks", "phase": "post"},  # overlap: converted AND post
            ],
            [
                {"path": "/a", "phase": "pre"},
                {"path": "/b", "phase": "post"},  # post-only, no conversion
            ],
            [
                {"path": "/a", "phase": "pre"},
                # no conversion, no post → this is a true drop-off
            ],
        ]
        db = MagicMock()
        db.execute.return_value.all.return_value = []
        with patch.object(jas, "_fetch_journeys", return_value=journeys):
            out = jas.summary_counts(db, 1, _ago(30), _now())
        assert out["sessions_with_journey"] == 3
        assert out["meeting_booked"] == 1
        assert out["sessions_no_activity"] == 1
        # The post-only, non-converting session is the "kept browsing"
        # bucket; the converted-and-browsed session must NOT appear here.
        assert out["sessions_browsed_no_conversion"] == 1
        # Buckets partition every journey exactly once.
        converted = out["meeting_booked"] + out["handoff_requested"] + out["offline_message_sent"]
        assert (
            converted + out["sessions_browsed_no_conversion"] + out["sessions_no_activity"]
            == out["sessions_with_journey"]
        )


# ── Routes: plan gate + shape ────────────────────────────────────────────────


class TestJourneyRoutes:
    def _guarded_app(self, gate_enabled=True):
        app = _build_app(auth_override={"client_id": 42})
        # Bot ownership: pass. Gate: parameterized.
        return app

    def test_gate_denies_when_flag_off(self):
        app = _build_app(auth_override={"client_id": 42})
        with (
            patch("app.api.analytics_routes._verify_bot_ownership", return_value=None),
            patch(
                "app.services.plan_entitlements_service.is_journey_analytics_enabled_for_bot",
                return_value=False,
            ),
            patch("app.api.analytics_routes.get_session") as mock_gs,
        ):
            mock_gs.side_effect = lambda: _session_ctx(MagicMock())
            r = TestClient(app).get("/analytics/journey/summary?bot_id=1&period=2026-08")
        assert r.status_code == 402
        assert "Standard or Professional" in r.json()["detail"]

    def test_summary_happy_path(self):
        app = _build_app(auth_override={"client_id": 42})
        payload = {
            "sessions_with_journey": 10,
            "meeting_booked": 2,
            "handoff_requested": 1,
            "offline_message_sent": 0,
            "leads_captured": 4,
        }
        with (
            patch("app.api.analytics_routes._verify_bot_ownership", return_value=None),
            patch(
                "app.services.plan_entitlements_service.is_journey_analytics_enabled_for_bot",
                return_value=True,
            ),
            patch("app.api.analytics_routes.get_session") as mock_gs,
            patch(
                "app.services.journey_analytics_service.summary_counts",
                return_value=payload,
            ),
        ):
            mock_gs.side_effect = lambda: _session_ctx(MagicMock())
            r = TestClient(app).get("/analytics/journey/summary?bot_id=1&period=2026-08")
        assert r.status_code == 200
        assert r.json() == payload

    def test_invalid_period_returns_422(self):
        app = _build_app(auth_override={"client_id": 42})
        with (
            patch("app.api.analytics_routes._verify_bot_ownership", return_value=None),
            patch(
                "app.services.plan_entitlements_service.is_journey_analytics_enabled_for_bot",
                return_value=True,
            ),
            patch("app.api.analytics_routes.get_session") as mock_gs,
        ):
            mock_gs.side_effect = lambda: _session_ctx(MagicMock())
            r = TestClient(app).get(
                "/analytics/journey/summary?bot_id=1&period=99d"
            )  # rolling-day format no longer valid
        assert r.status_code == 422

    def test_yyyy_mm_windows_resolve_to_calendar_month(self):
        """YYYY-MM must anchor to the 1st at 00:00 UTC and end at that month's boundary."""
        from datetime import UTC, datetime

        from app.api.analytics_routes import _resolve_journey_window

        # A definitively-past month (September 2024) resolves to a full,
        # non-truncated window: 2024-09-01 00:00 → 2024-09-30 23:59:59.999999 UTC.
        since, until = _resolve_journey_window("2024-09")
        assert since == datetime(2024, 9, 1, tzinfo=UTC)
        assert until.year == 2024 and until.month == 9 and until.day == 30
        assert until.hour == 23 and until.minute == 59 and until.second == 59

        # December rolls forward to January cleanly.
        dec_since, dec_until = _resolve_journey_window("2024-12")
        assert dec_since == datetime(2024, 12, 1, tzinfo=UTC)
        assert dec_until.year == 2024 and dec_until.month == 12 and dec_until.day == 31

    def test_future_and_out_of_range_periods_return_422(self):
        """Future months and pre-2020 years must be rejected at the resolver."""
        import pytest as _pytest
        from fastapi import HTTPException

        from app.api.analytics_routes import _resolve_journey_window

        with _pytest.raises(HTTPException) as exc_info:
            _resolve_journey_window("2099-01")
        assert exc_info.value.status_code == 422

        with _pytest.raises(HTTPException) as exc_info:
            _resolve_journey_window("1999-05")
        assert exc_info.value.status_code == 422

    def test_bad_period_shape_returns_422(self):
        """Rolling-day strings like '30d' are no longer accepted."""
        import pytest as _pytest
        from fastapi import HTTPException

        from app.api.analytics_routes import _resolve_journey_window

        for bad in ("30d", "2026", "2026-13", "not-a-month"):
            with _pytest.raises(HTTPException) as exc_info:
                _resolve_journey_window(bad)
            assert exc_info.value.status_code == 422

    def test_invalid_conversion_type_returns_422(self):
        app = _build_app(auth_override={"client_id": 42})
        with (
            patch("app.api.analytics_routes._verify_bot_ownership", return_value=None),
            patch(
                "app.services.plan_entitlements_service.is_journey_analytics_enabled_for_bot",
                return_value=True,
            ),
            patch("app.api.analytics_routes.get_session") as mock_gs,
        ):
            mock_gs.side_effect = lambda: _session_ctx(MagicMock())
            r = TestClient(app).get("/analytics/journey/conversion-paths?bot_id=1&conversion_type=signup")
        assert r.status_code == 422


# ── Helpers ───────────────────────────────────────────────────────────────────


def _now() -> datetime:
    return datetime.now(UTC)


def _ago(days: int) -> datetime:
    return _now() - timedelta(days=days)
