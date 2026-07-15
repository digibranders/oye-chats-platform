"""F1: POST /auth/onboarding/complete marks the account's onboarding done.

Called when the user finishes the Build Studio Go-live milestone. Real-Postgres
via the shared ``db`` fixture; skips without DB_URL.
"""

from __future__ import annotations

import os
from contextlib import contextmanager
from unittest.mock import patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.db.models import Client

pytestmark = pytest.mark.skipif(
    not os.getenv("DB_URL"),
    reason="onboarding-complete endpoint test needs a reachable Postgres at DB_URL",
)


@contextmanager
def _session_cm(session):
    yield session


def test_complete_onboarding_sets_flag(db):
    from app.api import auth, auth_routes

    client = Client(name="Grad", email="grad@example.com", api_key="grad-key", hashed_password="h")
    db.add(client)
    db.flush()
    db.commit()
    assert client.onboarding_complete is False

    app = FastAPI()
    app.include_router(auth_routes.router)
    app.dependency_overrides[auth.get_current_client_strict] = lambda: client
    api = TestClient(app, raise_server_exceptions=False)

    with patch.object(auth_routes, "get_session", lambda: _session_cm(db)):
        res = api.post("/auth/onboarding/complete")

    assert res.status_code == 200, res.text
    assert res.json()["onboarding_complete"] is True
    db.refresh(client)
    assert client.onboarding_complete is True
