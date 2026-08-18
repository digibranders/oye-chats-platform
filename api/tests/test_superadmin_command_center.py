"""Super-admin Command Center summary endpoint. Verifies the 9 headline metrics
are computed and calendar/currency-bucketed server-side."""

import os
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api import superadmin_ops_routes
from app.api.auth import get_superadmin
from app.db.models import (
    Bot,
    ChatSession,
    Client,
    Invoice,
    MeetingBooking,
    Operator,
    PlatformFeedback,
)

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")


@contextmanager
def _ctx(session):
    yield session


def _client(db, monkeypatch) -> TestClient:
    monkeypatch.setattr(superadmin_ops_routes, "get_session", lambda: _ctx(db))
    app = FastAPI()
    app.include_router(superadmin_ops_routes.router)
    app.dependency_overrides[get_superadmin] = lambda: SimpleNamespace(
        id=None, name="Admin", is_superadmin=True, superadmin_role="owner"
    )
    return TestClient(app)


def _invoice(db, client_id, cents, currency, paid_at):
    db.add(
        Invoice(
            client_id=client_id,
            amount_cents=cents,
            currency=currency,
            status="paid",
            invoice_type="tax_invoice",
            paid_at=paid_at,
        )
    )


def test_command_center_metrics(db, monkeypatch):
    now = datetime.now(UTC)
    current_month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    last_month_day = current_month_start - timedelta(days=1)
    current_year_start = now.replace(month=1, day=1, hour=0, minute=0, second=0, microsecond=0)
    # Mid-last-year (unambiguously inside the previous calendar year) and a date
    # two full years back (must be excluded from both growth windows).
    last_year_day = current_year_start - timedelta(days=180)
    two_years_ago = current_year_start.replace(year=current_year_start.year - 2)

    # Account created this month → signups_current_month = 1.
    acct = Client(name="Acme", email="acme@test.example", api_key="key-acme", billing_country="IN")
    db.add(acct)
    db.flush()

    bot = Bot(client_id=acct.id, bot_key="bot-cc-1")
    db.add(bot)
    db.flush()
    op = Operator(client_id=acct.id, bot_id=bot.id, name="Op", email="op@test.example")
    db.add(op)
    db.flush()

    # 4 sessions: 2 BANT-qualified (mql/sql), 1 unqualified, 1 escalated to operator.
    db.add(ChatSession(id="s-q1", client_id=acct.id, bant_tier="mql"))
    db.add(ChatSession(id="s-q2", client_id=acct.id, bant_tier="sql"))
    db.add(ChatSession(id="s-u1", client_id=acct.id, bant_tier="unqualified"))
    db.add(ChatSession(id="s-op", client_id=acct.id, bant_tier="unqualified", assigned_operator_id=op.id))
    db.flush()

    db.add(MeetingBooking(session_id="s-q1", bot_id=bot.id, status="scheduled"))
    db.add(PlatformFeedback(client_id=acct.id, message="add dark mode", type="feature_request"))
    db.add(PlatformFeedback(client_id=acct.id, message="please add SSO", type="feature_request"))
    db.add(PlatformFeedback(client_id=acct.id, message="it broke", type="bug"))

    # Revenue windows. INR is fixed-rate converted to USD cents server-side, so
    # use USD to keep the assertion currency-agnostic and exact.
    _invoice(db, acct.id, 1000, "usd", now)  # current month + current year
    _invoice(db, acct.id, 500, "usd", last_month_day)  # last month
    _invoice(db, acct.id, 2000, "usd", last_year_day)  # last year
    _invoice(db, acct.id, 9999, "usd", two_years_ago)  # excluded (older than last year)
    db.flush()

    c = _client(db, monkeypatch)
    res = c.get("/superadmin/command-center")
    assert res.status_code == 200, res.text
    body = res.json()

    assert body["operator_transfers"] == 1
    assert body["bant_qualified_leads"] == 2
    assert body["chats_total"] == 4
    assert body["booked_meetings"] == 1
    assert body["feature_requests"] == 2
    assert body["signups_current_month"] == 1
    assert body["signups_last_month"] == 0

    assert body["revenue_current_month_cents"] == 1000
    assert body["revenue_last_month_cents"] == 500
    # Every invoice at/after last-year-start counts toward exactly one growth
    # window; the two-years-ago invoice (9999) is excluded from both. The split
    # between current/last year shifts with today's date (the last-month invoice
    # lands in last year only when today is in January), so assert the invariant.
    assert body["growth_current_year_cents"] + body["growth_last_year_cents"] == 3500
    assert body["growth_current_year_cents"] >= 1000
    assert body["growth_last_year_cents"] >= 2000
