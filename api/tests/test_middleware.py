"""Tests for middleware utilities."""

import os
from unittest.mock import patch

from app.core.middleware import get_cors_origins


class TestCorsOrigins:
    def test_development_defaults(self):
        with patch.dict(os.environ, {"APP_ENV": "development"}, clear=False):
            origins = get_cors_origins()
            assert "http://localhost:3000" in origins
            assert "http://localhost:5173" in origins
            assert "http://localhost:8000" in origins

    def test_production_from_env(self):
        with patch.dict(
            os.environ,
            {"APP_ENV": "production", "CORS_ORIGINS": "https://app.example.com,https://example.com"},
            clear=False,
        ):
            origins = get_cors_origins()
            assert origins == ["https://app.example.com", "https://example.com"]

    def test_production_empty_origins(self):
        with patch.dict(os.environ, {"APP_ENV": "production", "CORS_ORIGINS": ""}, clear=False):
            origins = get_cors_origins()
            assert origins == []

    def test_default_is_development(self):
        with patch.dict(os.environ, {}, clear=False):
            if "APP_ENV" in os.environ:
                del os.environ["APP_ENV"]
            origins = get_cors_origins()
            assert len(origins) > 0  # Should return dev defaults
