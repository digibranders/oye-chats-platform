"""Client buyer-identity columns exist and round-trip."""

import os

import pytest

from app.db.models import Client

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")


def test_billing_fields_roundtrip(db):
    c = Client(
        name="Acme",
        email="billing-fields@test.example",
        api_key="test-key-billing-fields",
        legal_name="Acme Industries Pvt Ltd",
        gstin="27AAPFU0939F1ZV",
        billing_address={"line1": "1 Test Lane", "city": "Mumbai", "postal_code": "400001"},
        billing_country="IN",
        billing_state_code="27",
        billing_email="accounts@acme.example",
    )
    db.add(c)
    db.flush()
    got = db.get(Client, c.id)
    assert got.gstin == "27AAPFU0939F1ZV"
    assert got.billing_address["city"] == "Mumbai"
    assert got.billing_state_code == "27"


def test_billing_fields_default_null(db):
    c = Client(name="Bare", email="bare-billing@test.example", api_key="test-key-bare-billing")
    db.add(c)
    db.flush()
    assert c.gstin is None and c.billing_state_code is None and c.billing_country is None
