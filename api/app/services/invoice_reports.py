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

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session, aliased

from app.db.models import Invoice

IST = ZoneInfo("Asia/Kolkata")

# GSTR-1 Table 6A: exports carry place-of-supply code 96 (Other Country) —
# stored NULL on the document (a foreign buyer has no GST state), resolved
# here at reporting time.
EXPORT_POS = "96"

# GSTR-1 Table 5 (B2CL): inter-state supplies to UNREGISTERED recipients above
# this document value are reported invoice-level; below it they aggregate in
# B2CS (Table 7). Threshold cut ₹2.5L → ₹1,00,000 by Notification 12/2024-CT.
B2CL_THRESHOLD_MINOR = 100_000_00

# Credit-note sections net DOWN the period's turnover (sales − reversals).
_CREDIT_NOTE_SECTIONS = frozenset({"CDNR", "CDNUR"})

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
        # A reversal of a non-GST document (a receipt-era refund) carries no
        # tax and has no place in GSTR-1 — only tax-bearing credit notes are
        # reported. CDNR = registered recipient (buyer GSTIN), CDNUR otherwise.
        if inv.tax_rate_bps is None:
            return None
        return "CDNR" if (inv.buyer_snapshot or {}).get("gstin") else "CDNUR"
    if inv.invoice_type != "tax_invoice":
        return None  # receipts carry no GST; legacy rows aren't documents
    if inv.is_export:
        return "EXP"
    if (inv.buyer_snapshot or {}).get("gstin"):
        return "B2B"
    # Unregistered (B2C): inter-state above the threshold is invoice-level B2CL,
    # everything else aggregates in B2CS.
    if inv.supply_kind == "inter" and (inv.amount_cents or 0) > B2CL_THRESHOLD_MINOR:
        return "B2CL"
    return "B2CS"


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
    """Per-section and grand totals for the month.

    Per-section figures are positive magnitudes (a CA reads CDNR as the credit
    -note total). ``grand_total`` is NET turnover — credit-note sections are
    subtracted (sales − reversals) so it reconciles with output-tax liability.
    """
    rows = gstr_document_rows(session, month)
    sections: dict[str, dict[str, int]] = {}
    grand = {"count": 0, "gross_minor": 0, "taxable_minor": 0, "total_tax_minor": 0}
    for row in rows:
        bucket = sections.setdefault(
            row["section"], {"count": 0, "gross_minor": 0, "taxable_minor": 0, "total_tax_minor": 0}
        )
        bucket["count"] += 1
        bucket["gross_minor"] += row["gross_minor"] or 0
        bucket["taxable_minor"] += row["taxable_minor"] or 0
        bucket["total_tax_minor"] += row["total_tax_minor"] or 0
        sign = -1 if row["section"] in _CREDIT_NOTE_SECTIONS else 1
        grand["count"] += 1
        grand["gross_minor"] += sign * (row["gross_minor"] or 0)
        grand["taxable_minor"] += sign * (row["taxable_minor"] or 0)
        grand["total_tax_minor"] += sign * (row["total_tax_minor"] or 0)
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
    candidates = (
        session.execute(
            select(Invoice).where(
                Invoice.invoice_number.isnot(None),
                Invoice.invoice_type != "credit_note",
                Invoice.status.in_(("refunded", "partially_refunded", "dispute_lost")),
            )
        )
        .scalars()
        .all()
    )
    # Sum of credit notes already issued per candidate — a single surviving CN
    # must not mask a second swallowed one, so compare the SUM, not existence.
    reversed_by_id: dict[int, int] = {}
    if candidates:
        reversed_by_id = dict(
            session.execute(
                select(note.credit_note_of_id, func.coalesce(func.sum(note.amount_cents), 0))
                .where(note.credit_note_of_id.in_([c.id for c in candidates]))
                .group_by(note.credit_note_of_id)
            ).all()
        )
    refunds_missing_cn = []
    for inv in candidates:
        reversed_minor = reversed_by_id.get(inv.id, 0)
        if inv.status in ("refunded", "dispute_lost"):
            # Full reversal expected; a short sum means a CN was swallowed.
            if reversed_minor < (inv.amount_cents or 0):
                refunds_missing_cn.append(inv)
        # partially_refunded: the refunded amount isn't stored on the invoice,
        # so only a total absence of any credit note is provably wrong here.
        elif reversed_minor == 0:
            refunds_missing_cn.append(inv)
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

    # Reconciliation identities pushed into SQL so this returns only the (near
    # always zero) offending rows instead of hydrating every document ever
    # issued — the check stays cheap as the table grows.
    def _c(col):
        return func.coalesce(col, 0)

    broken = (
        session.execute(
            select(Invoice).where(
                Invoice.invoice_number.isnot(None),
                Invoice.taxable_value_minor.isnot(None),
                or_(
                    _c(Invoice.taxable_value_minor) + _c(Invoice.total_tax_minor) != _c(Invoice.amount_cents),
                    _c(Invoice.cgst_minor) + _c(Invoice.sgst_minor) + _c(Invoice.igst_minor)
                    != _c(Invoice.total_tax_minor),
                ),
            )
        )
        .scalars()
        .all()
    )

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
