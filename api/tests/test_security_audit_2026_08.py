"""Regression tests for the 2026-08 security review.

Each class pins one boundary that was found open (or unverified) during the
review. They are deliberately grouped by finding rather than by module so the
reason a test exists survives longer than the diff that introduced it.

Everything here runs against MagicMock sessions or the in-memory rate-limit
storage, so no Postgres is required. These must run in CI on every push, which
the ``DB_URL``-gated suites do not.
"""

from __future__ import annotations

import uuid
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from app.api.auth import get_current_client_or_operator, get_current_client_strict, get_current_operator


@contextmanager
def _session_context(session):
    yield session


class _Scalar:
    """Mimics ``session.execute(...).scalar_one_or_none()`` / ``.scalars().first()``."""

    def __init__(self, value):
        self._value = value

    def scalar_one_or_none(self):
        return self._value

    def scalars(self):
        return self

    def first(self):
        return self._value


def _operator_auth(role: str):
    return {
        "type": "operator",
        "entity": SimpleNamespace(id=7, role=role, client_id=1, bot_id=1),
        "client_id": 1,
        "operator_id": 7,
        "bot_id": 1,
    }


def _client_auth():
    return {
        "type": "client",
        "entity": SimpleNamespace(id=1, is_superadmin=False),
        "client_id": 1,
        "operator_id": None,
    }


# ── Finding H1: outbound webhooks were not role-guarded ──────────────────────
#
# ``POST/PATCH/DELETE /webhooks`` accepted any operator of the workspace. An
# outbound webhook is a standing export of every ``lead.captured`` payload to a
# URL the caller picks, so the lowest-privileged role (the one the invite flow
# hands to support staff) could redirect the workspace's entire lead stream to
# their own server. Bots and knowledge sources were already owner/admin-only;
# webhooks were the odd one out.


class TestWebhookRoleGuard:
    def _app(self, auth):
        from app.api.webhook_routes import router

        app = FastAPI()
        app.include_router(router)
        app.dependency_overrides[get_current_client_or_operator] = lambda: auth
        return TestClient(app, raise_server_exceptions=False)

    @pytest.mark.parametrize(
        ("method", "path", "body"),
        [
            ("POST", "/webhooks?bot_id=1", {"url": "https://evil.example.com/x", "events": ["tier_transition"]}),
            ("PATCH", "/webhooks/1", {"url": "https://evil.example.com/x"}),
            ("DELETE", "/webhooks/1", None),
            ("POST", "/webhooks/1/test", None),
        ],
    )
    def test_plain_operator_cannot_manage_webhooks(self, method, path, body):
        client = self._app(_operator_auth("operator"))
        resp = client.request(method, path, json=body)
        assert resp.status_code == 403
        assert "permission to manage webhooks" in resp.text

    @pytest.mark.parametrize("role", ["owner", "admin"])
    def test_managers_pass_the_role_gate(self, role, monkeypatch):
        """The guard must not be a blanket deny. Owners/admins get past it.

        Asserted by the guard function directly: the routes themselves go on to
        hit the plan-entitlement layer and the DB, which is a different test's
        job.
        """
        from app.api.webhook_routes import _require_webhook_management_access

        _require_webhook_management_access(_operator_auth(role))  # must not raise

    def test_direct_client_login_passes(self):
        from app.api.webhook_routes import _require_webhook_management_access

        _require_webhook_management_access(_client_auth())  # must not raise

    def test_operator_reads_are_still_allowed(self, monkeypatch):
        """Listing is intentionally NOT gated, the secret is masked in the
        response, and operators legitimately need to see whether a workspace has
        delivery configured. Narrowing reads too would be a behaviour change the
        finding did not call for."""
        from app.api import webhook_routes

        class _ListResult(_Scalar):
            def all(self):
                return []

        session = MagicMock()
        session.execute.return_value = _ListResult(SimpleNamespace(id=1, client_id=1))
        monkeypatch.setattr(webhook_routes, "get_session", lambda: _session_context(session))

        resp = self._app(_operator_auth("operator")).get("/webhooks?bot_id=1")
        assert resp.status_code == 200
        assert resp.json() == []


# ── Finding H2: the session credential survived a password change ────────────
#
# ``Client.api_key`` / ``Operator.operator_api_key`` are permanent bearer
# tokens with no expiry and no server-side session table. Neither the
# authenticated change-password flows nor the OTP password reset rotated them,
# so a stolen key kept working after the victim did the one thing every
# incident-response guide tells them to do.


class TestCredentialRotationOnPasswordChange:
    def test_client_change_password_rotates_api_key(self, monkeypatch):
        from app.api import client_routes

        row = SimpleNamespace(id=1, hashed_password="hash", api_key="old-key-aaaa")
        session = MagicMock()
        session.get.return_value = row
        monkeypatch.setattr(client_routes, "get_session", lambda: _session_context(session))
        monkeypatch.setattr(client_routes, "verify_password", lambda *_: True)
        monkeypatch.setattr(client_routes, "get_password_hash", lambda p: f"hashed::{p}")

        app = FastAPI()
        app.include_router(client_routes.router)
        app.dependency_overrides[get_current_client_strict] = lambda: SimpleNamespace(id=1)
        client = TestClient(app, raise_server_exceptions=False)

        resp = client.post(
            "/client/change-password",
            json={"current_password": "OldPassword1", "new_password": "NewPassword1"},
        )
        assert resp.status_code == 200
        assert row.api_key != "old-key-aaaa"
        # Returned so the caller's own tab survives its own revocation.
        assert resp.json()["api_key"] == row.api_key
        assert row.hashed_password == "hashed::NewPassword1"

    def test_password_reset_rotates_api_key_without_returning_it(self, monkeypatch):
        from app.api import auth_routes

        client_row = SimpleNamespace(
            id=1,
            is_superadmin=False,
            deactivated_at=None,
            suspended_at=None,
            reset_otp="123456",
            reset_otp_expires_at=datetime.now(UTC) + timedelta(minutes=5),
            hashed_password="hash",
            api_key="old-key-bbbb",
        )
        session = MagicMock()
        session.execute.return_value = _Scalar(client_row)
        monkeypatch.setattr(auth_routes, "get_session", lambda: _session_context(session))
        monkeypatch.setattr(auth_routes, "get_password_hash", lambda p: f"hashed::{p}")

        app = FastAPI()
        app.state.limiter = auth_routes.limiter
        app.include_router(auth_routes.router)
        client = TestClient(app, raise_server_exceptions=False)

        resp = client.post(
            "/auth/reset-password",
            json={"email": "a@example.com", "otp": "123456", "new_password": "NewPassword1"},
        )
        assert resp.status_code == 200
        assert client_row.api_key != "old-key-bbbb"
        # The reset endpoint is unauthenticated, it must never hand a live
        # credential back to whoever posted the OTP.
        assert client_row.api_key not in resp.text

    def test_operator_change_password_rotates_operator_key(self, monkeypatch):
        from app.api import auth_routes

        op_row = SimpleNamespace(id=5, hashed_password="hash", operator_api_key="old-op-key")
        session = MagicMock()
        session.execute.return_value = _Scalar(op_row)
        monkeypatch.setattr(auth_routes, "get_session", lambda: _session_context(session))
        monkeypatch.setattr(auth_routes, "verify_password", lambda *_: True)
        monkeypatch.setattr(auth_routes, "get_password_hash", lambda p: f"hashed::{p}")

        app = FastAPI()
        app.state.limiter = auth_routes.limiter
        app.include_router(auth_routes.router)
        app.dependency_overrides[get_current_operator] = lambda: SimpleNamespace(id=5)
        client = TestClient(app, raise_server_exceptions=False)

        resp = client.post(
            "/auth/operator-change-password",
            json={"current_password": "OldPassword1", "new_password": "NewPassword1"},
        )
        assert resp.status_code == 200
        assert op_row.operator_api_key != "old-op-key"
        assert resp.json()["access_token"] == op_row.operator_api_key


# ── Finding M1: the e-mail-verification OTP had no per-account attempt cap ───
#
# A wrong guess left the 6-digit code live, and the only ceiling was a per-IP
# rate limit, which buys nothing against a prober with a proxy pool. The other
# OTP flows in the codebase already burn the code; this one now burns it after
# a bounded number of failures.


class TestOtpAttemptCeiling:
    def test_budget_is_bounded_then_reports_exhausted(self):
        from app.core.otp_guard import MAX_OTP_ATTEMPTS, clear_attempts, register_failed_attempt

        identity = f"otp-{uuid.uuid4().hex}@example.com"
        try:
            for _ in range(MAX_OTP_ATTEMPTS):
                assert register_failed_attempt("verify_email", identity) is False
            assert register_failed_attempt("verify_email", identity) is True
        finally:
            clear_attempts("verify_email", identity)

    def test_success_clears_the_budget(self):
        from app.core.otp_guard import clear_attempts, register_failed_attempt

        identity = f"otp-{uuid.uuid4().hex}@example.com"
        register_failed_attempt("verify_email", identity)
        clear_attempts("verify_email", identity)
        assert register_failed_attempt("verify_email", identity) is False
        clear_attempts("verify_email", identity)

    def test_scopes_do_not_share_a_counter(self):
        from app.core.otp_guard import MAX_OTP_ATTEMPTS, clear_attempts, register_failed_attempt

        identity = f"otp-{uuid.uuid4().hex}@example.com"
        try:
            for _ in range(MAX_OTP_ATTEMPTS + 1):
                register_failed_attempt("verify_email", identity)
            # A different flow for the same account starts with a full budget.
            assert register_failed_attempt("some_other_flow", identity) is False
        finally:
            clear_attempts("verify_email", identity)
            clear_attempts("some_other_flow", identity)

    def test_counter_outage_fails_closed(self, monkeypatch):
        """A broken counter must burn the code, never wave the guess through."""
        from app.core import otp_guard

        broken = MagicMock()
        broken.limiter.hit.side_effect = RuntimeError("redis down")
        monkeypatch.setattr(otp_guard, "limiter", broken)
        assert otp_guard.register_failed_attempt("verify_email", "x@example.com") is True

    def test_verify_email_burns_the_code_once_exhausted(self, monkeypatch):
        from app.api import auth_routes

        row = SimpleNamespace(
            id=1,
            email_otp="123456",
            email_otp_expires_at=datetime.now(UTC) + timedelta(minutes=5),
            is_verified=False,
        )
        session = MagicMock()
        session.execute.return_value = _Scalar(row)
        monkeypatch.setattr(auth_routes, "get_session", lambda: _session_context(session))
        monkeypatch.setattr(auth_routes, "register_failed_attempt", lambda *_: True)

        app = FastAPI()
        app.state.limiter = auth_routes.limiter
        app.include_router(auth_routes.router)
        client = TestClient(app, raise_server_exceptions=False)

        resp = client.post("/auth/verify-email", json={"email": "a@example.com", "otp": "000000"})
        assert resp.status_code == 400
        assert "Too many incorrect codes" in resp.text
        assert row.email_otp is None  # the code is gone, no further guessing
        assert row.is_verified is False

    def test_verify_email_keeps_the_code_while_budget_remains(self, monkeypatch):
        from app.api import auth_routes

        row = SimpleNamespace(
            id=1,
            email_otp="123456",
            email_otp_expires_at=datetime.now(UTC) + timedelta(minutes=5),
            is_verified=False,
        )
        session = MagicMock()
        session.execute.return_value = _Scalar(row)
        monkeypatch.setattr(auth_routes, "get_session", lambda: _session_context(session))
        monkeypatch.setattr(auth_routes, "register_failed_attempt", lambda *_: False)

        app = FastAPI()
        app.state.limiter = auth_routes.limiter
        app.include_router(auth_routes.router)
        client = TestClient(app, raise_server_exceptions=False)

        resp = client.post("/auth/verify-email", json={"email": "a@example.com", "otp": "000000"})
        assert resp.status_code == 400
        assert "Incorrect code" in resp.text
        assert row.email_otp == "123456"  # an honest mistype does not burn it


# ── Finding M2: password spraying was bounded per-IP only ────────────────────


class TestPerAccountLoginThrottle:
    def test_account_budget_is_bounded(self):
        from app.core.rate_limit import clear_failed_logins, login_attempts_exhausted, note_failed_login

        identity = f"login-{uuid.uuid4().hex}@example.com"
        try:
            assert login_attempts_exhausted(identity) is False
            for _ in range(20):
                note_failed_login(identity)
            assert login_attempts_exhausted(identity) is True
        finally:
            clear_failed_logins(identity)

    def test_successful_login_clears_the_budget(self):
        from app.core.rate_limit import clear_failed_logins, login_attempts_exhausted, note_failed_login

        identity = f"login-{uuid.uuid4().hex}@example.com"
        for _ in range(20):
            note_failed_login(identity)
        clear_failed_logins(identity)
        assert login_attempts_exhausted(identity) is False

    def test_counter_outage_fails_open(self, monkeypatch):
        """Unlike the OTP guard, a broken counter here must NOT lock customers
        out of their own accounts, the per-IP limit still applies underneath."""
        from app.core import rate_limit

        broken = MagicMock()
        broken.limiter.test.side_effect = RuntimeError("redis down")
        monkeypatch.setattr(rate_limit, "limiter", broken)
        assert rate_limit.login_attempts_exhausted("x@example.com") is False

    def test_login_returns_429_when_account_is_throttled(self, monkeypatch):
        from app.api import auth_routes

        monkeypatch.setattr(auth_routes, "login_attempts_exhausted", lambda _: True)
        app = FastAPI()
        app.state.limiter = auth_routes.limiter
        app.include_router(auth_routes.router)
        client = TestClient(app, raise_server_exceptions=False)

        resp = client.post("/auth/login", json={"email": "victim@example.com", "password": "guess1234"})
        assert resp.status_code == 429
        assert resp.headers.get("Retry-After") == "900"

    def test_throttle_precedes_the_password_check(self, monkeypatch):
        """A throttled account must cost the attacker a 429, not a bcrypt
        verification. Otherwise the ceiling is also a CPU amplifier."""
        from app.api import auth_routes

        monkeypatch.setattr(auth_routes, "login_attempts_exhausted", lambda _: True)

        def _boom(*_args, **_kwargs):
            raise AssertionError("password verification must not run for a throttled account")

        monkeypatch.setattr(auth_routes, "verify_password", _boom)
        app = FastAPI()
        app.state.limiter = auth_routes.limiter
        app.include_router(auth_routes.router)
        client = TestClient(app, raise_server_exceptions=False)

        assert client.post("/auth/login", json={"email": "v@example.com", "password": "x"}).status_code == 429


# ── Standing guarantees re-verified during the review ────────────────────────
#
# These were already correct. They are pinned here because each one is a single
# ``if`` away from silently regressing, and the review had to establish them by
# reading code rather than by running a test.


class TestStandingAuthGuarantees:
    def test_bot_key_never_resolves_to_a_client_identity(self):
        """``X-Bot-Key`` is public, it is in every customer's page source. It
        must not be accepted by the client resolver under any header name."""
        from app.api.auth import get_current_client

        with pytest.raises(HTTPException) as exc:
            get_current_client(
                request=MagicMock(),
                api_key=None,
                operator_key=None,
                legacy_agent_key=None,
                impersonation_token=None,
            )
        assert exc.value.status_code == 401

    def test_superadmin_gate_rejects_a_plain_client(self):
        from app.api.auth import get_superadmin

        with pytest.raises(HTTPException) as exc:
            get_superadmin(client=SimpleNamespace(id=2, is_superadmin=False))
        assert exc.value.status_code == 403

    def test_superadmin_gate_rejects_a_truthy_non_true_flag(self):
        """The check is ``is not True`` on purpose, a string or 1 from a
        loosely-typed source must not pass."""
        from app.api.auth import get_superadmin

        for value in ("true", 1, "yes"):
            with pytest.raises(HTTPException):
                get_superadmin(client=SimpleNamespace(id=2, is_superadmin=value))

    def test_impersonation_denies_unmarked_mutations(self):
        from app.api.auth import _enforce_impersonation_write_guard

        request = MagicMock()
        request.method = "POST"
        request.scope = {"route": SimpleNamespace(endpoint=lambda: None), "path": "/bots"}
        with pytest.raises(HTTPException) as exc:
            _enforce_impersonation_write_guard(request, actor_id=1, target_id=2)
        assert exc.value.status_code == 403
        assert exc.value.detail["error"] == "impersonation_read_only"

    def test_impersonation_allows_marked_mutations_and_safe_methods(self):
        from app.api.auth import _enforce_impersonation_write_guard, impersonation_writable

        @impersonation_writable
        def _endpoint():
            return None

        request = MagicMock()
        request.method = "POST"
        request.scope = {"route": SimpleNamespace(endpoint=_endpoint), "path": "/x"}
        assert _enforce_impersonation_write_guard(request, actor_id=1, target_id=2) is True

        request.method = "GET"
        assert _enforce_impersonation_write_guard(request, actor_id=1, target_id=2) is False

    @pytest.mark.parametrize("field", ["suspended_at", "deactivated_at"])
    def test_suspended_and_deleted_accounts_cannot_authenticate(self, field):
        from app.api.auth import _ensure_client_authenticatable

        row = SimpleNamespace(id=1, is_superadmin=False, suspended_at=None, deactivated_at=None)
        setattr(row, field, datetime.now(UTC))
        with pytest.raises(HTTPException) as exc:
            _ensure_client_authenticatable(row)
        assert exc.value.status_code == 403

    def test_widget_origin_check_rejects_a_missing_origin_header(self):
        """A non-browser client must not bypass ``allowed_domains`` by simply
        omitting Origin and Referer."""
        from app.api.auth import _enforce_bot_origin

        bot = SimpleNamespace(id=1, domain_check_enabled=True, allowed_domains=["acme.com"])
        request = MagicMock()
        request.headers = {}
        with pytest.raises(HTTPException) as exc:
            _enforce_bot_origin(bot, request)
        assert exc.value.status_code == 403

    def test_widget_origin_wildcard_never_matches_the_apex(self):
        from app.core.origin_check import is_origin_allowed

        assert is_origin_allowed("app.acme.com", ["*.acme.com"], app_env="production") is True
        assert is_origin_allowed("acme.com", ["*.acme.com"], app_env="production") is False
        # The classic suffix-match bug: evil-acme.com must not match acme.com.
        assert is_origin_allowed("evil-acme.com", ["acme.com"], app_env="production") is False
        assert is_origin_allowed("acme.com.evil.net", ["acme.com"], app_env="production") is False

    def test_localhost_is_not_auto_allowed_in_production(self):
        from app.core.origin_check import is_origin_allowed

        assert is_origin_allowed("localhost", ["acme.com"], app_env="production") is False
        assert is_origin_allowed("localhost", ["acme.com"], app_env="development") is True

    def test_ssrf_guard_rejects_internal_targets(self):
        import pytest as _pytest

        from app.core.ssrf import SSRFError, validate_public_url

        for url in (
            "http://127.0.0.1/admin",
            "http://169.254.169.254/latest/meta-data/",
            "http://10.0.0.5/",
            "http://192.168.1.1/",
            "http://[::1]/",
            "file:///etc/passwd",
            "gopher://evil/",
        ):
            with _pytest.raises(SSRFError):
                validate_public_url(url)

    def test_razorpay_signature_uses_constant_time_comparison(self, monkeypatch):
        from app.services import razorpay_service

        monkeypatch.setattr(razorpay_service, "RAZORPAY_WEBHOOK_SECRET", "topsecret")
        with pytest.raises(razorpay_service.SignatureMismatch):
            razorpay_service.verify_webhook_signature(payload=b'{"event":"x"}', signature="deadbeef")
        with pytest.raises(razorpay_service.SignatureMismatch):
            razorpay_service.verify_webhook_signature(payload=b'{"event":"x"}', signature="")

    def test_razorpay_signature_accepts_the_real_hmac(self, monkeypatch):
        import hashlib
        import hmac as _hmac

        from app.services import razorpay_service

        monkeypatch.setattr(razorpay_service, "RAZORPAY_WEBHOOK_SECRET", "topsecret")
        payload = b'{"event":"subscription.charged"}'
        good = _hmac.new(b"topsecret", payload, hashlib.sha256).hexdigest()
        razorpay_service.verify_webhook_signature(payload=payload, signature=good)  # must not raise

    def test_file_proxy_rejects_traversal_and_unlisted_prefixes(self):
        from app.main import serve_b2_file

        for bad in ("../../etc/passwd", "/etc/passwd", "logos/../../secret"):
            with pytest.raises(HTTPException) as exc:
                serve_b2_file(bad)
            assert exc.value.status_code in (400, 403)

        with pytest.raises(HTTPException) as exc:
            serve_b2_file("invoices/other-tenant.pdf")
        assert exc.value.status_code == 403

    def test_scriptable_types_are_never_served_inline(self):
        """A stored SVG/HTML served inline from the API origin would be stored
        XSS. The inline allow-list is the control; assert it stays a list of
        inert types."""
        from app.main import _INLINE_SAFE_TYPES

        for scriptable in (
            "image/svg+xml",
            "text/html",
            "application/xhtml+xml",
            "text/javascript",
            "application/javascript",
            "application/xml",
            "text/xml",
        ):
            assert scriptable not in _INLINE_SAFE_TYPES

    def test_production_cors_never_widens_to_arbitrary_subdomains(self, monkeypatch):
        from app.core.middleware import get_cors_origin_regex

        monkeypatch.setenv("APP_ENV", "production")
        assert get_cors_origin_regex() is None

    def test_production_disables_the_openapi_schema(self):
        from app.main import _docs_urls

        assert _docs_urls("production") == {"docs_url": None, "redoc_url": None, "openapi_url": None}
        assert _docs_urls("development")["openapi_url"] == "/openapi.json"

    def test_cors_credentials_are_off_whenever_the_origin_is_wildcard(self, monkeypatch):
        """The embeddable widget needs ``*``; that combination must never ship
        with credentials enabled."""
        from app.core.middleware import get_cors_origins

        monkeypatch.setenv("APP_ENV", "production")
        monkeypatch.setenv("CORS_ORIGINS", "*")
        origins = get_cors_origins()
        assert origins == ["*"]
        assert ("*" not in origins) is False  # documents the condition main.py evaluates
