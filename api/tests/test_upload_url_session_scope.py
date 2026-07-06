"""Regression tests for presigned-upload session scoping (roadmap §0.4).

``POST /chat/upload-url`` mints a presigned CDN PUT URL. The bot key is public,
so the URL must be bound to a chat session that belongs to the authenticated bot
— otherwise anyone could host arbitrary content on cdn.oyechats.com under a
victim's key. A session_id that is missing or belongs to another bot -> 404, and
no presigned URL is issued.

MagicMock session — no Postgres; the R2 presign helpers are patched.
"""

from contextlib import contextmanager, suppress
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.auth import get_current_bot
from app.api.chat_routes import router

BOT = SimpleNamespace(id=1, name="Bot")


@contextmanager
def _session_context(session):
    yield session


class _ScalarOne:
    def __init__(self, value):
        self._value = value

    def scalar_one_or_none(self):
        return self._value


def _client():
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_current_bot] = lambda: BOT
    return TestClient(app)


def _body(session_id="s1"):
    return {
        "filename": "photo.png",
        "content_type": "image/png",
        "size": 1024,
        "session_id": session_id,
    }


class TestUploadUrlSessionScope:
    @pytest.fixture(autouse=True)
    def _reset_rate_limiter(self):
        from app.core.rate_limit import limiter

        with suppress(Exception):
            limiter.reset()
        yield

    def _patch_session(self, monkeypatch, *, owned_id):
        from app.api import chat_routes

        session = MagicMock()
        session.execute.return_value = _ScalarOne(owned_id)
        monkeypatch.setattr(chat_routes, "get_session", lambda: _session_context(session))

    def test_foreign_or_missing_session_rejected(self, monkeypatch):
        # Ownership query returns nothing -> session isn't this bot's. The route
        # 404s BEFORE it ever imports r2_service, so this (the security-critical
        # assertion) runs without the R2/boto3 dependency present.
        self._patch_session(monkeypatch, owned_id=None)
        resp = _client().post("/chat/upload-url", json=_body("someone-elses-session"))
        assert resp.status_code == 404

    def test_owned_session_gets_presigned_post(self, monkeypatch):
        pytest.importorskip("boto3", reason="r2_service requires boto3 to import")
        from app.services import r2_service

        self._patch_session(monkeypatch, owned_id="s1")
        issued: list = []

        def _fake_presign_post(key, content_type, max_bytes, *a, **k):
            # The size ceiling must be threaded through to the policy.
            issued.append((key, max_bytes))
            return {"url": f"https://r2.example/post/{key}", "fields": {"key": key, "Content-Type": content_type}}

        monkeypatch.setattr(r2_service, "generate_presigned_post", _fake_presign_post)
        monkeypatch.setattr(r2_service, "_build_public_url", lambda key: f"https://cdn.oyechats.com/{key}")

        resp = _client().post("/chat/upload-url", json=_body("s1"))
        assert resp.status_code == 200
        data = resp.json()
        assert data["upload_url"].startswith("https://r2.example/post/")
        assert data["fields"]["Content-Type"] == "image/png"
        assert data["file_url"].startswith("https://cdn.oyechats.com/")
        assert len(issued) == 1
        # 10 MB ceiling is enforced server-side via the policy, not the client size.
        assert issued[0][1] == 10 * 1024 * 1024
