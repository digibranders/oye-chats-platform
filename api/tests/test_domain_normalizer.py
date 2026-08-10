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


def test_domain_from_email_uses_the_same_rules():
    from app.services.domain_normalizer import domain_from_email

    assert domain_from_email("Gaurav@Mail.Acme.CO.UK") == "acme.co.uk"
    assert domain_from_email("no-at-sign") is None
    assert domain_from_email(None) is None
