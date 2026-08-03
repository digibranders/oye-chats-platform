"""Statutory presentation rules on the invoice PDF.

These are the details a CA checks and a customer's finance team notices:
Rule 48(2) copy marking, Rule 46(p) signature handling, Rule 46 export fields,
Companies Act s.12(3)(c) identity, and the currency the amounts are actually
denominated in.
"""

import os
from datetime import UTC, datetime

import pytest

from app.core.gstin import country_name
from app.db.models import Client, Invoice
from app.services import invoice_service
from app.services.invoice_pdf import _fmt_money, _fmt_rate, render_invoice_html
from app.services.seller_profile_service import SellerProfileError, save_seller_profile

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")


# ── Pure formatters ──────────────────────────────────────────────────────────


def test_rate_never_renders_a_trailing_zero():
    """'CGST @ 9.0%' reads as an unfinished template on a statutory document."""
    assert _fmt_rate(1800) == "18"
    assert _fmt_rate(1800, half=True) == "9"
    assert _fmt_rate(500, half=True) == "2.5"
    assert _fmt_rate(None) == "0"


def test_money_uses_lakh_grouping_only_for_inr():
    """'$1,52,458.00' is not a number anyone outside India reads correctly, and
    on an export document it misstates the figure's presentation."""
    assert _fmt_money(15245800, "INR") == "₹1,52,458.00"
    assert _fmt_money(15245800, "USD") == "$152,458.00"
    assert _fmt_money(15245800, "GBP") == "£152,458.00"


def test_money_defaults_to_inr_and_labels_unknown_currencies():
    assert _fmt_money(100000, None) == "₹1,000.00"
    assert _fmt_money(100000, "ZZZ") == "ZZZ 1,000.00"


def test_country_name_falls_back_to_the_code():
    """Never leave 'Country of destination:' blank on an export invoice."""
    assert country_name("US") == "United States"
    assert country_name("ZZ") == "ZZ"
    assert country_name(None) is None


# ── Seller profile identity ──────────────────────────────────────────────────


def test_cin_must_be_a_real_cin(db):
    with pytest.raises(SellerProfileError, match="Corporate Identity Number"):
        save_seller_profile(db, {"legal_name": "X Pvt Ltd", "cin": "NOTACIN"}, actor_id=None)


def test_valid_cin_and_contact_round_trip(db):
    profile = save_seller_profile(
        db,
        {
            "legal_name": "Digibranders Pvt Ltd",
            "cin": "U62099MH2023PTC123456",
            "website": "https://oyechats.com",
            "support_email": "support@oyechats.com",
        },
        actor_id=None,
    )
    assert profile.cin == "U62099MH2023PTC123456"
    assert profile.support_email == "support@oyechats.com"


def test_website_must_be_absolute(db):
    with pytest.raises(SellerProfileError, match="http"):
        save_seller_profile(db, {"legal_name": "X", "website": "oyechats.com"}, actor_id=None)


# ── Rendered document ────────────────────────────────────────────────────────


@pytest.fixture
def enabled(monkeypatch):
    from app import config

    monkeypatch.setattr(config, "INVOICING_V2_ENABLED", True)


def _issued(db, email, **buyer_fields):
    save_seller_profile(
        db,
        {
            "legal_name": "Digibranders Pvt Ltd",
            "trade_name": "OyeChats",
            "gstin": "27AAICD9268J1Z0",
            "cin": "U62099MH2023PTC123456",
            "support_email": "support@oyechats.com",
        },
        actor_id=None,
    )
    buyer = Client(name="B", email=email, api_key=f"k-{email}", **buyer_fields)
    db.add(buyer)
    db.flush()
    inv = Invoice(
        client_id=buyer.id,
        amount_cents=399900,
        currency="inr",
        status="paid",
        description="Credits top-up — 5,500 credits",
        paid_at=datetime.now(UTC),
    )
    db.add(inv)
    db.flush()
    assert invoice_service.finalize_invoice(db, inv) is True
    return inv


def test_tax_invoice_carries_the_rule_48_copy_marking(db, enabled):
    html = render_invoice_html(_issued(db, "copy@test.dev"))
    assert "ORIGINAL FOR RECIPIENT" in html


def test_footer_declares_no_signature_is_required_and_shows_no_empty_signatory(db, enabled):
    """Rule 46(p)'s proviso waives the signature for an electronic invoice — but
    only if the document says so. The old layout printed a vague
    'computer-generated' line AND an empty 'Authorised signatory' block, which
    reads as an UNSIGNED invoice rather than one needing no signature."""
    html = render_invoice_html(_issued(db, "sign@test.dev"))
    assert "does not require a physical signature" in html
    assert "Authorised signatory" not in html


def test_footer_uses_the_configured_support_address(db, enabled):
    html = render_invoice_html(_issued(db, "mail@test.dev"))
    assert "support@oyechats.com" in html
    assert "developer@oyechats.com" not in html


def test_companies_act_identity_is_printed(db, enabled):
    """s.12(3)(c) requires CIN on every billhead."""
    html = render_invoice_html(_issued(db, "cin@test.dev"))
    assert "U62099MH2023PTC123456" in html


def test_domestic_invoice_shows_place_of_supply_and_reverse_charge(db, enabled):
    html = render_invoice_html(_issued(db, "dom@test.dev"))
    assert "Reverse charge: No" in html  # Rule 46(o), mandatory on every invoice
    assert "Place of supply:" in html


def test_export_invoice_shows_place_of_supply_and_destination(db, enabled):
    """finalize stores NULL place_of_supply for an export (no Indian state), but
    Rule 46 still wants a place of supply and the country of destination."""
    inv = _issued(db, "exp@test.dev", billing_country="US")
    assert inv.is_export is True
    html = render_invoice_html(inv)
    assert "Place of supply: 96 – Outside India" in html
    assert "Country of destination: United States" in html


def test_export_invoice_carries_the_rule_46_endorsement(db, enabled):
    inv = _issued(db, "exp2@test.dev", billing_country="DE")
    html = render_invoice_html(inv)
    assert "EXPORT" in html.upper()
