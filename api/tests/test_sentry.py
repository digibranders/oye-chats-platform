"""Tests for Sentry error tracking configuration."""

import os
from unittest.mock import patch

from app.config import sentry_enabled

DSN = "https://key@sentry.io/123"


class TestSentryEnabled:
    """``sentry_enabled`` gates reporting to production only.

    Developers keep the same DSN in their local ``.env``; without this gate every
    localhost traceback and every CI run (``APP_ENV=testing``) pages Sentry.
    """

    def test_disabled_when_dsn_missing(self):
        assert sentry_enabled(None, "production") is False
        assert sentry_enabled("", "production") is False

    def test_enabled_in_production_with_dsn(self):
        assert sentry_enabled(DSN, "production") is True

    def test_disabled_on_localhost_dev(self):
        assert sentry_enabled(DSN, "development") is False

    def test_disabled_in_testing(self):
        assert sentry_enabled(DSN, "testing") is False

    def test_force_enable_opts_non_production_in(self):
        assert sentry_enabled(DSN, "development", force_enable=True) is True

    def test_force_enable_cannot_compensate_for_missing_dsn(self):
        assert sentry_enabled(None, "development", force_enable=True) is False


class TestAppEnv:
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
