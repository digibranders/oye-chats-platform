"""Tests for the client account endpoints in app.api.client_routes.

These cover the new ``get_current_client``-gated endpoints:
- ``PATCH /client/profile``
- ``POST /client/change-password``
- ``POST /client/change-email/request`` + ``/confirm`` + ``/cancel``
- ``GET /client/api-key`` + ``POST /client/api-key/regenerate``

The suite does not use real auth headers: it wires ``auth_override_client``
into ``dependency_overrides`` and monkeypatches ``client_routes.get_session``
to yield a lightweight fake session driven by the ``mock_client`` fixture.
"""

from contextlib import contextmanager
from datetime import UTC, datetime, timedelta

from fastapi.testclient import TestClient
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded

from app.api.client_routes import router
from app.core.rate_limit import limiter
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
    """Return a TestClient wired with client auth + a fake session.

    Also wires slowapi's limiter onto app.state so the rate-limited
    change-email endpoints resolve under TestClient the same way main.py
    wires it in production, and stubs the outbound emails so tests don't
    hit the network.
    """
    from fastapi import FastAPI

    from app.api import client_routes

    monkeypatch.setattr(client_routes, "get_session", lambda: _session_ctx(session))
    monkeypatch.setattr(client_routes, "send_email_change_otp", lambda *a, **k: None)
    monkeypatch.setattr(client_routes, "send_email_change_requested_notice", lambda *a, **k: None)

    api = FastAPI()
    api.state.limiter = limiter
    api.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
    api.include_router(router)
    api.dependency_overrides.update(auth_override_client)
    return TestClient(api)


# ── PATCH /client/profile ─────────────────────────────────────────────────────


class TestUpdateProfile:
    def test_update_changes_name(self, monkeypatch, mock_client, auth_override_client):
        mock_client.name = "Old"
        mock_client.email = "old@example.com"
        session = _FakeSession(mock_client)
        tc = _build_client(monkeypatch, session, auth_override_client)

        res = tc.patch("/client/profile", json={"name": "New"})

        assert res.status_code == 200
        body = res.json()
        assert body["name"] == "New"
        assert body["email"] == "old@example.com"

    def test_email_field_is_ignored(self, monkeypatch, mock_client, auth_override_client):
        """Email changes must go through /client/change-email/* — a bare PATCH
        can no longer move the login email even if the caller sends one."""
        mock_client.email = "old@example.com"
        session = _FakeSession(mock_client)
        tc = _build_client(monkeypatch, session, auth_override_client)

        res = tc.patch("/client/profile", json={"name": "New", "email": "new@example.com"})

        assert res.status_code == 200
        assert res.json()["email"] == "old@example.com"

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


# ── POST /client/change-email/request + /confirm + /cancel ────────────────────


class TestChangeEmailRequest:
    def test_starts_pending_change_and_sends_otp(self, monkeypatch, mock_client, auth_override_client):
        mock_client.hashed_password = get_password_hash("Correct1")
        mock_client.email = "old@example.com"
        mock_client.pending_email = None
        session = _FakeSession(mock_client)
        tc = _build_client(monkeypatch, session, auth_override_client)

        res = tc.post(
            "/client/change-email/request",
            json={"new_email": "new@example.com", "current_password": "Correct1"},
        )

        assert res.status_code == 200
        assert res.json()["pending_email"] == "new@example.com"
        assert mock_client.pending_email == "new@example.com"
        assert mock_client.email == "old@example.com"  # unchanged until confirmed
        assert mock_client.email_change_otp is not None

    def test_wrong_password_is_rejected(self, monkeypatch, mock_client, auth_override_client):
        mock_client.hashed_password = get_password_hash("Correct1")
        session = _FakeSession(mock_client)
        tc = _build_client(monkeypatch, session, auth_override_client)

        res = tc.post(
            "/client/change-email/request",
            json={"new_email": "new@example.com", "current_password": "WRONG"},
        )

        assert res.status_code == 400
        assert mock_client.pending_email is None

    def test_rejects_duplicate_email(self, monkeypatch, mock_client, auth_override_client):
        mock_client.hashed_password = get_password_hash("Correct1")
        mock_client.email = "me@example.com"
        session = _FakeSession(mock_client, existing_email="taken@example.com")
        tc = _build_client(monkeypatch, session, auth_override_client)

        res = tc.post(
            "/client/change-email/request",
            json={"new_email": "taken@example.com", "current_password": "Correct1"},
        )

        assert res.status_code == 400
        assert "already exists" in res.json()["detail"]

    def test_rejects_same_as_current_email(self, monkeypatch, mock_client, auth_override_client):
        mock_client.hashed_password = get_password_hash("Correct1")
        mock_client.email = "me@example.com"
        session = _FakeSession(mock_client)
        tc = _build_client(monkeypatch, session, auth_override_client)

        res = tc.post(
            "/client/change-email/request",
            json={"new_email": "me@example.com", "current_password": "Correct1"},
        )

        assert res.status_code == 400


class TestChangeEmailConfirm:
    def test_correct_otp_promotes_pending_email(self, monkeypatch, mock_client, auth_override_client):
        mock_client.email = "old@example.com"
        mock_client.pending_email = "new@example.com"
        mock_client.email_change_otp = "123456"
        mock_client.email_change_otp_expires_at = datetime.now(UTC) + timedelta(minutes=10)
        session = _FakeSession(mock_client)
        tc = _build_client(monkeypatch, session, auth_override_client)

        res = tc.post("/client/change-email/confirm", json={"otp": "123456"})

        assert res.status_code == 200
        body = res.json()
        assert body["email"] == "new@example.com"
        assert body["pending_email"] is None
        assert mock_client.email == "new@example.com"
        assert mock_client.pending_email is None
        assert mock_client.email_change_otp is None

    def test_wrong_otp_is_rejected_and_invalidated(self, monkeypatch, mock_client, auth_override_client):
        mock_client.email = "old@example.com"
        mock_client.pending_email = "new@example.com"
        mock_client.email_change_otp = "123456"
        mock_client.email_change_otp_expires_at = datetime.now(UTC) + timedelta(minutes=10)
        session = _FakeSession(mock_client)
        tc = _build_client(monkeypatch, session, auth_override_client)

        res = tc.post("/client/change-email/confirm", json={"otp": "000000"})

        assert res.status_code == 400
        assert mock_client.email == "old@example.com"
        assert mock_client.email_change_otp is None  # invalidated after wrong guess

    def test_expired_otp_is_rejected(self, monkeypatch, mock_client, auth_override_client):
        mock_client.email = "old@example.com"
        mock_client.pending_email = "new@example.com"
        mock_client.email_change_otp = "123456"
        mock_client.email_change_otp_expires_at = datetime.now(UTC) - timedelta(minutes=1)
        session = _FakeSession(mock_client)
        tc = _build_client(monkeypatch, session, auth_override_client)

        res = tc.post("/client/change-email/confirm", json={"otp": "123456"})

        assert res.status_code == 400
        assert "expired" in res.json()["detail"].lower()
        assert mock_client.email == "old@example.com"
        assert mock_client.pending_email is None

    def test_no_pending_change_is_rejected(self, monkeypatch, mock_client, auth_override_client):
        mock_client.pending_email = None
        mock_client.email_change_otp = None
        mock_client.email_change_otp_expires_at = None
        session = _FakeSession(mock_client)
        tc = _build_client(monkeypatch, session, auth_override_client)

        res = tc.post("/client/change-email/confirm", json={"otp": "123456"})

        assert res.status_code == 400


class TestChangeEmailCancel:
    def test_clears_pending_state(self, monkeypatch, mock_client, auth_override_client):
        mock_client.pending_email = "new@example.com"
        mock_client.email_change_otp = "123456"
        mock_client.email_change_otp_expires_at = datetime.now(UTC) + timedelta(minutes=10)
        session = _FakeSession(mock_client)
        tc = _build_client(monkeypatch, session, auth_override_client)

        res = tc.post("/client/change-email/cancel")

        assert res.status_code == 200
        assert res.json()["ok"] is True
        assert mock_client.pending_email is None
        assert mock_client.email_change_otp is None
        assert mock_client.email_change_otp_expires_at is None


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
