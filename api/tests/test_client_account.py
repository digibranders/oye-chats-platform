"""Tests for the client account endpoints in app.api.client_routes.

These cover the new ``get_current_client``-gated endpoints:
- ``PATCH /client/profile``
- ``POST /client/change-password``
- ``GET /client/api-key`` + ``POST /client/api-key/regenerate``

The suite does not use real auth headers: it wires ``auth_override_client``
into ``dependency_overrides`` and monkeypatches ``client_routes.get_session``
to yield a lightweight fake session driven by the ``mock_client`` fixture.
"""

from contextlib import contextmanager

from fastapi.testclient import TestClient

from app.api.client_routes import router
from app.core.security import get_password_hash, verify_password


@contextmanager
def _session_ctx(session):
    yield session


class _FakeSession:
    """Minimal SQLAlchemy-session stand-in for the account endpoints.

    Supports ``get(Client, id)``, ``execute(select(...)).scalars().first()``,
    ``commit()`` and ``refresh()``. The duplicate-email lookup is driven by
    ``existing_email`` so tests can simulate a taken address.
    """

    def __init__(self, row, existing_email=None):
        self._row = row
        self._existing_email = existing_email

    def get(self, _model, _pk):
        return self._row

    def execute(self, _statement):
        match = self._existing_email is not None and self._existing_email != getattr(self._row, "email", None)
        return _ExecuteResult(object() if match else None)

    def commit(self):
        pass

    def refresh(self, _row):
        pass


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


def _build_client(monkeypatch, session, auth_override_client):
    """Return a TestClient wired with client auth + a fake session."""
    from fastapi import FastAPI

    from app.api import client_routes

    monkeypatch.setattr(client_routes, "get_session", lambda: _session_ctx(session))

    api = FastAPI()
    api.include_router(router)
    api.dependency_overrides.update(auth_override_client)
    return TestClient(api)


# ── PATCH /client/profile ─────────────────────────────────────────────────────


class TestUpdateProfile:
    def test_update_changes_name_and_email(self, monkeypatch, mock_client, auth_override_client):
        mock_client.name = "Old"
        mock_client.email = "old@example.com"
        session = _FakeSession(mock_client)
        tc = _build_client(monkeypatch, session, auth_override_client)

        res = tc.patch("/client/profile", json={"name": "New", "email": "new@example.com"})

        assert res.status_code == 200
        body = res.json()
        assert body["name"] == "New"
        assert body["email"] == "new@example.com"

    def test_rejects_duplicate_email(self, monkeypatch, mock_client, auth_override_client):
        mock_client.email = "me@example.com"
        session = _FakeSession(mock_client, existing_email="taken@example.com")
        tc = _build_client(monkeypatch, session, auth_override_client)

        res = tc.patch("/client/profile", json={"email": "taken@example.com"})

        assert res.status_code == 400
        assert "already exists" in res.json()["detail"]

    def test_empty_name_is_unprocessable(self, monkeypatch, mock_client, auth_override_client):
        session = _FakeSession(mock_client)
        tc = _build_client(monkeypatch, session, auth_override_client)

        res = tc.patch("/client/profile", json={"name": "   "})

        assert res.status_code == 422


# ── POST /client/change-password ──────────────────────────────────────────────


class TestChangePassword:
    def test_success(self, monkeypatch, mock_client, auth_override_client):
        mock_client.hashed_password = get_password_hash("OldPass1")
        session = _FakeSession(mock_client)
        tc = _build_client(monkeypatch, session, auth_override_client)

        res = tc.post(
            "/client/change-password",
            json={"current_password": "OldPass1", "new_password": "NewPass2"},
        )

        assert res.status_code == 200
        assert res.json()["ok"] is True
        assert verify_password("NewPass2", mock_client.hashed_password)

    def test_wrong_current_password(self, monkeypatch, mock_client, auth_override_client):
        mock_client.hashed_password = get_password_hash("OldPass1")
        session = _FakeSession(mock_client)
        tc = _build_client(monkeypatch, session, auth_override_client)

        res = tc.post(
            "/client/change-password",
            json={"current_password": "WRONG", "new_password": "NewPass2"},
        )

        assert res.status_code == 400

    def test_weak_new_password(self, monkeypatch, mock_client, auth_override_client):
        mock_client.hashed_password = get_password_hash("OldPass1")
        session = _FakeSession(mock_client)
        tc = _build_client(monkeypatch, session, auth_override_client)

        res = tc.post(
            "/client/change-password",
            json={"current_password": "OldPass1", "new_password": "short"},
        )

        assert res.status_code == 422


# ── GET /client/api-key + POST /client/api-key/regenerate ─────────────────────


class TestApiKey:
    def test_get_api_key_is_masked(self, monkeypatch, mock_client, auth_override_client):
        mock_client.api_key = "supersecretkey1234"
        session = _FakeSession(mock_client)
        tc = _build_client(monkeypatch, session, auth_override_client)

        res = tc.get("/client/api-key")

        assert res.status_code == 200
        masked = res.json()["api_key_masked"]
        assert masked.startswith("••")
        assert masked.endswith("1234")
        assert "supersecret" not in masked

    def test_regenerate_returns_full_once_and_changes(self, monkeypatch, mock_client, auth_override_client):
        mock_client.api_key = "supersecretkey1234"
        session = _FakeSession(mock_client)
        tc = _build_client(monkeypatch, session, auth_override_client)

        before = tc.get("/client/api-key").json()["api_key_masked"]
        res = tc.post("/client/api-key/regenerate")

        assert res.status_code == 200
        body = res.json()
        assert body["ok"] is True
        assert len(body["api_key"]) >= 16
        assert body["api_key_masked"] != before
        assert mock_client.api_key == body["api_key"]
