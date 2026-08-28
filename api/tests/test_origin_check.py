"""Tests for app.core.origin_check (widget embed domain whitelist)."""

import pytest

from app.core.origin_check import (
    extract_hostname,
    is_origin_allowed,
    normalize_domain_input,
    origin_check_applies,
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


# ── the ``www.`` equivalence ─────────────────────────────────────────────────
#
# ``normalize_domain_input`` stores ``www.acme.com`` as ``acme.com``, so the apex
# entry is the ONLY way a customer can describe a site served from ``www.``. An
# exact entry therefore also admits its ``www.`` host. The negative cases below
# are the point of the parametrisation: the match must be on the ``www.`` label,
# never on a string prefix, and it must not generalise to other subdomains.


@pytest.mark.parametrize(
    ("host", "allowed", "expected"),
    [
        # The bug: the customer's own homepage, rejected by their own allowlist.
        ("www.acme.com", ["acme.com"], True),
        # The apex itself still matches, unchanged.
        ("acme.com", ["acme.com"], True),
        # Prefix, not label. ``wwwacme.com`` is a different registrable domain
        # that anyone can buy, and must never be admitted by ``acme.com``.
        ("wwwacme.com", ["acme.com"], False),
        ("www-acme.com", ["acme.com"], False),
        # ``www.`` of an unrelated domain is still unrelated.
        ("www.evil.com", ["acme.com"], False),
        # Only the ``www`` label is widened -- no general subdomain access.
        ("app.acme.com", ["acme.com"], False),
        ("mail.www.acme.com", ["acme.com"], False),
        ("www.acme.com.evil.net", ["acme.com"], False),
        # Wildcard behaviour is untouched: ``*.acme.com`` already covered ``www``.
        ("www.acme.com", ["*.acme.com"], True),
        # ...and still does not cover the apex.
        ("acme.com", ["*.acme.com"], False),
        # Local hosts are excluded from the widening: ``www.localhost`` is not a
        # name anything is served from, so a ``localhost`` entry must not admit it.
        ("www.localhost", ["localhost"], False),
        ("www.127.0.0.1", ["127.0.0.1"], False),
        ("localhost", ["localhost"], True),
    ],
)
def test_www_matching(host, allowed, expected):
    assert is_origin_allowed(host, allowed, app_env="production") is expected


@pytest.mark.parametrize(
    "entry",
    [
        "www.acme.com",
        # Repeated labels too. A single strip left this normalizing to
        # ``www.acme.com``, an entry that admits ``www.www.acme.com`` and
        # silently EXCLUDES the customer's own apex.
        "www.www.acme.com",
        "www.www.www.acme.com",
        "https://www.acme.com/contact",
        "WWW.Acme.com",
    ],
)
def test_no_entry_can_be_stored_as_a_www_host(entry):
    """The premise the ``www.`` matching arm rests on, tested as a rule.

    That arm is only safe because the widening is one-directional: an entry can
    never itself be a ``www.`` host, so it can only ever widen apex -> www and
    never www -> some other apex. That holds only if EVERY leading ``www.`` is
    stripped, which is why this asserts a rule rather than one example.
    """
    assert normalize_domain_input(entry) == "acme.com"


def test_www_widening_is_one_directional():
    """A ``www.`` host is admitted by the apex, never the reverse."""
    assert normalize_domain_input("www.acme.com") == "acme.com"
    # And the hostname side is deliberately NOT stripped, which is why the
    # matching arm has to exist at all.
    assert extract_hostname("https://www.acme.com") == "www.acme.com"
    assert is_origin_allowed("www.acme.com", ["acme.com"], app_env="production")
    # The reverse: an apex host is NOT admitted by a *.-less subdomain entry.
    assert not is_origin_allowed("acme.com", ["shop.acme.com"], app_env="production")


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


# ── origin_check_applies ─────────────────────────────────────────────────────
#
# The shared gate that decides whether the allowlist is enforced at all. HTTP
# (``auth._enforce_bot_origin``) and the visitor WebSocket both call it, so this
# is where the fail-open-on-empty contract is pinned once for both transports.


@pytest.mark.parametrize(
    ("enabled", "allowed", "expected"),
    [
        (False, [], False),
        (False, ["acme.com"], False),
        # The bug that bricked live chat: flag on, nothing configured. This must
        # be "do not enforce", not "enforce an empty list" (which rejects every
        # host in production).
        (True, [], False),
        (True, ["acme.com"], True),
        # Defensive: a NULL JSONB column reaches the caller as None.
        (True, None, False),
        (None, ["acme.com"], False),
    ],
)
def test_origin_check_applies(enabled, allowed, expected):
    assert origin_check_applies(domain_check_enabled=enabled, allowed=allowed) is expected


@pytest.mark.parametrize(
    "header",
    [
        "https://" + "a" * 5000,
        "https://" + ("a" * 60 + ".") * 20 + "com",
    ],
)
def test_an_oversized_hostname_is_refused_rather_than_returned(header):
    """The header is attacker-supplied and the hostname is not only compared.

    ``bot_routes`` stores it as ``Bot.widget_last_origin``, which rides into the
    bot-config cache entry every widget bootstrap reads. DNS caps a name at 253
    characters, so anything longer is not a host: refusing it keeps junk out of
    a hot-path cache without inventing a truncated string the caller could not
    tell apart from a real hostname.
    """
    assert extract_hostname(header) is None


def test_a_hostname_at_the_dns_limit_still_parses():
    """The bound is the DNS limit, not an arbitrary short cap."""
    host = "a" * 249 + ".com"
    assert extract_hostname(f"https://{host}") == host
