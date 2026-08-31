# OyeChats — Billing & Invoicing System Review

**Reviewer:** Senior Software Engineer / Global-SaaS Billing & India-GST specialist
**Date:** 2026-07-10
**Method:** 100% code-based. Documentation, docstrings, and prior reports were treated as *claims* and verified against the actual implementation. No file was modified.
**Scope:** `oye-chats-platform/api` (Razorpay integration, invoicing/GST, credit ledger, subscriptions, plans/pricing) + billing UIs in `oye-chats-platform/app`, `oyechats-admin`, and `oyechats-website`.

> ## ✅ Findings A–H were closed. Two premises have since moved.
>
> **Re-checked 2026-08-31.** The eight confirmed findings were remediated in PR #260 (plan:
> [`2026-07-11-billing-remediation-plan.md`](./2026-07-11-billing-remediation-plan.md);
> changelog: [`2026-07-11-pre-merge-runbook.md`](./2026-07-11-pre-merge-runbook.md) §1). The
> **§7 documentation-drift table is also resolved** — `CLAUDE.md` now reads "Razorpay (INR)
> — single provider" and no longer lists `api/app/services/billing_service.py`.
>
> Left unedited, because the review's value is its reasoning and its severity calls, not its
> status. Read these two with the correction in mind:
>
> * **§1's "Razorpay is a single point of failure for *all* revenue" still stands**, and is a
>   deliberate position, not an oversight — see `billing-system-overview.html` §14 for why the
>   Stripe rail was built and then removed.
> * **Pricing became GST-EXCLUSIVE on 26 Aug 2026.** Every price is now a base price and a
>   domestic customer is debited base + GST (`core/tax.py::gross_charge_minor`). The invoicing
>   engine described here was NOT changed, so the carve-out this review assesses is still the
>   shipped one.

---

## 1. Executive summary

This is a **mature, carefully-engineered billing system** — well above the norm for a SaaS at this stage. The financial primitives are genuinely strong: the GST tax engine, gapless invoice numbering, credit-ledger concurrency control, and webhook idempotency are all senior-level work and reconcile by construction. Much of this quality is the visible residue of a prior remediation pass (53 findings closed).

The residual risk is **not** in the crypto or the core math — those are solid. It is concentrated in a handful of **money-loss / revenue-leakage corners and GST presentation gaps**, most of them at feature *seams* (seats, plan-price edits, proration, cross-boundary dating) rather than in the hot path.

**Overall grade: B+ / strong.** No unmitigated Critical was confirmed. There are **6 High-severity** issues that should be fixed before scaling paid volume, several of which are latent today because the feature that triggers them (operator seats, plan-price edits) may not be heavily exercised yet.

### Top priorities (fix first)

| # | Severity | One-liner |
|---|----------|-----------|
| A | **HIGH** | Extra operator seats are entitled *before* the seat mandate is authorized/charged → free seats + no GST invoice for seat revenue |
| B | **HIGH** | Editing a plan's price never resyncs the immutable Razorpay plan → displayed price silently diverges from the charged price |
| C | **HIGH** | A paid top-up is silently lost if the order-fetch fails → customer charged, zero credits, event de-duped so it never reprocesses |
| D | **HIGH** | No idempotency on `/change-plan` upgrade (sequential double-submit) → duplicate Razorpay subscriptions → one-cycle double-charge |
| E | **HIGH** | Refunded credits are counted by `get_balance` but are un-allocatable by the FIFO engine → stuck balance + "insufficient credits" despite a positive balance |
| G | **MED-HIGH** | Invoice date & FY serial derive from finalize wall-clock, not `paid_at` → month/FY-boundary charges land in the wrong GSTR period with an out-of-sequence serial |

---

## 2. Architecture (as-built, from code)

- **Single payment rail: Razorpay, INR only.** Despite `CLAUDE.md` describing "Razorpay primary + **Stripe fallback**" and referencing `api/app/services/billing_service.py`, **Stripe does not exist in the codebase** (2 incidental comment mentions; the referenced file is absent). There is no payment-provider redundancy. *(Doc drift — §7.)*
- **Money representation:** integer minor units (paise/cents) everywhere; the column name `*_cents` means "minor units of the row's `currency`". No floats in the money path (the only floats are credit-fraction clawback math, rounded + capped — acceptable).
- **Multi-currency:** geo-split — IN→INR (charged), non-IN→USD (fixed `*_usd_cents` columns, **no live FX in the charge path**). Phase 1 hard-blocks non-IN checkout to "contact sales"; USD rail is not yet live.
- **Invoicing v2 (`INVOICING_V2_ENABLED`, default ON):** India GST-compliant tax invoices with gapless per-FY numbering, immutable documents, credit-note corrections, and GSTR-1-style exports. Gated behind a seller-profile "configured" activation check.
- **Credit ledger:** event-sourced (`balance = SUM(delta)`), FIFO top-up expiry, per-bot vs client-pool scoping, PG advisory-lock serialization.
- **Webhooks:** HMAC-verified (raw bytes, constant-time), event-id idempotency via `ON CONFLICT DO NOTHING`, dead-letter store, 5xx-to-retry.

### What is genuinely solid (independently verified)

- **GST tax engine** (`core/tax.py`) — single rounding point, integer paise, largest-remainder CGST/SGST split; `taxable+tax==total` and `cgst+sgst+igst==total_tax` hold by construction. Correct intra/inter/export + LUT handling.
- **Gapless invoice numbering** (`invoice_service.allocate_invoice_number`) — `INSERT … ON CONFLICT DO NOTHING` then `SELECT … FOR UPDATE` + ORM increment; serial allocated only at finalize (abandoned payments burn none); separate series for invoices/receipts/credit-notes; unique index backstop.
- **IST-correct financial year** — FY boundary computed in `Asia/Kolkata`, matching GSTR periods (with the exception noted in finding G).
- **Credit-note corrections** — never edit the original; frozen-parameter reversal; idempotent on `provider_ref` + a `FOR UPDATE` on the original that stops a partial-refund + chargeback from over-reversing tax.
- **Credit double-spend prevention** — per-`(client,bot)` `pg_advisory_xact_lock` acquired *before* the balance read.
- **Plan-renewal double-grant defense** (`grant_subscription_period_once`) — `flush → refresh(FOR UPDATE)` then a **monotonic** marker check that correctly no-ops dead-letter replays of older periods. Excellent concurrency reasoning.
- **Webhook trust boundary** — constant-time HMAC, fail-closed on missing secret, race-safe dedup, dead-letter + retry, no external side effects before commit.
- **Discount safety** — cannot go negative or >100%; customer discount capped at 50%; `affiliate + customer ≤ pool`; DB CheckConstraints; no referral+coupon stacking; entitlements follow the *base* plan, not the discounted billing plan.
- **Authorization / IDOR** — every subscription/invoice mutation resolves through `client_id`-filtered helpers; superadmin routes gated by `is_superadmin`. No cross-client path found.
- **Trial abuse** — one trial per plan, lifetime (checked against full history, under the billing lock).

---

## 3. HIGH-severity findings

### A. Operator seats are entitled before the seat mandate is authorized or charged
**`app/api/subscription_routes.py:1471-1492`, `app/services/razorpay_service.py:517-610`** — *verified by direct read; converged by 2 independent reviews.*

`change_seat_count` calls `edit_seat_addon_quantity(...)` then unconditionally does `sub.operator_quantity = new_total; session.commit()` and returns only `{"message": "Seats updated"}`. On the **first** seat purchase, `edit_seat_addon_quantity` creates a brand-new Razorpay subscription (which sits in `created` state and debits nothing until the customer authorizes the UPI/card mandate via Razorpay Checkout) — but the returned checkout payload (`short_url`/`subscription_id`) is **discarded**. There is no `/seats/verify` route and no gating on the seat subscription's `subscription.activated` webhook.

**Failure:** customer clicks "Add seat" → `operator_quantity` jumps immediately and live-chat seat enforcement honors it → the seat add-on is never authenticated → Razorpay never charges → **extra operator seats run for free indefinitely**. Compounding this, seat-add-on `subscription.charged` events are `return`ed before dispatch (`razorpay_service.py:996-1005`), so even a paid seat add-on **creates no `Invoice` and no numbered GST tax document** — that recurring revenue is invisible to reconciliation and GST filing.

**Fix:** return the seat checkout payload to the client and gate the `operator_quantity` bump on the seat subscription's `activated` webhook (mirror the main-plan re-auth model). Emit a payment-history invoice for seat-add-on charges (no credit grant) so the revenue is documented.

### B. Editing a plan's price never resyncs the (immutable) Razorpay plan
**`app/api/superadmin_plan_routes.py:244-277`; charge path `razorpay_service.py:320`**

`update_plan` writes `monthly_price_cents`/`annual_price_cents` straight onto the row and never touches `razorpay_plan_id_monthly/annual`. Razorpay plans are immutable, and the full-price charge path bills whatever amount is baked into the existing plan id, with **no amount re-validation** (unlike the *discounted* path at `razorpay_service.py:472-513`, which re-checks `cached.amount_paise == discounted_paise` and mints a fresh plan on drift).

**Failure:** admin raises Standard ₹4,599 → ₹5,599. The marketing catalog, admin list, and `/checkout/quote` all immediately quote ₹5,599, but every new mandate keeps debiting ₹4,599. **Displayed ≠ charged.** A diagnostic endpoint (`GET /admin/plan-price-check`) *detects* this drift but is opt-in and enforced nowhere.

**Fix:** on any price-field change, either require a matching new `razorpay_plan_id_*`, or auto-create a new Razorpay plan and swap the id in the same transaction. At minimum, block checkout when the live Razorpay amount ≠ DB amount (the guard the discounted path already has).

### C. Paid top-up silently lost when the order fetch fails
**`app/services/razorpay_service.py:1944-1956`**

On a `payment.captured` whose payload lacks order notes, the handler fetches the order to read `notes`; if `order.fetch` throws, the exception is **swallowed**, `purpose` stays `None`, and the handler returns normally as *"payment.captured ignored (not a topup)"*. The route then commits the `processed_webhooks` row — so any Razorpay retry is de-duped as "Duplicate event skipped."

**Failure:** customer pays for a credit pack → `order.fetch` hits a transient 5xx/timeout → event acked as ignored → **customer charged, zero credits, never reprocesses.**

**Fix:** distinguish "fetch failed" from "fetched, confirmed not a top-up." On fetch failure, **raise** so the event dead-letters and retries (idempotency makes the eventual success a no-op).

### D. No idempotency on plan-change upgrade → duplicate subscriptions / double-charge
**`app/api/subscription_routes.py:1108-1131`, `app/services/transition_service.py:150-160`**

The paid→paid upgrade mints a fresh Razorpay subscription on every call with no check for an already-pending upgrade checkout. `lock_client_for_billing` serializes *concurrent* requests but not a *sequential* double-submit (click → modal → click again); the old sub isn't cancelled until activation and the new one isn't locally visible until its activation webhook, so the second request re-reads the same old sub and creates a **second** Razorpay subscription. The `/checkout` "already-subscribed" guard doesn't cover this either (a still-pending checkout has no active local sub).

**Failure:** customer authorizes both modals → **both first cycles charge** → activation of the second gateway-cancels the first, but only after it already debited → double-charge + refund ticket.

**Fix:** before minting an upgrade sub, look for an existing pending sub tagged with this `prev_razorpay_subscription_id` (or persist a short-lived "pending change" marker) and return the existing checkout.

### E. Refunded credits are counted in the balance but are un-allocatable → stuck credits
**`app/services/credit_service.py:288` (`_grants_for` whitelist), `:427-436` (`refund`), `:958-967` (`reverse_refund_clawback`)** — *verified by direct read.*

`get_balance` sums **all** deltas, but the FIFO allocator `_grants_for` only returns rows with `reason ∈ (plan_grant, topup, manual_adjust)`. `refund()` and `reverse_refund_clawback()` write positive rows with `reason="refund"` and **no `grant_id`**, so they inflate the balance but can never be allocated by `check_and_deduct`.

**Failure:** after a crawl-failure refund of +50 (with no live grant), `get_balance` = 50, but a deduction of 10 passes the pre-check then finds no allocatable grant → hits the "short allocation" path → raises `InsufficientCredits(available=0)` and logs an ERROR. The customer holds a positive balance they **can never spend**, and every retry re-hits it. The `refund()` docstring's claim that refunds "behave like a fresh manual adjustment for FIFO purposes" is contradicted by the whitelist.

**Fix:** add `"refund"` to the `_grants_for` whitelist (with ordering/expiry), or attribute refunds to a real grant. Enforce the invariant: **`get_balance` must equal what the allocator can consume.**

### F. Upgrade rollover credit is snapshotted at click-time and re-granted in full at activation
**`app/services/transition_service.py:138,150,405-448`, `razorpay_service.py:1544-1551`**

`execute_paid_upgrade` snapshots `remaining_plan_credits` at the upgrade click and stores it in `upgrade_credit_pending_cents`. The old plan stays live until mandate authorization, so the customer keeps burning credits in between. At activation, `reset_monthly_plan_credits` expires whatever actually remains, then `apply_pending_proration` grants the **full click-time snapshot** as a 12-month top-up.

**Failure:** snapshot 5,000 at click; customer spends to 3,000 before authorizing; at activation the 3,000 are expired and **5,000** is granted → net **+2,000 credits the customer no longer had** (leakage). Separately, monthly-expiring plan credits are silently upgraded to 12-month top-up credits.

**Fix:** recompute remaining plan credits *inside* the activation webhook (after cancelling the old sub) and clamp to the live balance, rather than trusting the click-time snapshot.

---

## 4. MEDIUM-severity findings

### G. Invoice date & FY serial derive from finalize wall-clock, not `paid_at`
**`app/services/invoice_service.py:165,190,199,200`** — GST-compliance risk.
Both the document date and the FY serial bucket are taken from the instant `finalize_invoice` runs, ignoring the `paid_at`/`period_start` already on the row. A `subscription.charged` webhook (which "can lag in prod") for a payment captured **31 Mar 23:59 IST** but processed **1 Apr 00:05 IST** gets an FY `26-27` serial and an April date, while the supply belongs to FY `25-26` → wrong GSTR-1 period, out-of-sequence serial (audit flag). Same class of error at every month boundary. **Fix:** date the document from `paid_at` (fallback `period_end`/now) and pass that same instant to `financial_year_label`/`allocate_invoice_number`.

### H. Credit deductions are not idempotent per `reference_id`
**`app/services/credit_service.py:349-408`** — `check_and_deduct` accepts `reference_id` (chat_message_id/document_id) but never checks for an existing deduction with that reference. An ARQ retry, SSE reconnect, or duplicated ingestion event re-deducts for the same message → double-charge of credits. Contrast the carefully idempotent *grant* path. **Fix:** short-circuit under the advisory lock if a row already exists for `(reason, reference_id)` in scope; back with a partial unique index.

### I. Irreversible gateway calls executed before the DB commit
**`app/services/razorpay_service.py:1423` (and `1572`)** — inside `_handle_subscription_activated`, the superseded subscription is cancelled at the gateway while still inside the handler's transaction. If a later statement raises, the transaction rolls back but the gateway cancel does not → old sub cancelled at Razorpay yet still `active` locally → **customer left with no live mandate.** **Fix:** defer gateway cancels of superseded subscriptions to after commit (or to the reconcile sweep).

### J. Extra-seat price is a single global plan; ignores per-plan price & has no USD rail
**`razorpay_service.py:537`, `config.py:259`, `subscription_routes.py:1490`** — all extra seats bill against one hard-wired ₹499 `RAZORPAY_SEAT_PLAN_ID`, but `Plan.extra_seat_price_cents` is per-plan and is echoed to the UI as the price. Any plan with a seat price ≠ ₹499 shows a price it won't charge, and there is no USD seat rail. **Fix:** resolve the seat plan from the customer's plan/currency, or assert equality at seat-change time.

### K. MRR double/triple-counts seats
**`app/api/superadmin_plan_routes.py:455`** — `mrr_cents += plan_monthly * sub.operator_quantity`, but the main sub is always Razorpay quantity 1 and seats bill on a separate flat add-on while `operator_quantity` holds the *total* seat count. A 3-seat Standard reports ~$144 MRR instead of ~$58. Every multi-seat customer inflates MRR/ARR. **Fix:** base MRR on quantity 1 + `extra_seats × extra_seat_price`.

### L. Finalized-invoice immutability is convention-only
**`invoice_service.py:139`, `models.py:1130-1133`** — re-finalize is blocked, but nothing prevents later code from mutating frozen tax columns (`amount_cents`, `taxable_value_minor`, `seller_snapshot`, …) on a numbered row; reconciliation only detects *arithmetic-inconsistent* tampering, not a self-consistent edit. **Fix:** a `before_update` SQLAlchemy event (or DB trigger) rejecting changes to frozen columns once `invoice_number IS NOT NULL`, whitelisting only delivery columns (`pdf_url`, `emailed_at`, `status`).

### M. GST invoice presentation gaps (Rule 46)
**`app/services/invoice_pdf.py`** — three sub-issues:
- **`:307-309`** — a taxable export *without* LUT (IGST-paid, Rule 96A fallback) prints **no export endorsement**. Rule 46 requires *"SUPPLY MEANT FOR EXPORT ON PAYMENT OF INTEGRATED TAX."*
- **`:330`** — place of supply renders as a bare code (`27`) instead of *"27 – Maharashtra"* (Rule 46 requires the State name for inter-state supply); no code→name map exists.
- **`invoice_service.py:115-126` / `invoice_pdf.py:197`** — no enforcement of Rule 46(f) recipient name/address for a B2C sale ≥ ₹50,000 (falls back to literal *"Customer"*). **Fix:** add the endorsement branch, a state-name map, and a finalize-time flag/gate for high-value B2C without name/address.

### N. First-period grant not idempotent when `activated` lacks `current_end`
**`razorpay_service.py:1370-1375`, `credit_service.py:794-802`** — when `activated` arrives without `current_end` (UPI mandate authenticated but not yet charged), the grant fires but the marker is **not advanced**; the later `charged` (with a real `current_end`) grants again — net effect refunds the customer's first-cycle consumption. **Fix:** derive a stable first-period key when `current_end` is missing so the marker advances at activation.

### O. Other Medium items (verified plausible, lower blast radius)
- **`credit_service.py:602-615`** — `expire_old_topups` reads consumption *before* taking the advisory lock (TOCTOU); a concurrent deduction between read and lock can over-sweep a grant.
- **`credit_service.py:227-229`** — kill switch reads a 60s-TTL cache → up to 60s fail-open unless the admin toggle calls `invalidate_pricing_cache()`. Verify the toggle route does.
- **`credit_service.py:H1`** — `get_balance` counts expired-but-unswept top-ups (daily cron) while the allocator excludes them → same "short allocation" divergence for up to 24h.
- **`credit_service.py:958-967`** — `reverse_refund_clawback` is not self-idempotent (mitigated in practice by `processed_webhooks`, but the docstring overclaims).
- **Frontend** — three different hardcoded INR→USD fallback rates (`94.67` in `useBotPricing.js:41` and `admin utils.ts:22`, but **`83`** in `PlanModal.jsx:992`) → same plan shows different USD prices; marketing site is **USD-only** so Indian visitors see `$` then get charged `₹` (`oyechats-website/lib/pricing.ts:115`). Display-only, but a cross-surface trust gap.
- **`Billing.jsx:351-356`** — `?subscription=success` / `?topup=success` shows a success toast from the query string alone (a replayed/bookmarked URL can show success without server confirmation). Reconcile against a fresh fetch first.

---

## 5. LOW-severity / cleanup

- **Plan price fields lack `Field(ge=0)`** (`superadmin_plan_routes.py:68-118`) — a negative price is accepted (contrast the bounded `operator_quantity`).
- **Seat `delta` unbounded** when a plan omits `limits.operators` (`subscription_routes.py:1442`) — enforce an absolute ceiling.
- **`RAZORPAY_SEAT_PLAN_ID` defaults to a live plan id** (`config.py:259`) — prefer fail-closed (no default) so a missing env can't bill against production.
- **Same-plan monthly↔annual cycle change is rejected** (`subscription_routes.py:1031`) — the natural monthly→annual switch 400s as "already on this plan."
- **`cancel` idempotency checks only `"canceled"`, not `"cancelled"`** (`:1272`) — a British-spelled terminal row slips the guard.
- **`get_credit_cost` defaults unknown actions to 0** (free) and can throw on non-numeric JSONB (`credit_service.py:224`) — fail-closed instead.
- **Serial exceeds Rule 46's 16-char cap past 999,999 docs/FY** (`invoice_service.py:98`) — unreachable at current volume; note only.
- **Cumulative partial credit notes can drift ±1 paisa** vs the original (independent `compute_tax` per partial) — aggregate only; document.
- **Tax-rate labels render as floats** (`CGST @ 9.0%`) — cosmetic.
- **Top-up checkout uses the money `amount` as the pack selector** (`app.js:1769`) — *backend-safe* (`initiate_topup` re-derives from server `topup_packs` and rejects unmatched amounts), but a fragile contract; prefer `pack_id`.
- **Account currency is client-flippable via billing country** (`BillingDetailsCard.jsx:262`) — display-only today (backend pins INR at checkout), but confirm the server keeps validating country before the USD rail goes live.
- **Orphaned `app/src/pages/Subscription.jsx`** — not routed; contains a broken checkout (discards the Razorpay payload) and swapped `showToast` args. Delete it to prevent future foot-guns.
- **`InvoiceDetailDialog.tsx:115-117`** renders empty CGST/SGST/IGST rows on export/USD invoices — cosmetic.

---

## 6. Cross-cutting observations (finance lens)

1. **Entitlement-before-payment is the recurring anti-pattern.** Findings A (seats) and F (rollover credits) both grant value before the money is confirmed. The main-plan flow gets this right (grant on `activated`/`charged`); the seat and proration seams do not. Adopt one rule everywhere: *entitlement follows a confirmed gateway event, never a local intent.*
2. **"Displayed price = charged price" holds on the discounted path but not the base path.** Finding B is the mirror image of a guard the code already has 60 lines away. Reuse `resolve_discounted_plan`'s amount-reconciliation on the base plan.
3. **Balance integrity has two sources of truth that can disagree** (`get_balance` vs what `_grants_for` can allocate). Findings E, H1, and the breakdown divergence all stem from this. One query should define both.
4. **Seat revenue is invisible to GST/reconciliation** (finding A) — for an India seller that has invested this heavily in Rule-46 compliance, undocumented recurring seat revenue is a genuine tax exposure, not just a reporting gap.
5. **Single payment provider, no fallback.** Razorpay is a single point of failure for *all* revenue. The "Stripe fallback" in the docs is fiction. Either build the fallback or update the docs and add a Razorpay-outage runbook.

---

## 7. Documentation drift (code contradicts the docs)

| Doc claim | Reality |
|-----------|---------|
| `CLAUDE.md`: "Payments: Razorpay (primary) + **Stripe (fallback)**" | No Stripe anywhere in code. Razorpay is the sole rail. |
| `CLAUDE.md` Key Files: "Billing (Stripe) `api/app/services/billing_service.py`" | File does not exist. |
| DB schema doc: "Invoice — synced from **providers**" (plural) | One provider (Razorpay). |
| `refund()` docstring: refunds "behave like a fresh manual adjustment for FIFO" | False — excluded from the FIFO whitelist (finding E). |
| `reverse_refund_clawback` docstring: "re-running is still safe" | Not self-idempotent; relies on the caller's webhook dedup (finding O). |

**Recommendation:** the user's instinct to distrust the docs was correct. Update `CLAUDE.md`'s payments section and Key Files table to reflect the Razorpay-only reality.

---

## 8. Suggested remediation order

1. **A — seats** (revenue leak + GST gap): gate entitlement on the seat `activated` webhook; issue seat invoices. *Highest $ impact.*
2. **C — top-up loss on fetch failure**: raise-instead-of-ack. *Small, high-value fix.*
3. **B — plan-price ↔ Razorpay resync**: block/auto-resync on price edit. *Prevents silent under/over-charging.*
4. **E + H1 + H — credit balance integrity**: unify `get_balance`/allocatable set; add per-`reference_id` deduction idempotency.
5. **D — upgrade double-submit idempotency.**
6. **G — invoice dating from `paid_at`** (before the next FY boundary / any GST filing).
7. **F, I, N** — proration and webhook transactional ordering.
8. **K, L, M** — MRR accuracy, invoice immutability enforcement, Rule 46 PDF fields.
9. Low/cleanup batch (§5) + doc fixes (§7).

**Before merging any fix, add a regression test** — the suite already has 41 billing test files and a Postgres fixture, so each of these is directly testable (concurrency ones included).

---

## 9. Methodology note

Six subsystem reviews were run in parallel over the full source (Razorpay, invoicing/GST, credit ledger, subscriptions, plans/pricing, and the three frontends). Every High/Critical claim in this document was **independently re-verified by direct file read** — including the tax engine, credit-deduction locking, per-period grant idempotency, invoice numbering/immutability, the geo/currency-arbitrage path, the seat entitlement flow, and the top-up amount-trust boundary. Two agent-reported "Critical/High" items were **downgraded after verification** (the top-up amount-as-selector is backend-safe; the geo query-param override is display-only), which is reflected in the severities above.
