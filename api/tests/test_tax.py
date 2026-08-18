"""GST tax engine. Pure computation, integer paise.

Golden cases come from the plan doc §1c (the ₹1,799 / ₹4,599 money-flow
diagrams); every scenario asserts the reconciliation invariants.
"""

import pytest

from app.core.tax import TaxBreakup, compute_tax, supply_kind

# ── supply classification ─────────────────────────────────────────────────────


def test_supply_kind_intra_same_state():
    assert supply_kind("27", "27", "IN") == "intra"


def test_supply_kind_inter_different_state():
    assert supply_kind("27", "29", "IN") == "inter"


def test_supply_kind_export_foreign_country():
    assert supply_kind("27", None, "US") == "export"


def test_supply_kind_b2c_no_state_defaults_to_supplier_location():
    # Circular 242: with no address on record, place of supply = supplier
    # location, i.e. intra-state.
    assert supply_kind("27", None, "IN") == "intra"
    assert supply_kind("27", "", "IN") == "intra"


def test_supply_kind_none_country_treated_as_domestic():
    assert supply_kind("27", "29", None) == "inter"


def test_supply_kind_country_case_insensitive():
    assert supply_kind("27", None, "in") == "intra"
    assert supply_kind("27", None, "us") == "export"


# ── golden inclusive intra-state cases ────────────────────────────────────────


def test_golden_1799_inclusive_intra():
    b = compute_tax(179900, 1800, inclusive=True, kind="intra")
    assert (b.taxable_minor, b.cgst_minor, b.sgst_minor, b.igst_minor) == (152458, 13721, 13721, 0)
    assert b.total_tax_minor == 27442
    assert b.total_minor == 179900
    assert b.is_export is False


def test_golden_4599_inclusive_intra():
    b = compute_tax(459900, 1800, inclusive=True, kind="intra")
    assert (b.taxable_minor, b.cgst_minor, b.sgst_minor, b.igst_minor) == (389746, 35077, 35077, 0)
    assert b.total_tax_minor == 70154
    assert b.total_minor == 459900


# ── inter-state → IGST ────────────────────────────────────────────────────────


def test_1799_inclusive_inter_igst():
    b = compute_tax(179900, 1800, inclusive=True, kind="inter")
    assert b.igst_minor == 27442
    assert b.cgst_minor == 0 and b.sgst_minor == 0
    assert b.taxable_minor == 152458
    assert b.total_minor == 179900


# ── exclusive pricing (GST added on top) ──────────────────────────────────────


def test_exclusive_intra_adds_tax_on_top():
    b = compute_tax(152458, 1800, inclusive=False, kind="intra")
    assert b.taxable_minor == 152458
    assert b.total_tax_minor == 27442
    assert b.cgst_minor == 13721 and b.sgst_minor == 13721
    assert b.total_minor == 152458 + 27442


def test_exclusive_inter_adds_igst_on_top():
    b = compute_tax(100000, 1800, inclusive=False, kind="inter")
    assert b.taxable_minor == 100000
    assert b.igst_minor == 18000
    assert b.total_minor == 118000


# ── export ────────────────────────────────────────────────────────────────────


def test_export_with_lut_is_zero_rated():
    b = compute_tax(179900, 1800, inclusive=True, kind="export", lut_active=True)
    assert b.total_tax_minor == 0
    assert b.cgst_minor == 0 and b.sgst_minor == 0 and b.igst_minor == 0
    assert b.taxable_minor == 179900
    assert b.total_minor == 179900
    assert b.is_export is True


def test_export_without_lut_charges_igst_inclusive():
    b = compute_tax(179900, 1800, inclusive=True, kind="export", lut_active=False)
    assert b.igst_minor == 27442
    assert b.taxable_minor == 152458
    assert b.total_minor == 179900
    assert b.is_export is True


def test_export_without_lut_charges_igst_exclusive():
    b = compute_tax(100000, 1800, inclusive=False, kind="export", lut_active=False)
    assert b.igst_minor == 18000
    assert b.total_minor == 118000
    assert b.is_export is True


# ── rounding edges ────────────────────────────────────────────────────────────


def test_one_rupee_inclusive_intra_odd_paisa_split():
    b = compute_tax(100, 1800, inclusive=True, kind="intra")
    assert b.taxable_minor == 85
    assert b.total_tax_minor == 15
    # Odd total tax → largest-remainder puts the extra paisa on SGST.
    assert b.cgst_minor == 7 and b.sgst_minor == 8


def test_101_paisa_inclusive_intra():
    b = compute_tax(101, 1800, inclusive=True, kind="intra")
    assert b.taxable_minor == 86
    assert b.total_tax_minor == 15
    assert b.cgst_minor == 7 and b.sgst_minor == 8


def test_exact_integer_quotient_no_rounding():
    # 5900 * 10000 / 11800 = 5000.0 exactly. Every rounding mode agrees, so
    # this proves the carve-out arithmetic but NOT the rounding direction.
    b = compute_tax(5900, 1800, inclusive=True, kind="intra")
    assert b.taxable_minor == 5000
    assert b.total_tax_minor == 900


def test_half_up_rounding_lands_on_a_true_half():
    # 25 * 1800 / 10000 = 4.5 exactly. Half-UP → 5 (banker's/half-even → 4,
    # truncation → 4). Only half-up passes, so this pins the rounding mode.
    b = compute_tax(25, 1800, inclusive=False, kind="inter")
    assert b.igst_minor == 5
    assert b.total_minor == 30


# ── validation ────────────────────────────────────────────────────────────────


def test_negative_amount_rejected():
    with pytest.raises(ValueError, match="amount"):
        compute_tax(-1, 1800, inclusive=True, kind="intra")


def test_bad_rate_rejected():
    with pytest.raises(ValueError, match="rate"):
        compute_tax(1000, -1, inclusive=True, kind="intra")


def test_unknown_kind_rejected():
    with pytest.raises(ValueError, match="kind"):
        compute_tax(1000, 1800, inclusive=True, kind="interstate")


def test_zero_amount_yields_zero_tax():
    b = compute_tax(0, 1800, inclusive=True, kind="intra")
    assert b == TaxBreakup(
        taxable_minor=0,
        cgst_minor=0,
        sgst_minor=0,
        igst_minor=0,
        total_tax_minor=0,
        total_minor=0,
        is_export=False,
        supply_kind="intra",
        rate_bps=1800,
        zero_rated_export=False,
    )


def test_zero_rate_intra_is_taxless_but_not_export():
    # A genuine 0%-rate domestic supply. Distinct from a zero-rated export.
    b = compute_tax(179900, 0, inclusive=True, kind="intra")
    assert b.total_tax_minor == 0
    assert b.taxable_minor == 179900
    assert b.is_export is False
    assert b.zero_rated_export is False
    assert b.rate_bps == 0


def test_rate_bps_snapshotted_on_breakup():
    b = compute_tax(179900, 1800, inclusive=True, kind="intra")
    assert b.rate_bps == 1800


def test_zero_rated_export_flag_only_for_lut_export():
    lut = compute_tax(179900, 1800, inclusive=True, kind="export", lut_active=True)
    no_lut = compute_tax(179900, 1800, inclusive=True, kind="export", lut_active=False)
    intra = compute_tax(179900, 1800, inclusive=True, kind="intra")
    assert lut.zero_rated_export is True
    assert no_lut.zero_rated_export is False  # taxed export, not zero-rated
    assert intra.zero_rated_export is False


def test_whitespace_only_country_is_domestic_not_export():
    # A blank-but-present country must not flip a domestic sale to an export.
    assert supply_kind("27", "29", "  ") == "inter"
    assert supply_kind("27", "27", "  ") == "intra"


def test_state_codes_compared_after_whitespace_strip():
    assert supply_kind(" 27 ", "27", "IN") == "intra"


def test_cgst_equals_sgst_at_whole_rupee_bases():
    # The split convention coincides with per-component rounding at whole-rupee
    # taxable bases; assert the halves stay equal for exclusive whole-rupee bases.
    for rupees in (1, 999, 1799, 4599, 10000):
        b = compute_tax(rupees * 100, 1800, inclusive=False, kind="intra")
        assert b.cgst_minor == b.sgst_minor


# ── invariants across the whole matrix ────────────────────────────────────────


@pytest.mark.parametrize("amount", [0, 1, 25, 100, 101, 179900, 459900, 999999, 12345, 10**12])
@pytest.mark.parametrize("rate", [0, 1200, 1800, 2800])
@pytest.mark.parametrize("inclusive", [True, False])
@pytest.mark.parametrize("kind", ["intra", "inter", "export"])
@pytest.mark.parametrize("lut", [True, False])
def test_invariants_hold_everywhere(amount, rate, inclusive, kind, lut):
    b = compute_tax(amount, rate, inclusive=inclusive, kind=kind, lut_active=lut)
    # Core reconciliation. Always exact.
    assert b.taxable_minor + b.total_tax_minor == b.total_minor
    assert b.cgst_minor + b.sgst_minor + b.igst_minor == b.total_tax_minor
    assert b.taxable_minor >= 0 and b.total_tax_minor >= 0
    if inclusive:
        assert b.total_minor == amount
    else:
        assert b.total_minor == amount + b.total_tax_minor
    if kind == "intra":
        assert b.igst_minor == 0
        assert abs(b.cgst_minor - b.sgst_minor) <= 1
        assert b.is_export is False
    elif kind == "inter":
        assert b.cgst_minor == 0 and b.sgst_minor == 0
        assert b.igst_minor == b.total_tax_minor
        assert b.is_export is False
    else:  # export
        assert b.is_export is True
        assert b.cgst_minor == 0 and b.sgst_minor == 0
        if lut:
            assert b.total_tax_minor == 0
            assert b.taxable_minor == b.total_minor
        else:
            assert b.igst_minor == b.total_tax_minor
