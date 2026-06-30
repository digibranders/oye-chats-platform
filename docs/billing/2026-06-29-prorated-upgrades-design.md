# Design: Prorated Plan Upgrades (Option A — industry-standard monetary proration)

**Status:** Proposed
**Date:** 2026-06-29
**Author:** Engineering (senior review)
**Related:** [`2026-06-29-payment-system-review-report.md`](2026-06-29-payment-system-review-report.md) (findings H1/H2, C2), [`2026-06-25-payment-system-implementation-plan.md`](2026-06-25-payment-system-implementation-plan.md)
**Affects:** `api/app/services/transition_service.py`, `api/app/services/razorpay_service.py`, `api/app/api/subscription_routes.py`, `api/app/api/webhook_billing_routes.py` (handler dispatch), `api/app/services/credit_service.py`, `app/src/pages/Billing.jsx`

---

## 1. Problem statement

A customer on **Starter ($19/mo)** upgrades to **Standard ($49/mo)** mid-cycle. Today (see review report §"Upgrade flow"):

- The Starter Razorpay mandate is cancelled **immediately**, a fresh Standard subscription is created, and the customer is **charged the full $49 now** with the billing cycle **restarting today**.
- The only thing carried over is **unused message credits** (re-granted as a 12-month top-up). There is **no monetary credit** for the unused days of the $19 already paid.
- The UI promises *"your unused Starter time will be credited"* — which is **false**: time is not credited, only credits are.
- The old mandate is cancelled **before** the new payment is confirmed → an abandoned checkout drops the customer off billing entirely. *(Verified in [`transition_service.execute_paid_upgrade`](../../api/app/services/transition_service.py): `cancel_subscription(sub, at_period_end=False)` runs before `create_subscription` returns the checkout payload. This is an independent **ordering** bug — related to but distinct from the H1 row-locking and H2 entitlement-resolution findings; fixing H1/H2 alone does not close it.)*

This diverges from every major SaaS billing system (Stripe Billing, Chargebee, Paddle, Recurly), all of which **prorate the upgrade in money**: the customer pays only the *incremental* cost for the remaining period, and the billing anchor is preserved.

## 2. Goals / non-goals

**Goals**
- On a mid-cycle **upgrade**, charge the customer the **prorated difference** between the new and old plan for the remaining days of the current period — not the full new-plan price.
- **Preserve the billing anchor** (renewal date does not move).
- Flip entitlements to the new tier **immediately** on successful payment.
- Make the flow **abandonment-safe**: a dismissed checkout leaves the customer on their current plan, still billed normally.
- Keep money math in **integer minor units (paise)**, exact, never negative.

**Non-goals**
- Downgrades — remain **scheduled at period end** (no monetary proration; unchanged from today, [`transition_service.schedule_paid_downgrade`](../../api/app/services/transition_service.py)).
- Free→paid (handled by trial/new-subscription paths).
- Changing the credit-allowance model beyond what proration requires (§6).
- Stripe-provider proration (Stripe already prorates natively; this doc is the Razorpay path).

## 3. Why this shape (Razorpay constraints)

Razorpay subscriptions **cannot change plan in place** and have **no native proration** (unlike Stripe's automatic proration line items). Three candidate mechanics were considered:

| Approach | Verdict |
|---|---|
| **A. Refund unused old value to card, then charge full new plan** | ❌ Refund fees, days-long settlement, churns cash, and collides with the credit-clawback path (report C2) which would wrongly reverse credits on the proration refund. |
| **B. Recurring discounted plan for the first cycle** | ❌ Razorpay discounts are modelled as discounted *plans* that recur **every** cycle ([`resolve_discounted_plan`](../../api/app/services/razorpay_service.py)); wrong tool for a one-time credit. |
| **C. One-time Razorpay Order for the prorated difference now, + new subscription scheduled to start at the current period end** | ✅ **Chosen.** Reuses the existing top-up Order/checkout machinery, no refund fees, preserves the anchor, and is inherently abandonment-safe (old mandate is only cancelled after the one-time payment captures). |

This mirrors Stripe's "upgrade now, keep the anchor, bill the difference" behavior using Razorpay-native primitives we already operate.

## 4. Proration math

All amounts are **integer minor units** of the plan currency (paise for INR). Rounding is **half-up**, and the charge is **clamped to ≥ 0** (a non-positive difference means it isn't an upgrade → not this path).

```
period_total_secs   = current_period_end − current_period_start
remaining_secs       = max(0, current_period_end − now)
remaining_fraction   = remaining_secs / period_total_secs        # 0.0 … 1.0

old_price = old_plan.monthly_price_cents   (or annual_price_cents for annual cycle)
new_price = new_plan.monthly_price_cents   (or annual_price_cents)

# Incremental cost for the remaining period == prorated difference.
# Algebraically equal to (new·f − old·f); compute as one product to avoid
# double rounding so the unused-old credit and new-period charge reconcile exactly.
upgrade_charge_minor = round_half_up((new_price − old_price) × remaining_fraction)
upgrade_charge_minor = max(0, upgrade_charge_minor)
```

**Worked example** (Starter ₹1,599 / Standard ₹3,999, day 10 of a 30-day cycle, `remaining_fraction = 20/30 = 0.6667`):

```
upgrade_charge = round((399900 − 159900) × 0.6667) = round(240000 × 0.6667)
               = 160000 paise = ₹1,600 charged today
```

Then the full ₹3,999 recurring begins at the **original** renewal date. Compare to today's behavior: the customer would pay ₹3,999 immediately and lose the unused ₹1,066 of Starter.

> Use the **server-stored** `current_period_start/end` (UTC, from the Razorpay subscription entity) and `datetime.now(UTC)` — never client-supplied dates. Currency for *display* still follows `app.core.pricing.display_price` (geo), but the **charge** is INR paise.

## 5. Flow & sequencing (abandonment-safe)

```
change_plan (upgrade branch, new_price > old_price, provider=razorpay)
  │
  ├─ compute upgrade_charge_minor (§4); if ≤ 0 → reject (not an upgrade)
  ├─ create one-time Razorpay Order (purpose="plan_upgrade") with notes:
  │     oyechats_client_id, target_plan_id, prev_razorpay_subscription_id,
  │     billing_cycle, prorated_credits, anchor_period_end (unix)
  ├─ persist expected amount for the order (idempotency + amount-tamper check)
  └─ return order checkout payload  ──────────────►  frontend opens Razorpay

Customer pays the one-time order
  │
  ▼
webhook: payment.captured / order.paid  (purpose == "plan_upgrade")
  ├─ verify signature + dedupe by event_id (existing machinery)
  ├─ assert captured amount == persisted expected amount  (report H1/§9)
  ├─ create NEW Standard subscription with start_at = anchor_period_end
  │     (so the first FULL ₹3,999 lands at the original renewal date)
  ├─ cancel OLD Starter mandate at_period_end=True  (no double-charge; old
  │     cycle finishes, then it stops — only NOW, after payment captured)
  ├─ flip entitlements to Standard immediately:
  │     local Subscription.plan_id → new_plan (or insert new active row;
  │     keep current_period_end = anchor so the anchor is preserved)
  ├─ grant prorated incremental credits (§6)
  └─ record Invoice (description "Upgrade proration ₹X")

Customer DISMISSES checkout  →  no webhook  →  old Starter mandate intact,
                                  entitlements unchanged. SAFE.
```

Key ordering rule (fixes report H1): **the old mandate is cancelled only inside the webhook, after the upgrade payment is captured** — never speculatively in the route.

## 6. Credit handling on upgrade

To keep credits consistent with money, grant the **prorated incremental** allowance for the remaining period rather than a fresh full month (which would double-grant against the preserved anchor):

```
extra_credits = round_half_up(
    (new_plan.credits_per_month − old_plan.credits_per_month) × remaining_fraction
)
extra_credits = max(0, extra_credits)
```

- Granted as a `plan_grant` tied to the (preserved) period, so the next monthly reset at `current_period_end` correctly zeroes it and the full Standard allowance is granted on the normal renewal.
- The customer's **already-unused Starter credits stay untouched** (no reset on upgrade in this model), so nothing they paid for is lost.
- This replaces today's "reset + full new grant + roll old unused into a 12-month top-up" sequence, which over-grants relative to money paid.

> Decision point for product: if you prefer the *generous* model (keep full rollover), document it explicitly — but the proration-consistent default above is recommended so credits and money tell the same story.

## 7. Schema / data

No new tables required. Reuse the **order-notes** contract (like top-ups) plus an idempotency record for the expected amount:

- **Razorpay Order `notes`** (server-set, signature-protected via the captured payment): `purpose="plan_upgrade"`, `oyechats_client_id`, `target_plan_id`, `prev_razorpay_subscription_id`, `billing_cycle`, `prorated_credits`, `anchor_period_end`.
- **Expected-amount store** for the one-time order (mirrors the recommended top-up reconcile): a row keyed by `razorpay_order_id` with `expected_amount_paise` so the webhook can assert no amount tampering. (Can live on `Invoice` at creation with `status="pending"`, or a small `pending_upgrade_orders` table.)
- **Invoice**: one row at capture, `description="Upgrade proration"`, `amount_cents = upgrade_charge_minor`, linked to the new subscription.
- Retire the misuse of `Subscription.upgrade_credit_pending_cents` (legacy name storing a credit count) for this path — the new flow carries state in order notes, not on the old row.

## 8. API & frontend changes

- **`POST /change-plan`** upgrade branch now returns an **Order** checkout payload (`order_id`, `amount`, `key_id`, `status="upgrade_checkout_required"`) instead of a subscription payload. Message: *"You'll be charged ₹X today for the upgrade (prorated). Your plan renews at ₹3,999 on <renewal date>."* — accurate copy (fixes the misleading-message finding).
- **`POST /change-plan/preview`** (new, recommended): returns `{upgrade_charge_minor, currency, remaining_days, renewal_date, extra_credits}` so the UI can show the exact charge **before** the customer confirms (Stripe/Chargebee parity).
- Webhook dispatch gains a `purpose == "plan_upgrade"` branch in `_handle_payment_captured` (or a dedicated `_handle_plan_upgrade_captured`).
- `app/src/pages/Billing.jsx`: open Razorpay with `order_id` (not `subscription_id`) for upgrades; render the preview.

## 9. Edge cases

| Case | Handling |
|---|---|
| `remaining_fraction ≈ 1` (upgrade same day as renewal) | Charge ≈ full difference — correct. |
| Upgrade on the **last** day | `remaining_secs` small → tiny charge; clamp ≥ 0; still flips tier and schedules new sub at anchor. |
| New price ≤ old price | Not an upgrade → routes to the scheduled-downgrade branch. |
| Annual cycle | Same math with `annual_price_cents` and the annual period window. |
| Monthly → annual upgrade | Treat as upgrade if annual price > current period-equivalent; charge prorated difference; new annual sub `start_at` = anchor. (Phase 2 — document separately.) |
| Multiple upgrades in one cycle | Each computes against the **current** anchor and old plan; idempotent per order. |
| One-time upgrade payment **fails** | Old plan intact; customer retries. No state change. |
| Refund of the upgrade charge | Must reverse **only** the prorated credits, tied via `reference_id`/grant link — depends on the report **C2** clawback-scoping fix landing first. |
| Concurrent upgrade + cancel | Lock the subscription row (`with_for_update`) in `change_plan` — report H1 fix. |
| Rounding | Single product, half-up, clamp ≥ 0; one rounding point so credit + charge reconcile. |

## 10. Rollout

1. Ship behind a config flag `PRORATED_UPGRADES_ENABLED` (default off). When off, the current cancel-and-recreate path remains.
2. Land the **C2** (refund clawback scope) and **H1** (row-lock + cancel-after-capture) fixes first — this design depends on both.
3. Enable for internal/test clients (`CHECKOUT_TEST_CLIENT_IDS`) → verify on the ₹1 test plan → enable globally.
4. Update the billing help docs + the in-app upgrade copy.

## 11. Test plan

Unit — proration math (`transition_service`):
1. Day-10-of-30 Starter→Standard → exact `upgrade_charge_minor` (₹1,600 example).
2. `remaining_fraction` boundaries (0, 1), last-day, same-day-as-renewal.
3. New ≤ old → raises / routes to downgrade.
4. Annual cycle math.
5. Rounding: charge + unused-old credit reconcile to the new-period value exactly; never negative.

Integration — flow:
6. Happy path: pay upgrade order → new sub created with `start_at == anchor`, old mandate cancelled at period end, entitlements = Standard now, prorated credits granted, Invoice recorded.
7. **Abandoned checkout** → old mandate intact, entitlements unchanged, no new sub. (regression for H1)
8. Webhook replay of the upgrade capture → single charge, single grant (event-id dedupe).
9. Amount-tamper: captured amount ≠ expected → rejected, no grant. (H1)
10. Renewal after upgrade fires the **full** Standard price on the **original** anchor date.
11. Refund of the upgrade charge reverses only the prorated credits, balance never negative. (depends on C2)
12. Concurrent double-click on upgrade → one order/charge (row lock + idempotency).

## 12. Decision summary

Adopt **Option A / Approach C**: bill the prorated upgrade difference as a one-time Razorpay Order now, start the new-tier subscription at the preserved billing anchor, flip entitlements on capture, and grant prorated incremental credits. This matches industry behavior, removes the double-charge, fixes the misleading "time will be credited" copy, and — by cancelling the old mandate only after capture — closes the abandoned-checkout gap. Depends on the C2 and H1 fixes landing first.
