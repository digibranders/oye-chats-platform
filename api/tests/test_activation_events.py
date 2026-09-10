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
