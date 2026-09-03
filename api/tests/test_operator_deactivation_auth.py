"""Deactivating an operator must revoke every credential path, not just one.

``PATCH /operators/{id} {"is_active": false}`` is how a workspace removes a
teammate. Two doors were still open to a deactivated operator:

* ``get_current_client`` resolves ``X-Operator-Key`` to the workspace owner's
  ``Client`` so operators can read client-scoped resources. It checked neither
  ``is_active`` nor anything else, while its siblings (``get_current_operator``,
  ``get_current_client_or_operator``) both refuse an inactive operator.
* ``POST /auth/operator-login`` matched on email + password only, so a
  deactivated operator could sign in and be handed their ``operator_api_key``.

Both are pinned here. The login test also covers the owning workspace being
suspended: the key resolvers refuse a suspended workspace's operators on every
request, so the login must not mint a credential those requests will reject.
"""

from __future__ import annotations

import os
from contextlib import contextmanager
from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from app.api import auth, auth_routes
from app.core.security import get_password_hash
from app.db.models import Bot, Client, Operator

# ── get_current_client: X-Operator-Key fallback ─────────────────────────────


class _ExecuteResult:
    def __init__(self, value):
        self._value = value

    def scalars(self):
        return self

    def first(self):
        return self._value


@contextmanager
def _session_ctx(session):
    yield session


def _request() -> MagicMock:
    request = MagicMock()
    request.headers = {}
    return request


def _operator(*, is_active: bool) -> SimpleNamespace:
    return SimpleNamespace(id=9, client_id=1, operator_api_key="op-key", role="operator", is_active=is_active)


def _owner() -> SimpleNamespace:
    return SimpleNamespace(
        id=1,
        name="Acme",
        email="acme@example.com",
        api_key="client-key-123",
        is_superadmin=False,
        suspended_at=None,
        deactivated_at=None,
    )


class TestGetCurrentClientOperatorFallback:
    def test_deactivated_operator_key_is_rejected(self, monkeypatch):
        session = MagicMock()
        # First execute() → operator lookup. The owner lookup must never run.
        session.execute.side_effect = [_ExecuteResult(_operator(is_active=False))]
        monkeypatch.setattr(auth, "get_session", lambda: _session_ctx(session))

        with pytest.raises(HTTPException) as exc:
            auth.get_current_client(
                _request(), api_key=None, operator_key="op-key", legacy_agent_key=None, impersonation_token=None
            )

        assert exc.value.status_code == 401
        assert "deactivated" in exc.value.detail
        assert session.execute.call_count == 1

    def test_active_operator_key_still_resolves_the_workspace(self, monkeypatch):
        session = MagicMock()
        session.execute.side_effect = [_ExecuteResult(_operator(is_active=True)), _ExecuteResult(_owner())]
        monkeypatch.setattr(auth, "get_session", lambda: _session_ctx(session))

        client = auth.get_current_client(
            _request(), api_key=None, operator_key="op-key", legacy_agent_key=None, impersonation_token=None
        )

        assert client.id == 1


# ── POST /auth/operator-login ────────────────────────────────────────────────

pytestmark_db = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")


def _login_app() -> TestClient:
    app = FastAPI()
    app.include_router(auth_routes.router)
    return TestClient(app)


def _seed_operator(db, *, email: str, is_active: bool, workspace_suspended: bool = False) -> Operator:
    owner = Client(
        name="Acme",
        email=f"owner-{email}",
        api_key=f"key-{email}",
        hashed_password="h",
        suspended_at=datetime.now(UTC) if workspace_suspended else None,
    )
    db.add(owner)
    db.flush()
    bot = Bot(client_id=owner.id, name="Bot", bot_key=f"bot-{email}")
    db.add(bot)
    db.flush()
    operator = Operator(
        client_id=owner.id,
        bot_id=bot.id,
        name="Op",
        email=email,
        hashed_password=get_password_hash("correct-horse"),
        role="operator",
        is_active=is_active,
        operator_api_key=f"opkey-{email}",
    )
    db.add(operator)
    db.commit()
    return operator


def _post_login(tc: TestClient, email: str):
    return tc.post("/auth/operator-login", json={"email": email, "password": "correct-horse"})


@pytestmark_db
class TestOperatorLogin:
    @pytest.fixture(autouse=True)
    def _wire(self, db, monkeypatch):
        monkeypatch.setattr(auth_routes, "get_session", lambda: _session_ctx(db))
        monkeypatch.setattr(auth_routes, "login_attempts_exhausted", lambda key: False)
        monkeypatch.setattr(auth_routes, "note_failed_login", lambda key: None)
        monkeypatch.setattr(auth_routes, "clear_failed_logins", lambda key: None)

    def test_deactivated_operator_cannot_sign_in(self, db):
        _seed_operator(db, email="fired@example.com", is_active=False)

        response = _post_login(_login_app(), "fired@example.com")

        assert response.status_code == 401

    def test_active_operator_signs_in(self, db):
        operator = _seed_operator(db, email="active@example.com", is_active=True)

        response = _post_login(_login_app(), "active@example.com")

        assert response.status_code == 200
        assert response.json()["access_token"] == operator.operator_api_key

    def test_operator_of_a_suspended_workspace_cannot_sign_in(self, db):
        _seed_operator(db, email="suspended-ws@example.com", is_active=True, workspace_suspended=True)

        response = _post_login(_login_app(), "suspended-ws@example.com")

        assert response.status_code == 403
        assert response.json()["detail"] == "account_suspended"
