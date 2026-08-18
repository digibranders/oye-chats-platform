"""Hardening of the impersonation token-mint endpoint.

Covers the two controls added to ``POST /superadmin/clients/{id}/impersonate``:

1. The customer-app host in ``redirect_url`` comes from the shared ``APP_URL``
   setting (``app/config.py``), so impersonation also works against localhost
   and staging. It deliberately does NOT introduce a second env var for the
   same concept. See ``test_redirect_url_uses_the_shared_app_url_setting``.
2. A Client whose ``is_superadmin`` is true can never be impersonated. The
   super-admin UI already filters those rows out, but a UI filter is not a
   control, the backend enforces it and mints nothing.

Existing mint behaviour (token id, audit trail, read-only gating) is pinned
here too so the hardening cannot silently regress it.
"""

import hashlib
import os
from contextlib import contextmanager

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api import superadmin_routes_v2
from app.api.auth import get_superadmin
from app.db.models import AuditLog, Client, ImpersonationToken

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")

PRODUCTION_APP_URL = "https://app.oyechats.com"


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


def _client(db, monkeypatch, admin: Client) -> TestClient:
    monkeypatch.setattr(superadmin_routes_v2, "get_session", lambda: _ctx(db))
    app = FastAPI()
    app.include_router(superadmin_routes_v2.router)
    app.dependency_overrides[get_superadmin] = lambda: admin
    return TestClient(app)


# ── redirect_url / APP_URL ──────────────────────────────────────────────────


def test_redirect_url_honours_app_url(db, monkeypatch):
    monkeypatch.setattr(superadmin_routes_v2, "APP_URL", "http://localhost:5174")
    admin = _mk_admin(db, "imp-base-admin@test.example")
    target = _mk_target(db, "imp-base-target@test.example")
    c = _client(db, monkeypatch, admin)

    res = c.post(f"/superadmin/clients/{target.id}/impersonate")
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["redirect_url"] == f"http://localhost:5174/?impersonation={body['token']}"


def test_redirect_url_uses_the_shared_app_url_setting(db, monkeypatch):
    """The hand-off host must come from ``app.config.APP_URL`` and nothing else.

    A second env var for the same concept (an earlier draft used
    ``APP_BASE_URL``) silently half-fixes the bug it was meant to fix: a
    developer whose ``.env`` already points ``APP_URL`` at localhost would
    still be handed a production impersonation link until they set the second
    var too. This pins the single source of truth.
    """
    import app.config as app_config

    assert superadmin_routes_v2.APP_URL == app_config.APP_URL

    # A stray APP_BASE_URL must have no effect whatsoever.
    monkeypatch.setenv("APP_BASE_URL", "https://should-be-ignored.example")
    monkeypatch.setattr(superadmin_routes_v2, "APP_URL", "https://app.oyechats.com")
    admin = _mk_admin(db, "imp-default-admin@test.example")
    target = _mk_target(db, "imp-default-target@test.example")
    c = _client(db, monkeypatch, admin)

    res = c.post(f"/superadmin/clients/{target.id}/impersonate")
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["redirect_url"] == f"{PRODUCTION_APP_URL}/?impersonation={body['token']}"
    assert "should-be-ignored" not in body["redirect_url"]


def test_redirect_url_has_no_double_slash_with_trailing_slash_host(db, monkeypatch):
    monkeypatch.setattr(superadmin_routes_v2, "APP_URL", "https://staging.oyechats.com/")
    admin = _mk_admin(db, "imp-slash-admin@test.example")
    target = _mk_target(db, "imp-slash-target@test.example")
    c = _client(db, monkeypatch, admin)

    res = c.post(f"/superadmin/clients/{target.id}/impersonate")
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["redirect_url"] == f"https://staging.oyechats.com/?impersonation={body['token']}"
    # The only "//" in the URL is the one in the scheme separator.
    assert body["redirect_url"].count("//") == 1


def test_redirect_url_carries_the_raw_token_that_was_stored(db, monkeypatch):
    monkeypatch.setattr(superadmin_routes_v2, "APP_URL", "http://localhost:5174")
    admin = _mk_admin(db, "imp-raw-admin@test.example")
    target = _mk_target(db, "imp-raw-target@test.example")
    c = _client(db, monkeypatch, admin)

    res = c.post(f"/superadmin/clients/{target.id}/impersonate")
    assert res.status_code == 200, res.text
    body = res.json()

    raw = body["redirect_url"].split("?impersonation=", 1)[1]
    assert raw == body["token"]

    record = db.get(ImpersonationToken, body["token_id"])
    assert record is not None
    # The token in the URL is the pre-image of the hash that was persisted.
    assert record.token_hash == hashlib.sha256(raw.encode("utf-8")).hexdigest()


# ── super-admin targets are not impersonable ────────────────────────────────


def test_impersonating_a_superadmin_target_is_rejected(db, monkeypatch):
    admin = _mk_admin(db, "imp-priv-admin@test.example")
    target = _mk_admin(db, "imp-priv-target@test.example", role="admin")
    c = _client(db, monkeypatch, admin)

    res = c.post(f"/superadmin/clients/{target.id}/impersonate")
    assert res.status_code == 403, res.text
    assert db.query(ImpersonationToken).count() == 0


def test_impersonating_self_is_rejected(db, monkeypatch):
    admin = _mk_admin(db, "imp-self-admin@test.example")
    c = _client(db, monkeypatch, admin)

    res = c.post(f"/superadmin/clients/{admin.id}/impersonate")
    assert res.status_code == 403, res.text
    assert db.query(ImpersonationToken).count() == 0


# ── existing behaviour stays intact ─────────────────────────────────────────


def test_impersonate_writes_audit_row(db, monkeypatch):
    admin = _mk_admin(db, "imp-audit-admin@test.example")
    target = _mk_target(db, "imp-audit-target@test.example")
    c = _client(db, monkeypatch, admin)

    res = c.post(f"/superadmin/clients/{target.id}/impersonate")
    assert res.status_code == 200, res.text
    body = res.json()

    audit = db.query(AuditLog).filter(AuditLog.action == "client.impersonate").all()
    assert len(audit) == 1
    assert audit[0].target_id == str(target.id)
    assert audit[0].after["token_id"] == body["token_id"]


def test_readonly_admin_cannot_mint_a_token(db, monkeypatch):
    admin = _mk_admin(db, "imp-ro-mint-admin@test.example", role="readonly")
    target = _mk_target(db, "imp-ro-mint-target@test.example")
    c = _client(db, monkeypatch, admin)

    res = c.post(f"/superadmin/clients/{target.id}/impersonate")
    assert res.status_code == 403, res.text
    assert db.query(ImpersonationToken).count() == 0


def test_impersonate_unknown_client_returns_404(db, monkeypatch):
    admin = _mk_admin(db, "imp-404-mint-admin@test.example")
    c = _client(db, monkeypatch, admin)

    res = c.post("/superadmin/clients/999999/impersonate")
    assert res.status_code == 404
    assert db.query(ImpersonationToken).count() == 0
