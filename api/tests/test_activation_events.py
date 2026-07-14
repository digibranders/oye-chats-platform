"""Activation event stream + super-admin funnel (onboarding instrumentation).

Task B3. Clients emit free-form activation milestones (``studio_opened``,
etc.) to ``POST /activation/events``; the super-admin funnel aggregates them by
``event_type`` and reports a "time to verified live widget" (TTVLW) statistic
over clients whose bots have gone live.

Real-Postgres route tests via the shared ``db`` fixture; mirrors
tests/test_onboarding_flag.py. Skips without DB_URL.
"""

from __future__ import annotations

import os
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.db.models import ActivationEvent, Bot, Client

pytestmark = pytest.mark.skipif(
    not os.getenv("DB_URL"),
    reason="activation-event tests need a reachable Postgres at DB_URL",
)


@contextmanager
def _session_cm(session):
    yield session


@contextmanager
def _patch(activation_routes_module, db):
    """Point the module-level get_session() at the test session."""
    from unittest.mock import patch

    with patch.object(activation_routes_module, "get_session", lambda: _session_cm(db)):
        yield True


def _make_client(db, *, email: str, api_key: str, is_superadmin: bool = False) -> Client:
    client = Client(
        name="Act User",
        email=email,
        api_key=api_key,
        hashed_password="h",
        is_superadmin=is_superadmin,
    )
    db.add(client)
    db.flush()
    db.commit()
    return client


def _app(db):
    from app.api import activation_routes

    app = FastAPI()
    app.include_router(activation_routes.router)
    return app, activation_routes


def test_post_event_persists_row_for_authed_client(db):
    from app.api import auth

    client = _make_client(db, email="act-post@example.com", api_key="act-post-key")
    app, mod = _app(db)
    app.dependency_overrides[auth.get_current_client] = lambda: client
    api = TestClient(app, raise_server_exceptions=False)

    with _patch(mod, db):
        res = api.post("/activation/events", json={"event_type": "studio_opened"})

    assert res.status_code == 201, res.text

    row = db.execute(select(ActivationEvent).where(ActivationEvent.client_id == client.id)).scalars().first()
    assert row is not None
    assert row.event_type == "studio_opened"
    assert row.bot_id is None
    assert row.event_data is None


def test_post_event_accepts_bot_id_and_event_data(db):
    from app.api import auth

    client = _make_client(db, email="act-full@example.com", api_key="act-full-key")
    bot = Bot(client_id=client.id, bot_key="bot-act-full", name="Act Bot", system_prompt="")
    db.add(bot)
    db.flush()
    db.commit()

    app, mod = _app(db)
    app.dependency_overrides[auth.get_current_client] = lambda: client
    api = TestClient(app, raise_server_exceptions=False)

    with _patch(mod, db):
        res = api.post(
            "/activation/events",
            json={
                "event_type": "first_doc_uploaded",
                "bot_id": bot.id,
                "event_data": {"source": "wizard", "count": 2},
            },
        )

    assert res.status_code == 201, res.text

    row = (
        db.execute(select(ActivationEvent).where(ActivationEvent.event_type == "first_doc_uploaded")).scalars().first()
    )
    assert row is not None
    assert row.bot_id == bot.id
    assert row.event_data == {"source": "wizard", "count": 2}


def test_post_event_rejects_empty_event_type(db):
    from app.api import auth

    client = _make_client(db, email="act-empty@example.com", api_key="act-empty-key")
    app, mod = _app(db)
    app.dependency_overrides[auth.get_current_client] = lambda: client
    api = TestClient(app, raise_server_exceptions=False)

    with _patch(mod, db):
        res = api.post("/activation/events", json={"event_type": "   "})

    assert res.status_code == 422, res.text


def test_funnel_forbidden_for_non_superadmin(db):
    from app.api import auth

    client = _make_client(db, email="act-nonsa@example.com", api_key="act-nonsa-key")
    app, mod = _app(db)
    # get_superadmin depends on get_current_client_strict then checks the flag.
    app.dependency_overrides[auth.get_current_client_strict] = lambda: client
    api = TestClient(app, raise_server_exceptions=False)

    with _patch(mod, db):
        res = api.get("/activation/funnel")

    assert res.status_code == 403, res.text


def test_funnel_returns_counts_and_ttvlw_for_superadmin(db):
    from app.api import auth

    sa = _make_client(db, email="act-sa@example.com", api_key="act-sa-key", is_superadmin=True)

    # Two activation events of one type, one of another.
    db.add_all(
        [
            ActivationEvent(client_id=sa.id, event_type="studio_opened"),
            ActivationEvent(client_id=sa.id, event_type="studio_opened"),
            ActivationEvent(client_id=sa.id, event_type="first_doc_uploaded"),
        ]
    )

    # A qualifying client: created_at set, one bot with widget_installed_at 100s later.
    base = datetime(2026, 7, 1, 12, 0, 0, tzinfo=UTC)
    live_client = Client(
        name="Live",
        email="act-live@example.com",
        api_key="act-live-key",
        hashed_password="h",
        created_at=base,
    )
    db.add(live_client)
    db.flush()
    live_bot = Bot(
        client_id=live_client.id,
        bot_key="bot-act-live",
        name="Live Bot",
        system_prompt="",
        widget_installed_at=base + timedelta(seconds=100),
    )
    db.add(live_bot)
    db.flush()
    db.commit()

    app, mod = _app(db)
    app.dependency_overrides[auth.get_current_client_strict] = lambda: sa
    api = TestClient(app, raise_server_exceptions=False)

    with _patch(mod, db):
        res = api.get("/activation/funnel")

    assert res.status_code == 200, res.text
    body = res.json()
    assert body["counts"]["studio_opened"] == 2
    assert body["counts"]["first_doc_uploaded"] == 1
    assert body["ttvlw"]["count"] == 1
    assert body["ttvlw"]["median_seconds"] == 100.0


def test_funnel_null_median_when_no_live_clients(db):
    from app.api import auth

    sa = _make_client(db, email="act-sa2@example.com", api_key="act-sa2-key", is_superadmin=True)

    app, mod = _app(db)
    app.dependency_overrides[auth.get_current_client_strict] = lambda: sa
    api = TestClient(app, raise_server_exceptions=False)

    with _patch(mod, db):
        res = api.get("/activation/funnel")

    assert res.status_code == 200, res.text
    body = res.json()
    assert body["ttvlw"]["count"] == 0
    assert body["ttvlw"]["median_seconds"] is None
