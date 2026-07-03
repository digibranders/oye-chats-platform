"""GSTR-1-style reporting + invoice reconciliation (invoicing v2 Phase 7).

Document-level rows for the CA's monthly filing, sectioned the way GSTR-1
tables are organised, plus anomaly checks that catch the failure modes the
issuing pipeline deliberately tolerates in-line (savepoint-swallowed credit
notes, stuck PDF renders) so nothing silently stays broken.

All reads; nothing here mutates documents. Periods are Indian-calendar months
(IST) — the same convention the serial series uses.
"""

from __future__ import annotations

import re
from datetime import UTC, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.orm import Session, aliased

from app.db.models import Invoice

IST = ZoneInfo("Asia/Kolkata")

# GSTR-1 Table 6A: exports carry place-of-supply code 96 (Other Country) —
# stored NULL on the document (a foreign buyer has no GST state), resolved
# here at reporting time.
EXPORT_POS = "96"

# How long a numbered document may lack a PDF before it counts as stuck
# (the sweep runs every 5 minutes; an hour means ~12 consecutive failures).
PDF_STUCK_AFTER = timedelta(hours=1)


def month_window_utc(month: str) -> tuple[datetime, datetime]:
    """``"2026-07"`` → the UTC instants bounding that IST calendar month."""
    if not re.fullmatch(r"\d{4}-\d{2}", month or ""):
        raise ValueError(f"month must be YYYY-MM, got {month!r}")
    year, mon = int(month[:4]), int(month[5:7])
    if not 1 <= mon <= 12:
        raise ValueError(f"month out of range: {month!r}")
    start_ist = datetime(year, mon, 1, tzinfo=IST)
    end_ist = datetime(year + 1, 1, 1, tzinfo=IST) if mon == 12 else datetime(year, mon + 1, 1, tzinfo=IST)
    return start_ist.astimezone(UTC), end_ist.astimezone(UTC)


def _section_for(inv: Invoice) -> str | None:
    """GSTR-1 section for a document; ``None`` = not GST-reportable."""
    if inv.invoice_type == "credit_note":
        # CDNR = registered recipient (buyer GSTIN present), CDNUR otherwise.
        buyer_gstin = (inv.buyer_snapshot or {}).get("gstin")
        return "CDNR" if buyer_gstin else "CDNUR"
    if inv.invoice_type != "tax_invoice":
        return None  # receipts carry no GST; legacy rows aren't documents
    if inv.is_export:
        return "EXP"
    return "B2B" if (inv.buyer_snapshot or {}).get("gstin") else "B2CS"


def _ist_date(dt: datetime | None) -> str | None:
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return f"{dt.astimezone(IST):%d-%m-%Y}"


def gstr_document_rows(session: Session, month: str) -> list[dict[str, Any]]:
    """Document-level rows for every GST-reportable document issued in ``month``."""
    start, end = month_window_utc(month)
    invoices = (
        session.execute(
            select(Invoice)
            .where(
                Invoice.invoice_number.isnot(None),
                Invoice.issued_at >= start,
                Invoice.issued_at < end,
            )
            .order_by(Invoice.invoice_number)
        )
        .scalars()
        .all()
    )
    rows: list[dict[str, Any]] = []
    for inv in invoices:
        section = _section_for(inv)
        if section is None:
            continue
        buyer = inv.buyer_snapshot or {}
        against = None
        against_date = None
        if inv.invoice_type == "credit_note":
            ref = next((item for item in (inv.line_items or []) if item.get("against_invoice")), {})
            against = ref.get("against_invoice")
            raw = ref.get("against_invoice_date")
            if raw:
                try:
                    against_date = _ist_date(datetime.fromisoformat(raw))
                except ValueError:
                    against_date = None
        rows.append(
            {
                "section": section,
                "invoice_number": inv.invoice_number,
                "invoice_date": _ist_date(inv.issued_at),
                "invoice_type": inv.invoice_type,
                "buyer_name": buyer.get("legal_name") or buyer.get("name"),
                "buyer_gstin": buyer.get("gstin"),
                "place_of_supply": EXPORT_POS if inv.is_export else inv.place_of_supply,
                "supply_kind": inv.supply_kind,
                "rate_bps": inv.tax_rate_bps,
                "hsn_sac": inv.hsn_sac,
                "gross_minor": inv.amount_cents,
                "taxable_minor": inv.taxable_value_minor,
                "cgst_minor": inv.cgst_minor,
                "sgst_minor": inv.sgst_minor,
                "igst_minor": inv.igst_minor,
                "total_tax_minor": inv.total_tax_minor,
                "against_invoice": against,
                "against_invoice_date": against_date,
            }
        )
    return rows


def gstr_summary(session: Session, month: str) -> dict[str, Any]:
    """Per-section and grand totals for the month — must tie to the rows."""
    rows = gstr_document_rows(session, month)
    sections: dict[str, dict[str, int]] = {}
    grand = {"count": 0, "gross_minor": 0, "taxable_minor": 0, "total_tax_minor": 0}
    for row in rows:
        bucket = sections.setdefault(
            row["section"], {"count": 0, "gross_minor": 0, "taxable_minor": 0, "total_tax_minor": 0}
        )
        for target in (bucket, grand):
            target["count"] += 1
            target["gross_minor"] += row["gross_minor"] or 0
            target["taxable_minor"] += row["taxable_minor"] or 0
            target["total_tax_minor"] += row["total_tax_minor"] or 0
    return {"month": month, "sections": sections, "grand_total": grand}


def reconciliation_anomalies(session: Session) -> dict[str, list[dict[str, Any]]]:
    """Conditions that should never persist — each list should be empty.

    * ``refunds_without_credit_note`` — a refunded/charged-back NUMBERED
      invoice with no linked credit note: the savepoint-swallowed CN path.
      Re-issue from the superadmin console.
    * ``pdfs_pending`` — numbered documents still without a PDF well past the
      sweep interval (renderer down / pango missing / data poison).
    * ``broken_totals`` — tax components that no longer reconcile (impossible
      by construction; presence means manual DB tampering).
    """
    note = aliased(Invoice)
    refunds_missing_cn = (
        session.execute(
            select(Invoice)
            .outerjoin(note, note.credit_note_of_id == Invoice.id)
            .where(
                Invoice.invoice_number.isnot(None),
                Invoice.invoice_type != "credit_note",
                Invoice.status.in_(("refunded", "partially_refunded", "dispute_lost")),
                note.id.is_(None),
            )
        )
        .scalars()
        .all()
    )
    cutoff = datetime.now(UTC) - PDF_STUCK_AFTER
    pdfs_pending = (
        session.execute(
            select(Invoice).where(
                Invoice.invoice_number.isnot(None),
                Invoice.pdf_url.is_(None),
                Invoice.issued_at < cutoff,
            )
        )
        .scalars()
        .all()
    )
    tax_docs = (
        session.execute(
            select(Invoice).where(Invoice.invoice_number.isnot(None), Invoice.taxable_value_minor.isnot(None))
        )
        .scalars()
        .all()
    )
    broken = [
        inv
        for inv in tax_docs
        if (inv.taxable_value_minor or 0) + (inv.total_tax_minor or 0) != (inv.amount_cents or 0)
        or (inv.cgst_minor or 0) + (inv.sgst_minor or 0) + (inv.igst_minor or 0) != (inv.total_tax_minor or 0)
    ]

    def _brief(inv: Invoice) -> dict[str, Any]:
        return {
            "id": inv.id,
            "invoice_number": inv.invoice_number,
            "invoice_type": inv.invoice_type,
            "status": inv.status,
            "client_id": inv.client_id,
            "amount_cents": inv.amount_cents,
            "issued_at": inv.issued_at.isoformat() if inv.issued_at else None,
        }

    return {
        "refunds_without_credit_note": [_brief(i) for i in refunds_missing_cn],
        "pdfs_pending": [_brief(i) for i in pdfs_pending],
        "broken_totals": [_brief(i) for i in broken],
    }
