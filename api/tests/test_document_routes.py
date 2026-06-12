"""Tests for app.api.document_routes — document management endpoints."""

from contextlib import contextmanager
from io import BytesIO
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.auth import (
    get_current_client_or_operator,
    require_active_subscription_for_workspace,
)
from app.api.document_routes import router


@contextmanager
def _session_ctx(session):
    yield session


def _build_app(auth_override=None):
    app = FastAPI()
    app.include_router(router)
    if auth_override:
        app.dependency_overrides[get_current_client_or_operator] = lambda: auth_override
    # See test_bot_routes — gate semantics live in test_trial_enforcement;
    # bypassing here keeps these tests focused on document-route logic.
    app.dependency_overrides[require_active_subscription_for_workspace] = lambda: None
    return app


def _client_auth(client_id=1):
    return {
        "type": "client",
        "entity": SimpleNamespace(id=client_id),
        "client_id": client_id,
        "operator_id": None,
    }


def _operator_auth(client_id=1, role="operator"):
    return {
        "type": "operator",
        "entity": SimpleNamespace(id=10, client_id=client_id, role=role),
        "client_id": client_id,
        "operator_id": 10,
    }


# ── List documents ───────────────────────────────────────────────────────────


class TestListDocuments:
    def test_returns_documents(self, monkeypatch):
        from app.api import document_routes

        session = MagicMock()
        monkeypatch.setattr(document_routes, "get_session", lambda: _session_ctx(session))
        monkeypatch.setattr(
            document_routes,
            "get_ingested_documents",
            lambda *a, **kw: [{"name": "guide.pdf", "ingested_at": "2024-01-01"}],
        )

        app = _build_app(auth_override=_client_auth())
        tc = TestClient(app)
        response = tc.get("/documents")

        assert response.status_code == 200
        assert len(response.json()) == 1
        assert response.json()[0]["name"] == "guide.pdf"

    def test_empty_list(self, monkeypatch):
        from app.api import document_routes

        session = MagicMock()
        monkeypatch.setattr(document_routes, "get_session", lambda: _session_ctx(session))
        monkeypatch.setattr(document_routes, "get_ingested_documents", lambda *a, **kw: [])

        app = _build_app(auth_override=_client_auth())
        tc = TestClient(app)
        response = tc.get("/documents")

        assert response.status_code == 200
        assert response.json() == []


# ── Delete document ──────────────────────────────────────────────────────────


class TestDeleteDocument:
    def test_deletes_by_name(self, monkeypatch):
        from app.api import document_routes

        session = MagicMock()
        # First delete attempt by root_name: 5 deleted
        session.query.return_value.filter.return_value.delete.return_value = 5
        monkeypatch.setattr(document_routes, "get_session", lambda: _session_ctx(session))
        monkeypatch.setattr(document_routes, "cache_delete_prefix", MagicMock())

        app = _build_app(auth_override=_client_auth())
        tc = TestClient(app)
        response = tc.delete("/documents/guide.pdf?bot_id=1")

        assert response.status_code == 200
        assert response.json()["chunks_removed"] == 5

    def test_not_found(self, monkeypatch):
        from app.api import document_routes

        session = MagicMock()
        session.query.return_value.filter.return_value.delete.return_value = 0
        monkeypatch.setattr(document_routes, "get_session", lambda: _session_ctx(session))

        app = _build_app(auth_override=_client_auth())
        tc = TestClient(app)
        response = tc.delete("/documents/nonexistent.pdf")

        assert response.status_code == 404

    def test_regular_operator_blocked(self, monkeypatch):
        from app.api import document_routes

        monkeypatch.setattr(document_routes, "get_session", lambda: _session_ctx(MagicMock()))

        app = _build_app(auth_override=_operator_auth(role="operator"))
        tc = TestClient(app)
        response = tc.delete("/documents/doc.pdf")

        assert response.status_code == 403


# ── Upload validation ────────────────────────────────────────────────────────


class TestIngestDocuments:
    def test_no_files_rejected(self, monkeypatch):
        from app.api import document_routes

        monkeypatch.setattr(document_routes, "get_session", lambda: _session_ctx(MagicMock()))

        app = _build_app(auth_override=_client_auth())
        tc = TestClient(app)
        response = tc.post("/ingest")

        # No files should be rejected
        assert response.status_code in (400, 422)

    def test_unsupported_file_type_skipped(self, monkeypatch):
        from app.api import document_routes

        monkeypatch.setattr(document_routes, "get_session", lambda: _session_ctx(MagicMock()))

        app = _build_app(auth_override=_client_auth())
        tc = TestClient(app)

        # Upload a .csv file (unsupported)
        files = [("files", ("data.csv", BytesIO(b"a,b,c"), "text/csv"))]
        response = tc.post("/ingest", files=files)

        # Should reject since no valid files
        assert response.status_code == 400

    def test_oversized_file_rejected(self, monkeypatch):
        from app.api import document_routes

        monkeypatch.setattr(document_routes, "get_session", lambda: _session_ctx(MagicMock()))

        app = _build_app(auth_override=_client_auth())
        tc = TestClient(app)

        # Create a file that exceeds 20MB limit
        large_content = b"x" * (21 * 1024 * 1024)
        files = [("files", ("big.pdf", BytesIO(large_content), "application/pdf"))]
        response = tc.post("/ingest", files=files)

        assert response.status_code == 413

    def test_regular_operator_blocked(self, monkeypatch):
        from app.api import document_routes

        monkeypatch.setattr(document_routes, "get_session", lambda: _session_ctx(MagicMock()))

        app = _build_app(auth_override=_operator_auth(role="operator"))
        tc = TestClient(app)

        files = [("files", ("doc.pdf", BytesIO(b"content"), "application/pdf"))]
        response = tc.post("/ingest", files=files)

        assert response.status_code == 403


# ── Memory check ─────────────────────────────────────────────────────────────


class TestMemoryCheck:
    def test_raises_when_over_threshold(self):
        from app.api.document_routes import _check_memory

        mem = SimpleNamespace(percent=95.0)
        with (
            patch("app.api.document_routes.psutil") as mock_psutil,
            patch.dict("os.environ", {"CRAWL_MEMORY_THRESHOLD": "90"}),
        ):
            mock_psutil.virtual_memory.return_value = mem
            import pytest
            from fastapi import HTTPException

            with pytest.raises(HTTPException) as exc_info:
                _check_memory()
            assert exc_info.value.status_code == 503

    def test_passes_when_under_threshold(self):
        from app.api.document_routes import _check_memory

        mem = SimpleNamespace(percent=50.0)
        with (
            patch("app.api.document_routes.psutil") as mock_psutil,
            patch.dict("os.environ", {"CRAWL_MEMORY_THRESHOLD": "90"}),
        ):
            mock_psutil.virtual_memory.return_value = mem
            # Should not raise
            _check_memory()


# ── Bot ownership verification ───────────────────────────────────────────────


class TestBotOwnership:
    def test_valid_ownership_passes(self, monkeypatch):
        from app.api import document_routes

        session = MagicMock()
        bot = SimpleNamespace(id=5, client_id=1)
        session.execute.return_value.scalar_one_or_none.return_value = bot
        monkeypatch.setattr(document_routes, "get_session", lambda: _session_ctx(session))

        # Should not raise
        document_routes._verify_bot_ownership(5, 1)

    def test_invalid_ownership_raises(self, monkeypatch):
        from app.api import document_routes

        session = MagicMock()
        session.execute.return_value.scalar_one_or_none.return_value = None
        monkeypatch.setattr(document_routes, "get_session", lambda: _session_ctx(session))

        import pytest
        from fastapi import HTTPException

        with pytest.raises(HTTPException) as exc_info:
            document_routes._verify_bot_ownership(5, 999)
        assert exc_info.value.status_code == 403

    def test_none_bot_id_skips(self):
        from app.api.document_routes import _verify_bot_ownership

        # Should not raise or query DB
        _verify_bot_ownership(None, 1)


# ── Knowledge management access ─────────────────────────────────────────────


class TestKnowledgeManagementAccess:
    def test_client_allowed(self):
        from app.api.document_routes import _require_knowledge_management_access

        auth = _client_auth()
        # Should not raise
        _require_knowledge_management_access(auth)

    def test_admin_operator_allowed(self):
        from app.api.document_routes import _require_knowledge_management_access

        auth = _operator_auth(role="admin")
        _require_knowledge_management_access(auth)

    def test_regular_operator_blocked(self):
        from fastapi import HTTPException

        from app.api.document_routes import _require_knowledge_management_access

        auth = _operator_auth(role="operator")
        import pytest

        with pytest.raises(HTTPException) as exc_info:
            _require_knowledge_management_access(auth)
        assert exc_info.value.status_code == 403
