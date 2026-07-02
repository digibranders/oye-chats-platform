# Invoicing Phase 2 — Tax Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A pure, exhaustively-tested GST computation module `app/core/tax.py` — no I/O, integer paise — that later phases call to fill an invoice's tax fields.

**Architecture:** Two pure functions. `supply_kind(seller_state, buyer_state, buyer_country)` classifies the supply as `intra` / `inter` / `export` per the Place-of-Supply rules. `compute_tax(amount_minor, rate_bps, *, inclusive, kind, lut_active)` returns an immutable `TaxBreakup` with taxable value, CGST/SGST/IGST, total tax, total, and export flag. Single rounding point (half-up); largest-remainder split so components reconcile to the paisa.

**Tech Stack:** Python 3.11 · dataclasses · pytest. Path: `api/app/core/tax.py`, test `api/tests/test_tax.py`.

**Env:** `cd api && .venv/bin/python -m pytest tests/test_tax.py --no-cov` (no DB needed — pure module). Lint `.venv/bin/python -m ruff check . && ruff format .`. Branch `development`, commit per task.

## Tax rules encoded (from v2 doc §2a matrix + research)

| Scenario | Result |
|---|---|
| intra-state (seller state == buyer state) | CGST + SGST, each ≈ rate/2; IGST 0 |
| inter-state (different Indian states) | IGST = full rate; CGST/SGST 0 |
| export, LUT active | zero-rated: all taxes 0, taxable = total, `is_export=True` |
| export, no LUT | IGST = full rate (like inter-state), `is_export=True` |

**Inclusive** (our default): `taxable = round_half_up(amount × 10000 / (10000 + rate_bps))`, `total_tax = amount − taxable`, `total = amount`. **Exclusive:** `taxable = amount`, `total_tax = round_half_up(amount × rate_bps / 10000)`, `total = amount + total_tax`.
Split: `cgst = total_tax // 2`, `sgst = total_tax − cgst` (odd paisa → SGST, largest-remainder).

**Golden cases (₹, GST-inclusive, intra, 1800 bps):** ₹1,799 (179900p) → taxable 152458, cgst 13721, sgst 13721, total_tax 27442. ₹4,599 (459900p) → taxable 389746, cgst 35077, sgst 35077, total_tax 70154.

**Invariants (asserted in tests):** `taxable + total_tax == total`; `cgst + sgst + igst == total_tax`; intra ⇒ `igst==0`, `abs(cgst−sgst) ≤ 1`; inter/export-no-LUT ⇒ `cgst==sgst==0, igst==total_tax`; export+LUT ⇒ `total_tax==0, taxable==total==amount`; inclusive ⇒ `total==amount`; exclusive ⇒ `total==amount+total_tax`.

---

### Task 1: `core/tax.py` + exhaustive tests

**Files:** Create `app/core/tax.py`, `tests/test_tax.py`.

- [ ] Step 1: Write failing tests (golden ₹1,799/₹4,599; intra/inter/export×inclusive/exclusive; edge amounts 100p/101p; LUT on/off; state/country classification; invariants via a parametrized invariant-checker; rejects negative amount / bad rate).
- [ ] Step 2: Run — expect FAIL (`ModuleNotFoundError`). `cd api && .venv/bin/python -m pytest tests/test_tax.py --no-cov`.
- [ ] Step 3: Implement `app/core/tax.py` (pure, integer half-up via `(2n + d) // (2d)`).
- [ ] Step 4: Run — expect all PASS.
- [ ] Step 5: `ruff check` + `format`; commit `feat(invoicing): pure GST tax engine (core/tax.py)`.

### Task 2: Phase 2 gate

- [ ] Full suite + ruff clean.
- [ ] 2-agent adversarial code review of the diff; verify each finding against code; fix confirmed ones; re-run.
- [ ] Report to user.
