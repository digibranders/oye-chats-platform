"""Registrable-domain extraction.

`user@mail.acme.co.uk` must resolve to `acme.co.uk`, not `co.uk` and not
`mail.acme.co.uk`. A naive rsplit on "." breaks every multi-part TLD, and
getting it wrong silently mis-attributes a lead to the wrong company — or
creates a cache entry keyed on a public suffix that then serves the wrong
profile to every lead under it.
"""

import pytest

from app.services.domain_normalizer import registrable_domain


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("acme.com", "acme.com"),
        ("www.acme.com", "acme.com"),
        ("mail.acme.com", "acme.com"),
        ("deep.sub.acme.com", "acme.com"),
        # Multi-part suffixes — the case a naive split gets wrong.
        ("acme.co.uk", "acme.co.uk"),
        ("mail.acme.co.uk", "acme.co.uk"),
        ("acme.co.in", "acme.co.in"),
        ("acme.com.au", "acme.com.au"),
        ("acme.gov.uk", "acme.gov.uk"),
        # Case and whitespace.
        ("  ACME.COM  ", "acme.com"),
        # Trailing dot (fully-qualified form).
        ("acme.com.", "acme.com"),
    ],
)
def test_registrable_domain(raw, expected):
    assert registrable_domain(raw) == expected


@pytest.mark.parametrize(
    "raw",
    [
        None,
        "",
        "   ",
        "acme",  # no dot
        "co.uk",  # a public suffix alone is not a company
        "com",
        ".com",
        "acme..com",
        "-.com",
        "192.168.1.1",  # an IP is not a domain
    ],
)
def test_rejects_non_company_domains(raw):
    assert registrable_domain(raw) is None


@pytest.mark.parametrize(
    "host",
    [
        # PSL *private* section. These are the collisions that matter most:
        # company_profile.domain is a CROSS-TENANT primary key, so resolving
        # acme.myshopify.com to "myshopify.com" would serve "Shopify" as the
        # company to every other customer's Shopify-hosted lead.
        "acme.myshopify.com",
        "acme.github.io",
        "acme.gitlab.io",
        "acme.vercel.app",
        "acme.netlify.app",
        "acme.pages.dev",
        "acme.workers.dev",
        "acme.web.app",
        "acme.firebaseapp.com",
        "acme.herokuapp.com",
        "acme.azurewebsites.net",
        "acme.wixsite.com",
        "acme.squarespace.com",
        "acme.blogspot.com",
        "acme.notion.site",
        "acme.webflow.io",
        # ICANN second-levels the original curated set missed.
        "acme.com.co",
        "acme.com.pl",
        "acme.com.ua",
        "acme.com.pe",
        "acme.com.es",
        "acme.co.cr",
        "acme.or.kr",
        "acme.ne.kr",
    ],
)
def test_platform_and_missing_suffixes_never_collapse_onto_the_host(host):
    """The registrable domain must include the customer's own label.

    Returning the bare host ("myshopify.com", "com.co") would poison a
    cache key shared by every tenant.
    """
    result = registrable_domain(host)
    assert result is not None
    assert result.startswith("acme."), f"{host} collapsed to {result!r}"


@pytest.mark.parametrize(
    "host",
    [
        # An UNLISTED multi-part suffix must degrade to None, not to a
        # public suffix used as a shared cache key.
        "acme.co.zz",
        "acme.com.zz",
        "acme.org.zz",
        # Bare public suffixes, however they arrive.
        "myshopify.com",
        "github.io",
        "vercel.app",
        "com.co",
    ],
)
def test_unknown_or_bare_public_suffix_degrades_to_none(host):
    """A miss is cheap — the caller falls back. A poisoned shared key is not."""
    assert registrable_domain(host) is None


def test_label_regex_rejects_an_embedded_newline():
    """`$` matches before a trailing newline, so `match()` let a newline INSIDE
    a label through. The value becomes a DB primary key and part of a crawl
    URL, so it must be `fullmatch`.

    A newline at the very END is different — surrounding whitespace is stripped
    before validation, which is the desired normalisation for a value read from
    a file or a header.
    """
    assert registrable_domain("sub.acme\n.com") is None
    assert registrable_domain("acme\n.com") is None
    assert registrable_domain("acme.com\n") == "acme.com"


@pytest.mark.parametrize(
    "host",
    ["acme.local", "acme.internal", "localhost.localdomain", "999.999.999.999", "123.456"],
)
def test_reserved_and_junk_hosts_are_rejected(host):
    assert registrable_domain(host) is None


def test_total_length_is_bounded():
    assert registrable_domain("a" * 60 + "." + "b" * 60 + "." + "c" * 150 + ".com") is None
