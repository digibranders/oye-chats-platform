"""Tests for chat route security — URL sanitization, auth, and input validation."""

from types import SimpleNamespace
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.auth import get_current_bot
from app.api.chat_routes import router


def _build_app(bot_override=None):
    app = FastAPI()
    app.include_router(router)
    if bot_override:
        app.dependency_overrides[get_current_bot] = lambda: bot_override
    return app


# ── URL sanitization ─────────────────────────────────────────────────────────


class TestUrlSanitization:
    def test_valid_https_url(self):
        from app.api.chat_routes import _sanitize_url

        assert _sanitize_url("https://example.com") == "https://example.com"

    def test_valid_http_url(self):
        from app.api.chat_routes import _sanitize_url

        assert _sanitize_url("http://example.com") == "http://example.com"

    def test_rejects_javascript_url(self):
        from app.api.chat_routes import _sanitize_url

        assert _sanitize_url("javascript:alert(1)") is None

    def test_rejects_data_url(self):
        from app.api.chat_routes import _sanitize_url

        assert _sanitize_url("data:text/html,<h1>hi</h1>") is None

    def test_none_input(self):
        from app.api.chat_routes import _sanitize_url

        assert _sanitize_url(None) is None

    def test_empty_string(self):
        from app.api.chat_routes import _sanitize_url

        assert _sanitize_url("") is None

    def test_truncates_long_url(self):
        from app.api.chat_routes import _sanitize_url

        long_url = "https://example.com/" + "a" * 3000
        result = _sanitize_url(long_url, max_len=100)
        assert len(result) == 100


# ── Email redaction ──────────────────────────────────────────────────────────


class TestEmailRedaction:
    def test_redacts_email(self):
        from app.api.chat_routes import _redact_email

        result = _redact_email("john@example.com")
        assert "john" not in result
        assert "example.com" in result
        assert result.startswith("j***@")

    def test_none_email(self):
        from app.api.chat_routes import _redact_email

        result = _redact_email(None)
        assert result == "***"

    def test_no_at_sign(self):
        from app.api.chat_routes import _redact_email

        result = _redact_email("not-an-email")
        assert result == "***"


# ── Upload URL validation ────────────────────────────────────────────────────


class TestUploadValidation:
    def test_rejects_invalid_content_type(self):
        bot = SimpleNamespace(id=1, bot_key="bot-test", client_id=1, is_active=True)
        app = _build_app(bot_override=bot)
        tc = TestClient(app)

        response = tc.post(
            "/chat/upload-url",
            json={"filename": "malware.exe", "content_type": "application/x-executable", "size": 1000},
            headers={"X-Bot-Key": "bot-test"},
        )

        assert response.status_code == 400

    def test_rejects_oversized_file(self):
        bot = SimpleNamespace(id=1, bot_key="bot-test", client_id=1, is_active=True)
        app = _build_app(bot_override=bot)
        tc = TestClient(app)

        response = tc.post(
            "/chat/upload-url",
            json={"filename": "huge.pdf", "content_type": "application/pdf", "size": 20_000_000},
            headers={"X-Bot-Key": "bot-test"},
        )

        assert response.status_code == 400

    def test_accepts_valid_image(self):
        bot = SimpleNamespace(id=1, bot_key="bot-test", client_id=1, is_active=True)
        app = _build_app(bot_override=bot)
        tc = TestClient(app)

        with (
            patch("app.services.b2_service.generate_presigned_put", return_value="https://presigned-url"),
            patch("app.services.b2_service._build_public_url", return_value="https://public-url"),
        ):
            response = tc.post(
                "/chat/upload-url",
                json={"filename": "photo.jpg", "content_type": "image/jpeg", "size": 500_000},
                headers={"X-Bot-Key": "bot-test"},
            )

        assert response.status_code == 200
        assert "upload_url" in response.json()
