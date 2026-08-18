"""GET /credits/daily, the Usage-page consumption trend series.

Sums metered consumption debits (ai_chat / url_scan / email_send /
document_upload) per UTC day into a zero-filled ascending series. Grants,
monthly resets, top-ups, refunds, and manual adjustments are NOT consumption
and must be excluded so the trend matches the usage breakdown.

Real-Postgres route test via the shared ``db`` fixture; skips without DB_URL.
"""

from __future__ import annotations

import os
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.db.models import Client, CreditLedger

pytestmark = pytest.mark.skipif(
    not os.getenv("DB_URL"),
    reason="credit-daily route test needs a reachable Postgres at DB_URL",
)


@contextmanager
def _session_cm(session):
    yield session


def _make_client(db, *, email: str) -> Client:
    client = Client(name="c", email=email, api_key=email, hashed_password="h", is_verified=True)
    db.add(client)
    db.flush()
    return client


def _ledger(db, client, *, delta: int, reason: str, created_at: datetime) -> None:
    db.add(CreditLedger(client_id=client.id, delta=delta, reason=reason, created_at=created_at))


def _api(db, client) -> TestClient:
    from app.api import auth, subscription_routes

    app = FastAPI()
    app.include_router(subscription_routes.credits_router)
    app.dependency_overrides[auth.get_current_client_strict] = lambda: client
    return TestClient(app, raise_server_exceptions=False)


def _call(db, client, days: int = 7):
    from app.api import subscription_routes

    api = _api(db, client)
    with patch_session(subscription_routes, db):
        return api.get(f"/credits/daily?days={days}")


def patch_session(module, db):
    from unittest.mock import patch

    return patch.object(module, "get_session", lambda: _session_cm(db))


def test_daily_series_is_zero_filled_and_sums_consumption(db) -> None:
    client = _make_client(db, email="daily-basic@e.com")
    now = datetime.now(UTC)
    today = now
    yesterday = now - timedelta(days=1)

    # Today: 1 + 1 (ai_chat) + 5 (url_scan) = 7 consumed.
    _ledger(db, client, delta=-1, reason="ai_chat", created_at=today)
    _ledger(db, client, delta=-1, reason="ai_chat", created_at=today)
    _ledger(db, client, delta=-5, reason="url_scan", created_at=today)
    # Yesterday: 3 (document_upload).
    _ledger(db, client, delta=-3, reason="document_upload", created_at=yesterday)
    # Noise that must be EXCLUDED: a grant (+), a reset (−), a topup (+), a refund.
    _ledger(db, client, delta=200, reason="plan_grant", created_at=today)
    _ledger(db, client, delta=-50, reason="plan_grant", created_at=today)
    _ledger(db, client, delta=100, reason="topup", created_at=today)
    _ledger(db, client, delta=10, reason="refund", created_at=today)
    db.commit()

    res = _call(db, client, days=7)
    assert res.status_code == 200, res.text
    body = res.json()

    assert body["days"] == 7
    series = body["series"]
    assert len(series) == 7
    # Ascending, contiguous calendar days.
    dates = [row["date"] for row in series]
    assert dates == sorted(dates)
    assert dates[-1] == today.date().isoformat()
    assert dates[-2] == yesterday.date().isoformat()

    used_by_date = {row["date"]: row["credits_used"] for row in series}
    # Consumption only. Grant/reset/topup/refund excluded.
    assert used_by_date[today.date().isoformat()] == 7
    assert used_by_date[yesterday.date().isoformat()] == 3
    # Every other day is a real zero, not a gap.
    quiet = [d for d in dates if d not in (today.date().isoformat(), yesterday.date().isoformat())]
    assert all(used_by_date[d] == 0 for d in quiet)


def test_daily_excludes_activity_outside_the_window(db) -> None:
    client = _make_client(db, email="daily-window@e.com")
    now = datetime.now(UTC)
    # 10 days ago. Outside a 7-day window.
    _ledger(db, client, delta=-9, reason="ai_chat", created_at=now - timedelta(days=10))
    db.commit()

    res = _call(db, client, days=7)
    assert res.status_code == 200, res.text
    series = res.json()["series"]
    assert sum(row["credits_used"] for row in series) == 0
