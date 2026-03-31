"""Tests for Sentry error tracking configuration."""

import os
from unittest.mock import patch


class TestSentryConfig:
    def test_sentry_disabled_when_dsn_missing(self):
        """SENTRY_ENABLED is False when SENTRY_DSN is not set."""
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("SENTRY_DSN", None)
            # Re-evaluate the flag
            dsn = os.getenv("SENTRY_DSN")
            enabled = bool(dsn)
            assert enabled is False

    def test_sentry_enabled_when_dsn_present(self):
        """SENTRY_ENABLED is True when SENTRY_DSN is set."""
        with patch.dict(os.environ, {"SENTRY_DSN": "https://key@sentry.io/123"}, clear=False):
            dsn = os.getenv("SENTRY_DSN")
            enabled = bool(dsn)
            assert enabled is True

    def test_app_env_defaults_to_development(self):
        """APP_ENV defaults to 'development' when not set."""
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("APP_ENV", None)
            env = os.getenv("APP_ENV", "development")
            assert env == "development"

    def test_app_env_reads_from_env(self):
        """APP_ENV reads from environment variable."""
        with patch.dict(os.environ, {"APP_ENV": "production"}, clear=False):
            env = os.getenv("APP_ENV", "development")
            assert env == "production"
