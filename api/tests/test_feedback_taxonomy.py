"""Feedback taxonomy — backend coverage (real Postgres).

Exercises the Type/Area/Severity taxonomy, auto-captured context, and
multi-screenshot attachments end-to-end:

  * ``POST /client/feedback`` — validates type/area/severity enums, drops
    severity for non-bugs, whitelists context, normalizes attachments, and
    mirrors the first attachment into the legacy ``attachment_url``.
  * ``GET /client/feedback`` — serializes the new fields and coalesces
    ``attachments`` from a legacy single ``attachment_url``.
  * ``GET /superadmin/platform-feedback`` — filters by type/area/severity.
  * ``PATCH`` — re-classification with the bug-only severity rule + audit.
  * Migration backfill mapping (category → type) at the SQL level.
"""

from __future__ import annotations

import os
from contextlib import contextmanager

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import text

from app.api import client_routes, superadmin_routes
from app.api.auth import get_current_client, get_superadmin
from app.db.models import AuditLog, Client, PlatformFeedback

pytestmark = pytest.mark.skipif(
    not os.getenv("DB_URL"),
    reason="feedback taxonomy tests need a reachable Postgres at DB_URL",
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


@contextmanager
def _session_cm(db):
    yield db


def _client_app(db, client: Client) -> TestClient:
    superadmin_routes.get_session = lambda: _session_cm(db)  # type: ignore[assignment]
    client_routes.get_session = lambda: _session_cm(db)  # type: ignore[assignment]
    app = FastAPI()
    app.include_router(client_routes.router)
    app.dependency_overrides[get_current_client] = lambda: client
    return TestClient(app)


def _admin_app(db, admin: Client) -> TestClient:
    superadmin_routes.get_session = lambda: _session_cm(db)  # type: ignore[assignment]
    app = FastAPI()
    app.include_router(superadmin_routes.router)
    app.dependency_overrides[get_superadmin] = lambda: admin
    return TestClient(app)


class TestSubmitTaxonomy:
    def test_full_submission_persists_taxonomy_and_attachments(self, db):
        owner = _make_client(db, email="t1@example.com")
        db.commit()
        api = _client_app(db, owner)

        resp = api.post(
            "/client/feedback",
            json={
                "message": "Checkout 500s on submit",
                "type": "bug",
                "area": "billing",
                "severity": "high",
                "context": {
                    "page_url": "/billing",
                    "app_version": "1.2.3",
                    "plan_tier": "standard",
                    "user_agent": "UA/1",
                    "junk": "drop-me",
                },
                "attachments": [
                    {"url": "https://x/a.png", "name": "a.png", "content_type": "image/png"},
                    "https://x/b.png",
                ],
            },
        )
        assert resp.status_code == 201, resp.text

        db.expire_all()
        fb = db.query(PlatformFeedback).filter(PlatformFeedback.client_id == owner.id).one()
        assert fb.type == "bug"
        assert fb.area == "billing"
        assert fb.severity == "high"
        assert fb.context == {
            "page_url": "/billing",
            "app_version": "1.2.3",
            "plan_tier": "standard",
            "user_agent": "UA/1",
        }
        assert fb.attachments[0]["url"] == "https://x/a.png"
        assert fb.attachments[1] == {"url": "https://x/b.png"}
        # First attachment mirrored into the legacy single column.
        assert fb.attachment_url == "https://x/a.png"

    def test_severity_dropped_for_non_bug(self, db):
        owner = _make_client(db, email="t2@example.com")
        db.commit()
        api = _client_app(db, owner)

        resp = api.post(
            "/client/feedback",
            json={"message": "Please add dark mode", "type": "feature_request", "severity": "critical"},
        )
        assert resp.status_code == 201, resp.text
        db.expire_all()
        fb = db.query(PlatformFeedback).filter(PlatformFeedback.client_id == owner.id).one()
        assert fb.type == "feature_request"
        assert fb.severity is None

    def test_defaults_to_other_when_type_omitted(self, db):
        owner = _make_client(db, email="t3@example.com")
        db.commit()
        api = _client_app(db, owner)
        resp = api.post("/client/feedback", json={"message": "just a note"})
        assert resp.status_code == 201, resp.text
        db.expire_all()
        fb = db.query(PlatformFeedback).filter(PlatformFeedback.client_id == owner.id).one()
        assert fb.type == "other"

    @pytest.mark.parametrize(
        "field,value",
        [("type", "nonsense"), ("area", "nonsense"), ("severity", "nonsense")],
    )
    def test_invalid_enum_rejected(self, db, field, value):
        owner = _make_client(db, email=f"t4-{field}@example.com")
        db.commit()
        api = _client_app(db, owner)
        resp = api.post("/client/feedback", json={"message": "x", field: value})
        assert resp.status_code == 422


class TestClientFeedbackSerialization:
    def test_includes_taxonomy_and_coalesces_legacy_attachment(self, db):
        owner = _make_client(db, email="ser@example.com")
        # A legacy row: no attachments array, only the single attachment_url.
        legacy = PlatformFeedback(
            client_id=owner.id,
            message="legacy",
            attachment_url="https://x/legacy.png",
            type="bug",
            area="dashboard",
            severity="low",
        )
        db.add(legacy)
        db.commit()

        api = _client_app(db, owner)
        rows = api.get("/client/feedback").json()
        assert len(rows) == 1
        row = rows[0]
        assert row["type"] == "bug"
        assert row["area"] == "dashboard"
        assert row["severity"] == "low"
        # Coalesced from the legacy single column.
        assert row["attachments"] == [{"url": "https://x/legacy.png"}]


class TestSuperadminFilters:
    def _seed(self, db, owner):
        db.add_all(
            [
                PlatformFeedback(client_id=owner.id, message="b1", type="bug", area="billing", severity="high"),
                PlatformFeedback(client_id=owner.id, message="f1", type="feature_request", area="bots"),
                PlatformFeedback(client_id=owner.id, message="q1", type="question", area="billing"),
            ]
        )
        db.commit()

    def test_filter_by_type_area_severity(self, db):
        admin = _make_client(db, email="adminf@example.com", superadmin=True)
        owner = _make_client(db, email="ownerf@example.com")
        self._seed(db, owner)
        api = _admin_app(db, admin)

        assert len(api.get("/superadmin/platform-feedback", params={"type": "bug"}).json()) == 1
        assert len(api.get("/superadmin/platform-feedback", params={"area": "billing"}).json()) == 2
        assert len(api.get("/superadmin/platform-feedback", params={"severity": "high"}).json()) == 1

    def test_invalid_filter_returns_400(self, db):
        admin = _make_client(db, email="adminf2@example.com", superadmin=True)
        db.commit()
        api = _admin_app(db, admin)
        assert api.get("/superadmin/platform-feedback", params={"type": "bogus"}).status_code == 400


class TestReclassify:
    def test_patch_reclassifies_and_audits(self, db):
        admin = _make_client(db, email="adminr@example.com", superadmin=True)
        owner = _make_client(db, email="ownerr@example.com")
        fb = PlatformFeedback(client_id=owner.id, message="m", type="other")
        db.add(fb)
        db.commit()

        api = _admin_app(db, admin)
        resp = api.patch(
            f"/superadmin/platform-feedback/{fb.id}",
            json={"type": "bug", "area": "widget", "severity": "critical"},
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["type"] == "bug"
        assert data["area"] == "widget"
        assert data["severity"] == "critical"

        audit = db.query(AuditLog).filter(AuditLog.action == "platform_feedback.update").one()
        assert audit.before["type"] == "other"
        assert audit.after["type"] == "bug"
        assert audit.after["severity"] == "critical"

    def test_severity_cleared_when_reclassified_away_from_bug(self, db):
        admin = _make_client(db, email="adminr2@example.com", superadmin=True)
        owner = _make_client(db, email="ownerr2@example.com")
        fb = PlatformFeedback(client_id=owner.id, message="m", type="bug", severity="high")
        db.add(fb)
        db.commit()

        api = _admin_app(db, admin)
        resp = api.patch(f"/superadmin/platform-feedback/{fb.id}", json={"type": "question"})
        assert resp.status_code == 200, resp.text
        assert resp.json()["severity"] is None
        db.expire_all()
        assert db.get(PlatformFeedback, fb.id).severity is None

    def test_invalid_type_returns_400(self, db):
        admin = _make_client(db, email="adminr3@example.com", superadmin=True)
        fb = PlatformFeedback(client_id=admin.id, message="m", type="other")
        db.add(fb)
        db.commit()
        api = _admin_app(db, admin)
        assert api.patch(f"/superadmin/platform-feedback/{fb.id}", json={"type": "bogus"}).status_code == 400


class TestMigrationBackfill:
    def test_category_to_type_sql_mapping(self, db):
        owner = _make_client(db, email="mig@example.com")
        db.add_all(
            [
                PlatformFeedback(client_id=owner.id, message="m1", category="bug", type="other"),
                PlatformFeedback(client_id=owner.id, message="m2", category="feature", type="other"),
                PlatformFeedback(client_id=owner.id, message="m3", category="ui_ux", type="other"),
                PlatformFeedback(client_id=owner.id, message="m4", category="performance", type="other"),
                PlatformFeedback(client_id=owner.id, message="m5", category=None, type="other"),
            ]
        )
        db.commit()

        # Mirror the Alembic backfill so the mapping is regression-tested.
        db.execute(
            text(
                "UPDATE platform_feedback SET type = CASE category "
                "WHEN 'bug' THEN 'bug' WHEN 'feature' THEN 'feature_request' ELSE 'other' END"
            )
        )
        db.commit()
        db.expire_all()

        rows = {
            r.message: r.type for r in db.query(PlatformFeedback).filter(PlatformFeedback.client_id == owner.id).all()
        }
        assert rows == {
            "m1": "bug",
            "m2": "feature_request",
            "m3": "other",
            "m4": "other",
            "m5": "other",
        }
