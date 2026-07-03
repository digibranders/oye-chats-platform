"""Invoice finalization — turns a freshly-created payment-history row into a
numbered, tax-computed, immutable tax invoice (invoicing v2 Phase 3).

No-op unless ``INVOICING_V2_ENABLED`` — legacy rows are left untouched. When
enabled it runs in shadow mode: invoices are numbered, taxed, and snapshotted,
but not yet emailed or shown to customers (Phase 4/6). Finalization is
idempotent (an already-numbered invoice is never re-finalized) and issued
documents are immutable — corrections are credit notes, never edits.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from app import config
from app.core.tax import compute_tax, supply_kind
from app.db.models import Client, Invoice, InvoiceCounter
from app.services.seller_profile_service import SellerProfile, get_seller_profile

logger = logging.getLogger(__name__)

IST = ZoneInfo("Asia/Kolkata")

# Receipts (no seller GSTIN yet) get their own serial series so they never
# interleave with the Rule 46 tax-invoice range reported in GSTR-1 Table 13.
# Reserved in seller_profile_service.RESERVED_PREFIXES so an admin can't
# collide with it. Credit notes (Phase 5) will use "CN".
RECEIPT_SERIES_PREFIX = "RCT"


def financial_year_label(dt: datetime) -> str:
    """Indian financial year label for ``dt`` — FY runs 1 Apr – 31 Mar **IST**.

    The FY boundary is an Indian-calendar fact, so the instant is converted to
    Asia/Kolkata before reading the month (a webhook at 20:00 UTC on 31 Mar is
    already 1 Apr in India — numbering it in the old FY would be an audit
    flag). Naive datetimes are treated as UTC.

    e.g. 2 Jul 2026 → ``"26-27"``; 31 Mar 2026 00:00 UTC → ``"25-26"``.
    """
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    ist = dt.astimezone(IST)
    start = ist.year if ist.month >= 4 else ist.year - 1
    return f"{start % 100:02d}-{(start + 1) % 100:02d}"


def allocate_invoice_number(session: Session, prefix: str, dt: datetime) -> str:
    """Allocate the next gapless serial for ``(financial_year, prefix)``.

    Ensures the counter row exists atomically (``INSERT … ON CONFLICT DO
    NOTHING``), then locks it (``SELECT … FOR UPDATE``) and increments through
    the ORM. The row lock serializes concurrent finalizers so serials are
    consecutive with no gaps or duplicates, and the ORM write keeps
    ``updated_at`` honest. Serials are only allocated here (at finalize), so an
    abandoned/failed payment never burns a number — a Rule 46 audit
    requirement.
    """
    fy = financial_year_label(dt)
    session.execute(
        pg_insert(InvoiceCounter)
        .values(financial_year=fy, prefix=prefix, last_serial=0)
        .on_conflict_do_nothing(index_elements=["financial_year", "prefix"])
    )
    counter = session.execute(
        select(InvoiceCounter)
        .where(InvoiceCounter.financial_year == fy, InvoiceCounter.prefix == prefix)
        .with_for_update()
    ).scalar_one()
    counter.last_serial += 1
    session.flush()
    return f"{prefix}/{fy}/{counter.last_serial:06d}"


def _seller_snapshot(seller: SellerProfile) -> dict:
    return {
        "legal_name": seller.legal_name,
        "trade_name": seller.trade_name,
        "gstin": seller.gstin,
        "address_lines": seller.address_lines,
        "state_code": seller.state_code,
        "sac_code": seller.sac_code,
        "gst_enabled": seller.gst_enabled,
        "lut_active": seller.lut_active,
        "lut_number": seller.lut_number,
    }


def _buyer_snapshot(buyer: Client | None) -> dict:
    if buyer is None:
        return {}
    return {
        "name": buyer.name,
        "legal_name": buyer.legal_name,
        "email": buyer.billing_email or buyer.email,
        "gstin": buyer.gstin,
        "billing_address": buyer.billing_address,
        "billing_state_code": buyer.billing_state_code,
        "billing_country": buyer.billing_country,
    }


def finalize_invoice(session: Session, invoice: Invoice) -> bool:
    """Enrich a just-created invoice into a numbered tax document.

    Returns ``True`` if it finalized, ``False`` on a no-op (flag off, or the
    invoice is already finalized). Must be called within the webhook handler's
    transaction, after the invoice row is flushed (so ``amount_cents`` /
    ``client_id`` are set).
    """
    if not config.INVOICING_V2_ENABLED:
        return False
    if invoice.invoice_number:  # already finalized — immutable, never re-touch
        return False
    # The tax engine assumes INR paise. Razorpay charges are INR; this guards
    # any non-INR charge from being taxed as rupees and
    # minting a false tax invoice — such rows stay legacy until a
    # currency-aware path exists.
    if (invoice.currency or "").lower() != "inr":
        logger.warning(
            "invoice %s currency %r is not INR — skipping finalize (stays legacy)",
            invoice.id,
            invoice.currency,
        )
        return False

    seller = get_seller_profile(session)
    # ACTIVATION GATE: the flags default ON, so the seller profile is what
    # actually turns invoicing on. Until the super-admin saves the company's
    # legal identity, no document is issued — a receipt/invoice bearing an
    # empty legal name would be worse than no document.
    if not seller.configured:
        return False

    buyer = session.get(Client, invoice.client_id)
    buyer_state = buyer.billing_state_code if buyer else None
    buyer_country = buyer.billing_country if buyer else None
    kind = supply_kind(seller.state_code, buyer_state, buyer_country)
    issued = datetime.now(UTC)

    if seller.gst_enabled:
        breakup = compute_tax(
            invoice.amount_cents,
            seller.tax_rate_bps,
            inclusive=seller.price_inclusive,
            kind=kind,
            lut_active=seller.lut_active,
        )
        invoice.invoice_type = "tax_invoice"
        invoice.hsn_sac = seller.sac_code
        invoice.tax_rate_bps = breakup.rate_bps
        invoice.taxable_value_minor = breakup.taxable_minor
        invoice.cgst_minor = breakup.cgst_minor
        invoice.sgst_minor = breakup.sgst_minor
        invoice.igst_minor = breakup.igst_minor
        invoice.total_tax_minor = breakup.total_tax_minor
        invoice.supply_kind = breakup.supply_kind
        invoice.is_export = breakup.is_export
        # Place of supply: the buyer's state for a domestic sale (supplier's
        # own state when B2C with no state on record — Circular 242); undefined
        # for exports.
        # Phase 7: GSTR-1 Table 6A (exports) needs a POS code ("96"/port state);
        # the NULL here is resolved in the GSTR export, not stored on the doc.
        invoice.place_of_supply = None if kind == "export" else (buyer_state or seller.state_code)
    else:
        # No seller GSTIN → issue a plain numbered receipt, no tax breakup.
        invoice.invoice_type = "receipt"

    # Receipts run on their own series so the tax-invoice serial range stays
    # consecutive (Rule 46(b) / GSTR-1 Table 13) even if GST mode is enabled
    # mid-FY.
    series_prefix = seller.invoice_prefix if invoice.invoice_type == "tax_invoice" else RECEIPT_SERIES_PREFIX
    invoice.invoice_number = allocate_invoice_number(session, series_prefix, issued)
    invoice.issued_at = issued
    invoice.seller_snapshot = _seller_snapshot(seller)
    invoice.buyer_snapshot = _buyer_snapshot(buyer)
    # Phase 3 stores a single header-derived line; the Phase 4 PDF composes the
    # full Rule-46 line (HSN/SAC, qty, per-line taxable) from the header fields
    # above. Enrich this list if multi-line invoices (plan + overage) are added.
    invoice.line_items = [{"description": invoice.description, "amount_minor": invoice.amount_cents}]
    session.flush()
    return True


def finalize_invoice_safely(session: Session, invoice: Invoice) -> bool:
    """Finalize inside a SAVEPOINT, swallowing any failure.

    Invoicing runs in shadow mode inside the payment webhook's transaction, so
    it must NEVER block the money path (credit grants, renewals). A failed
    finalize rolls back only its own writes — including any counter increment,
    so no serial is burned — leaving a legacy row for a later reconciliation
    pass, while the outer transaction (and the customer's credits) proceeds.
    """
    try:
        with session.begin_nested():
            return finalize_invoice(session, invoice)
    except Exception:
        logger.exception(
            "invoice finalize failed for invoice %s; leaving legacy row (shadow mode)",
            invoice.id,
        )
        return False
