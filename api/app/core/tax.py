"""GST tax engine — pure, integer-paise computation, no I/O.

Given a charge amount and the supply classification, produces the CGST/SGST/
IGST breakup that later invoicing phases snapshot onto the invoice. Every
result reconciles exactly: ``taxable + total_tax == total`` and
``cgst + sgst + igst == total_tax`` (single rounding point + largest-remainder
split), which is the property a GST audit checks.

Tax direction (v2 plan §2a): OyeChats/Digibranders is the domestic supplier
(forward charge), so we compute, show, and remit GST ourselves.

* intra-state (same state)  → CGST + SGST, each ≈ rate/2
* inter-state               → IGST at the full rate
* export + LUT              → zero-rated (all taxes 0)
* export, no LUT            → IGST at the full rate (Rule 96A fallback)
"""

from __future__ import annotations

from dataclasses import dataclass

SupplyKind = str  # "intra" | "inter" | "export"
_KINDS = ("intra", "inter", "export")


@dataclass(frozen=True)
class TaxBreakup:
    taxable_minor: int
    cgst_minor: int
    sgst_minor: int
    igst_minor: int
    total_tax_minor: int
    total_minor: int
    is_export: bool
    supply_kind: SupplyKind


def _round_half_up(numerator: int, denominator: int) -> int:
    """Round ``numerator / denominator`` to the nearest integer, halves up.

    Integer-only (no float): ``floor((n + d/2) / d) == (2n + d) // (2d)`` for
    non-negative inputs — avoids binary-float rounding drift on money.
    """
    return (2 * numerator + denominator) // (2 * denominator)


def supply_kind(seller_state: str | None, buyer_state: str | None, buyer_country: str | None) -> SupplyKind:
    """Classify a supply as intra / inter / export.

    A non-Indian buyer country is an export. Domestically, the supply is
    intra-state when the buyer's state matches the seller's — and, per Circular
    242/36/2024, a B2C sale with no state on record has its place of supply at
    the supplier's location, i.e. intra-state.
    """
    country = (buyer_country or "IN").strip().upper()
    if country != "IN":
        return "export"
    if not buyer_state or buyer_state == seller_state:
        return "intra"
    return "inter"


def compute_tax(
    amount_minor: int,
    rate_bps: int,
    *,
    inclusive: bool,
    kind: SupplyKind,
    lut_active: bool = False,
) -> TaxBreakup:
    """Compute the GST breakup for a charge, in integer paise.

    ``amount_minor`` is the gross charge when ``inclusive`` (GST embedded), or
    the taxable base when exclusive (GST added on top). ``rate_bps`` is the
    full GST rate in basis points (1800 = 18%). ``lut_active`` only matters for
    ``kind == "export"``.
    """
    if amount_minor < 0:
        raise ValueError("amount_minor must be non-negative")
    if rate_bps < 0:
        raise ValueError("rate_bps must be non-negative")
    if kind not in _KINDS:
        raise ValueError(f"kind must be one of {_KINDS}, got {kind!r}")

    is_export = kind == "export"

    # Export under a filed LUT is zero-rated — no tax carved out or added.
    if is_export and lut_active:
        return TaxBreakup(
            taxable_minor=amount_minor,
            cgst_minor=0,
            sgst_minor=0,
            igst_minor=0,
            total_tax_minor=0,
            total_minor=amount_minor,
            is_export=True,
            supply_kind=kind,
        )

    # Single rounding point: derive taxable + total_tax + total.
    if inclusive:
        taxable = _round_half_up(amount_minor * 10000, 10000 + rate_bps)
        total = amount_minor
        total_tax = total - taxable
    else:
        taxable = amount_minor
        total_tax = _round_half_up(amount_minor * rate_bps, 10000)
        total = taxable + total_tax

    # Split by place of supply. Export-without-LUT follows the inter-state
    # (IGST) treatment.
    if kind == "intra":
        cgst = total_tax // 2
        sgst = total_tax - cgst  # odd paisa → SGST (largest-remainder)
        igst = 0
    else:
        cgst = 0
        sgst = 0
        igst = total_tax

    return TaxBreakup(
        taxable_minor=taxable,
        cgst_minor=cgst,
        sgst_minor=sgst,
        igst_minor=igst,
        total_tax_minor=total_tax,
        total_minor=total,
        is_export=is_export,
        supply_kind=kind,
    )
