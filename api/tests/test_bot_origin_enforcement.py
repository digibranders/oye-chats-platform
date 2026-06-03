"""Integration tests for the widget Origin/Referer check in get_current_bot.

These tests exercise the in-process helper instead of spinning up the full
FastAPI app, because ``get_current_bot`` is heavily intertwined with the
Redis cache and database session. The helper is the actual security boundary --
verifying its behaviour gives us the guarantees we need.
"""

from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from fastapi import HTTPException

from app.api.auth import _enforce_bot_origin


def _bot(*, enabled: bool, domains: list[str]) -> SimpleNamespace:
    return SimpleNamespace(
        id=42,
        domain_check_enabled=enabled,
        allowed_domains=domains,
    )


def _request(headers: dict[str, str]) -> MagicMock:
    req = MagicMock()
    req.headers = headers
    return req


def test_check_disabled_lets_anything_through():
    bot = _bot(enabled=False, domains=[])
    _enforce_bot_origin(bot, _request({"origin": "https://evil.com"}))  # no exception


def test_matching_origin_passes():
    bot = _bot(enabled=True, domains=["acme.com"])
    _enforce_bot_origin(bot, _request({"origin": "https://acme.com"}))


def test_matching_wildcard_subdomain_passes():
    bot = _bot(enabled=True, domains=["*.acme.com"])
    _enforce_bot_origin(bot, _request({"origin": "https://app.acme.com"}))


def test_mismatching_origin_rejects(monkeypatch):
    monkeypatch.setenv("APP_ENV", "production")
    bot = _bot(enabled=True, domains=["acme.com"])
    with pytest.raises(HTTPException) as exc:
        _enforce_bot_origin(bot, _request({"origin": "https://evil.com"}))
    assert exc.value.status_code == 403
    assert exc.value.detail == "origin_not_allowed"


def test_referer_used_when_origin_missing():
    bot = _bot(enabled=True, domains=["acme.com"])
    _enforce_bot_origin(bot, _request({"referer": "https://acme.com/page"}))


def test_missing_origin_and_referer_rejects(monkeypatch):
    monkeypatch.setenv("APP_ENV", "production")
    bot = _bot(enabled=True, domains=["acme.com"])
    with pytest.raises(HTTPException) as exc:
        _enforce_bot_origin(bot, _request({}))
    assert exc.value.status_code == 403


def test_localhost_allowed_in_dev_even_without_listing(monkeypatch):
    monkeypatch.setenv("APP_ENV", "development")
    bot = _bot(enabled=True, domains=["acme.com"])
    _enforce_bot_origin(bot, _request({"origin": "http://localhost:3000"}))


def test_localhost_blocked_in_production_unless_listed(monkeypatch):
    monkeypatch.setenv("APP_ENV", "production")
    bot = _bot(enabled=True, domains=["acme.com"])
    with pytest.raises(HTTPException):
        _enforce_bot_origin(bot, _request({"origin": "http://localhost:3000"}))


def test_request_none_with_check_enabled_fails_closed():
    bot = _bot(enabled=True, domains=["acme.com"])
    with pytest.raises(HTTPException) as exc:
        _enforce_bot_origin(bot, None)
    assert exc.value.status_code == 403


def test_stale_cache_bot_without_new_attrs_is_treated_as_disabled():
    # Older Redis cache entries won't have ``domain_check_enabled`` set on the
    # reconstructed Bot. ``_enforce_bot_origin`` must default to "off" so
    # cached widgets do not start failing the moment the new code rolls out.
    legacy = SimpleNamespace(id=1)  # no domain_check_enabled attr at all
    _enforce_bot_origin(legacy, _request({"origin": "https://anywhere.com"}))
