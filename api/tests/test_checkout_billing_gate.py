"""Paid checkout requires a complete buyer identity (F6).

An invoice is issued from a WEBHOOK, so there is no second chance to ask who
was billed. Today a customer can pay with every billing field NULL, which is
why the rendered tax invoice reads "BILL TO: gaurav" with no address and no
GSTIN — and a B2B customer without their GSTIN on the document cannot claim
input tax credit, which is a commercial problem before it is a compliance one.
"""

import os

import pytest

from app.db.models import Client

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")


def _client_row(db, email, **fields):
    row = Client(name="Gate", email=email, api_key=f"key-{email}", **fields)
    db.add(row)
    db.flush()
    return row


_FULL_IN = {
    "legal_name": "Fynix Digital",
    "billing_address": {"line1": "1 MG Road", "city": "Pune", "postal_code": "411001"},
    "billing_country": "IN",
    "billing_state_code": "27",
}


def test_missing_identity_lists_every_missing_field_in_display_order(db):
    from app.api.subscription_routes import _missing_billing_fields

    client = _client_row(db, "bare@test.dev", billing_country="IN")
    assert _missing_billing_fields(client) == ["legal_name", "billing_address", "billing_state_code"]


def test_complete_indian_identity_passes(db):
    from app.api.subscription_routes import _missing_billing_fields

    assert _missing_billing_fields(_client_row(db, "full@test.dev", **_FULL_IN)) == []


def test_state_code_is_not_required_outside_india(db):
    """An export has no Indian place of supply, so a state code is meaningless."""
    from app.api.subscription_routes import _missing_billing_fields

    client = _client_row(
        db,
        "export@test.dev",
        legal_name="Acme Inc",
        billing_address={"line1": "1 Market St", "city": "SF", "postal_code": "94105"},
        billing_country="US",
    )
    assert _missing_billing_fields(client) == []


def test_state_code_is_required_when_country_is_unset(db):
    """NULL country defaults to IN elsewhere in the billing stack, so the
    stricter Indian rule must apply rather than silently passing."""
    from app.api.subscription_routes import _missing_billing_fields

    client = _client_row(
        db,
        "nocountry@test.dev",
        legal_name="X",
        billing_address={"line1": "1 MG Road"},
    )
    assert _missing_billing_fields(client) == ["billing_state_code"]


def test_address_without_line1_counts_as_missing(db):
    """Rule 46 wants an address, not a city on its own."""
    from app.api.subscription_routes import _missing_billing_fields

    client = _client_row(
        db,
        "partial@test.dev",
        legal_name="X",
        billing_address={"city": "Pune"},
        billing_country="IN",
        billing_state_code="27",
    )
    assert _missing_billing_fields(client) == ["billing_address"]


def test_whitespace_only_values_do_not_satisfy_the_gate(db):
    from app.api.subscription_routes import _missing_billing_fields

    client = _client_row(
        db,
        "blank@test.dev",
        legal_name="   ",
        billing_address={"line1": "  "},
        billing_country="IN",
        billing_state_code=" ",
    )
    assert _missing_billing_fields(client) == ["legal_name", "billing_address", "billing_state_code"]


def test_a_non_dict_address_is_treated_as_missing(db):
    """billing_address is JSONB; a legacy string row must not crash the gate."""
    from app.api.subscription_routes import _missing_billing_fields

    client = _client_row(db, "badaddr@test.dev", legal_name="X", billing_country="US")
    client.billing_address = "1 MG Road"  # legacy shape
    db.flush()
    assert _missing_billing_fields(client) == ["billing_address"]


def test_gstin_is_not_required(db):
    """B2C customers are legitimate. The gate collects what Rule 46 mandates for
    everyone; a GSTIN is optional and only matters for input tax credit."""
    from app.api.subscription_routes import _missing_billing_fields

    assert _missing_billing_fields(_client_row(db, "b2c@test.dev", **_FULL_IN)) == []
