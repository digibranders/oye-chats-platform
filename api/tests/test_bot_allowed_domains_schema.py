"""Tests for the bot create/update schema layer wrt allowed_domains."""

import pytest
from pydantic import ValidationError

from app.api.bot_routes import (
    CreateBotRequest,
    UpdateBotRequest,
    _derive_allowed_domains_from_website,
)


def test_create_normalizes_and_dedupes_domains():
    req = CreateBotRequest(
        name="Test",
        allowed_domains=["https://www.Acme.com/path", "*.acme.com", "acme.com", "ACME.com"],
    )
    # https://www.Acme.com/path -> acme.com (dedup with later acme.com),
    # *.acme.com stays, then acme.com is deduped.
    assert req.allowed_domains == ["acme.com", "*.acme.com"]


def test_create_rejects_invalid_domain():
    with pytest.raises(ValidationError):
        CreateBotRequest(name="Test", allowed_domains=["notadomain"])


def test_create_allows_omitted_field():
    req = CreateBotRequest(name="Test")
    assert req.allowed_domains is None
    assert req.domain_check_enabled is None


def test_create_rejects_too_many_domains():
    with pytest.raises(ValidationError):
        CreateBotRequest(
            name="Test",
            allowed_domains=[f"site{i}.com" for i in range(60)],
        )


def test_update_validator_runs():
    req = UpdateBotRequest(allowed_domains=["acme.com", "https://shop.acme.com"])
    assert req.allowed_domains == ["acme.com", "shop.acme.com"]


def test_update_rejects_non_string_entry():
    with pytest.raises(ValidationError):
        UpdateBotRequest(allowed_domains=["acme.com", 42])  # type: ignore[list-item]


def test_derive_from_website_apex_plus_wildcard():
    assert _derive_allowed_domains_from_website("https://www.acme.com/about") == [
        "acme.com",
        "*.acme.com",
    ]


def test_derive_from_website_empty_or_invalid():
    assert _derive_allowed_domains_from_website(None) == []
    assert _derive_allowed_domains_from_website("") == []
    assert _derive_allowed_domains_from_website("not a url") == []


def test_derive_from_website_localhost_single_entry():
    # Wildcards over localhost make no sense, so we only emit the literal.
    assert _derive_allowed_domains_from_website("http://localhost:5174") == ["localhost"]
