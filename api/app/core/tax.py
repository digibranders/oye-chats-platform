"""GST tax engine. Pure, integer-paise computation, no I/O.

Given a charge amount and the supply classification, produces the CGST/SGST/
IGST breakup that later invoicing phases snapshot onto the invoice. Every
result reconciles exactly: ``taxable + total_tax == total`` and
``cgst + sgst + igst == total_tax`` (single rounding point + largest-remainder
split), which is the property a GST audit checks.

CGST/SGST split. Deliberate convention: we round ``total_tax`` once and split
it (``cgst = total_tax // 2``, odd paisa → SGST), rather than rounding each
half independently from ``rate/2``. This guarantees ``cgst + sgst`` equals the
carved-out ``total_tax`` with no reconciliation gap. Per-component rounding
can make the halves sum to ``total_tax ± 1`` paisa and break the inclusive
"customer pays exactly the sticker price" invariant. The two methods coincide
exactly at whole-rupee taxable bases (the only granularity billed here); they
diverge only for sub-rupee bases, which do not occur.

Tax direction (v2 plan §2a): OyeChats/Digibranders is the domestic supplier
(forward charge), so we compute, show, and remit GST ourselves.

* intra-state (same state)  → CGST + SGST, each ≈ rate/2
* inter-state               → IGST at the full rate
* export + LUT              → zero-rated (all taxes 0)
* export, no LUT            → IGST at the full rate (Rule 96A fallback)
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, get_args

SupplyKind = Literal["intra", "inter", "export"]
_KINDS = get_args(SupplyKind)


@dataclass(frozen=True)
class TaxBreakup:
    taxable_minor: int
    cgst_minor: int
    sgst_minor: int
    igst_minor: int
    total_tax_minor: int
    total_minor: int
    is_export: bool  # derived: supply_kind == "export"
    supply_kind: SupplyKind
    rate_bps: int  # the full GST rate applied (snapshotted so the PDF can print "@ 18%"
    # True only for a zero-rated export under a filed LUT) distinguishes that
    # legend-bearing case from a genuine 0%-rate supply (both have zero tax).
    zero_rated_export: bool = False


def _round_half_up(numerator: int, denominator: int) -> int:
    """Round ``numerator / denominator`` to the nearest integer, halves up.

    Integer-only (no float): ``floor((n + d/2) / d) == (2n + d) // (2d)`` for
    non-negative inputs. Avoids binary-float rounding drift on money.
    """
    return (2 * numerator + denominator) // (2 * denominator)


def supply_kind(seller_state: str | None, buyer_state: str | None, buyer_country: str | None) -> SupplyKind:
    """Classify a supply as intra / inter / export.

    A non-Indian buyer country is an export. Domestically, the supply is
    intra-state when the buyer's state matches the seller's, and, per Circular
    242/36/2024, a B2C sale with no state on record has its place of supply at
    the supplier's location, i.e. intra-state.

    Precondition: ``seller_state`` and ``buyer_state`` must already be canonical
    2-char zero-padded GST state codes (as produced by ``seller_profile_service``
    and validated on ``Client.billing_state_code``). This function compares them
    literally and does NOT re-pad. ``"7"`` and ``"07"`` would classify as
    inter-state. Whitespace is tolerated; zero-padding is the caller's job.
    """
    # Empty / whitespace-only country means "no country on record" → domestic,
    # NOT export (a blank must never flip a domestic sale to a zero-rated export).
    country = (buyer_country or "").strip().upper() or "IN"
    if country != "IN":
        return "export"
    seller = (seller_state or "").strip()
    buyer = (buyer_state or "").strip()
    if not buyer or buyer == seller:
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

    # Export under a filed LUT is zero-rated, no tax carved out or added.
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
            rate_bps=rate_bps,
            zero_rated_export=True,
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
        rate_bps=rate_bps,
        zero_rated_export=False,
    )
