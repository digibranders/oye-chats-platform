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


def _request(headers: dict[str, str], *, base_url: str = "https://api.oyechats.com/") -> MagicMock:
    """A widget request. ``base_url`` is OUR host, which serves the demo page.

    Defaulted to a real value rather than left as a ``MagicMock`` attribute so
    every test states the host it is being served from: the check now treats
    that host as allowed, and a test whose own host is unreadable would pass for
    the wrong reason.
    """
    req = MagicMock()
    req.headers = headers
    req.base_url = base_url
    return req


def test_check_disabled_lets_anything_through():
    bot = _bot(enabled=False, domains=[])
    _enforce_bot_origin(bot, _request({"origin": "https://evil.com"}))  # no exception


def test_enabled_but_empty_allowlist_fails_open(monkeypatch):
    # Secure-by-default relies on this: enabling the flag on a bot that has no
    # configured domains must NOT brick it. Enforcement only bites once an
    # allowlist is actually configured.
    monkeypatch.setenv("APP_ENV", "production")
    bot = _bot(enabled=True, domains=[])
    _enforce_bot_origin(bot, _request({"origin": "https://anywhere.com"}))  # no exception


def test_enabled_empty_allowlist_allows_missing_headers(monkeypatch):
    # Fail-open must short-circuit before the missing-headers hard reject too,
    # so a bot with no configured domains is never rejected on that path.
    monkeypatch.setenv("APP_ENV", "production")
    bot = _bot(enabled=True, domains=[])
    _enforce_bot_origin(bot, _request({}))  # no exception


def test_matching_origin_passes():
    bot = _bot(enabled=True, domains=["acme.com"])
    _enforce_bot_origin(bot, _request({"origin": "https://acme.com"}))


def test_matching_wildcard_subdomain_passes():
    bot = _bot(enabled=True, domains=["*.acme.com"])
    _enforce_bot_origin(bot, _request({"origin": "https://app.acme.com"}))


def test_www_origin_passes_against_apex_entry(monkeypatch):
    """The customer's own homepage must not 403 against their own allowlist.

    ``normalize_domain_input`` stores ``www.acme.com`` as ``acme.com``, so the
    apex entry is the only thing the customer can have configured, while the
    browser sends ``https://www.acme.com`` as the Origin.
    """
    monkeypatch.setenv("APP_ENV", "production")
    bot = _bot(enabled=True, domains=["acme.com"])
    _enforce_bot_origin(bot, _request({"origin": "https://www.acme.com"}))  # no exception


def test_www_of_an_unrelated_domain_still_rejects(monkeypatch):
    """The widening is one label on a vouched-for name, not a prefix match."""
    monkeypatch.setenv("APP_ENV", "production")
    bot = _bot(enabled=True, domains=["acme.com"])
    for origin in ("https://www.evil.com", "https://wwwacme.com", "https://app.acme.com"):
        with pytest.raises(HTTPException) as exc:
            _enforce_bot_origin(bot, _request({"origin": origin}))
        assert exc.value.status_code == 403


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


# ---------------------------------------------------------------------------
# The hosted demo page.
#
# ``GET /demo/{bot_key}`` is served BY THE API, so a widget on it reports the
# API as its origin. That host is in nobody's allowlist, so the config call
# 403'd: the widget fell back to "OyeChats AI" with the default avatar and
# greeting instead of the customer's branding, and the live-chat socket closed
# 4403 so nobody could reach a person from it. Since ``create_bot`` defaults
# ``domain_check_enabled`` on and derives a list from the customer's website,
# that was very nearly every bot, and the "Share a link instead" URL printed on
# Deploy was broken for all of them.
# ---------------------------------------------------------------------------


def test_our_own_host_is_allowed_so_the_demo_page_works():
    bot = _bot(enabled=True, domains=["northwindsecurity.com"])
    request = _request(
        {"origin": "https://api.oyechats.com"},
        base_url="https://api.oyechats.com/",
    )
    _enforce_bot_origin(bot, request)  # no exception


def test_our_own_host_is_matched_exactly_not_as_a_suffix():
    # The exemption is an equality test. A host that merely ENDS with ours is a
    # domain somebody else can register.
    bot = _bot(enabled=True, domains=["northwindsecurity.com"])
    for forged in ("api.oyechats.com.evil.com", "evil-api.oyechats.com.co", "notapi.oyechats.com"):
        request = _request({"origin": f"https://{forged}"}, base_url="https://api.oyechats.com/")
        with pytest.raises(HTTPException) as excinfo:
            _enforce_bot_origin(bot, request)
        assert excinfo.value.status_code == 403


def test_a_foreign_site_is_still_refused_while_the_demo_works():
    # The exemption must not become a general fail-open: the whole point of the
    # allowlist is that a browser on somebody else's site cannot boot this
    # widget, and a browser cannot claim to be our host.
    bot = _bot(enabled=True, domains=["northwindsecurity.com"])
    request = _request({"origin": "https://evil.com"}, base_url="https://api.oyechats.com/")
    with pytest.raises(HTTPException) as excinfo:
        _enforce_bot_origin(bot, request)
    assert excinfo.value.status_code == 403
