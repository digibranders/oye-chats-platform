"""Tests for app.api.auth_routes — authentication endpoints."""

from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import MagicMock

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.auth_routes import router


@contextmanager
def _session_ctx(session):
    yield session


def _build_app():
    app = FastAPI()
    app.include_router(router)
    return app


class _ScalarResult:
    def __init__(self, value):
        self._value = value

    def first(self):
        return self._value

    def all(self):
        return self._value if isinstance(self._value, list) else [self._value] if self._value else []


class _ExecuteResult:
    def __init__(self, value):
        self._value = value

    def scalars(self):
        return _ScalarResult(self._value)

    def scalar_one_or_none(self):
        return self._value


# ── Login ────────────────────────────────────────────────────────────────────


class TestLogin:
    def test_successful_login(self, monkeypatch):
        from app.api import auth_routes

        client_obj = SimpleNamespace(
            id=1,
            name="Test User",
            email="test@example.com",
            api_key="api-key-123",
            hashed_password="hashed",
            is_superadmin=False,
            company_name="Test Co",
            website="https://example.com",
        )
        session = MagicMock()
        session.execute.return_value = _ExecuteResult(client_obj)
        monkeypatch.setattr(auth_routes, "get_session", lambda: _session_ctx(session))
        monkeypatch.setattr(auth_routes, "verify_password", lambda plain, hashed: True)

        app = _build_app()
        tc = TestClient(app)
        response = tc.post("/auth/login", json={"email": "test@example.com", "password": "password123"})

        assert response.status_code == 200
        data = response.json()
        assert data["access_token"] == "api-key-123"
        assert data["client_id"] == 1

    def test_wrong_password(self, monkeypatch):
        from app.api import auth_routes

        client_obj = SimpleNamespace(
            id=1,
            name="User",
            email="test@example.com",
            hashed_password="hashed",
        )
        session = MagicMock()
        session.execute.return_value = _ExecuteResult(client_obj)
        monkeypatch.setattr(auth_routes, "get_session", lambda: _session_ctx(session))
        monkeypatch.setattr(auth_routes, "verify_password", lambda p, h: False)

        tc = TestClient(_build_app())
        response = tc.post("/auth/login", json={"email": "test@example.com", "password": "wrong"})

        assert response.status_code == 401

    def test_unknown_email(self, monkeypatch):
        from app.api import auth_routes

        session = MagicMock()
        session.execute.return_value = _ExecuteResult(None)
        monkeypatch.setattr(auth_routes, "get_session", lambda: _session_ctx(session))

        tc = TestClient(_build_app())
        response = tc.post("/auth/login", json={"email": "unknown@example.com", "password": "password123"})

        assert response.status_code == 401

    def test_case_insensitive_email(self, monkeypatch):
        from app.api import auth_routes

        client_obj = SimpleNamespace(
            id=1,
            name="User",
            email="test@example.com",
            api_key="key",
            hashed_password="h",
            is_superadmin=False,
            company_name="Co",
            website="",
        )
        session = MagicMock()
        session.execute.return_value = _ExecuteResult(client_obj)
        monkeypatch.setattr(auth_routes, "get_session", lambda: _session_ctx(session))
        monkeypatch.setattr(auth_routes, "verify_password", lambda p, h: True)

        tc = TestClient(_build_app())
        response = tc.post("/auth/login", json={"email": "TEST@Example.COM", "password": "password123"})

        assert response.status_code == 200


# ── Registration ─────────────────────────────────────────────────────────────


class TestRegister:
    def test_successful_registration(self, monkeypatch):
        from app.api import auth_routes

        session = MagicMock()
        session.execute.return_value = _ExecuteResult(None)  # no duplicate

        def mock_flush():
            # Simulate DB assigning an ID on flush
            for obj in added_objects:
                if not hasattr(obj, "id") or obj.id is None:
                    obj.id = 42

        added_objects = []
        session.add.side_effect = added_objects.append
        session.flush.side_effect = mock_flush
        session.refresh.side_effect = lambda obj: None
        monkeypatch.setattr(auth_routes, "get_session", lambda: _session_ctx(session))
        monkeypatch.setattr(auth_routes, "get_password_hash", lambda p: "hashed")

        tc = TestClient(_build_app())
        response = tc.post(
            "/auth/register",
            json={
                "name": "New User",
                "email": "new@example.com",
                "password": "password1",
                "company_name": "NewCo",
                "website": "https://newco.com",
            },
        )

        assert response.status_code == 200
        assert len(added_objects) == 1
        assert response.json()["client_id"] == 42

    def test_duplicate_email_rejected(self, monkeypatch):
        from app.api import auth_routes

        existing = SimpleNamespace(id=1, email="dup@example.com")
        session = MagicMock()
        session.execute.return_value = _ExecuteResult(existing)
        monkeypatch.setattr(auth_routes, "get_session", lambda: _session_ctx(session))

        tc = TestClient(_build_app())
        response = tc.post(
            "/auth/register",
            json={
                "name": "User",
                "email": "dup@example.com",
                "password": "password1",
                "company_name": "Co",
                "website": "",
            },
        )

        assert response.status_code == 409

    def test_weak_password_rejected(self):
        tc = TestClient(_build_app())
        response = tc.post(
            "/auth/register",
            json={"name": "User", "email": "a@b.com", "password": "short", "company_name": "Co", "website": ""},
        )

        assert response.status_code == 422

    def test_invalid_email_rejected(self):
        tc = TestClient(_build_app())
        response = tc.post(
            "/auth/register",
            json={
                "name": "User",
                "email": "not-an-email",
                "password": "password1",
                "company_name": "Co",
                "website": "",
            },
        )

        assert response.status_code == 422

    def test_password_needs_letter_and_number(self):
        tc = TestClient(_build_app())
        # Only letters
        response = tc.post(
            "/auth/register",
            json={"name": "User", "email": "a@b.com", "password": "allletters", "company_name": "Co", "website": ""},
        )
        assert response.status_code == 422


# ── Password Reset ───────────────────────────────────────────────────────────


class TestPasswordReset:
    def test_request_reset_always_200(self, monkeypatch):
        """Must not reveal whether email exists (timing attack prevention)."""
        from app.api import auth_routes

        session = MagicMock()
        session.execute.return_value = _ExecuteResult(None)
        monkeypatch.setattr(auth_routes, "get_session", lambda: _session_ctx(session))

        tc = TestClient(_build_app())
        response = tc.post("/auth/request-password-reset", json={"email": "nobody@example.com"})

        assert response.status_code == 200

    def test_request_reset_sends_email(self, monkeypatch):
        from app.api import auth_routes

        client_obj = SimpleNamespace(
            id=1,
            email="test@example.com",
            reset_otp=None,
            reset_otp_expires_at=None,
        )
        session = MagicMock()
        session.execute.return_value = _ExecuteResult(client_obj)
        monkeypatch.setattr(auth_routes, "get_session", lambda: _session_ctx(session))
        mock_send = MagicMock()
        monkeypatch.setattr(auth_routes, "send_password_reset_email", mock_send)

        tc = TestClient(_build_app())
        tc.post("/auth/request-password-reset", json={"email": "test@example.com"})

        mock_send.assert_called_once()
        # OTP should be set on the client object
        assert client_obj.reset_otp is not None

    def test_reset_with_valid_otp(self, monkeypatch):
        from datetime import UTC, datetime, timedelta

        from app.api import auth_routes

        client_obj = SimpleNamespace(
            id=1,
            email="test@example.com",
            reset_otp="123456",
            reset_otp_expires_at=datetime.now(UTC) + timedelta(minutes=10),
            hashed_password="old_hash",
        )
        session = MagicMock()
        session.execute.return_value = _ExecuteResult(client_obj)
        monkeypatch.setattr(auth_routes, "get_session", lambda: _session_ctx(session))
        monkeypatch.setattr(auth_routes, "get_password_hash", lambda p: "new_hash")

        tc = TestClient(_build_app())
        response = tc.post(
            "/auth/reset-password",
            json={"email": "test@example.com", "otp": "123456", "new_password": "newpass1"},
        )

        assert response.status_code == 200
        assert client_obj.hashed_password == "new_hash"
        assert client_obj.reset_otp is None

    def test_reset_with_wrong_otp(self, monkeypatch):
        from datetime import UTC, datetime, timedelta

        from app.api import auth_routes

        client_obj = SimpleNamespace(
            id=1,
            email="test@example.com",
            reset_otp="123456",
            reset_otp_expires_at=datetime.now(UTC) + timedelta(minutes=10),
            hashed_password="old",
        )
        session = MagicMock()
        session.execute.return_value = _ExecuteResult(client_obj)
        monkeypatch.setattr(auth_routes, "get_session", lambda: _session_ctx(session))

        tc = TestClient(_build_app())
        response = tc.post(
            "/auth/reset-password",
            json={"email": "test@example.com", "otp": "999999", "new_password": "newpass1"},
        )

        assert response.status_code == 400
        # OTP should be invalidated after wrong attempt (brute force prevention)
        assert client_obj.reset_otp is None

    def test_reset_with_expired_otp(self, monkeypatch):
        from datetime import UTC, datetime, timedelta

        from app.api import auth_routes

        client_obj = SimpleNamespace(
            id=1,
            email="test@example.com",
            reset_otp="123456",
            reset_otp_expires_at=datetime.now(UTC) - timedelta(minutes=1),
            hashed_password="old",
        )
        session = MagicMock()
        session.execute.return_value = _ExecuteResult(client_obj)
        monkeypatch.setattr(auth_routes, "get_session", lambda: _session_ctx(session))

        tc = TestClient(_build_app())
        response = tc.post(
            "/auth/reset-password",
            json={"email": "test@example.com", "otp": "123456", "new_password": "newpass1"},
        )

        assert response.status_code == 400

    def test_reset_without_otp_set(self, monkeypatch):
        from app.api import auth_routes

        client_obj = SimpleNamespace(
            id=1,
            email="test@example.com",
            reset_otp=None,
            reset_otp_expires_at=None,
        )
        session = MagicMock()
        session.execute.return_value = _ExecuteResult(client_obj)
        monkeypatch.setattr(auth_routes, "get_session", lambda: _session_ctx(session))

        tc = TestClient(_build_app())
        response = tc.post(
            "/auth/reset-password",
            json={"email": "test@example.com", "otp": "123456", "new_password": "newpass1"},
        )

        assert response.status_code == 400


# ── Workspace Selection Helpers ──────────────────────────────────────────────


class TestWorkspaceSelection:
    def test_choose_best_candidate_by_bot_count(self):
        from app.api.auth_routes import _choose_best_operator_candidate

        op1 = SimpleNamespace(id=1, client_id=10, created_at=None)
        op2 = SimpleNamespace(id=2, client_id=20, created_at=None)

        stats = {
            10: {"bot_count": 1, "operator_count": 0, "website_bot_count": 0, "document_count": 0, "session_count": 0},
            20: {"bot_count": 5, "operator_count": 0, "website_bot_count": 0, "document_count": 0, "session_count": 0},
        }

        result = _choose_best_operator_candidate([op1, op2], workspace_stats=stats)
        assert result.client_id == 20

    def test_choose_best_candidate_by_sessions(self):
        from app.api.auth_routes import _choose_best_operator_candidate

        op1 = SimpleNamespace(id=1, client_id=10, created_at=None)
        op2 = SimpleNamespace(id=2, client_id=20, created_at=None)

        stats = {
            10: {
                "bot_count": 1,
                "operator_count": 1,
                "website_bot_count": 1,
                "document_count": 0,
                "session_count": 100,
            },
            20: {"bot_count": 1, "operator_count": 1, "website_bot_count": 1, "document_count": 0, "session_count": 0},
        }

        result = _choose_best_operator_candidate([op1, op2], workspace_stats=stats)
        assert result.client_id == 10

    def test_choose_default_bot_prefers_active(self):
        from app.api.auth_routes import _choose_default_workspace_bot

        bot1 = SimpleNamespace(id=1, website=None, created_at=None)
        bot2 = SimpleNamespace(id=2, website="https://example.com", created_at=None)

        activity = {
            1: {"session_count": 0, "document_count": 0},
            2: {"session_count": 10, "document_count": 5},
        }

        result = _choose_default_workspace_bot([bot1, bot2], bot_activity=activity)
        assert result.id == 2
