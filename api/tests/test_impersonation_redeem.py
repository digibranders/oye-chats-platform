"""``POST /auth/impersonation/redeem`` — turning a minted token into a session.

The endpoint is deliberately unauthenticated: the token *is* the credential.
It exchanges the raw token for the small profile the customer app needs to
render its impersonation banner — and, critically, never for the Account's
permanent ``api_key`` (constraint 3.1 of the design: that credential outlives
the 30-minute window and ignores ``revoked_at``).

Redemption does not burn the token — the tab may reload, so the token stays a
bearer credential for its remaining life.
"""

import hashlib
import os
import secrets
from contextlib import contextmanager, suppress
from datetime import UTC, datetime, timedelta

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded

from app.api import auth_routes
from app.core.rate_limit import limiter
from app.db.models import AuditLog, Client, ImpersonationToken

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")

REDEEM_URL = "/auth/impersonation/redeem"


@contextmanager
def _ctx(session):
    yield session


def _mk_admin(db, email: str) -> Client:
    admin = Client(name=f"Admin-{email}", email=email, api_key=f"key-{email}", is_superadmin=True)
    db.add(admin)
    db.flush()
    return admin


def _mk_target(db, email: str) -> Client:
    target = Client(name=f"Target-{email}", email=email, api_key=f"key-{email}")
    db.add(target)
    db.flush()
    return target


def _mk_token(
    db,
    actor: Client,
    target: Client,
    *,
    expires_in: timedelta = timedelta(minutes=30),
    revoked: bool = False,
) -> tuple[str, int]:
    raw = secrets.token_urlsafe(32)
    record = ImpersonationToken(
        token_hash=hashlib.sha256(raw.encode("utf-8")).hexdigest(),
        actor_id=actor.id,
        target_id=target.id,
        expires_at=datetime.now(UTC) + expires_in,
        revoked_at=datetime.now(UTC) if revoked else None,
    )
    db.add(record)
    db.flush()
    return raw, record.id


def _client(db, monkeypatch) -> TestClient:
    monkeypatch.setattr(auth_routes, "get_session", lambda: _ctx(db))
    app = FastAPI()
    # /auth/impersonation/redeem is rate-limited — wire slowapi as main.py does
    # so the decorated route resolves app.state.limiter under TestClient.
    app.state.limiter = limiter
    app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
    app.include_router(auth_routes.router)
    return TestClient(app)


@pytest.fixture(autouse=True)
def _reset_rate_limiter():
    """The redeem limit is per-IP and TestClient always presents the same IP —
    reset between tests so ordering never produces a spurious 429."""
    with suppress(Exception):
        limiter.reset()
    yield
    with suppress(Exception):
        limiter.reset()


class TestRedeemSuccess:
    def test_valid_token_returns_the_session_profile(self, db, monkeypatch):
        admin = _mk_admin(db, "red-ok-admin@test.example")
        target = _mk_target(db, "red-ok-target@test.example")
        admin_email, target_id, target_name, target_email = admin.email, target.id, target.name, target.email
        raw, token_id = _mk_token(db, admin, target)
        c = _client(db, monkeypatch)

        res = c.post(REDEEM_URL, json={"token": raw})

        assert res.status_code == 200, res.text
        body = res.json()
        assert set(body) == {"client_id", "name", "email", "expires_at", "actor_email", "is_impersonation"}
        assert body["client_id"] == target_id
        assert body["name"] == target_name
        assert body["email"] == target_email
        assert body["actor_email"] == admin_email
        assert body["is_impersonation"] is True
        assert body["expires_at"] == db.get(ImpersonationToken, token_id).expires_at.isoformat()

    def test_response_never_contains_the_account_api_key(self, db, monkeypatch):
        admin = _mk_admin(db, "red-key-admin@test.example")
        target = _mk_target(db, "red-key-target@test.example")
        real_key = target.api_key
        raw, _ = _mk_token(db, admin, target)
        c = _client(db, monkeypatch)

        res = c.post(REDEEM_URL, json={"token": raw})

        assert res.status_code == 200, res.text
        assert "api_key" not in res.json()
        assert real_key not in res.text

    def test_redemption_does_not_burn_the_token(self, db, monkeypatch):
        """The tab may reload, so the token stays valid for its remaining life."""
        admin = _mk_admin(db, "red-reuse-admin@test.example")
        target = _mk_target(db, "red-reuse-target@test.example")
        raw, token_id = _mk_token(db, admin, target)
        c = _client(db, monkeypatch)

        assert c.post(REDEEM_URL, json={"token": raw}).status_code == 200
        assert c.post(REDEEM_URL, json={"token": raw}).status_code == 200
        assert db.get(ImpersonationToken, token_id).revoked_at is None

    def test_redemption_writes_an_audit_row(self, db, monkeypatch):
        admin = _mk_admin(db, "red-aud-admin@test.example")
        target = _mk_target(db, "red-aud-target@test.example")
        admin_id, target_id = admin.id, target.id
        raw, token_id = _mk_token(db, admin, target)
        c = _client(db, monkeypatch)

        assert c.post(REDEEM_URL, json={"token": raw}).status_code == 200

        rows = db.query(AuditLog).filter(AuditLog.action == "client.impersonate_redeem").all()
        assert len(rows) == 1
        assert rows[0].actor_id == admin_id
        assert rows[0].target_id == str(target_id)
        assert rows[0].after["token_id"] == token_id


class TestRedeemRejection:
    @pytest.mark.parametrize("token", ["", "   ", "not-a-real-token", "!!!not base64!!!"])
    def test_empty_or_malformed_token_is_rejected(self, db, monkeypatch, token):
        c = _client(db, monkeypatch)

        res = c.post(REDEEM_URL, json={"token": token})

        assert res.status_code == 401, res.text
        assert res.json()["detail"] == "Impersonation session expired or revoked."

    def test_expired_token_is_rejected(self, db, monkeypatch):
        admin = _mk_admin(db, "red-exp-admin@test.example")
        target = _mk_target(db, "red-exp-target@test.example")
        raw, _ = _mk_token(db, admin, target, expires_in=timedelta(seconds=-1))
        c = _client(db, monkeypatch)

        res = c.post(REDEEM_URL, json={"token": raw})

        assert res.status_code == 401, res.text
        assert db.query(AuditLog).filter(AuditLog.action == "client.impersonate_redeem").count() == 0

    def test_revoked_token_is_rejected(self, db, monkeypatch):
        admin = _mk_admin(db, "red-rev-admin@test.example")
        target = _mk_target(db, "red-rev-target@test.example")
        raw, _ = _mk_token(db, admin, target, revoked=True)
        c = _client(db, monkeypatch)

        res = c.post(REDEEM_URL, json={"token": raw})

        assert res.status_code == 401, res.text

    def test_unknown_token_is_rejected(self, db, monkeypatch):
        c = _client(db, monkeypatch)

        res = c.post(REDEEM_URL, json={"token": secrets.token_urlsafe(32)})

        assert res.status_code == 401, res.text

    def test_missing_token_field_is_a_validation_error(self, db, monkeypatch):
        c = _client(db, monkeypatch)

        assert c.post(REDEEM_URL, json={}).status_code == 422
