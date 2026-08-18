"""Onboarding-state flags on the Client account + /auth/me exposure.

A freshly registered (email/password) client starts life un-verified and with
onboarding not yet complete. The admin dashboard reads both flags off
``GET /auth/me`` to decide whether to route the user into the verify-email
step and the first-run onboarding wizard, so the endpoint must surface them.

Real-Postgres route tests via the shared ``db`` fixture; mirrors
tests/test_checkout_country_gate.py. Skips without DB_URL.
"""

from __future__ import annotations

import os
from contextlib import contextmanager

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.db.models import Client

pytestmark = pytest.mark.skipif(
    not os.getenv("DB_URL"),
    reason="onboarding-flag tests need a reachable Postgres at DB_URL",
)


@contextmanager
def _session_cm(session):
    yield session


def _register(db, *, email: str) -> TestClient:
    """Drive the real /auth/register endpoint against the throwaway DB."""
    from app.api import auth_routes

    app = FastAPI()
    app.include_router(auth_routes.router)
    api = TestClient(app, raise_server_exceptions=False)

    res = api.post(
        "/auth/register",
        json={
            "name": "Fresh User",
            "email": email,
            "password": "password1",
            "company_name": "FreshCo",
            "website": "https://freshco.example.com",
        },
    )
    assert res.status_code == 200, res.text
    return api


def test_registered_client_starts_unverified_and_onboarding_incomplete(db):
    from unittest.mock import patch

    from app.api import auth_routes

    email = "onboarding-fresh@example.com"
    # Force the dev-only auto-verify flag OFF so this asserts the real
    # (production) path: a fresh signup requires email verification. Registration
    # stamps ``is_verified = DEV_AUTO_VERIFY_EMAIL`` (auth_routes.register), which
    # is truthy on local machines whose .env sets ``DEV_AUTO_VERIFY_EMAIL=true``,
    # without this pin the assertion below is non-deterministic across dev envs.
    # The route imports the flag from ``app.config`` at call time, so patching the
    # module attribute is what the handler actually reads.
    with patch("app.config.DEV_AUTO_VERIFY_EMAIL", False), _patch(auth_routes, db):
        _register(db, email=email)

    client = db.execute(_select_client(email)).scalars().first()
    assert client is not None
    # Both default to False at the DB layer (server_default="false"); a brand
    # new account has neither verified its email nor finished onboarding.
    assert client.is_verified is False
    assert client.onboarding_complete is False


def test_auth_me_exposes_verification_and_onboarding_flags(db):
    from app.api import auth, auth_routes

    client = Client(
        name="Me User",
        email="onboarding-me@example.com",
        api_key="onboarding-me-key",
        hashed_password="h",
    )
    db.add(client)
    db.flush()
    db.commit()

    app = FastAPI()
    app.include_router(auth_routes.router)
    app.dependency_overrides[auth.get_current_client_or_operator] = lambda: {
        "type": "client",
        "entity": client,
        "client_id": client.id,
        "operator_id": None,
    }
    api = TestClient(app, raise_server_exceptions=False)

    with _patch(auth_routes, db):
        res = api.get("/auth/me")

    assert res.status_code == 200, res.text
    body = res.json()
    assert body["is_verified"] is False
    assert body["onboarding_complete"] is False


def test_auth_me_operator_mirrors_owner_client_flags(db):
    """The operator /auth/me branch has no flags of its own, it must resolve
    ``is_verified`` / ``onboarding_complete`` from the owning client (the
    workspace they belong to), not fall back to the ``False`` defaults."""
    from app.api import auth, auth_routes
    from app.db.models import Bot, Operator

    owner = Client(
        name="Owner",
        email="onboarding-owner@example.com",
        api_key="onboarding-owner-key",
        hashed_password="h",
        is_verified=True,
        onboarding_complete=True,
    )
    db.add(owner)
    db.flush()

    bot = Bot(client_id=owner.id, bot_key="bot-onboarding", name="Owner Bot", system_prompt="")
    db.add(bot)
    db.flush()

    operator = Operator(
        client_id=owner.id,
        bot_id=bot.id,
        name="Op User",
        email="onboarding-op@example.com",
        role="operator",
    )
    db.add(operator)
    db.flush()
    db.commit()

    app = FastAPI()
    app.include_router(auth_routes.router)
    app.dependency_overrides[auth.get_current_client_or_operator] = lambda: {
        "type": "operator",
        "entity": operator,
        "client_id": owner.id,
        "operator_id": operator.id,
    }
    api = TestClient(app, raise_server_exceptions=False)

    with _patch(auth_routes, db):
        res = api.get("/auth/me")

    assert res.status_code == 200, res.text
    body = res.json()
    assert body["kind"] == "operator"
    # Mirrors the owner client's values (True/True). Proving the branch
    # resolves from the owner rather than emitting the column defaults.
    assert body["is_verified"] is True
    assert body["onboarding_complete"] is True


# ── local helpers ──


def _select_client(email: str):
    from sqlalchemy import select

    return select(Client).where(Client.email == email)


@contextmanager
def _patch(auth_routes_module, db):
    """Point the module-level get_session() at the test session."""
    from unittest.mock import patch

    with patch.object(auth_routes_module, "get_session", lambda: _session_cm(db)):
        yield True
