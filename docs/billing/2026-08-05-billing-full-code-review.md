# Billing / Payments / Invoicing — Full Code Review (2026-08-05)

**Method:** six parallel deep-read reviews (checkout/subscriptions, Razorpay core,
invoicing/GST, credits/entitlements, webhooks/worker, pricing/geo/plan-admin) over the
current `development` tree (HEAD `17edaf2`), with the highest-severity findings
independently re-verified line-by-line. Everything below is code-verified — no
speculation, no doc-reading.

**Companion:** target-state blueprint at
`2026-08-05-ideal-billing-system-blueprint.md` (§10 carries the prioritized gap list).

---

## Part A — Verdict

The core engineering is genuinely strong. The tax engine, invoice numbering,
webhook idempotency, and credit-ledger locking are production-grade, and **every
headline historical bug is confirmed fixed** (see Part D). What remains falls into
three themes:

1. **Refund/clawback misattribution** — the one place a routine ops action
   destroys customer money-state today (P0).
2. **`billing_country` is a self-declared tax authority** — one unguarded PATCH
   flips GST classification and, later, the charge rail (P0 compliance).
3. **Side doors around the main gate** — `/change-plan`, the renewal cron, and
   seat add-ons each bypass checks the primary path enforces (P1 cluster).

---

## Part B — Workflow maps (as implemented)

### B1. Rail selection (INR vs USD)
- **Display**: `core/geo.py` resolves country from edge headers
  (`CF-IPCountry` → `X-Vercel-IP-Country` → CloudFront → `X-Country-Code`), with an
  unauthenticated `?country=` override; unknown → USD display. `core/pricing.py:23`
  `display_price()` picks INR paise vs `*_usd_cents` (static fallback conversion at
  `DISPLAY_USD_TO_INR` when the USD column is NULL). FX is display-only — never charged.
- **Charge**: `core/pricing.py:53` `charge_currency(client.billing_country)` —
  `IN`/unknown → INR, else USD — resolved centrally inside
  `razorpay_service.create_subscription` (:402). Plans carry dual Razorpay ids
  (`razorpay_plan_id_monthly/annual` + `_usd`); `_plan_id_for_rail` (:333) hard-errors
  rather than cross-rail fallback. `INTL_PAYMENTS_ENABLED` gates only `/checkout` +
  quote at the route layer (see P1-2).
- **Top-ups are always INR** on both rails (deliberate, documented;
  `razorpay_service.py:197-215`) — USD figures are display-only notes.

### B2. Checkout → activation
`GET /checkout/quote` (country = param → stored → IP geo) →
`POST /checkout` (`subscription_routes.py:1179`): verified email →
`_resolve_confirmed_billing_country_or_409` (param → stored → **default IN**;
non-IN 409s unless intl flag on) → `_require_billing_identity` (Rule 46 buyer
fields) → pg advisory billing lock → already-subscribed 409 → persist country
(skipped when GSTIN set) → `create_subscription` (referral-discount plan mint per
(base, cycle, bps, **currency**) with staleness self-heal). No local row yet.
Activation lands via `subscription.activated` webhook
(`razorpay_service.py:1883`: create row, retire superseded siblings — gateway
cancels deferred to end of handler, marker-idempotent first-period grant, pending
upgrade proration) or via `POST /verify-razorpay-subscription` →
`reconcile_subscription_from_razorpay` (:1567, signature + ownership + synthetic
dedup key burned only after a billable state is confirmed) — both converge, both
idempotent (unique `razorpay_subscription_id`, unique `razorpay_payment_id`).

### B3. Renewal
`subscription.charged` (:2446): unknown sub → `WebhookOutOfOrder` (5xx, redeliver)
→ idempotent invoice → refuse-resurrect canceled rows (invoice, **no credits**) →
deferred-cancel backstop (emergency gateway cancel, credits withheld, "refund
required" log) → marker-keyed grant (`grant_subscription_period_once`: FOR UPDATE +
monotonic `last_granted_period_end`) → roll period, clear dunning.
Safety-net cron `task_renew_due_subscriptions` (00:05) grants the same marker way
— but keyed on the *old* period end (bug P1-3).

### B4. Plan change / cancel / resume (UPI cancel+recreate model)
- **Upgrade** (`transition_service.execute_paid_upgrade`): snapshot unused
  credits → mint replacement checkout with `prev_razorpay_subscription_id` → old
  mandate retired at activation → rollover re-granted clamped to live remaining.
- **Downgrade**: immediate gateway cancel-at-cycle-end + queued
  `scheduled_plan_id`; promoted at cutover (advisory lock + FOR UPDATE), re-auth
  email.
- **Cancel** `/cancel`: sets `cancel_at_period_end` intent only; inline gateway
  cancel iff within `GATEWAY_CANCEL_LEAD_DAYS` (failure = 502, correctly fatal).
  Cron `task_execute_pending_cancellations` (00:03) executes the rest under the
  same per-client advisory lock; marker `gateway_cancel_executed_at` stamped only
  when plan + seat cancels both succeed.
- **Resume** `/resume`: before gateway-cancel fact → verify liveness at the
  gateway, flag flip (free); after → mint replacement with
  `start_at = current_period_end`, grants nothing until first charge.

### B5. Invoicing (both rails)
Every charge → `Invoice` row idempotent on `razorpay_payment_id` →
`finalize_invoice` (`invoice_service.py:215`): supply classified by
`supply_kind(seller.state_code, buyer.billing_state_code, buyer.billing_country)`
(`core/tax.py:61`) — blank country can never become an export; tax from
`compute_tax` (integer paise, single rounding point, inclusive carve-out, CGST=tax//2
odd-paisa-to-SGST); serial allocated in-transaction from `InvoiceCounter`
(gapless, IST fiscal year, savepoint un-burns on rollback); seller/buyer
snapshots frozen; ORM guard makes tax columns immutable. Exports: USD face +
INR mirror from Razorpay `base_amount` (5–500 INR/unit tripwire; refuses to
number without a mirror), LUT → zero-rated with legend, no LUT → IGST (Rule 96A),
POS rendered "96 – Outside India". Credit notes: FOR UPDATE on the original +
cumulative cap + provider-ref idempotency; full refund reuses exact original
figures. PDFs: ARQ sweep, guarded NULL→url claim, R2 under capability key,
auto-email once. GSTR-1-style reports sum only INR figures (mirror for exports).

---

## Part C — Findings (deduplicated, ranked)

Convergence notes: findings flagged independently by multiple reviewers are
marked ⊕; ✔ = re-verified line-by-line during synthesis.

### P0 — fix before the next refund / before intl launch

**P0-1 ✔ Refund/chargeback clawback can wipe an unrelated plan grant.**
`razorpay_service.py:3072` (and :3216 for disputes) picks the clawback reason from
`inv.subscription_id is not None → "plan_grant"`. Seat add-on invoices
(`:1332-1334`) and withheld-credit charges after cancellation (`:2505-2516`,
`:2584-2591` — where the log *prescribes* a refund) carry `subscription_id` but
funded **no grant**. With no invoice-linked grant, `clawback_refund` falls back to
the *most recent* plan grant in scope (`credit_service.py:1013-1035`) at
`refund_fraction = 1.0` — a ₹449 seat refund erases the customer's entire
unconsumed plan allowance. **Aggravator ⊕:** `_backfill_plan_grant_reference`
(`credit_service.py:800-812`) lacks `delta > 0` and an `id` tiebreak, so the
invoice link can land on a negative reset row (same `created_at` in one
transaction), silently reactivating the bad fallback even for normal plan
invoices. *Fix:* mark no-grant invoices (kind column or description filter) and
skip clawback for them; add `delta > 0` + `ORDER BY id DESC` to the backfill;
make the fallback opt-in for pre-C2 legacy rows only.

**P0-2 ✔⊕⊕⊕ `billing_country` is self-declared and single-handedly drives GST.**
`PUT /billing-details` (`subscription_routes.py:802-905`) accepts any 2-letter
country; only a GSTIN pins IN. `supply_kind` reads it directly, so an Indian
customer on a live INR mandate who clears GSTIN and sets `US` gets every renewal
and top-up zero-rated as a LUT export — 18% embedded GST no longer carved out or
remitted on a rupee-settled domestic payment (also fails export-of-services FX
conditions). `_resolve_fx` blocks the *opposite* contradiction only (foreign
currency + IN); INR + foreign country issues silently
(`invoice_service.py:178-180`). Suspicion logging is one-directional (claims-IN
vs foreign IP only, `subscription_routes.py:1116-1122`) and checkout-time only;
signup seeds country from IP (`auth_routes.py:849`). *Fix:* freeze
`billing_country` while a mandate is live (rail change = cancel+recreate per
blueprint §2); on any change, re-run the mismatch check bidirectionally and flag
for review; refuse INR-settled export classification unless the account has ever
charged in a foreign currency.

### P1 — structural gaps around the main gate

**P1-1 ⊕ `/change-plan` bypasses every first-purchase gate.**
`subscription_routes.py:1336-1606` — Branch 3 is the real trial→paid and
free→paid conversion path, yet has no `_require_billing_identity` (statutory
buyer fields can be missing on the conversion invoice — the checkout comment
itself says "no second chance"), no country confirmation, no coupon/stacking
check, and no `INTL_PAYMENTS_ENABLED` gate.

**P1-2 ⊕ The intl kill-switch and USD rail are inconsistent.**
`INTL_PAYMENTS_ENABLED` is never read in `razorpay_service` — `/change-plan`,
`/resume`, `/seats` mint USD mandates for stored-foreign-country clients with the
flag off (or 400 opaquely if USD ids are absent). Superadmin USD price edits
don't re-mint the USD Razorpay plan (`superadmin_plan_routes.py:356-359` covers
INR only; the request models have no USD plan-id fields) → displayed ≠ charged
after any USD edit; `plan-price-check` diffs INR only. USD seat add-ons are
invisible to the orphan sweep (`razorpay_service.py:961-963` accepts only the INR
seat plan id) and `_handle_subscription_cancelled` (:2649) never cancels the seat
mandate — a Razorpay-side cancellation leaves $5/seat debiting with no sweep
coverage. *The USD rail must not launch until this cluster is closed.*

**P1-3 ✔⊕⊕ Renewal cron vs webhook: same period, different idempotency keys.**
`tasks.py:465` grants keyed on the **old** `current_period_end` (before rolling);
the webhook keys on Razorpay's **new** `current_end`
(`razorpay_service.py:2597`). Monotonic guard (`credit_service.py:882-886`)
passes the larger value → delayed-webhook redelivery after a cron grant runs
reset+grant twice for one paid cycle (consumption wiped, double ledger rows).
*Fix (one line):* cron grants `add_months(sub.current_period_end, period_months)`.
Related: the cron also grants with **no payment confirmation** (no provider
filter, no paid-invoice check — unbounded free renewals if webhooks are down) and
includes `trialing` rows (free full-plan grant in the 00:05–00:15 window before
trial expiry; permanent if the expiry cron errors).

**P1-4 Webhook route blocks the event loop.**
`webhook_billing_routes.py:60` is `async def` but handlers make synchronous
Razorpay HTTP calls (5s/30s timeouts, several chained during activation) while
holding the DB transaction and FOR-UPDATE locks — with Gunicorn's default single
uvicorn worker this stalls the entire API (chat SSE included) for up to ~35s per
slow gateway call. *Fix:* make the route `def` (threadpool) or
`run_in_executor`.

**P1-5 Top-up verify burns its idempotency key before confirming capture.**
`reconcile_topup_from_razorpay` records `reconcile:topup:<order_id>` first
(:1679), then bails un-granted if the payment is still `authorized`
(:1713-1714) — the key is permanently burned, later verifies no-op, and the
webhook is the only remaining path (which is the exact dropped-webhook scenario
this backstop exists for; localhost has no webhook at all). The sibling
subscription reconcile documents and fixes precisely this ordering (:1586-1595).

**P1-6 Silent-failure blind spots.**
(a) Wrong/rotated webhook secret → every event 400s at WARNING, no dead-letter,
no Sentry (`webhook_billing_routes.py:97`). (b) `refund.failed` restores credits
but never decrements `Invoice.refunded_minor` (`razorpay_service.py:3136-3167`) —
later partial refunds mis-flip status to `refunded`. (c) The unnumbered-invoice
self-heal and anomaly report filter `status == "paid"`
(`invoice_service.py:395`, `invoice_reports.py:327`) — a charge refunded before
finalize drops out of every report and can never get a credit note.

### P2 — correctness/quality (fix in normal course)

- **Coupon code accepted, silently ignored** — customer pays full price with a
  200 (`subscription_routes.py:912,1207`; no redemption path exists). Wire or 400.
- **Equal-price paid→paid change** falls through to fresh-checkout Branch 3:
  immediate double-billing + zero rollover; latent while seeded prices are
  distinct (`subscription_routes.py:1512,1542,1586`). Also unlimited repeated
  Branch-3 submits mint unbounded authorizable checkouts.
- **Sequential double-`/checkout`** passes the local-row 409 twice (rows only
  exist post-activation) → two authorizable gateway subs, both can charge, loser
  retired without refund; each attempt also inserts a pre-payment
  `ReferralConversion` (no uniqueness) inflating affiliate stats.
- **Quote/charge divergence:** country-less caller quoted USD but charged INR
  (`:988` vs `:1156`); GSTIN + confirmed foreign country silently swaps to INR
  (persist skipped at `:1265`); `$0` quote advertised when USD column NULL but
  USD plan id wired (`:1000-1005`); `/credits/balance` currency from raw IP only.
- **Monthly→annual on the same plan is impossible** (`:1369` never consults
  cycle). Cancel-pending users re-picking their plan hit a dead-end 400 instead
  of resume routing.
- **Seat quantity edits use Update Subscription API** — blocked for UPI mandates
  (`razorpay_service.py:875-887`) → customer-facing 502; the very constraint the
  plan-change flow was redesigned around.
- **No rate limits** on `/checkout`, `/change-plan`, `/resume`, `/topup`.
- **Outbound customer webhooks are at-most-once** on enqueue failure
  (`webhook_service.py:282-289`, `enqueue.py:89-100`); legacy multi-worker retry
  poller can double-deliver (no `SKIP LOCKED`); final-attempt exhaustion is
  unlogged; dedup relies on the unsigned `X-Razorpay-Event-Id` header (replay
  with fresh id re-runs handlers lacking payload-level keys: past_due flip,
  token deletes).
- **Invoice email recovery pass** lacks the claim guard → concurrent sweeps can
  double-email (`tasks.py:1905-1911`); it also re-renders instead of fetching the
  stored R2 bytes.
- **Partial credit notes** can strand a paisa of tax (per-note rounding vs
  original single rounding); partial-refund reconciliation ignores the stored
  `refunded_minor`; CN serial series shared with receipt reversals (Table 13
  explanation burden).
- **Misc:** `trialing→trialing` swap is dead code (`has_used_trial` fires
  first); `_capture_paid_at` uses authorization time not capture; money columns
  are 32-bit Integer (₹2.1cr ceiling); JPY-class currencies permanently blocked
  by the 5–500 FX band; `expire_old_topups` double-subtracts expiry rows
  (safe-by-luck); preview quota fails open per-process without Redis;
  `topup_allowed` plan feature unenforced server-side; `email_send` cost priced
  but never charged; sweep holds accumulating advisory locks in one transaction;
  `processed_webhooks` never pruned; `plan_price_check` uses the weak auth
  dependency (operator keys can read gateway sync data); unauthenticated
  `?country=` can pollute the geo audit log; `update_plan` can orphan gateway
  plans on commit failure with no log.

---

## Part D — Historical bugs re-verified FIXED in current code

| Bug | Status | Evidence |
|---|---|---|
| Annual subscribers got 1/12 credits | **Fixed** | `credit_service.py:752-786` (×`cycle_months`), `tasks.py:459` |
| Activation credit double-grant (H-A) | **Fixed** | marker-guarded `grant_subscription_period_once`, FOR UPDATE + monotonic, both call paths |
| Un-numbered invoice self-heal (H-B) | **Present** | `invoice_service.py:367-406` + reconciliation anomaly (but see P1-6c status filter) |
| Top-ups invoiced as GST exports | **Fixed** | top-ups classify from `billing_country` like subscriptions; `razorpay_service.py:2922-2929` |
| `/crawl` gated wrong credit bucket | **Fixed** | `document_routes.py:1033-1117` resolves the drained bucket |
| Preview mode = unlimited free LLM | **Fixed (bounded)** | owner-auth + per-bot daily Redis quota (fails open — P2) |
| Superadmin plan routes: zero readonly gating | **Fixed** | `_require_write` on all five write routes |
| Credit-note lock race (17edaf2) | **Test-only fix** | production lock at `invoice_service.py:462` predates it, correct |
| Webhook signature/idempotency | **Sound** | raw-bytes HMAC + `compare_digest`, fail-closed, atomic `ON CONFLICT` dedup, dead-letter + 5xx |
| Deferred-cancel model | **As designed** | intent/fact split, inline execution near period end, seat failure blocks marker, resume verifies gateway liveness |
| Tenant scoping across billing routes | **Sound** | every query client-scoped; reconcile paths ownership-checked |
