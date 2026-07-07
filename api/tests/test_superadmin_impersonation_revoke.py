"""Impersonation token revocation (audit F16).

The "Exit" control in the super-admin dashboard must be able to invalidate the
impersonation token server-side, not just clear local UI state. These tests
cover the new ``POST /superadmin/impersonation/{token_id}/revoke`` endpoint and
the ``token_id`` now returned by the issuing endpoint.
"""

import hashlib
import os
import secrets
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api import superadmin_routes_v2
from app.api.auth import get_superadmin
from app.db.models import AuditLog, Client, ImpersonationToken

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")


@contextmanager
def _ctx(session):
    yield session


def _mk_admin(db, email: str, role: str = "owner") -> Client:
    admin = Client(
        name=f"Admin-{email}",
        email=email,
        api_key=f"key-{email}",
        is_superadmin=True,
        superadmin_role=role,
    )
    db.add(admin)
    db.flush()
    return admin


def _mk_target(db, email: str) -> Client:
    target = Client(name=f"Target-{email}", email=email, api_key=f"key-{email}")
    db.add(target)
    db.flush()
    return target


def _mk_token(db, actor: Client, target: Client, minutes: int = 30) -> ImpersonationToken:
    raw = secrets.token_urlsafe(32)
    record = ImpersonationToken(
        token_hash=hashlib.sha256(raw.encode("utf-8")).hexdigest(),
        actor_id=actor.id,
        target_id=target.id,
        expires_at=datetime.now(UTC) + timedelta(minutes=minutes),
    )
    db.add(record)
    db.flush()
    return record


def _client(db, monkeypatch, admin: Client) -> TestClient:
    monkeypatch.setattr(superadmin_routes_v2, "get_session", lambda: _ctx(db))
    app = FastAPI()
    app.include_router(superadmin_routes_v2.router)
    app.dependency_overrides[get_superadmin] = lambda: admin
    return TestClient(app)


def test_impersonate_returns_token_id(db, monkeypatch):
    admin = _mk_admin(db, "imp-issue-admin@test.example")
    target = _mk_target(db, "imp-issue-target@test.example")
    c = _client(db, monkeypatch, admin)

    res = c.post(f"/superadmin/clients/{target.id}/impersonate")
    assert res.status_code == 200, res.text
    body = res.json()
    assert isinstance(body["token_id"], int)

    record = db.get(ImpersonationToken, body["token_id"])
    assert record is not None
    assert record.actor_id == admin.id
    assert record.target_id == target.id
    assert record.revoked_at is None


def test_initiator_can_revoke_own_token(db, monkeypatch):
    admin = _mk_admin(db, "imp-rev-admin@test.example")
    target = _mk_target(db, "imp-rev-target@test.example")
    token = _mk_token(db, admin, target)
    c = _client(db, monkeypatch, admin)

    res = c.post(f"/superadmin/impersonation/{token.id}/revoke")
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["ok"] is True
    assert body["revoked_at"]

    db.refresh(token)
    assert token.revoked_at is not None

    audit = db.query(AuditLog).filter(AuditLog.action == "client.impersonate_revoke").all()
    assert len(audit) == 1
    assert audit[0].target_id == str(target.id)


def test_revoke_is_idempotent(db, monkeypatch):
    admin = _mk_admin(db, "imp-idem-admin@test.example")
    target = _mk_target(db, "imp-idem-target@test.example")
    token = _mk_token(db, admin, target)
    c = _client(db, monkeypatch, admin)

    first = c.post(f"/superadmin/impersonation/{token.id}/revoke")
    assert first.status_code == 200, first.text
    db.refresh(token)
    first_revoked_at = token.revoked_at

    second = c.post(f"/superadmin/impersonation/{token.id}/revoke")
    assert second.status_code == 200, second.text
    db.refresh(token)
    assert token.revoked_at == first_revoked_at  # unchanged

    # Only the first call writes an audit entry.
    audit = db.query(AuditLog).filter(AuditLog.action == "client.impersonate_revoke").all()
    assert len(audit) == 1


def test_revoke_unknown_token_returns_404(db, monkeypatch):
    admin = _mk_admin(db, "imp-404-admin@test.example")
    c = _client(db, monkeypatch, admin)

    res = c.post("/superadmin/impersonation/999999/revoke")
    assert res.status_code == 404


def test_readonly_admin_cannot_revoke_another_admins_token(db, monkeypatch):
    issuer = _mk_admin(db, "imp-ro-issuer@test.example")
    readonly = _mk_admin(db, "imp-ro-reader@test.example", role="readonly")
    target = _mk_target(db, "imp-ro-target@test.example")
    token = _mk_token(db, issuer, target)
    c = _client(db, monkeypatch, readonly)

    res = c.post(f"/superadmin/impersonation/{token.id}/revoke")
    assert res.status_code == 403

    db.refresh(token)
    assert token.revoked_at is None


def test_write_admin_can_revoke_another_admins_token(db, monkeypatch):
    issuer = _mk_admin(db, "imp-other-issuer@test.example")
    other = _mk_admin(db, "imp-other-admin@test.example", role="admin")
    target = _mk_target(db, "imp-other-target@test.example")
    token = _mk_token(db, issuer, target)
    c = _client(db, monkeypatch, other)

    res = c.post(f"/superadmin/impersonation/{token.id}/revoke")
    assert res.status_code == 200, res.text

    db.refresh(token)
    assert token.revoked_at is not None
