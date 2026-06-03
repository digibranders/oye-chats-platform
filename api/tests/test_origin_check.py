"""Tests for app.core.origin_check (widget embed domain whitelist)."""

import pytest

from app.core.origin_check import (
    extract_hostname,
    is_origin_allowed,
    normalize_domain_input,
)

# ── extract_hostname ─────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("header", "expected"),
    [
        ("https://acme.com", "acme.com"),
        ("https://app.acme.com:8443/path?x=1", "app.acme.com"),
        ("http://Acme.COM", "acme.com"),
        ("https://www.acme.com/foo/bar", "www.acme.com"),  # www kept here -- decision is in matching, not extraction
        ("acme.com", "acme.com"),  # bare hostname (Referer fallback edge case)
        ("https://127.0.0.1:5174", "127.0.0.1"),
        ("https://localhost:5173", "localhost"),
    ],
)
def test_extract_hostname_happy(header, expected):
    assert extract_hostname(header) == expected


@pytest.mark.parametrize("header", ["", "   ", None])
def test_extract_hostname_empty(header):
    assert extract_hostname(header) is None


# ── normalize_domain_input ───────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("acme.com", "acme.com"),
        ("  ACME.com  ", "acme.com"),
        ("https://acme.com/", "acme.com"),
        ("https://www.acme.com/contact", "acme.com"),
        ("http://acme.com:8080/", "acme.com"),
        ("*.acme.com", "*.acme.com"),
        ("*.WWW.acme.com", "*.acme.com"),  # strip www inside wildcard too
        ("localhost", "localhost"),
        ("127.0.0.1", "127.0.0.1"),
    ],
)
def test_normalize_domain_input_happy(raw, expected):
    assert normalize_domain_input(raw) == expected


@pytest.mark.parametrize(
    "raw",
    [
        "",
        "   ",
        "notadomain",
        "***.acme.com",
        "acme",
        "..",
        "http://",
    ],
)
def test_normalize_domain_input_rejects_garbage(raw):
    with pytest.raises(ValueError):
        normalize_domain_input(raw)


def test_normalize_domain_input_none_raises():
    with pytest.raises(ValueError):
        normalize_domain_input(None)  # type: ignore[arg-type]


# ── is_origin_allowed ────────────────────────────────────────────────────────


def test_exact_match():
    assert is_origin_allowed("acme.com", ["acme.com"], app_env="production")


def test_exact_match_case_insensitive():
    assert is_origin_allowed("ACME.com", ["acme.com"], app_env="production")


def test_no_match_rejects():
    assert not is_origin_allowed("evil.com", ["acme.com"], app_env="production")


def test_wildcard_matches_subdomain():
    assert is_origin_allowed("app.acme.com", ["*.acme.com"], app_env="production")
    assert is_origin_allowed("blog.acme.com", ["*.acme.com"], app_env="production")


def test_wildcard_does_not_match_apex():
    # *.acme.com must NOT match acme.com itself -- the apex must be listed explicitly.
    assert not is_origin_allowed("acme.com", ["*.acme.com"], app_env="production")


def test_wildcard_plus_apex():
    allowed = ["acme.com", "*.acme.com"]
    assert is_origin_allowed("acme.com", allowed, app_env="production")
    assert is_origin_allowed("shop.acme.com", allowed, app_env="production")


def test_wildcard_does_not_match_unrelated_suffix():
    # Common pitfall: ``*.acme.com`` should NOT match ``evilacme.com``.
    assert not is_origin_allowed("evilacme.com", ["*.acme.com"], app_env="production")


def test_localhost_auto_allowed_in_dev():
    assert is_origin_allowed("localhost", [], app_env="development")
    assert is_origin_allowed("127.0.0.1", [], app_env="development")


def test_localhost_blocked_in_production_unless_listed():
    assert not is_origin_allowed("localhost", [], app_env="production")
    assert is_origin_allowed("localhost", ["localhost"], app_env="production")


def test_empty_hostname_rejected():
    assert not is_origin_allowed(None, ["acme.com"], app_env="production")
    assert not is_origin_allowed("", ["acme.com"], app_env="production")


def test_empty_allowed_list_in_production_rejects_everything():
    assert not is_origin_allowed("acme.com", [], app_env="production")


def test_allowed_entry_with_whitespace_and_empty_strings_skipped():
    # Defensive: stale data with blank entries must not become an allow-all.
    assert not is_origin_allowed("evil.com", ["", "   "], app_env="production")
    assert is_origin_allowed("acme.com", ["", "acme.com", "   "], app_env="production")
