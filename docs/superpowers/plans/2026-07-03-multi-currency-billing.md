# Multi-Currency Billing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement **Phase 1** task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Phase 2 is design-locked, not step-locked** — see the note at its head before starting it.

**Goal:** Make OyeChats' currency story coherent end-to-end — keep the USD sticker the team wants, but stop hiding the rupee charge — and lay a gated path to genuine foreign-currency (USD) billing when it's actually needed.

**Architecture:** Three currency layers stay explicitly separate: **display** (what the customer sees), **charge** (what Razorpay debits), and **invoice** (the legal tax document). Phase 1 hardens the *already-shipping* "display USD / charge INR / invoice INR" model (billing ADR D2/D3) by disclosing the INR charge and removing currency-label bugs. Phase 2 adds a second, geo-routed rail — real USD charging via Razorpay International Payments plus zero-rated export invoices — behind a feature flag, gated on external prerequisites.

**Tech Stack:** FastAPI + SQLAlchemy 2.0 (`api/`), React 19 + Vite (`app/`), Razorpay (INR primary; International Payments for Phase 2), WeasyPrint invoice PDFs, pytest + ESLint.

---

## CTO framing — read this first

**What is already true in the code (do NOT rebuild):**

- Display is already USD-first. `app/core/pricing.py::display_price` + `format_amount` and `GET /subscriptions/geo` (returns `display_currency: "USD"`) implement the team's "$19 for Starter" ask. This is done.
- Charge is already INR-only, by design. `razorpay_service.create_subscription` bills the INR Razorpay plan (`plan.razorpay_plan_id_monthly/annual`); `create_topup_order` hard-rejects non-INR. `core/pricing.py` documents this: *"there is no live FX in the charge path."*
- Invoice is already INR + GST and correct for Indian buyers, with an INR-only guard in `invoice_service.finalize_invoice`.

**The actual defect (this is what Phase 1 fixes):** `GET /subscriptions/checkout/quote` returns `currency: "USD"`, `amount_minor = monthly_price_usd_cents`, **and** `methods: ["card","upi"]` — i.e. it quotes "$19, pay by UPI" while the mandate actually debits the INR Razorpay plan. The customer is never shown the rupee amount they'll be charged. That's a transparency problem, not a math problem. Two cosmetic currency-label bugs compound it.

**Scope decision (mine, as CTO):**

- **Phase 1 ships now.** It is small, low-risk, and fully removes the incoherence the team's "$19" request would otherwise create. Fully specified below as TDD.
- **Phase 2 (real foreign USD) is NOT built speculatively.** It is a second billing rail (International Payments activation, dual Razorpay plans, export invoicing, LUT, FIRC/e-FIRA) with external prerequisites and CA sign-off. It is design-locked here so the direction is fixed, but we do not write exhaustive TDD steps for work blocked on decisions we haven't made. Kick it off only when the prerequisites at its head are all green.

**Out of scope for this plan** (tracked separately — see the invoice-structure review): statutory seller fields (CIN/PAN/contact) on the PDF, invoice line-item Qty/Rate columns, the `developer@` support email. Those are invoice-*document* fixes, not currency work.

---

# PHASE 1 — Charge-currency transparency + label cleanup

**Definition of done:** The checkout quote returns both the USD display price and the real INR charge; the plan-selector shows the customer the rupee amount before they pay; no UI labels a credit balance or a UPI charge as "USD". Full API suite green, `app/` lints and builds.

**Branch:** `development` (per project rule — never `main`).

**Test runner (backend):** `cd api && DB_URL=postgresql://postgres:postgres@127.0.0.1:5432/postgres .venv/bin/python -m pytest <path> --no-cov`
**Lint (frontend):** `cd app && npm run lint` · **Build:** `cd app && npm run build`

---

### Task 1: Quote returns the real INR charge alongside the USD display

The quote must stop being USD-only. Add `charge_*` fields sourced from the INR price columns (`monthly_price_cents` / `annual_price_cents` via the existing `_amount_for_cycle` helper) and a plain-language disclosure. The existing USD fields (`currency`, `amount_minor`, `amount_display`) are **unchanged** so nothing that reads them breaks.

**Files:**

- Modify: `api/app/api/subscription_routes.py` (the `checkout_quote` handler, ~665–753)
- Test: `api/tests/test_subscription_routes_pricing.py`

- [ ] **Step 1: Write the failing test**

Add to `api/tests/test_subscription_routes_pricing.py` (follow the existing fixtures in that file for `client`/`db`/auth headers — reuse the same `seed_plan`/`auth_headers` helpers already used by the other tests there):

```python
def test_checkout_quote_includes_inr_charge(client, auth_headers, seed_plan):
    # Starter: displayed as $19, actually charged ₹1,799 (incl. GST, inclusive pricing).
    plan = seed_plan(slug="starter", monthly_price_cents=179900,
                     monthly_price_usd_cents=1900,
                     razorpay_plan_id_monthly="plan_test_starter")

    res = client.get(
        f"/subscriptions/checkout/quote?plan_id={plan.id}&billing_cycle=monthly",
        headers=auth_headers,
    )
    assert res.status_code == 200
    body = res.json()

    # USD display fields are preserved unchanged.
    assert body["currency"] == "USD"
    assert body["amount_minor"] == 1900
    assert body["amount_display"] == "$19"

    # New: the real INR charge is disclosed.
    assert body["charge_currency"] == "INR"
    assert body["charge_amount_minor"] == 179900
    assert body["charge_amount_display"] == "₹1,799"
    assert "₹1,799" in body["charge_disclosure"]
    assert "GST" in body["charge_disclosure"]
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd api && DB_URL=postgresql://postgres:postgres@127.0.0.1:5432/postgres .venv/bin/python -m pytest tests/test_subscription_routes_pricing.py::test_checkout_quote_includes_inr_charge -v --no-cov`
Expected: FAIL — `KeyError: 'charge_currency'`.

- [ ] **Step 3: Add the charge fields to the quote**

In `checkout_quote`, after `plan` is validated and before the free-plan branch, compute the INR charge once:

```python
        country = resolve_country(request)
        usd_minor = plan.annual_price_usd_cents if billing_cycle == "annual" else plan.monthly_price_usd_cents
        amount_minor = int(usd_minor or 0)
        currency = "USD"
        amount_display = format_amount(amount_minor, currency)

        # The customer is DISPLAYED USD but CHARGED INR (billing ADR D2/D3 —
        # no live FX in the charge path). Surface the real rupee amount so the
        # UI can disclose it before the mandate is authorised. Inclusive
        # pricing (seller_profile.price_inclusive) means this total already
        # contains GST — say so, don't recompute tax here.
        charge_amount_minor = _amount_for_cycle(plan, billing_cycle)
        charge_currency = "INR"
        charge_amount_display = format_amount(charge_amount_minor, charge_currency)
        cycle_word = "yr" if billing_cycle == "annual" else "mo"
        charge_disclosure = (
            f"Billed as {charge_amount_display}/{cycle_word} (incl. GST) "
            "in INR via UPI or card."
        )
```

Then add these four keys to **every** returned dict in the handler (the free-plan branch, the enterprise branch, and the final success dict). For the free-plan branch set `charge_amount_minor: 0` and keep the same `charge_currency`/`charge_amount_display`/`charge_disclosure` keys so the response shape is uniform. Concretely, each `return {...}` gains:

```python
            "charge_currency": charge_currency,
            "charge_amount_minor": charge_amount_minor,
            "charge_amount_display": charge_amount_display,
            "charge_disclosure": charge_disclosure,
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `cd api && DB_URL=postgresql://postgres:postgres@127.0.0.1:5432/postgres .venv/bin/python -m pytest tests/test_subscription_routes_pricing.py::test_checkout_quote_includes_inr_charge -v --no-cov`
Expected: PASS.

- [ ] **Step 5: Run the full pricing test module (nothing else regressed)**

Run: `cd api && DB_URL=postgresql://postgres:postgres@127.0.0.1:5432/postgres .venv/bin/python -m pytest tests/test_subscription_routes_pricing.py -v --no-cov`
Expected: all PASS.

- [ ] **Step 6: Lint + commit**

```bash
cd api && uv run ruff check app/api/subscription_routes.py && uv run ruff format app/api/subscription_routes.py tests/test_subscription_routes_pricing.py
git add app/api/subscription_routes.py tests/test_subscription_routes_pricing.py
git commit -m "feat(billing): expose real INR charge + disclosure in checkout quote"
```

---

### Task 2: Show the INR charge disclosure in the plan selector

The customer must see the rupee amount before authorising. `PlanModal.jsx` already renders the `$` headline via its geo/`toDisplayPrice` logic; add a small disclosure line beneath the CTA, fed by the plan's INR price that the `/plans` payload already carries (`monthly_price_cents` / `annual_price_cents` + `currency`).

**Files:**

- Modify: `app/src/components/billing/PlanModal.jsx` (near the paid-plan CTA / price block — the `PlanCard`/price area around lines 981–1092 and the CTA render)
- Reuse: `app/src/lib/currency.js::formatMoney`

- [ ] **Step 1: Add a presentational disclosure helper**

At module scope in `PlanModal.jsx` (near the other helpers like `toDisplayPrice`), add:

```jsx
// The headline is USD (team decision) but Razorpay debits INR. Never let a
// customer authorise a mandate without seeing the rupee amount first.
function ChargeDisclosure({ plan, billingCycle }) {
  const inrMinor = billingCycle === 'annual'
    ? (plan?.annual_price_cents ?? 0)
    : (plan?.monthly_price_cents ?? 0);
  if (!inrMinor) return null; // free / enterprise — nothing is charged here
  const cycleWord = billingCycle === 'annual' ? 'yr' : 'mo';
  return (
    <p className="mt-2 text-[11px] text-surface-500 dark:text-surface-400">
      Billed as {formatMoney(inrMinor, 'inr')}/{cycleWord} (incl. GST) in INR via UPI or card.
    </p>
  );
}
```

- [ ] **Step 2: Render it under the price/CTA for paid plans**

In the paid-plan branch that renders the price + primary CTA button, add the disclosure immediately after the price block (use the same `billingCycle` variable already in scope in that component):

```jsx
              <ChargeDisclosure plan={plan} billingCycle={billingCycle} />
```

Place it so it reads directly under the `$` headline price, above or just below the "Upgrade to …"/"Subscribe" button — wherever the existing price JSX lives for that card.

- [ ] **Step 3: Verify in the running app**

Start the admin app and confirm the line renders under a paid plan's `$` price and reads e.g. *"Billed as ₹1,799/mo (incl. GST) in INR via UPI or card."*. Free/Enterprise cards show no disclosure (helper returns null).

Run: `cd app && npm run dev` → open Billing → "Change plan"/"Choose a plan" → inspect the Starter card.

- [ ] **Step 4: Lint + build + commit**

```bash
cd app && npm run lint && npm run build
git add src/components/billing/PlanModal.jsx
git commit -m "feat(billing): disclose INR charge amount under USD price in plan selector"
```

---

### Task 3: Remove the currency-label bugs

Two labels are factually wrong: a credit balance is tagged "(USD)" (credits are not a currency), and the top-ups footer says the charge is "USD" when top-ups are hard-charged in INR. Fix both. Do **not** flip `formatMoney`'s `'usd'` default here — that's a broader audit (Phase 1 follow-up), and a blind flip would mislabel the genuine USD headline columns.

**Files:**

- Modify: `app/src/pages/Billing.jsx` (line ~1111 credits "(USD)"; line ~1207 TopupsTab footer)

- [ ] **Step 1: Fix the top-up-credits "(USD)" label**

In `BotCreditCard` (~line 1109-1113), change:

```jsx
        {bot.topup > 0 && (
          <div className="mt-2 text-[11px] text-surface-500 dark:text-surface-400">
            + {fmtNumber(bot.topup)} top-up credits (USD)
          </div>
        )}
```

to:

```jsx
        {bot.topup > 0 && (
          <div className="mt-2 text-[11px] text-surface-500 dark:text-surface-400">
            + {fmtNumber(bot.topup)} top-up credits
          </div>
        )}
```

- [ ] **Step 2: Fix the TopupsTab charge-currency footer**

At the bottom of `TopupsTab` (~line 1206-1208), change:

```jsx
      <p className="text-[11px] text-surface-500 dark:text-surface-400 text-center">
        USD. We accept UPI, cards, and NetBanking via Razorpay.
      </p>
```

to:

```jsx
      <p className="text-[11px] text-surface-500 dark:text-surface-400 text-center">
        Prices shown in USD; billed in INR. We accept UPI, cards, and NetBanking via Razorpay.
      </p>
```

- [ ] **Step 3: Lint + build + commit**

```bash
cd app && npm run lint && npm run build
git add src/pages/Billing.jsx
git commit -m "fix(billing): correct misleading USD currency labels (credits/top-up footer)"
```

---

### Task 4: Full Phase-1 verification gate

- [ ] **Step 1: Backend suite**

Run: `cd api && DB_URL=postgresql://postgres:postgres@127.0.0.1:5432/postgres .venv/bin/python -m pytest --no-cov`
Expected: all PASS (baseline was 1533 in the invoicing track; this adds ≥1).

- [ ] **Step 2: Backend lint/format**

Run: `cd api && uv run ruff check . && uv run ruff format --check .`
Expected: clean.

- [ ] **Step 3: Frontend lint + build**

Run: `cd app && npm run lint && npm run build`
Expected: clean.

- [ ] **Step 4: Manual smoke**

Open Billing → Change plan: `$` headline + `₹` disclosure both visible. Overview per-bot card: no "(USD)" on credits. Top-ups tab footer: "Prices shown in USD; billed in INR."

Report results as: `lint ✓ · build ✓ · pytest ✓`.

---

# PHASE 2 — True foreign-currency (USD) billing  🔒 GATED

> **Do not begin Phase 2 until every prerequisite below is green.** This section is **design-locked, not step-locked**: the architecture and task boundaries are fixed, but per-task TDD steps are intentionally deferred to kickoff because the work depends on external activations and legal sign-offs that will shape the exact interfaces. Writing micro-steps now would be speculative. When prerequisites clear, expand each task below into TDD steps using this same skill.

### Prerequisites (all must be true before writing a line of code)

1. **Business decision:** confirmed real demand for foreign customers paying in their own currency (not just a USD sticker). If the answer is "we just want the $ label," Phase 1 already delivers it — **stop here.**
2. **Razorpay International Payments activated** on the Digibranders merchant account (separate underwriting/approval). Confirm supported presentment currencies and that **international recurring subscriptions** (card mandates) are enabled, not just one-time.
3. **EEFC vs INR settlement decision** for international card receipts (original-currency EEFC settlement vs forced INR conversion).
4. **GST/legal sign-off** (the CA items already pending in the invoicing plan): **LUT** filed for zero-rated export without IGST; SAC/export treatment; **FIRC/e-FIRA** capture process for forex-realisation proof.
5. **Accept that UPI is off the table for foreign buyers** — they are international-card-mandate only. This is a different flow from the primary rail; product must sign off.

### Architecture (locked)

Buyer **geography** (`resolve_country`) is the single routing key across all three layers:

| Layer   | Domestic (IN) buyer              | Foreign buyer                                                        |
| ------- | -------------------------------- | -------------------------------------------------------------------- |
| Display | USD sticker (or INR)             | USD sticker                                                          |
| Charge  | INR — UPI/card, existing rail   | **USD — international card mandate, new rail**                |
| Invoice | INR tax invoice + GST (existing) | **USD export invoice, zero-rated (LUT), INR-equivalent shown** |

### Tasks (expand to TDD at kickoff)

- [ ] **P2-T1 — Dual Razorpay plans + geo routing.** A Razorpay Plan is single-currency, so each paid tier needs a **parallel USD Razorpay plan** alongside the INR one. Add `razorpay_plan_id_monthly_usd` / `razorpay_plan_id_annual_usd` columns to `Plan` (Alembic migration). Extend the super-admin Plans UI to capture them. `razorpay_service.create_subscription` selects the INR vs USD plan id by buyer country. **Acceptance:** an IN buyer gets the INR plan/mandate; a US buyer gets the USD plan/mandate; neither can be charged in the wrong currency.
- [ ] **P2-T2 — International-card subscription + top-up path.** Gate a `currency` parameter through `create_subscription` and `create_topup_order` (today it hard-rejects non-INR). Restrict foreign flows to card methods (no UPI). Handle Razorpay International webhooks/settlement. **Acceptance:** a foreign card completes a recurring USD subscription and a one-time USD top-up end-to-end in Razorpay test mode.
- [ ] **P2-T3 — Export-invoice branch.** Replace the blanket INR-only guard in `finalize_invoice` with buyer-currency routing: INR → existing GST invoice; foreign convertible-forex → **export invoice** via the export path already modelled in `core/tax.py` (`supply_kind == "export"`, zero-rated, place of supply "Outside India", LUT legend already in the PDF template). **Acceptance:** a USD export payment produces a finalized, numbered, zero-rated export invoice; an INR payment is unchanged.
- [ ] **P2-T4 — INR equivalent on the export PDF (Rule 34).** The export invoice is denominated in USD but must also show the **INR equivalent** at the GAAP/RBI rate on the date of supply. Capture the rate at finalize, snapshot it, render an "INR equivalent @ rate on <date></date>" line. **Acceptance:** every foreign-currency invoice shows both the USD total and its INR equivalent + the rate/date used.
- [ ] **P2-T5 — FIRC/e-FIRA capture + export reconciliation.** Persist forex-realisation references (FIRC/e-FIRA) against export invoices; extend the reconciliation report (`invoice_reports.py`) to flag export invoices lacking realisation proof. **Acceptance:** the GSTR/export report lists each export invoice with its realisation reference or an anomaly.
- [ ] **P2-T6 — Geo-correct display.** Decide whether Indian buyers see INR or USD (today `/geo` returns USD for everyone via `display_price` which already supports `country == "IN" → INR`). Align display currency with charge currency so a buyer never sees a currency they can't be charged in. **Acceptance:** display currency and charge currency agree per buyer.

### Phase 2 rollout

Ship behind a `MULTICURRENCY_V2_ENABLED` flag (default off), mirroring the invoicing-track kill-switch pattern. Real activation gate = USD Razorpay plans configured + LUT on file, same "config-is-the-switch" approach as the seller profile.

---

## Risks & rollback

- **Phase 1 is additive and reversible.** The quote changes only *add* keys; the frontend changes are copy/labels. Rollback = revert the three commits.
- **Do not touch `formatMoney`'s default currency in Phase 1.** The USD headline columns depend on it; a global flip mislabels real USD amounts. Handle it as a scoped follow-up audit that passes explicit currency at each call site.
- **Phase 1's INR disclosure assumes `monthly_price_cents` equals the amount configured on the Razorpay plan.** If they can drift, add a super-admin reconciliation check (compare `plan.monthly_price_cents` to the live Razorpay plan amount) as a Phase-1 follow-up — otherwise the disclosure could quote a different rupee figure than the mandate debits.
- **Phase 2 doubles the billing surface.** Every new path needs its own webhook idempotency, its own invoice branch, and CA sign-off. Do not merge P2 tasks — land them independently, each with its own review, like the invoicing track.

---

## Self-review checklist (completed by plan author)

- **Spec coverage:** Q1 display USD → already done, noted; Q2 INR-vs-USD invoice → Phase 1 (INR) verified correct, Phase 2 (export) P2-T3/T4; Q3 foreign recurring card → P2-T1/T2; Q4 separate Razorpay plans → P2-T1. ✅
- **Placeholder scan:** Phase 1 steps contain full code and exact commands; Phase 2 is explicitly design-locked with acceptance criteria, not fake TDD. ✅
- **Type/name consistency:** `charge_amount_minor`/`charge_currency`/`charge_amount_display`/`charge_disclosure` used identically in Task 1 test, handler, and Task 2 consumer; `_amount_for_cycle`, `format_amount`, `formatMoney`, `resolve_country` all reference real existing symbols. ✅
