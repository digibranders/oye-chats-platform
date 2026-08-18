"""Invoice email attaches the rendered PDF (not just a download link).

Follow-up to the invoicing feature: the customer's invoice/receipt email now
carries the PDF as a Brevo attachment. These are pure-function tests, no DB,
no network (urlopen is stubbed)."""

import base64
import json
from types import SimpleNamespace
from unittest.mock import patch

from app.services import email_service


def _invoice(**over):
    base = dict(
        id=42,
        invoice_number="DB/26-27/000001",  # slashes must not leak into the filename
        invoice_type="tax_invoice",
        currency="inr",
        amount_cents=2299900,
        total_tax_minor=350831,
        seller_snapshot={"legal_name": "Digibranders Private Limited"},
    )
    base.update(over)
    return SimpleNamespace(**base)


def test_send_invoice_email_attaches_pdf_with_sanitized_name():
    pdf = b"%PDF-1.4 pretend invoice bytes"
    captured = {}

    def _capture(to, subject, html, *, attachments=None, **kw):
        captured["to"] = to
        captured["attachments"] = attachments

    with patch.object(email_service, "send_email_async", _capture):
        email_service.send_invoice_email("cust@example.com", _invoice(), "https://cdn/x.pdf", pdf_bytes=pdf)

    att = captured["attachments"]
    assert att is not None and len(att) == 1
    # Slash-bearing invoice number is flattened to a valid filename.
    assert att[0]["name"] == "DB-26-27-000001.pdf"
    # Content is the exact PDF bytes, base64-encoded.
    assert base64.b64decode(att[0]["content"]) == pdf


def test_send_invoice_email_without_pdf_sends_no_attachment():
    captured = {}

    def _capture(to, subject, html, *, attachments=None, **kw):
        captured["attachments"] = attachments

    with patch.object(email_service, "send_email_async", _capture):
        email_service.send_invoice_email("cust@example.com", _invoice(), "https://cdn/x.pdf")

    assert captured["attachments"] is None  # link-only fallback, no attachment


# ── currency of the announced amount ──────────────────────────────────────────


def _capture_html(invoice) -> tuple[str, str]:
    """Return (subject, html) for an invoice email, without sending."""
    captured = {}

    def _capture(to, subject, html, *, attachments=None, **kw):
        captured["subject"] = subject
        captured["html"] = html

    with patch.object(email_service, "send_email_async", _capture):
        email_service.send_invoice_email("cust@example.com", invoice, "https://cdn/x.pdf")
    return captured["subject"], captured["html"]


def test_inr_invoice_email_announces_rupees():
    _, html = _capture_html(_invoice())
    assert "₹22,999.00" in html


def test_usd_invoice_email_announces_dollars_not_rupees():
    # This hardcoded _fmt_inr, so a $9.00 export was announced as "₹9.00".
    # Matching neither the attached PDF nor the customer's card statement.
    _, html = _capture_html(_invoice(currency="usd", amount_cents=900, total_tax_minor=0))
    assert "$9.00" in html
    assert "₹9.00" not in html


def test_usd_invoice_email_shows_gst_in_the_same_currency():
    # An IGST-paid export: the tax line must not switch currency mid-email.
    _, html = _capture_html(_invoice(currency="usd", amount_cents=900, total_tax_minor=137))
    assert "$1.37" in html
    assert "₹1.37" not in html


def test_brevo_payload_uses_attachment_key():
    """The Brevo transactional API expects the singular `attachment` key,
    a wrong key silently drops the file, so pin it."""
    sent = {}

    class _Resp:
        status = 201

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    def _fake_urlopen(req, timeout=None):
        sent["payload"] = json.loads(req.data.decode("utf-8"))
        return _Resp()

    attachments = [{"content": base64.b64encode(b"x").decode("ascii"), "name": "a.pdf"}]
    with (
        patch.object(email_service, "EMAIL_ENABLED", True),
        patch.object(email_service, "BREVO_API_KEY", "k"),
        patch.object(email_service, "urlopen", _fake_urlopen),
    ):
        ok = email_service._send_brevo_email("to@x.com", "Subj", "<p>hi</p>", attachments=attachments)

    assert ok is True
    assert sent["payload"]["attachment"] == attachments
