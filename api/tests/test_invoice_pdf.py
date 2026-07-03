"""Invoice PDF/HTML rendering — amount-in-words, Rule 46 fields, legends.

HTML-level tests assert every legally-required figure lands in the document
(cheap, runs everywhere). The PDF smoke test needs WeasyPrint's system pango
libs and skips when they're absent (CI without pango stays green; locally run
with ``DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib`` on macOS).
"""

from datetime import UTC, datetime

import pytest

from app.db.models import Invoice
from app.services.invoice_pdf import amount_in_words_inr, render_invoice_html

# ── amount in words (Indian numbering) ────────────────────────────────────────


@pytest.mark.parametrize(
    ("minor", "words"),
    [
        (179900, "Rupees One Thousand Seven Hundred Ninety Nine Only"),
        (459900, "Rupees Four Thousand Five Hundred Ninety Nine Only"),
        (100, "Rupees One Only"),
        (0, "Rupees Zero Only"),
        (150, "Rupees One and Fifty Paise Only"),
        (27442, "Rupees Two Hundred Seventy Four and Forty Two Paise Only"),
        (10000000 * 100, "Rupees One Crore Only"),
        (123456700, "Rupees Twelve Lakh Thirty Four Thousand Five Hundred Sixty Seven Only"),
    ],
)
def test_amount_in_words_indian_system(minor, words):
    assert amount_in_words_inr(minor) == words


# ── HTML document ─────────────────────────────────────────────────────────────


def _tax_invoice(**overrides) -> Invoice:
    values = dict(
        client_id=1,
        amount_cents=179900,
        currency="inr",
        status="paid",
        invoice_type="tax_invoice",
        invoice_number="DB/26-27/000001",
        issued_at=datetime(2026, 7, 2, 12, 0, tzinfo=UTC),
        taxable_value_minor=152458,
        tax_rate_bps=1800,
        cgst_minor=13721,
        sgst_minor=13721,
        igst_minor=0,
        total_tax_minor=27442,
        hsn_sac="997331",
        place_of_supply="27",
        supply_kind="intra",
        is_export=False,
        description="Starter — monthly",
        line_items=[{"description": "Starter — monthly", "amount_minor": 179900}],
        seller_snapshot={
            "legal_name": "Digibranders Pvt Ltd",
            "trade_name": "OyeChats",
            "gstin": "27AAPFU0939F1ZV",
            "address_lines": ["1 Example Road", "Mumbai 400001"],
            "state_code": "27",
            "sac_code": "997331",
            "gst_enabled": True,
            "lut_active": False,
            "lut_number": None,
        },
        buyer_snapshot={
            "name": "Acme",
            "legal_name": "Acme Industries Pvt Ltd",
            "email": "accounts@acme.example",
            "gstin": "27AAPFU0939F1ZV",
            "billing_address": {"line1": "9 Test Lane", "city": "Mumbai"},
            "billing_state_code": "27",
            "billing_country": "IN",
        },
    )
    values.update(overrides)
    return Invoice(**values)


def test_tax_invoice_html_carries_rule46_fields():
    html = render_invoice_html(_tax_invoice())
    assert "TAX INVOICE" in html
    assert "DB/26-27/000001" in html
    assert "Digibranders Pvt Ltd" in html
    assert "27AAPFU0939F1ZV" in html
    assert "Acme Industries Pvt Ltd" in html
    assert "997331" in html
    # All money figures, formatted in rupees.
    assert "₹1,524.58" in html  # taxable
    assert "₹137.21" in html  # CGST and SGST
    assert "₹274.42" in html  # total tax
    assert "₹1,799.00" in html  # grand total
    assert "CGST @ 9.0%" in html and "SGST @ 9.0%" in html
    assert "Rupees One Thousand Seven Hundred Ninety Nine Only" in html
    assert "Place of supply: 27" in html
    # Issue date rendered in IST (12:00 UTC = 17:30 IST, same calendar day).
    assert "02 Jul 2026" in html
    assert "Reverse charge: No" in html


def test_igst_row_for_inter_state():
    html = render_invoice_html(
        _tax_invoice(cgst_minor=0, sgst_minor=0, igst_minor=27442, supply_kind="inter", place_of_supply="29")
    )
    assert "IGST @ 18.0%" in html
    assert "CGST" not in html


def test_export_lut_legend():
    html = render_invoice_html(
        _tax_invoice(
            cgst_minor=0,
            sgst_minor=0,
            igst_minor=0,
            total_tax_minor=0,
            taxable_value_minor=179900,
            supply_kind="export",
            is_export=True,
            place_of_supply=None,
            seller_snapshot={
                "legal_name": "Digibranders Pvt Ltd",
                "trade_name": "OyeChats",
                "gstin": "27AAPFU0939F1ZV",
                "address_lines": [],
                "state_code": "27",
                "sac_code": "997331",
                "gst_enabled": True,
                "lut_active": True,
                "lut_number": "LUT-2026-1",
            },
        )
    )
    assert "export under LUT without payment of IGST" in html
    assert "LUT-2026-1" in html


def test_receipt_has_no_tax_table():
    html = render_invoice_html(
        _tax_invoice(
            invoice_type="receipt",
            invoice_number="RCT/26-27/000001",
            taxable_value_minor=None,
            tax_rate_bps=None,
            cgst_minor=None,
            sgst_minor=None,
            igst_minor=None,
            total_tax_minor=None,
            hsn_sac=None,
            place_of_supply=None,
            supply_kind=None,
        )
    )
    assert "RECEIPT" in html
    assert "TAX INVOICE" not in html
    assert "CGST" not in html and "IGST" not in html
    assert "₹1,799.00" in html


def test_issue_date_renders_in_ist_across_midnight():
    # 20:00 UTC on 31 Mar is 01:30 IST on 1 Apr — the printed date must be the
    # IST calendar day, matching the FY series the number was allocated in.
    html = render_invoice_html(_tax_invoice(issued_at=datetime(2026, 3, 31, 20, 0, tzinfo=UTC)))
    assert "01 Apr 2026" in html


def test_unfinalized_invoice_rejected():
    inv = _tax_invoice(invoice_number=None)
    with pytest.raises(ValueError, match="finalized"):
        render_invoice_html(inv)


# ── PDF smoke (needs system pango) ────────────────────────────────────────────


def test_pdf_renders_and_contains_number():
    weasyprint = pytest.importorskip("weasyprint", reason="weasyprint not installed")
    try:
        weasyprint.HTML(string="<p>probe</p>").write_pdf()
    except OSError:
        pytest.skip("system pango libraries unavailable")

    from app.services.invoice_pdf import render_invoice_pdf

    pdf = render_invoice_pdf(_tax_invoice())
    assert pdf.startswith(b"%PDF")

    import io

    from pypdf import PdfReader

    text = PdfReader(io.BytesIO(pdf)).pages[0].extract_text()
    assert "DB/26-27/000001" in text
    assert "Digibranders" in text
