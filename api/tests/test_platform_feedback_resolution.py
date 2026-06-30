"""Platform Feedback Resolution & Status Loop — backend coverage (real Postgres).

Exercises the resolution loop end-to-end against a throwaway Postgres DB:

  * ``PATCH /superadmin/platform-feedback/{id}`` — status transitions stamp
    ``resolved_at``/``resolved_by``, write an audit row, and enqueue an in-app
    ``feedback_resolved`` notification for the owning client on resolve.
  * Invalid status → 400.
  * ``GET /client/feedback`` — returns only the caller's rows with status +
    admin response, and requires auth.
  * ``get_all_platform_feedback`` — serialises the new fields and honours the
    optional status filter.
"""

from __future__ import annotations

import os
from contextlib import contextmanager

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api import client_routes, superadmin_routes
from app.api.auth import get_current_client, get_superadmin
from app.db.models import AuditLog, Client, Notification, PlatformFeedback

pytestmark = pytest.mark.skipif(
    not os.getenv("DB_URL"),
    reason="platform feedback resolution tests need a reachable Postgres at DB_URL",
)


def _make_client(db, *, email: str, superadmin: bool = False) -> Client:
    client = Client(
        name=email.split("@")[0],
        email=email,
        api_key=f"key-{email}",
        hashed_password="h",
        is_superadmin=superadmin,
    )
    db.add(client)
    db.flush()
    return client


def _make_feedback(db, *, client_id: int, message: str = "Bot is slow") -> PlatformFeedback:
    fb = PlatformFeedback(client_id=client_id, message=message, category="bug")
    db.add(fb)
    db.flush()
    return fb


def _build_client(db, *, superadmin: Client | None = None, current_client: Client | None = None) -> TestClient:
    """Wire a FastAPI app over the shared test session with auth overrides."""

    @contextmanager
    def _session():
        # Yield the test's session without closing — the ``db`` fixture owns
        # teardown. Both the route and the post-commit notification path go
        # through this, so everything lands in the same throwaway DB.
        yield db

    superadmin_routes.get_session = _session  # type: ignore[assignment]
    client_routes.get_session = _session  # type: ignore[assignment]

    app = FastAPI()
    app.include_router(superadmin_routes.router)
    app.include_router(client_routes.router)
    if superadmin is not None:
        app.dependency_overrides[get_superadmin] = lambda: superadmin
    if current_client is not None:
        app.dependency_overrides[get_current_client] = lambda: current_client
    return TestClient(app, raise_server_exceptions=True)


class TestPatchPlatformFeedback:
    def test_resolve_stamps_metadata_audits_and_notifies(self, db, monkeypatch):
        # Avoid scheduling a real WS broadcast in the test event loop.
        from app.services import notification_service

        monkeypatch.setattr(notification_service, "create_notification", notification_service.create_notification)

        owner = _make_client(db, email="owner@example.com")
        admin = _make_client(db, email="admin@example.com", superadmin=True)
        fb = _make_feedback(db, client_id=owner.id)
        db.commit()

        api = _build_client(db, superadmin=admin)
        resp = api.patch(
            f"/superadmin/platform-feedback/{fb.id}",
            json={"status": "resolved", "admin_response": "Fixed in the latest release."},
        )

        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["status"] == "resolved"
        assert data["admin_response"] == "Fixed in the latest release."
        assert data["resolved_at"] is not None
        assert data["resolved_by"] == admin.id

        db.expire_all()
        row = db.get(PlatformFeedback, fb.id)
        assert row.status == "resolved"
        assert row.resolved_at is not None
        assert row.resolved_by == admin.id

        audits = db.query(AuditLog).filter(AuditLog.action == "platform_feedback.update").all()
        assert len(audits) == 1
        assert audits[0].target_id == str(fb.id)
        assert audits[0].before["status"] == "open"
        assert audits[0].after["status"] == "resolved"

        notes = db.query(Notification).filter(Notification.client_id == owner.id).all()
        assert len(notes) == 1
        assert notes[0].type == "feedback_resolved"
        assert notes[0].data["feedback_id"] == fb.id

    def test_response_only_update_does_not_resolve_or_notify(self, db):
        owner = _make_client(db, email="owner2@example.com")
        admin = _make_client(db, email="admin2@example.com", superadmin=True)
        fb = _make_feedback(db, client_id=owner.id)
        db.commit()

        api = _build_client(db, superadmin=admin)
        resp = api.patch(
            f"/superadmin/platform-feedback/{fb.id}",
            json={"admin_response": "Looking into it.", "status": "in_progress"},
        )

        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["status"] == "in_progress"
        assert data["resolved_at"] is None
        assert data["resolved_by"] is None
        assert db.query(Notification).filter(Notification.client_id == owner.id).count() == 0

    def test_invalid_status_returns_400(self, db):
        admin = _make_client(db, email="admin3@example.com", superadmin=True)
        fb = _make_feedback(db, client_id=admin.id)
        db.commit()

        api = _build_client(db, superadmin=admin)
        resp = api.patch(f"/superadmin/platform-feedback/{fb.id}", json={"status": "bogus"})
        assert resp.status_code == 400

    def test_missing_feedback_returns_404(self, db):
        admin = _make_client(db, email="admin4@example.com", superadmin=True)
        db.commit()

        api = _build_client(db, superadmin=admin)
        resp = api.patch("/superadmin/platform-feedback/999999", json={"status": "resolved"})
        assert resp.status_code == 404

    def test_empty_body_returns_400(self, db):
        admin = _make_client(db, email="admin5@example.com", superadmin=True)
        fb = _make_feedback(db, client_id=admin.id)
        db.commit()

        api = _build_client(db, superadmin=admin)
        resp = api.patch(f"/superadmin/platform-feedback/{fb.id}", json={})
        assert resp.status_code == 400


class TestGetClientFeedback:
    def test_returns_only_callers_rows_with_status(self, db):
        alice = _make_client(db, email="alice@example.com")
        bob = _make_client(db, email="bob@example.com")
        _make_feedback(db, client_id=alice.id, message="Alice issue")
        fb_a2 = _make_feedback(db, client_id=alice.id, message="Alice issue 2")
        _make_feedback(db, client_id=bob.id, message="Bob issue")
        fb_a2.status = "resolved"
        fb_a2.admin_response = "Done"
        db.commit()

        api = _build_client(db, current_client=alice)
        resp = api.get("/client/feedback")

        assert resp.status_code == 200, resp.text
        rows = resp.json()
        assert len(rows) == 2
        messages = {r["message"] for r in rows}
        assert messages == {"Alice issue", "Alice issue 2"}
        assert all("Bob" not in r["message"] for r in rows)
        resolved = next(r for r in rows if r["message"] == "Alice issue 2")
        assert resolved["status"] == "resolved"
        assert resolved["admin_response"] == "Done"

    def test_requires_auth(self, db):
        app = FastAPI()
        app.include_router(client_routes.router)
        resp = TestClient(app).get("/client/feedback")
        assert resp.status_code == 401


class TestRepositorySerialization:
    def test_get_all_includes_new_fields_and_status_filter(self, db):
        from app.db.repository import get_all_platform_feedback

        owner = _make_client(db, email="repo@example.com")
        open_fb = _make_feedback(db, client_id=owner.id, message="open one")
        resolved_fb = _make_feedback(db, client_id=owner.id, message="resolved one")
        resolved_fb.status = "resolved"
        resolved_fb.admin_response = "handled"
        db.commit()

        all_rows = get_all_platform_feedback(db)
        assert len(all_rows) == 2
        sample = all_rows[0]
        for key in ("status", "admin_response", "resolved_at", "resolved_by", "client_email"):
            assert key in sample

        only_resolved = get_all_platform_feedback(db, status="resolved")
        assert len(only_resolved) == 1
        assert only_resolved[0]["id"] == resolved_fb.id
        assert only_resolved[0]["admin_response"] == "handled"

        assert all(r["status"] == "open" or r["id"] == open_fb.id for r in get_all_platform_feedback(db, status="open"))
