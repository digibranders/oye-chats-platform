# Billing System — Implementation Plan to Target State (2026-08-05)

**Objective:** take the current billing stack to the blueprint
(`2026-08-05-ideal-billing-system-blueprint.md`) by closing every gap in
`2026-08-05-billing-full-code-review.md`.
**Out of scope:** the downgrade/dunning-recovery findings (D1–D8,
`2026-08-05-downgrade-and-payment-failure-review.md`) — owned by the other
developer ("Dev B"). Coordination points with their work are marked ⚠️.

**Branch policy:** all work on `development`, one PR per wave, TDD per repo
standard (test first, `ruff` + full `pytest` green before every push).

---

## Ownership & conflict map (read first)

Dev B's expected surface (downgrade path): `transition_service.py`,
`subscription_routes.py` change-plan Branches 1/2a/2b,
`_handle_subscription_cancelled` / `_handle_subscription_completed` in
`razorpay_service.py`, dunning/`tasks.py` expiry cron.

This plan touches those files in exactly three places, all flagged ⚠️ below.
Everything in Wave 0 is conflict-free by construction. Rule: Waves 0 and 2 can
run in parallel with Dev B; Wave 1's routing changes land **after** Dev B's
downgrade PR merges (or get assigned to Dev B directly).

---

## Wave 0 — Money-state hotfixes (1–2 dev-days, ship this week)

Small, isolated, individually testable. No schema changes. No Dev B overlap.

### 0.1 Refund clawback misattribution (P0-1) — the one to do first
- `razorpay_service.py:3072` + `:3216`: stop deriving clawback intent from
  `subscription_id` presence. Add a discriminator the invoice already carries:
  match on `description == "Operator seat add-on"` **and** on the
  withheld-credit renewals (no ledger row with `reference_id == invoice.id`
  AND subscription was cancel-pending at charge time). Cleanest durable fix:
  new nullable `Invoice.kind` column (`plan_charge | seat | topup |
  withheld_charge`) stamped at creation — one Alembic migration, backfill by
  description match.
- `clawback_refund` (`credit_service.py:1013-1035`): make the most-recent-grant
  fallback **opt-in** (`allow_legacy_fallback=True` only from the reconcile
  path for pre-C2 invoices); default = no linked grant → claw nothing, log at
  ERROR for manual review. A missed clawback is recoverable; a wrong one isn't.
- `_backfill_plan_grant_reference` (`credit_service.py:800-812`): add
  `CreditLedger.delta > 0` filter + `ORDER BY id DESC` tiebreak.
- **Tests:** refund a seat invoice → zero ledger rows reversed; refund a
  withheld-credit renewal → zero reversed + ERROR logged; normal plan refund →
  exact linked-grant reversal; backfill never selects a reset row (same-
  timestamp fixture).

### 0.2 Renewal cron grant key (P1-3a) — one line + tests
- `tasks.py:465`: grant `add_months(sub.current_period_end, period_months)`
  (the NEW period end), matching the webhook's key. Keep the roll-forward
  after it.
- **Tests:** cron-then-delayed-webhook replay → exactly one grant; webhook-
  then-cron → one grant (existing behavior preserved).

### 0.3 Renewal cron eligibility (P1-3b/c)
- Exclude `trialing` rows (`tasks.py:431`) — trials never "renew"; the expiry
  cron owns them. ⚠️ *Trivial overlap risk only if Dev B touches the same
  query; coordinate on merge order, not design.*
- Razorpay-provider rows: require a paid invoice inside the elapsed period
  before granting (manual/free-provider rows keep cron-granting as today).
  Cap the no-confirmation fallback at one period.
- **Tests:** trialing row untouched at 00:05; unpaid Razorpay row gets no
  second grant; free-plan manual row still renews.

### 0.4 Top-up verify ordering (P1-5)
- `reconcile_topup_from_razorpay` (`razorpay_service.py:1657-1714`): fetch and
  confirm `captured` + `purpose=="topup"` **before** burning
  `reconcile:topup:<order_id>` — mirror the documented ordering of the
  subscription reconcile (`:1586-1595`).
- **Tests:** verify while payment `authorized` → False, key NOT burned, second
  verify after capture → grants once; replay after grant → no-op.

### 0.5 Silent-failure trio (P1-6)
- `refund.failed` (`razorpay_service.py:3136-3167`): decrement
  `inv.refunded_minor` by the failed refund's amount; recompute status.
- Self-heal + anomaly filters (`invoice_service.py:395`,
  `invoice_reports.py:327`): widen `status == "paid"` to
  `status.in_(("paid","partially_refunded","refunded"))`.
- Webhook signature failures (`webhook_billing_routes.py:97`): count per
  15-minute window; ≥3 consecutive → `logger.error` (Sentry) with event-id +
  a "check RAZORPAY_WEBHOOK_SECRET rotation" hint.
- `payment.captured` early-return (`razorpay_service.py:2884`): `if
  existing_inv:` regardless of status (kills the refunded-then-redelivered
  5xx loop).
- **Tests:** refund-failed restores `refunded_minor`; partially-refunded
  unnumbered invoice gets healed + reported; simulated bad-signature burst
  emits ERROR.

**Wave 0 exit gate:** full pytest green; replay-twice tests added for every
touched webhook handler; deploy to prod after smoke (this wave is safe to
hotfix independently of everything else).

---

## Wave 1 — Tax-fact governance & one-gate checkout (3–4 dev-days) ⚠️

Implements blueprint §2 ("tax classification from durable, validated facts;
quote and charge share one resolver"). **Sequencing: land after Dev B's
downgrade PR** — this wave touches `subscription_routes.py` broadly.

### 1.1 Freeze `billing_country` under a live mandate (P0-2)
- `PUT /billing-details`: reject `billing_country` changes while any
  subscription in (`active`,`trialing`,`past_due`) has a
  `razorpay_subscription_id` → 409 `billing_country_locked` with support
  contact. (Rail change = churn event per blueprint; superadmin override
  endpoint for genuine relocations, audit-logged.)
- Make the geo-mismatch check bidirectional and persistent: log + flag
  `suspicious_geo` on IN-detected→foreign-claimed as well
  (`subscription_routes.py:1116-1122`), at checkout AND billing-details.
- Invoice-side backstop: in `finalize_invoice`, refuse to classify an
  INR-settled charge as `export` unless the account has ever charged in a
  foreign currency — mirror of the existing foreign-currency-on-domestic
  guard (`invoice_service.py:187-191`). Refused rows stay unnumbered and
  surface in reconciliation (existing machinery).
- **Tests:** country flip with live mandate → 409; GSTIN-clear-then-flip →
  409; export classification blocked for INR-only history; superadmin
  override works + audits.

### 1.2 One country/currency resolver for quote and charge
- New `resolve_billing_context(client, request_country, request) →
  (country, currency, source)` in `core/pricing.py`; used by `checkout_quote`,
  `create_checkout`, `/credits/balance`, and `charge_currency` call sites.
  Kills the quoted-USD/charged-INR divergence (`:988` vs `:1156`) and the
  balance-page IP-only currency.
- Explicit 409 (`billing_country_required`) when neither stored nor confirmed
  country exists at charge time — no more silent default-IN on a USD quote.
- GSTIN + confirmed non-IN country → 422 "clear GSTIN first" instead of the
  silent INR swap (`:1265`).
- **Tests:** matrix {stored, param, header, none} × {quote, checkout, topup,
  balance} asserting identical resolution.

### 1.3 Gate parity for `/change-plan` (P1-1) ⚠️ **joint with Dev B**
- Extract `/checkout`'s pre-charge gates (verified email ✓ already,
  `_require_billing_identity`, country confirmation, intl flag, stacking)
  into one dependency; apply to change-plan Branch 3 and `/resume` mode 2.
  *Dev B owns the branch structure — hand them the dependency + tests, or
  land immediately after their merge.*
- **Tests:** trial→paid via change-plan without billing identity → 409;
  stored-foreign-country + intl flag off → `intl_usd_pending` 409, not a USD
  mandate.

### 1.4 Checkout idempotency (P2 promoted)
- Persist a `pending_checkout_subscription_id` on the client (or reuse
  `DiscountedPlanCache`-style table) at `create_subscription`; sequential
  re-checkout within TTL reuses it (the `/resume` in-flight pattern,
  `:1881-1890`) instead of minting a new authorizable sub.
- Move `ReferralConversion` insert to activation webhook (payment-confirmed),
  add unique constraint on `client_id`. One migration.
- **Tests:** double-checkout returns same gateway sub id; abandoned checkout
  creates no conversion row.

---

## Wave 2 — USD-rail readiness (3 dev-days; **hard gate for intl launch**)

Parallel-safe with Dev B. Nothing here ships user-visible change until
`INTL_PAYMENTS_ENABLED` flips — it makes the flip safe.

### 2.1 Enforce the kill-switch in the service layer (P1-2/F8)
- `create_subscription` + `create_seat_addon_subscription`: when resolved
  currency is USD and `INTL_PAYMENTS_ENABLED` is false → typed
  `IntlPaymentsDisabled` error; routes map it to the existing
  `intl_usd_pending` 409. Flag checked in ONE place (the service), routes
  keep their UX-level gating.

### 2.2 USD plan-edit self-heal (F2)
- Extend `_PRICE_TO_PLAN_ID` map + request models in
  `superadmin_plan_routes.py` to the `*_usd_cents` ↔ `razorpay_plan_id_*_usd`
  pairs; mint USD Razorpay plans (currency="USD") on USD price edits with the
  same mint-first/apply-after/orphan-log pattern; add the currency guard the
  code comments already ask for (`plan.currency != "INR"` → refuse INR mint,
  F7) and an enum check on `currency` fields.
- Extend `plan-price-check` diagnostic to diff USD ids too; move it to strict
  superadmin auth (F9).

### 2.3 USD seat coverage (F3/F4)
- `iter_seat_addon_subscriptions` (`razorpay_service.py:961-963`): accept
  `RAZORPAY_SEAT_PLAN_ID_USD` as well → orphan sweep covers USD seats.
- ⚠️ `_handle_subscription_cancelled`: add seat-addon cancel + pending-park
  (same block `execute_gateway_cancellation` uses). *This handler is in Dev
  B's surface for D1 — hand them this 10-line addition as part of their PR.*
- Seat invoices: stamp `kind="seat"` (from Wave 0.1) and exclude them from
  `_revoke_unpaid_activation_grant`'s paid-invoice probe (F5).
- Quote hardening: free-plan short-circuit checks the resolved-currency
  amount, never advertise `$0`/`checkout_supported` off a NULL USD column
  (F6); `resolve_discounted_plan` gateway call wrapped in
  `RazorpayBillingError` (F7-low).

**Wave 2 exit gate = intl launch checklist:** all above merged + the Wave 1.2
resolver live + golden-invoice matrix (below) green for the export cases +
one real USD test transaction end-to-end on live keys.

---

## Wave 3 — Platform hardening (2–3 dev-days)

### 3.1 Webhook route off the event loop (P1-4)
- Change `razorpay_webhook` to sync `def` (FastAPI threadpool) — the handler
  stack is already synchronous end-to-end. Also `task_process_webhook_retries`
  → `run_in_executor` (L-1).
- **Test:** existing webhook suite unchanged; add a slow-gateway simulation
  asserting the health endpoint stays responsive (integration, marked slow).

### 3.2 Money-route rate limits (M7)
- SlowAPI on `/checkout`, `/change-plan`, `/resume`, `/credits/topup`,
  `/verify-*`: generous per-client limits (e.g. 10/min, 50/day) — abuse
  ceiling, invisible to real users.

### 3.3 Outbound webhook delivery integrity (M-1/M-4/L-4)
- Create the `WebhookDelivery` attempt row (or keep `next_retry_at`) until the
  ARQ enqueue is confirmed; add `FOR UPDATE SKIP LOCKED` to
  `process_pending_retries`; `logger.error` on final-attempt exhaustion.

### 3.4 Replay-hardening + hygiene (M-2, L-2, M-5)
- Dedup secondary key: payload digest (`sha256(raw_body)`) unique alongside
  event-id, so a replayed signed body with a fresh header id no-ops.
- Recovery email pass: claim `emailed_at` via guarded UPDATE before sending;
  attach the stored R2 bytes instead of re-rendering (L-8).
- `processed_webhooks` pruning cron (>180 days) — safe once payload-digest
  dedup exists for the money handlers' second layer.

---

## Wave 4 — P2 cleanup batch (2 dev-days, schedulable anytime)

- Coupons: 400 on unknown `coupon_code` (or wire redemption if product wants
  it — decision needed, default = 400).
- Equal-price plan-change guard: explicit 409 `plans_equal_price` instead of
  Branch-3 fall-through. ⚠️ *Branch conditions are Dev B's file — bundle into
  their PR or after.*
- Monthly↔annual cycle switch on the same plan: route to the upgrade path
  keyed on (plan, cycle) price comparison, not plan id equality.
- `/resume` gets `require_verified_email`; cancel-pending re-pick routes to
  resume instead of 400.
- `checkout_quote`/topup polish: `int()` truncation fix, `initiate_topup`
  explicit error branch, `topup_allowed` enforced server-side (decision:
  enforce vs drop the flag — default enforce).
- Terminal-state cancel detection: match Razorpay error `code`, not message
  substrings (F8-razorpay).
- Money columns Integer→BigInteger migration (L-4 invoicing) — bundled with
  the Wave 0.1 `kind` migration if convenient.

---

## Cross-cutting: test & release engineering

1. **Golden invoice matrix** (blueprint §8.4): {IN-intra, IN-inter, IN-B2B,
   export+LUT, export-no-LUT} × {subscription, renewal, top-up, credit note}
   asserted to the paisa — extend the existing suites where missing; add PDF
   snapshot tests for the 5 export cells before intl launch.
2. **Replay-twice discipline:** every webhook fixture in the suite runs twice
   asserting zero new ledger/invoice rows on pass 2 (Wave 0 introduces the
   helper; later waves adopt it).
3. **Reconciliation cron** (blueprint §7): daily job diffing Razorpay captured
   payments vs invoices vs grants for the window; ERROR on any delta. Build in
   Wave 3; it is the safety net that catches whatever this plan missed.
4. **Deploy order:** each wave = one PR `development` → smoke → PR to `main`.
   Migrations (0.1 kind column, 1.4 referral unique, 4 BigInteger) are
   backfill-before-code, per the repo's standing rule.

## Timeline (single dev + me, Dev B independent)

| Week | Ships |
|---|---|
| W1 | Wave 0 (hotfix PR) + Wave 2 started |
| W2 | Wave 2 complete (intl gate met) + Wave 1 after Dev B merges |
| W3 | Wave 3 + reconciliation cron |
| W4 | Wave 4 + golden-matrix completion + full smoke |

## Decisions needed from you (non-blocking for Wave 0)

1. Coupons: kill the field (400) or build redemption? *(default: 400 now)*
2. `billing_country` relocation: superadmin-only override acceptable? *(default: yes)*
3. `topup_allowed`: enforce for Free tier or drop the flag? *(default: enforce)*
4. Intl launch date target — Wave 2 is its critical path.
