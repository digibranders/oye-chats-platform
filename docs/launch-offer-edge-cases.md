# Launch Offer — Edge-Case Catalog

> ## ⚠️ Swept before the 26 Aug 2026 switch to GST-EXCLUSIVE pricing
>
> This catalog is left unedited. Every published price is now a base price, exclusive of GST, and a
> domestic customer is debited base + GST at charge time. International customers are an export and
> pay the listed USD price.
>
> That does not change any verdict below, but it does change two rows and opens one question:
> - **8.2** ("Confirm modal price with promo"). The "then ₹X" figure must be the **gross** for a
>   domestic customer, from `gross_display` on `GET /subscriptions/checkout/quote`. Re-verify it.
> - **4.3** ("Plan price changes while a promo sub is in its free window"). Unchanged in mechanism,
>   but a GST **rate** change is now a price change too, because each Razorpay plan is minted at base
>   + GST and is immutable.
> - **Open:** whether the month-4 charge on a `start_at` mandate authorised under the old
>   GST-inclusive plans debits the old amount. It should, since a mandate is locked to the plan it was
>   authorised against, but no one has verified it against a re-minted plan. Related to 5.6.
>
> Current source of truth: `api/app/core/tax.py` and
> [`api-reference.md`](./api-reference.md#billing-and-pricing-routes).

Systematic sweep of the "sign up via link, 3 months free" feature before production.
Grounded in the actual implementation on branch `steve`.

**Legend:** ✅ handled/verified · ⚠️ needs a decision or fix · 🔴 known gap (must fix before real customers)

---

## 🔴 Must-fix before any real customer sees this

| # | Edge case | Current behavior | Fix |
|---|---|---|---|
| C1 | **Credits run out mid-free-period** | Verified in code: `grant_subscription_period_once(period_end=None)` grants **one** month's allowance at authentication and can't advance the marker. During the 3 free months no `subscription.charged` fires, so **no monthly refresh** happens. The customer gets 1 month of credits for 3 months of access → runs dry ~month 2. | Task #8: a promo-aware monthly refresh (cron keyed on `promo_free_until` / activation anniversary) that re-grants `credits_per_month` each month of the free window without double-granting against `last_granted_period_end`. |
| C2 | **Annual cycle + promo = full-year charge after 3 months** | Nothing restricts the promo to monthly. A user picking **annual** gets `start_at = now + 3 months`, then is charged the **entire annual price** at month 3. "3 months free" then a huge yearly bill. | Restrict the promo to monthly (block annual in `create_checkout` when a promo applies, and hide/disable the annual toggle for promo-eligible plans), or explicitly design annual promo terms. Plan doc already recommended monthly-only. |
| C3 | **No pre-charge reminder** | Task #9 not built. Customer is charged at month 4 with only the NPCI UPI notice (cards get nothing). Surprise charge → chargebacks. | Build the reminder cron (`promo_reminder_sent`) ~10 days before `promo_free_until`. |

---

## 1. Signup & code capture

| # | Scenario | Behavior | Status |
|---|---|---|---|
| 1.1 | Link user, brand-new email | Code captured on `signup_promo_code`, offer applies | ✅ tested |
| 1.2 | Organic signup (no code) | No code stored → normal pricing | ✅ tested |
| 1.3 | Code with weird case/whitespace (`  launch3 `) | Normalized, stored canonical | ✅ tested |
| 1.4 | Unknown/garbage code | Silently ignored, nothing stored, signup never fails | ✅ tested |
| 1.5 | Existing user clicks link (logged in) | Bounced to dashboard, never re-registers → no code | ✅ |
| 1.6 | Existing user clicks link (logged out, same email) | 409 → routed to login → no code | ✅ |
| 1.7 | Code capture is first-touch immutable | `attribute_signup_code` never overwrites an existing code | ✅ tested |

## 2. Eligibility & timing

| # | Scenario | Behavior | Status |
|---|---|---|---|
| 2.1 | Signed up via code, campaign **still active** at checkout | Eligible | ✅ |
| 2.2 | Signed up via code, campaign **ended/paused** before they checkout | **Not eligible** (window must cover checkout time). A user who joined in time but checks out late loses the offer. | ⚠️ decision: honor signup-time eligibility, or accept window-at-checkout? |
| 2.3 | Two active promos, one public (no code) + one coded, client has the code | Both can match; `resolve` returns first by `starts_at desc` → ambiguous which applies | ⚠️ define precedence (coded should win) |
| 2.4 | `eligible_plan_ids` lists a since-deleted plan | Malformed/missing id → that plan ineligible, no crash | ✅ |
| 2.5 | Promo `code` is null (public time-window) | Falls back to `created_at`-in-window gate | ✅ |

## 3. Checkout & redemption

| # | Scenario | Behavior | Status |
|---|---|---|---|
| 3.1 | Concurrent checkouts race for the last capped slot | Atomic `consume_slot` guarded UPDATE, never oversells | ✅ tested |
| 3.2 | **Capped promo, abandoned checkout** | Slot is claimed at `create_checkout`, **before** mandate auth. Abandoned checkouts **consume slots** with no subscription → a cap can be drained by drop-offs. | ⚠️ only matters if a cap is used (launch is uncapped). If capping: add slot release / claim at activation. |
| 3.3 | Client already redeemed (has any sub with this `promotion_id`, incl. canceled) | Not eligible again (free period not re-grantable) | ✅ tested |
| 3.4 | Client already has an active **paid** sub | `create_checkout` 409s (mandate-backed guard) → promo not applicable | ✅ |
| 3.5 | Free→paid upgrade routes correctly | Promo-eligible selection forced through checkout, not change-plan | ✅ fixed (Task #13) |
| 3.6 | Promo user also enters a **referral code** in the confirm modal | Promo suppresses the recurring discount (`discount_bps=0`), but the referral conversion still records. Interaction/UX not fully traced. | ⚠️ verify no double-benefit / confusing UI |
| 3.7 | Free plan / Enterprise plan selected | Free is rejected. The seeded **Enterprise** tier is **no longer excluded** — since `1da4fff` it is a priced ladder rung that takes the promo like any other paid plan, matching `promotion_service._plan_eligible` (which scopes by `eligible_plan_ids` alone). Only a bespoke per-contract plan is excluded, via `plan.isContactSales` (the `contact_sales` / `enterprise` feature flags) in `promotionAppliesToPlan`. The old `isEnterprise` slug match no longer exists. | ✅ |

## 4. Currency & billing cycle

| # | Scenario | Behavior | Status |
|---|---|---|---|
| 4.1 | **International (USD) eligible user** | Blocked by the USD gate (`INTL_PAYMENTS_ENABLED` off) → "contact sales". Eligible but **can't redeem**. And `start_at` on a USD Razorpay plan is untested. | ⚠️ decide: promo is India-only for now? Test USD rail if not. |
| 4.2 | Annual billing cycle | See **C2** — full-year charge after 3 months | 🔴 |
| 4.3 | Plan price changes while a promo sub is in its free window | `promo_free_until` is stamped at checkout; later price edits don't change the deferred date. Month-4 charge uses the plan's then-current Razorpay price. | ⚠️ confirm intended |

## 5. Webhooks, grants & credits

| # | Scenario | Behavior | Status |
|---|---|---|---|
| 5.1 | `subscription.authenticated` for a promo sub | Grants entitlements (verified live §7) | ✅ verified |
| 5.2 | `authenticated` redelivered / fires twice | `_resolve_local_subscription` finds row → re-activation branch, **no re-grant** | ✅ |
| 5.3 | `authenticated` for a **non-promo** sub | Plain ack, no behavior change to the normal path | ✅ tested |
| 5.4 | `subscription.activated` fires at `start_at` (month 4) | Row exists → re-activation branch, no re-grant | ✅ (confirm activated actually fires then) |
| 5.5 | Credits during the 3 free months | See **C1** — only one month granted | 🔴 |
| 5.6 | First real charge at month 4 (GST/tax, invoice) | Existing `subscription.charged` path (period-idempotent grant + invoice) | ✅ (needs a real month-4 test) |

## 6. Cancellation & payment failure

| # | Scenario | Behavior | Status |
|---|---|---|---|
| 6.1 | Cancel during the free period | `subscription.cancelled` → no charge ever; slot stays consumed | ✅ |
| 6.2 | Card fails / expires at month 4 | `subscription.halted` → existing dunning | ✅ |
| 6.3 | UPI mandate revoked before month 4 | Charge fails → dunning → downgrade; can't force collection | ✅ (accepted UPI leakage) |
| 6.4 | UPI ₹1–5 validation charge at auth | Happens, auto-refunded (verified live). Copy warns about it | ✅ verified |

## 7. Admin & campaign management

| # | Scenario | Behavior | Status |
|---|---|---|---|
| 7.1 | Superadmin edits window/free_cycles after users joined | Existing subs keep their stamped `promo_free_until`; only new redemptions use new values | ✅ |
| 7.2 | Superadmin **deletes** a promo with active subs | `promotion_id` → SET NULL on subs; they keep `promo_free_until` (deferred charge still works); stats link lost | ✅ (pause preferred) |
| 7.3 | Superadmin **pauses** promo | New redemptions stop instantly; existing subs unaffected | ✅ |
| 7.4 | Duplicate code | Unique index on `promotions.code` → 409 | ✅ |

## 8. Display & UX

| # | Scenario | Behavior | Status |
|---|---|---|---|
| 8.1 | Banner shown but plan-specific eligibility differs | Banner uses plan-independent resolver; cards use `promotionAppliesToPlan` per plan | ✅ consistent enough |
| 8.2 | Confirm modal price with promo | Shows "Free · First N months free · then ₹X · ₹0 today" | ✅ fixed |
| 8.3 | Display (resolve_client_promotion) vs enforcement (resolve_active_promotion) drift | Both code-gated now → consistent | ✅ |
| 8.4 | Annual toggle visible for a promo plan | User can pick annual and hit **C2** | 🔴 tie to C2 fix |

## 9. Environment / production safety

| # | Scenario | Behavior | Status |
|---|---|---|---|
| 9.1 | Dev email auto-verify leaking to prod | Double-gated (`DEV_AUTO_VERIFY_EMAIL` flag AND `APP_ENV != production`); proven False in prod even with flag on | ✅ verified |
| 9.2 | Migration not applied at deploy | App 500s (missing tables) | ⚠️ run `alembic upgrade head` at deploy |
| 9.3 | Test data (E2ETEST, verified accounts) in prod | Local DB only; never travels with a code deploy | ✅ |

---

## Priority order

1. **C1** — free-period credit refresh (Task #8). Blocks real use.
2. **C2 / 8.4** — restrict promo to monthly (or design annual terms).
3. **C3** — pre-charge reminder email (Task #9).
4. **2.2 / 2.3** — signup-time vs checkout-time eligibility + overlapping-promo precedence.
5. **4.1** — international/USD eligibility decision + test.
6. **3.6** — referral + promo interaction in the modal.
7. **3.2** — slot-release, only if a capped promo is ever used.
