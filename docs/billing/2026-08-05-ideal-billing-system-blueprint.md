# OyeChats — Ideal Production-Ready Billing System (Target State)

> ## ⚠️ One assumption changed: pricing became GST-EXCLUSIVE on 26 Aug 2026
>
> This blueprint is dated 2026-08-05 and is left unedited. §6.1's bullet "INR pricing is
> **GST-inclusive** (sticker price is what the customer pays)" is no longer true. Every published
> price is now a **base** price, exclusive of GST. A domestic customer is debited base + GST
> (`core/tax.py::gross_charge_minor`); the USD rail is unchanged, since an export carries no Indian
> GST and the listed price is the full charge.
>
> Everything else in §6.1, including the supply classification tree and the blank-country invariant,
> still holds. So does the document model in §6.2: the invoicing engine was not changed, because the
> charge is `base + tax` and the carve-out therefore recovers the advertised base exactly.
>
> Current source of truth: `api/app/core/tax.py` and
> [`razorpay-plan-ids.md`](./razorpay-plan-ids.md#re-minting-for-gst-exclusive-pricing).

**Date:** 2026-08-05
**Scope:** Payments, subscriptions, credits, invoicing (GST + export), reconciliation, ops.
**Status:** Target-state blueprint. A parallel line-by-line code review of the current
implementation is in flight; its findings will be appended as a gap list against this
document.

This is not a greenfield fantasy — it is the finished version of the system the codebase
already converges on: **one gateway (Razorpay), two currency rails (INR domestic / USD
international), one ledger, one invoice engine, everything reconciled**.

---

## 0. The five money invariants

Everything below exists to keep these five statements true at all times. Any code path,
webhook, cron, or admin action that can break one of them is a production bug by
definition.

1. **Every captured payment produces exactly one finalized, numbered document**
   (tax invoice or receipt) — never zero, never two.
2. **Every credit grant and deduction is one append-only ledger row** with an
   idempotency key — balance is always derivable, never stored-and-drifted.
3. **Gateway state, DB state, and document state agree** — and a scheduled
   reconciliation job proves it daily rather than assuming it.
4. **Tax classification is decided by durable buyer facts** (billing country +
   state code on the account), never by request-time signals (IP headers, query
   params) — those may only choose the *display* rail.
5. **Nothing irreversible happens twice** — webhook replays, double-clicks, cron
   re-runs, and worker restarts must all be no-ops on the second pass.

---

## 1. Architecture (target)

```
 Browser (app/)                    Razorpay
   │  checkout, plan mgmt            │  webhooks (signed)
   ▼                                 ▼
 FastAPI api/ ──────────────► webhook_billing_routes ──► ProcessedWebhook (dedup)
   │ subscription_routes                 │
   │ (authz: X-API-Key, tenant-scoped)   ▼
   ▼                              razorpay_service  ← single writer of money state
 Postgres ── Subscription / Invoice / CreditLedger / Plan / PaymentMethod
   │
   ▼
 ARQ worker ── invoice finalize + PDF (WeasyPrint) ── email (Brevo)
            ── 00:03 deferred-cancel cron
            ── daily reconciliation cron
            ── retry sweeps (unnumbered invoices, unsent PDFs)
```

Key structural rules:

- **One writer.** All money-state mutations flow through `razorpay_service` /
  `invoice_service` / `credit_service` — routes and crons call services, never
  write `Invoice`/`CreditLedger` rows directly.
- **Webhook-first truth.** The client-side "payment verified" callback is a UX
  accelerator only; the webhook (signature-verified, deduped) is the source of
  record. Both paths must be idempotent against each other.
- **Async for anything slow.** PDF render, email, gateway cancels, reconciliation
  run in ARQ; the request path never blocks on WeasyPrint or Razorpay retries.

---

## 2. Customer classification & the two rails

| Fact | Where it lives | Decides |
|---|---|---|
| Display country | Edge headers (`CF-IPCountry` etc.) via `core/geo.py`; `?country=` override | Which price list the visitor *sees* (INR vs USD) |
| Billing country | `Client.billing_country` — confirmed at checkout, stored | Export vs domestic supply (GST or not) |
| Billing state | `Client.billing_state_code` (canonical 2-char GST code) | CGST+SGST vs IGST |
| Buyer GSTIN | `Client.gstin` (mod-36 validated) | B2B tax invoice vs B2C |
| Charge currency | The **Razorpay plan** the subscription is created on | The actual money rail |

Target behaviors:

- **Geo headers choose display only.** The server must independently enforce that
  the plan's currency matches the account's billing country at subscription-create
  time (Indian billing address ⇒ INR plan; non-Indian ⇒ USD plan). A client must
  not be able to force the wrong rail by spoofing a header or query param.
- **Unknown country → USD display**, but checkout **requires** the buyer to
  confirm country (and state, if India) before a subscription can be created.
  That confirmation is what lands on the invoice — Rule 46 needs it.
- **Rail changes are churn events, not edits.** If an account's billing country
  changes (IN ↔ non-IN), the active subscription must be cancelled and recreated
  on the other rail — never re-taxed in place. The invoice engine already treats
  "foreign currency on a domestic supply" as a contradiction that blocks
  finalization; the subscription layer should prevent it from arising at all.

---

## 3. Subscription lifecycle (target workflows)

### 3.1 New subscription (both rails)
1. Client picks a plan → server validates: plan is active, currency matches
   billing country, account has no live subscription on another plan.
2. Create Razorpay customer (idempotent — reuse stored `razorpay_customer_id`).
3. Create Razorpay subscription on the plan's provider ID; store local
   `Subscription` row in `created` state with the gateway ID **before**
   returning checkout params (so a webhook arriving first can find it).
4. Razorpay Checkout completes → client-side verify (signature check) flips UX;
   `subscription.activated` / `payment.captured` webhook is the durable trigger:
   - mark subscription `active`, set period start/end from gateway payload,
   - grant period credits (idempotency key = subscription id + period start),
   - create invoice → finalize (number + tax snapshot) → ARQ PDF + email.
5. Every step is individually idempotent; a replayed webhook re-runs all steps
   as no-ops.

### 3.2 Trial → paid
- Trial is a local state (no gateway mandate). Activation = full new-subscription
  flow; trial credits and paid credits are separate ledger reasons.
- Activation credit marker must be **once per (client, plan)** transition —
  guarded by a unique constraint, not a read-then-write check.

### 3.3 Plan change (the UPI constraint)
Razorpay's Update Subscription API is unavailable for UPI/eMandate. Target flow
for **all** plan changes (uniform is safer than per-method branching):
1. Create the new subscription on the target plan with `start_at` = current
   period end (no double-billing window).
2. Mark the old one for deferred gateway cancel at period end.
3. Buyer re-authorizes the new mandate (checkout).
4. Credits: remaining old-plan credits run to period end; new plan grants on its
   first charge. No proration on the credit side — proration is a pricing
   decision, and "no proration, switch at boundary" is the only version that is
   both explainable and race-free with UPI.

### 3.4 Cancel / reactivate (deferred-cancel model)
- `/cancel` sets `cancel_at_period_end` (reversible **intent**) — no gateway call.
- The 00:03 cron finds subscriptions within the execution window and performs the
  gateway cancel, stamping `gateway_cancel_executed_at` (irreversible **fact**).
- Reactivate before the cron ran = clear the flag (free). After = new checkout.
- Cron requirements: single-flight (advisory lock or unique job key — two
  workers must not double-execute), per-subscription try/except (one gateway
  failure must not abort the sweep), failed cancels retried next run and alerted
  after N failures, timezone-pinned to the billing timezone (IST) for "period
  end" math.

### 3.5 Dunning / past_due
- `subscription.halted` / charge failure webhooks → `past_due`, entitlements
  degrade gracefully (widget keeps answering with a banner; no data deletion),
  email sequence via Brevo, hard-expire after the grace window.

---

## 4. Payments & webhooks (target hardening)

- **Signature verification** on every webhook: HMAC-SHA256 with
  `hmac.compare_digest`, reject before parsing. No unauthenticated test bypass
  in production builds.
- **Dedup** via `ProcessedWebhook` keyed on the **event ID** (`x-razorpay-event-id`),
  inserted in the same transaction as the side effects — insert-first,
  unique-violation ⇒ already processed, skip.
- **Ordering tolerance.** Handlers must not assume `activated` precedes
  `charged` or that `payment.captured` precedes `invoice.paid`. Each handler
  reads current DB state and converges; none depends on arrival order.
- **Partial-failure containment.** "Payment captured but credits/invoice
  failed" must leave a visible, retryable marker (invoice row in
  `pending_finalize`, credits sweep) — never a silent divergence. Sweeps run on
  a schedule and self-heal (the un-numbered-invoice self-heal is this pattern;
  it should cover every money side effect).
- **Amounts are integers in minor units end-to-end** (paise/cents). Any float
  in a money path is a defect. Razorpay amounts are already minor-unit — no
  conversion arithmetic on the boundary.
- **Observability:** every dropped/failed/unknown webhook event logs at ERROR
  with the event ID and reaches Sentry (prod). A payment event that changes no
  state must be *deliberately* ignored (allowlist), not silently unmatched.

---

## 5. Credits & entitlements (target)

- **Append-only `CreditLedger`** is the only balance source; FIFO top-up expiry
  via the self-FK `grant_id` chain. No mutable balance column that can drift.
- **Idempotent grants:** unique constraint on `(reason, external_ref)` — e.g.
  `(subscription_charge, razorpay_payment_id)` — so webhook replays and
  verify-vs-webhook races cannot double-grant. DB constraint, not application
  check.
- **Annual plans** grant the **full annual credit amount** on each yearly charge
  (the 1/12 bug class must be structurally impossible: grant amount derives
  from `plan.credits_per_period * periods_in_charge`, computed from the plan's
  billing interval, with a test pinning the annual case).
- **Atomic consumption:** deduction is a single INSERT with a balance check in
  the same statement/transaction (`SELECT ... FOR UPDATE` on the grant rows or a
  serialized per-client advisory lock) — concurrent chats cannot spend the same
  credit twice or drive balance negative.
- **Every consumer gates the right bucket:** chat/LLM, crawl/train, and preview
  all deduct; preview mode deducts like production chat (no unlimited free LLM
  path). Kill switch via `PricingConfig` stays.
- **Per-bot scoping:** per-bot credit pools and bot-scoped top-ups resolve
  through one function (`resolve_spendable_grants(client, bot)`) used by every
  consumer, so scoping bugs can't diverge per call site.

---

## 6. Invoicing & GST (target)

The current engine's core design is correct and should be kept: **pure
integer-paise tax core** (`core/tax.py`), seller/buyer **snapshots frozen onto
the invoice**, separate serial series for tax invoices vs receipts, INR mirror
for foreign-currency documents. Target end-state around it:

### 6.1 Classification (per document, from frozen snapshots)
```
buyer.billing_country != IN            → EXPORT
  seller LUT active                    →   zero-rated (no tax), legend:
                                           "Supply meant for export under LUT
                                            without payment of IGST"
  no LUT                              →   IGST @ 18% (Rule 96A fallback)
buyer country IN (or blank → domestic):
  buyer_state == seller_state or blank →   CGST 9% + SGST 9% (intra; B2C blank-state
                                           = supplier's state per Circular 242/36/2024)
  else                                 →   IGST 18% (inter)
```
- INR pricing is **GST-inclusive** (sticker price is what the customer pays);
  USD pricing has **no GST** on the buyer-facing total — the INR mirror carries
  the GSTR-1 Table 6A reporting values at the Razorpay-implied FX rate, frozen
  at charge time.
- A blank country can never produce an export (already enforced in
  `supply_kind`) — keep that invariant tested.

### 6.2 Documents
- **Tax invoice** (seller GST-enabled): Rule 46 fields — seller GSTIN, buyer
  GSTIN if B2B, place of supply (state *name*), HSN/SAC 998319, per-line
  taxable value + tax breakup, consecutive serial per FY series
  (`OC/25-26/0001`), signed/issued dates in IST. Export invoices additionally:
  country of destination, LUT number + legend when zero-rated, currency +
  conversion note.
- **Receipt series** (seller not GST-registered): separate serial range, no tax
  breakup — never interleaved with the tax-invoice range.
- **Numbering:** allocated inside the finalize transaction under a per-series
  lock (serialized allocator) — no gaps from rollbacks, no duplicates from
  races. Un-numbered rows are impossible in the happy path; the self-heal sweep
  exists only as a backstop and alerts when it actually heals something.
- **Credit notes:** every refund/cancellation adjustment issues a credit note
  referencing the original invoice, reversing tax at the **original** rate and
  the **original** frozen FX (no re-conversion residue), own serial series,
  single-flight per original invoice (the lock added in `17edaf2`).
- **Timing:** invoice date = charge date (IST), not finalize date — a
  webhook-retry delay must not push a document into the next GSTR period or FY.

### 6.3 Filing outputs
- Monthly **GSTR-1 export**: B2B (Table 4), B2C (Table 7), exports (Table 6A
  with port-state POS), credit notes (Table 9B), document series (Table 13) —
  generated from invoice rows, reconciling to the paisa against the ledger of
  captured payments for the period.
- **Reconciliation report** (CA-facing): Razorpay settlements vs invoices vs
  credit ledger for a date range, with an explicit "unexplained delta" section
  that should always be empty.

---

## 7. Ops, reconciliation & safety nets

| Job | Cadence | What it proves |
|---|---|---|
| Gateway reconciliation | daily | Every Razorpay captured payment in the window has a finalized invoice + credit grant; every active gateway subscription has a matching local row (and vice versa) |
| Unfinalized-invoice sweep | 5 min | No invoice stuck without number/PDF |
| Deferred-cancel cron | daily 00:03 IST | Intent → fact conversion, retried + alerted |
| Dunning sweep | daily | past_due accounts progress through grace window |
| FX sanity | per document | Implied rate within plausible band (already in `invoice_service`) |

- **Alerting:** any reconciliation delta, any webhook signature failure, any
  self-heal that actually healed, any cron that skipped a run → Sentry +
  ops email. Silence must mean "nothing is wrong", not "nothing is watched".
- **Runbooks** stay in `docs/billing/` (repricing, pre-merge, local webhooks) —
  every manual money operation has a script under `api/scripts/` with
  `--dry-run` defaulting on.
- **Superadmin surfaces** (plan editor, invoice browser, reconciliation view)
  are read-gated *and* write-gated (`is_superadmin` on every route, plus
  readonly-role gating for support staff).

---

## 8. Testing & release gates (what "production-ready" means here)

1. **Property tests on the tax core:** for all amounts/rates: `taxable + tax ==
   total`, `cgst + sgst + igst == tax`, inclusive round-trip stability.
2. **Idempotency tests:** replay every webhook fixture twice — assert zero new
   ledger rows / invoices on the second pass.
3. **Race tests:** concurrent verify + webhook; concurrent consumption to zero
   balance; concurrent finalize on one invoice; double cron run.
4. **Rail matrix:** {IN-intra, IN-inter, IN-B2B, export+LUT, export-no-LUT} ×
   {subscription charge, renewal, top-up, credit note} — 20 golden invoices
   asserted to the paisa (PDF snapshot tests included).
5. **Lifecycle sims:** trial→paid, upgrade at boundary, cancel→reactivate
   before/after cron, past_due→recovery, past_due→expiry.
6. Standard gates: `ruff` clean, full `pytest` green, migrations
   forward-applied on a prod-schema copy before deploy, deploy runbook followed
   for order-sensitive changes (backfills before code that assumes them).

---

## 9. Explicit non-goals (keep it simple)

- **No second PSP** (Stripe etc.) until Razorpay international demonstrably
  blocks revenue — a second gateway doubles every invariant above.
- **No proration engine** — boundary-switching is correct for UPI and simpler
  everywhere.
- **No multi-currency beyond INR/USD** — USD is the single international rail;
  settlement is INR regardless (Razorpay constraint), so more display
  currencies add work without changing money mechanics.
- **No real-time FX** — the Razorpay-implied rate frozen per charge is the only
  rate that reconciles with what was actually settled.

---

## 10. Gap list vs current code

Full findings with file:line evidence: `2026-08-05-billing-full-code-review.md`.
Mapping to the invariants in §0:

| Priority | Gap | Invariant broken |
|---|---|---|
| P0-1 | Refund clawback misattribution (seat / withheld-credit invoices → wipes plan grant; backfill can link invoices to negative rows) | §0-2, §0-5 |
| P0-2 | `billing_country` self-declared → GST leakage + rail flip on live mandates | §0-4 |
| P1-1 | `/change-plan` (= trial/free→paid conversion) skips billing identity, country confirmation, intl gate | §0-4, §0-1 |
| P1-2 | USD rail incoherence: kill-switch not enforced in service, USD price edits don't re-mint gateway plans, USD seat add-ons unswept/uncancelled | §0-3 |
| P1-3 | Renewal cron keys grants on old period end (double reset+grant on delayed webhook); grants without payment confirmation; includes trialing rows | §0-2, §0-5 |
| P1-4 | Webhook handlers run blocking gateway HTTP on the event loop (single worker → full API stall) | availability |
| P1-5 | Top-up verify burns idempotency key before capture confirmed → paid-but-no-credits terminal state | §0-2, §0-5 |
| P1-6 | Silent-failure blind spots: signature failures invisible, `refund.failed` leaves `refunded_minor` inflated, self-heal blind to non-`paid` statuses | §0-1, §0-3 |
| P2 | Ignored coupons, equal-price plan-change fall-through, sequential double-checkout, quote/charge currency divergence, UPI seat edits, no money-route rate limits, at-most-once outbound webhooks, partial-CN paisa drift, misc. | various |

**Launch gates derived from this list:**
- Before the next refund/dispute is processed manually: fix P0-1.
- Before any GST filing cycle: fix P0-2 + P1-6(b)(c).
- Before `INTL_PAYMENTS_ENABLED=true`: close all of P1-2 plus the quote/charge
  divergence items in P2.
- Independent of launch: P1-3 one-line cron fix and P1-4 threading fix are cheap
  and high-value now.
