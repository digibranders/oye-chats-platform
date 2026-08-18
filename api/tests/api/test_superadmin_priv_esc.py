"""Privilege-escalation regression tests for PATCH /superadmin/clients/{id}.

Bug: ``patch_client`` only gated writes behind ``_require_write`` (blocks the
``readonly`` role) before writing ``is_superadmin`` / ``superadmin_role`` from
the request body. Any non-readonly super-admin ("admin"-tier) could therefore
promote themselves to ``owner`` or mint a brand-new super-admin from any
customer row, the ``owner`` tier was checked nowhere.

Fix: privilege-field writes (``is_superadmin``, ``superadmin_role``) now
require ``_require_owner`` (only ``superadmin_role == "owner"``), and even an
owner is forbidden from mutating their OWN privilege fields via this endpoint
(self-escalation / accidental self-lockout guard).
"""

from contextlib import contextmanager

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient as HttpClient

from app.api import superadmin_routes_v2
from app.api.auth import get_superadmin
from app.db.models import Client

pytestmark = pytest.mark.skipif(
    __import__("os").getenv("DB_URL") is None, reason="needs a reachable Postgres at DB_URL"
)


@contextmanager
def _ctx(session):
    yield session


def _make_client(db, *, name: str, email: str, role: str | None, is_superadmin: bool) -> Client:
    c = Client(
        name=name,
        email=email,
        api_key=f"key-{email}",
        is_superadmin=is_superadmin,
        superadmin_role=role,
    )
    db.add(c)
    db.flush()
    return c


def _http_client(db, monkeypatch, actor: Client) -> HttpClient:
    monkeypatch.setattr(superadmin_routes_v2, "get_session", lambda: _ctx(db))
    app = FastAPI()
    app.include_router(superadmin_routes_v2.router)
    app.dependency_overrides[get_superadmin] = lambda: actor
    return HttpClient(app)


def test_admin_tier_cannot_grant_superadmin_to_another_client(db, monkeypatch):
    """(a) an admin-tier actor patching ANOTHER client's is_superadmin/
    superadmin_role must be rejected with 403. Closes the escalation."""
    actor = _make_client(db, name="Admin", email="admin-tier@test.example", role="admin", is_superadmin=True)
    target = _make_client(db, name="Target", email="target-a@test.example", role=None, is_superadmin=False)

    c = _http_client(db, monkeypatch, actor)
    res = c.patch(f"/superadmin/clients/{target.id}", json={"is_superadmin": True, "superadmin_role": "owner"})

    assert res.status_code == 403, res.text
    db.expire(target)
    assert target.is_superadmin is False
    assert target.superadmin_role is None


def test_owner_tier_can_grant_superadmin_to_another_client(db, monkeypatch):
    """(b) an owner performing the same patch is allowed."""
    actor = _make_client(db, name="Owner", email="owner-tier@test.example", role="owner", is_superadmin=True)
    target = _make_client(db, name="Target2", email="target-b@test.example", role=None, is_superadmin=False)

    c = _http_client(db, monkeypatch, actor)
    res = c.patch(f"/superadmin/clients/{target.id}", json={"is_superadmin": True, "superadmin_role": "admin"})

    assert res.status_code == 200, res.text
    db.expire(target)
    assert target.is_superadmin is True
    assert target.superadmin_role == "admin"


@pytest.mark.parametrize("role", ["admin", "owner"])
def test_actor_cannot_patch_own_privilege_fields(db, monkeypatch, role):
    """(c) any actor (admin- or owner-tier) patching their OWN privilege
    fields is rejected. Prevents self-escalation and accidental lockout."""
    actor = _make_client(db, name="Self", email=f"self-{role}@test.example", role=role, is_superadmin=True)

    c = _http_client(db, monkeypatch, actor)
    res = c.patch(f"/superadmin/clients/{actor.id}", json={"superadmin_role": "owner"})

    assert res.status_code == 403, res.text
    db.expire(actor)
    assert actor.superadmin_role == role


def test_admin_tier_can_still_patch_non_privilege_fields(db, monkeypatch):
    """(d) an admin-tier actor patching a non-privilege field (e.g. name) on
    another client is still allowed. Only privilege writes are gated."""
    actor = _make_client(db, name="Admin2", email="admin-tier2@test.example", role="admin", is_superadmin=True)
    target = _make_client(db, name="Old Name", email="target-c@test.example", role=None, is_superadmin=False)

    c = _http_client(db, monkeypatch, actor)
    res = c.patch(f"/superadmin/clients/{target.id}", json={"name": "New Name"})

    assert res.status_code == 200, res.text
    assert res.json()["name"] == "New Name"
    db.expire(target)
    assert target.name == "New Name"
