# Invoicing & Tax — Implementation Plan

**Status:** Proposed · **Date:** 2026-06-29 · **Owner:** Engineering
**Builds on:** [Invoicing & Tax review](2026-06-29-invoicing-and-tax-review.md) (findings INV-1…INV-10)
**Complements:** [Remediation plan](2026-06-29-remediation-plan.md) (shares R1 reconciliation; credit notes depend on C2/H6 refund+dispute fixes)

Target outcome: OyeChats issues its **own GST-compliant tax invoices** — sequentially numbered, with seller + buyer GSTIN, place-of-supply-correct CGST/SGST/IGST breakup, HSN/SAC, immutable PDF, emailed to the customer, with credit notes on refund — while Razorpay remains the payment rail. This is the India-SaaS industry standard (own the tax document; the gateway owns the charge).

> ⚖️ **Finance/CA sign-off required.** Tax rates, SAC code, LUT/export treatment, and the inclusive-vs-exclusive pricing decision below are standard defaults for Indian SaaS but **must be confirmed with the company's accountant** before go-live. This plan encodes the mechanism; finance owns the policy values.

---

## 1. Guiding principles (senior engineering + compliance standards)

Acceptance gates for every task:

1. **TDD-first.** Tax math and numbering get exhaustive unit tests before wiring (the review's gaps are the seed cases).
2. **Issued invoices are immutable.** Once finalized, an invoice row is never mutated — corrections are **credit notes / revised invoices**, never edits. Mirrors the append-only ledger principle.
3. **Gapless, per-FY sequential numbering** allocated atomically at finalize time (locked counter), so abandoned/failed payments leave **no gaps** (a GST audit red flag).
4. **Money in integer minor units (paise); one rounding point (half-up).** Tax components must reconcile exactly: `CGST + SGST == total GST`, `taxable + tax == total`.
5. **Idempotent generation.** One invoice per payment (keyed on `razorpay_payment_id`), safe under webhook retries/replays.
6. **Place of supply drives the tax split** — never hardcode CGST/SGST; derive from seller state vs buyer state/country.
7. **Reversible, additive-first migrations** (Alembic up/down); backfill legacy `invoices` rows non-destructively.
8. **Observability:** metric/alert on numbering-counter contention, PDF/email failures, tax-reconciliation mismatches.
9. **Pre-completion checks** (`CLAUDE.md`): `ruff check`·`ruff format`·`pytest`; `npm run lint`+`build` for `app/`. Branch = `development`; one PR per task.

---

## 2. Required decisions (Phase 0 gate)

These block implementation; capture answers before Phase 1.

| # | Decision | Recommended default | Owner |
|---|---|---|---|
| D1 | GST registration status & **seller GSTIN / legal name / registered state** | (from finance) | Finance |
| D2 | **SAC code** for SaaS | `998314` (IT design & development services) | CA |
| D3 | GST **rate** | **18%** | CA |
| D4 | **Inclusive vs exclusive** pricing | **Inclusive** for INR display (carve out GST on the invoice); show "incl. GST" | Product/Finance |
| D5 | **Export of services** (foreign/USD buyers) treatment | **Zero-rated under LUT** (no IGST) if LUT filed, else IGST 18% | CA |
| D6 | Invoice **number format** | `OC/2026-27/000001` (prefix / FY / 6-digit serial) | Eng+Finance |
| D7 | Collect **buyer GSTIN** at checkout? | Optional field; required to mark invoice B2B | Product |
| D8 | Who is the **supplier of record** — OyeChats entity vs Razorpay route | OyeChats issues; Razorpay collects | Finance |

---

## 2a. Reference layout & supply-scenario matrix

**Layout reference:** the Stripe-issued **Anthropic** invoice (seller GSTIN/VAT block, invoice no., issue/due dates, bill-to with buyer GSTIN + address, line items `Qty | Unit price | Tax | Amount`, period, Subtotal/Total/Amount due) is a good visual template — the Phase 4 PDF should match this structure.

**Critical tax-direction note:** that sample is the **mirror image** of OyeChats. There, a **foreign supplier** (Anthropic, US) sells to an **Indian registered business**, so the line shows **`0%` + "tax to be paid on reverse charge basis"** — the *recipient* self-accounts for IGST (import of services). **OyeChats is the domestic Indian supplier**, so **forward charge applies**: we compute, show, collect, and remit GST ourselves. Our invoices carry *more* tax detail than the sample.

| Scenario | OyeChats role | Tax shown on invoice | Note line |
|---|---|---|---|
| Indian customer, **same state** as seller (intra-state) | Domestic supplier — forward charge | **CGST 9% + SGST 9%** | standard tax invoice |
| Indian customer, **different state** (inter-state) | Domestic supplier — forward charge | **IGST 18%** | standard tax invoice |
| **Foreign** customer (USD) — export of service | Exporter, zero-rated | **0%** | "Export of service under LUT — zero-rated" (or IGST 18% if no LUT) |
| *Foreign supplier → Indian B2B (the Anthropic sample)* | **N/A — not OyeChats's case** | 0% | "reverse charge" — for contrast only |

The `0% / reverse-charge` label never appears on a standard OyeChats sale; the only zero-rate case we issue is the **export** row (different legal basis: zero-rated export under LUT, not reverse charge). `core/tax.py` (Phase 2) must select the breakup + note from this matrix, never hardcode a single treatment.

## 3. Issue → phase mapping

| Finding | Title | Phase |
|---|---|---|
| INV-1 | No tax/GST (GSTIN, breakup, place of supply, HSN/SAC) | 1, 2, 3 |
| INV-5 | No legal sequential invoice numbering | 3 |
| INV-8 | Activation writes no invoice row | 3 |
| INV-9 | Only `paid` invoices created | 3 |
| INV-10 | `Invoice.currency` default `"usd"` while charging INR | 1 |
| INV-4 | `invoice_url`/`pdf_url` never populated; no PDF | 4 |
| INV-3 | No invoice/receipt email from OyeChats | 4 |
| INV-7 | Top-ups not invoiced provider-side | 3, 4 |
| INV-2 | No credit note on refund | 5 |
| INV-6 | Currency display bug (`$` hardcoded for INR) | 6 |

---

## 4. Phase plan

Effort = rough engineer-days. Each phase is independently shippable behind `INVOICING_V2_ENABLED` (issue documents in shadow/admin-only first, then customer-facing).

### Phase 0 — Decisions, seller config & foundations · ~2 d
- Resolve D1–D8 (§2); store seller identity (GSTIN, legal name, address, state, SAC, rate, LUT status) in **config / a `seller_profile` settings row** (single source, super-admin editable, never hardcoded).
- Test fixtures: intra-state, inter-state, export, inclusive/exclusive, partial-refund cases.
- Feature flag `INVOICING_V2_ENABLED` (+ `INVOICE_EMAILS_ENABLED`).
- **Acceptance:** seller profile readable in tests; flags wired; fixtures compile.

### Phase 1 — Tax identity & data model · ~3–4 d
- **`Client` billing fields:** `legal_name`, `gstin` (validated 15-char format), `billing_address`, `country`, `state_code` (GST state code for place of supply). Capture at checkout (D7); editable in account settings.
- **`Invoice` schema extension** (additive): `invoice_number` (unique, nullable until finalized), `invoice_type` (`tax_invoice`|`credit_note`), `seller_snapshot` (JSONB — GSTIN/name/address at issue time), `buyer_snapshot` (JSONB), `place_of_supply`, `taxable_value_minor`, `tax_rate_bps`, `cgst_minor`, `sgst_minor`, `igst_minor`, `total_tax_minor`, `hsn_sac`, `is_export`, `line_items` (JSONB), `credit_note_of_id` (self-FK). Fix `currency` default to nullable/explicit (INV-10).
- **`invoice_counters`** table: `(financial_year, prefix) → last_serial` for gapless numbering.
- Migrations additive + reversible; backfill existing rows as legacy (`invoice_number=NULL`, `invoice_type='legacy'`).
- **Acceptance:** GSTIN format validated; migrations up/down clean; legacy rows untouched and still listable.

### Phase 2 — Tax computation engine (pure, well-tested) · ~3 d
- `core/tax.py` — pure functions, integer paise, no I/O:
  - `place_of_supply(seller_state, buyer_state, buyer_country) -> {intra|inter|export}`.
  - `compute_gst(total_or_taxable_minor, rate_bps, inclusive: bool, supply_kind) -> TaxBreakup` returning `taxable, cgst, sgst, igst, total_tax, total` with the invariants enforced (`cgst==sgst`, `cgst+sgst==igst-equivalent`, components sum to total; remainder assigned to the last bucket — largest-remainder discipline).
  - Inclusive carve-out: `taxable = round(total × 10000 / (10000 + rate_bps))`.
  - Export: zero tax under LUT (D5), flagged `is_export`.
- **Acceptance:** unit tests for intra/inter/export × inclusive/exclusive × edge amounts; every invariant holds; ₹-perfect against hand-computed examples.

### Phase 3 — Invoice generation & gapless numbering · ~4–5 d
- A single `invoice_service.finalize_invoice(...)` called from the webhook handlers, **idempotent on `razorpay_payment_id`**:
  - Builds line items, runs `core/tax.py`, snapshots seller+buyer, **allocates the next serial under a row lock** on `invoice_counters` (no number for abandoned/failed payments → no gaps), writes an **immutable** finalized invoice.
- Wire into `_handle_subscription_charged`, `_handle_payment_captured` **and** fix **INV-8** (ensure the first/activation charge produces an invoice) and **INV-7** (top-ups get a real tax invoice).
- Reuses the period-grant/idempotency work from remediation H4/H5.
- **Acceptance:** one invoice per payment under replay; concurrent finalizes produce **consecutive, gapless** numbers (load test); abandoned payment → no number burned; export vs domestic numbering correct.

### Phase 4 — PDF, storage & email delivery · ~4 d
- Tax-invoice **PDF template** (HTML→PDF, e.g. WeasyPrint): seller GSTIN/name/address, buyer details, invoice no + date, SAC/HSN, taxable value, CGST/SGST/IGST lines, total, amount in words, place of supply, "Tax Invoice" title, signature/declaration.
- Render on finalize → store in **R2** → populate `invoice_url` (hosted) + `pdf_url` (download). Fixes **INV-4**.
- **Brevo email** on charge with the PDF attached/linked (gated by `INVOICE_EMAILS_ENABLED`). Fixes **INV-3**.
- **Acceptance:** PDF matches computed figures byte-for-byte on amounts; stored + linked; email delivered in a test; admin "download" now works.

### Phase 5 — Credit notes (refunds & disputes) · ~3 d · **depends on remediation C2 + H6**
- On `refund.processed` (and `dispute.lost`), generate a **credit note** linked to the original invoice (`credit_note_of_id`), with its own sequential number, negative tax breakup proportional to the refunded amount, PDF + email. Replaces today's bare `status` flip (INV-2).
- **Acceptance:** full + partial refund produce a correct credit note; tax reversed proportionally; original invoice immutable; numbers gapless.

### Phase 6 — Customer/admin UX + currency fix · ~2–3 d
- Fix **INV-6**: currency-aware formatting everywhere (`₹` vs `$` by `inv.currency`); stop hardcoding `$`.
- GSTIN/billing capture at checkout + account settings (Phase 1 fields surfaced).
- "Payment History" → "Invoices": show number, type, download PDF (now populated); superadmin invoice list + re-send email.
- **Acceptance:** INR renders as ₹; customer can download tax invoice + credit note; superadmin can re-send.

### Phase 7 — Reconciliation & reporting · ~3 d · ties to remediation R1
- **GSTR-1-style export** (period → taxable value, tax by rate, B2B vs B2C, export) for finance.
- Reconcile issued invoices ↔ Razorpay settlements/refunds (shared with remediation R1); flag mismatches.
- **Acceptance:** monthly export matches the ledger and Razorpay totals to the rupee; mismatches alert.

---

## 5. Sequencing & dependencies

```
P0 ─► P1 ─► P2 ─► P3 ─► P4 ─► P6
                   └─► P5 (needs remediation C2 + H6)
                   └─► P7 (needs R1)
```
- Critical path to **customer-facing tax invoices:** P0→P1→P2→P3→P4 (+P6 for the UI).
- **Credit notes (P5)** must wait for the refund/dispute correctness fixes (remediation C2, H6) so reversals are accurate before they're documented.
- Until P3 ships, **Phase A of the review's recommendations** (configure Razorpay dashboard GSTIN/tax as interim compliance) stays in effect — document it as the bridge.

## 6. Cross-cutting deliverables
- Regression suite: tax math, gapless numbering under concurrency, idempotent finalize, PDF amount-parity, credit-note proportions.
- Migrations: client billing fields; invoice tax columns + snapshots; `invoice_counters`; credit-note self-FK — all additive/reversible with legacy backfill.
- Runbooks: numbering-counter recovery, invoice re-issue/credit-note procedure, GSTR export.
- Doc updates: mark INV-1…INV-10 resolved in the review; update billing overview.

## 7. Risks & rollback
| Risk | Mitigation |
|---|---|
| Wrong tax treatment (legal exposure) | CA sign-off gate (§2); shadow-issue invoices admin-only before customer-facing; configurable rate/SAC |
| Numbering gaps/duplicates | Allocate-on-finalize under row lock; unique constraint; concurrency load test; counter recovery runbook |
| PDF/email failure blocks payment flow | Generate async after the money path commits; retry queue; never fail the webhook on PDF/email error |
| Legacy rows lack tax data | Marked `legacy`; excluded from GST export; not retro-taxed |
| Rounding mismatches | Single rounding point + invariant assertions in `core/tax.py` tests |

Each phase is flag-gated and revertible; invoices can be issued in shadow (stored, not emailed) until verified.

## 8. Definition of done (per task)
1. Failing test first; passes after; in CI.
2. Tax/numbering invariants asserted in tests.
3. `ruff`/`pytest` (+ FE `lint`/`build`) green; migration up/down verified.
4. Observability for the new failure mode added.
5. Flag default + rollout step documented; CA-owned values sourced from config, not code.
6. Review finding marked resolved; docs updated.
