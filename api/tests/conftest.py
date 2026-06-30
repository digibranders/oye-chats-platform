"""Shared test fixtures for OyeChats API tests."""

import os
from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from fastapi import FastAPI
from sqlalchemy import create_engine, make_url
from sqlalchemy import text as _sa_text
from sqlalchemy.orm import Session as _Session

from app.api.auth import get_current_bot, get_current_client, get_current_client_or_operator
from app.db.models import Base as _Base

# ── Real-Postgres throwaway DB (for DB-layer tests: locks, ledger, clawback) ──
#
# Mirrors the throwaway-database pattern in test_affiliate_service.py. Requires a
# reachable Postgres at ``DB_URL``; tests that request these fixtures must guard
# with ``pytestmark = skipif(no DB_URL)`` so they skip cleanly when none exists.


def _pg_base_url():
    raw = os.getenv("DB_URL")
    return make_url(raw) if raw else None


@pytest.fixture(scope="module")
def pg_engine():
    base = _pg_base_url()
    if base is None:
        pytest.skip("needs a reachable Postgres at DB_URL")
    test_db = (base.database or "postgres") + "_pytest"
    admin = create_engine(base.set(database="postgres"), isolation_level="AUTOCOMMIT")
    with admin.connect() as conn:
        conn.exec_driver_sql(f'DROP DATABASE IF EXISTS "{test_db}"')
        conn.exec_driver_sql(f'CREATE DATABASE "{test_db}"')
    admin.dispose()

    engine = create_engine(base.set(database=test_db))
    with engine.connect() as conn:
        conn.exec_driver_sql("CREATE EXTENSION IF NOT EXISTS citext")
        conn.exec_driver_sql("CREATE EXTENSION IF NOT EXISTS vector")
        conn.commit()
    _Base.metadata.create_all(engine)
    yield engine
    engine.dispose()

    admin = create_engine(base.set(database="postgres"), isolation_level="AUTOCOMMIT")
    with admin.connect() as conn:
        conn.exec_driver_sql(f'DROP DATABASE IF EXISTS "{test_db}"')
    admin.dispose()


@pytest.fixture()
def db(pg_engine):
    session = _Session(pg_engine)
    yield session
    session.rollback()
    names = ", ".join(f'"{t.name}"' for t in _Base.metadata.sorted_tables)
    session.execute(_sa_text(f"TRUNCATE {names} RESTART IDENTITY CASCADE"))
    session.commit()
    session.close()


# ── Mock DB session ──────────────────────────────────────────────────────────


@contextmanager
def _mock_session_context(session):
    yield session


@pytest.fixture()
def mock_db_session():
    """A MagicMock that mimics a SQLAlchemy session inside get_session()."""
    session = MagicMock()
    return session


@pytest.fixture()
def mock_get_session(mock_db_session):
    """Returns a callable that yields mock_db_session (drop-in for get_session)."""
    return lambda: _mock_session_context(mock_db_session)


# ── Mock domain objects ──────────────────────────────────────────────────────


@pytest.fixture()
def mock_client():
    """A SimpleNamespace representing a Client row."""
    return SimpleNamespace(
        id=1,
        name="Test Company",
        email="test@example.com",
        company_name="Test Company",
        website="https://example.com",
        api_key="test-api-key-123",
        hashed_password="$2b$12$hashedpassword",
        is_superadmin=False,
        max_bots=5,
        system_prompt=None,
    )


@pytest.fixture()
def mock_bot():
    """A SimpleNamespace representing a Bot row."""
    return SimpleNamespace(
        id=1,
        client_id=1,
        bot_key="bot-test123abc",
        name="Test Bot",
        website="https://example.com",
        system_prompt="You are a helpful assistant.",
        is_active=True,
        bant_enabled=False,
        bant_config=None,
        primary_color="#4F46E5",
        background_color="#FFFFFF",
        header_color="#4F46E5",
        welcome_title="Hi there!",
        welcome_subtitle="How can I help?",
        bot_logo=None,
        launcher_logo=None,
        launcher_name=None,
        brand_tone=None,
        company_name=None,
        company_description=None,
        feature_flags={},
        widget_messages={},
        widget_config={},
        live_chat_enabled=False,
        lead_form_enabled=False,
        notification_email=None,
        notification_emails=None,
        calendly_url=None,
        meeting_booking_enabled=False,
        created_at=None,
    )


@pytest.fixture()
def mock_chat_session():
    """A SimpleNamespace representing a ChatSession row ."""
    return SimpleNamespace(
        id="session-abc-123",
        bot_id=1,
        client_id=1,
        location=None,
        device=None,
        bant_need=None,
        bant_timeline=None,
        bant_authority=None,
        bant_budget=None,
        bant_need_score=0,
        bant_timeline_score=0,
        bant_authority_score=0,
        bant_budget_score=0,
        bant_score=0,
        bant_tier=None,
        dimension_scores=None,
        dimensions_assessed=0,
        bant_last_updated=None,
        behavioral_score=0,
        page_url=None,
        referrer=None,
        utm_params=None,
        visit_count=0,
        status="bot",
    )


# ── FastAPI test client helpers ──────────────────────────────────────────────


class _ScalarResult:
    def __init__(self, value):
        self._value = value

    def first(self):
        return self._value


class _ExecuteResult:
    def __init__(self, value):
        self._value = value

    def scalars(self):
        return _ScalarResult(self._value)


@pytest.fixture()
def scalar_result():
    """Factory for wrapping a value in execute().scalars().first() chain."""
    return _ExecuteResult


@pytest.fixture()
def test_app():
    """A bare FastAPI app with common dependency overrides pre-wired."""
    app = FastAPI()
    return app


@pytest.fixture()
def auth_override_client(mock_client):
    """Returns a dependency override dict for client auth."""
    return {get_current_client: lambda: mock_client}


@pytest.fixture()
def auth_override_client_or_operator(mock_client):
    """Returns a dependency override dict for client_or_operator auth."""
    return {
        get_current_client_or_operator: lambda: {
            "type": "client",
            "entity": mock_client,
            "client_id": mock_client.id,
            "operator_id": None,
        }
    }


@pytest.fixture()
def auth_override_bot(mock_bot):
    """Returns a dependency override dict for bot auth."""
    return {get_current_bot: lambda: mock_bot}
