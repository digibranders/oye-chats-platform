"""Paid checkout collects the buyer identity Rule 46 ACTUALLY mandates (F6).

An invoice is issued from a WEBHOOK, so there is no second chance to ask who
was billed, but WHAT must be asked depends on the buyer (see
``_missing_billing_fields``): a GST-registered buyer needs their registered
legal name + address on record (their input tax credit depends on it); an
export buyer needs an address (Rule 46's export proviso); an unregistered
domestic buyer below ₹50,000 (Rule 46(f)) owes NOTHING, the account name and
the Circular 242 supplier-state fallback make the invoice valid, and asking
anyway was blocking legitimate B2C payments.
"""

import os
from contextlib import contextmanager
from unittest.mock import patch

import pytest

from app.db.models import Client

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")


@contextmanager
def _routes_session(session):
    """Point the route module's get_session at the test session."""
    from app.api import subscription_routes

    @contextmanager
    def _cm():
        yield session

    with patch.object(subscription_routes, "get_session", _cm):
        yield


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


def test_bare_b2c_buyer_owes_nothing(db):
    # Rule 46(f): recipient details are only mandatory on ₹50,000+ invoices to
    # unregistered persons. A bare domestic B2C account passes the gate.
    from app.api.subscription_routes import _missing_billing_fields

    client = _client_row(db, "bare@test.dev", billing_country="IN")
    assert _missing_billing_fields(client) == []


def test_registered_buyer_missing_fields_listed_in_display_order(db):
    from app.api.subscription_routes import _missing_billing_fields

    client = _client_row(db, "bare-gstin@test.dev", billing_country="IN", gstin="27AAPFU0939F1ZV")
    assert _missing_billing_fields(client) == ["legal_name", "billing_address"]


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


def test_unset_country_is_domestic_b2c_and_owes_nothing(db):
    """NULL country defaults to IN throughout the billing stack; an
    unregistered domestic buyer below the Rule 46(f) threshold owes nothing.
    Place of supply falls back to the supplier state (Circular 242)."""
    from app.api.subscription_routes import _missing_billing_fields

    client = _client_row(
        db,
        "nocountry@test.dev",
        legal_name="X",
        billing_address={"line1": "1 MG Road"},
    )
    assert _missing_billing_fields(client) == []


def test_address_without_line1_counts_as_missing_for_registered_buyer(db):
    """Rule 46 wants an address, not a city on its own. Enforced where the
    address is mandatory (a registered buyer)."""
    from app.api.subscription_routes import _missing_billing_fields

    client = _client_row(
        db,
        "partial@test.dev",
        legal_name="X",
        gstin="27AAPFU0939F1ZV",
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
        gstin="27AAPFU0939F1ZV",
        billing_address={"line1": "  "},
        billing_country="IN",
        billing_state_code=" ",
    )
    assert _missing_billing_fields(client) == ["legal_name", "billing_address"]


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


# ── GSTIN implies a registered name ──────────────────────────────────────────


def test_gstin_without_a_legal_name_is_rejected(db):
    """A registered buyer must name themselves.

    The recipient name on a tax invoice has to match the GST registration, or
    the buyer's GSTR-2B reconciliation fails and they cannot claim the input
    tax credit. Enforced server-side too, so a client bypassing the form hits
    the same rule.
    """
    from fastapi import HTTPException

    from app.api.subscription_routes import BillingDetailsBody, update_billing_details

    client = _client_row(db, "gstin-noname@test.dev", billing_country="IN")

    with _routes_session(db), pytest.raises(HTTPException) as exc:
        update_billing_details(
            BillingDetailsBody(gstin="27AAPFU0939F1ZV"),
            client=client,
        )
    assert exc.value.status_code == 422
    assert "legal_name" in str(exc.value.detail)


def test_gstin_with_a_legal_name_is_accepted(db):
    from app.api.subscription_routes import BillingDetailsBody, update_billing_details

    client = _client_row(db, "gstin-named@test.dev", billing_country="IN")

    with _routes_session(db):
        update_billing_details(
            BillingDetailsBody(gstin="27AAPFU0939F1ZV", legal_name="Fynix Digital Pvt Ltd"),
            client=client,
        )

    db.refresh(client)
    assert client.gstin == "27AAPFU0939F1ZV"
    assert client.legal_name == "Fynix Digital Pvt Ltd"
    assert client.billing_state_code == "27"  # derived from the GSTIN


def test_no_gstin_needs_no_registered_name_rule(db):
    """An unregistered B2C buyer is perfectly normal."""
    from app.api.subscription_routes import BillingDetailsBody, update_billing_details

    client = _client_row(db, "b2c-noname@test.dev", billing_country="IN")

    with _routes_session(db):
        update_billing_details(BillingDetailsBody(legal_name="Gaurav"), client=client)

    db.refresh(client)
    assert client.legal_name == "Gaurav"
    assert client.gstin is None
