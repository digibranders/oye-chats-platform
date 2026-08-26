# Launch Offer — "Sign up this month, get 3 months free"

> ## ⚠️ Written before the 26 Aug 2026 switch to GST-EXCLUSIVE pricing
>
> This plan is left unedited. The `start_at` mechanic it specifies is unaffected: a deferred first
> charge is still a deferred first charge. What changed is the **amount**. Every published price is
> now a base price, exclusive of GST, and a domestic customer is debited base + GST. An international
> customer is an export and pays the listed USD price.
>
> Three items in the plan below read differently now:
> - **§6d and §8 checkout copy.** "then ₹X/mo" must quote the **gross** for a domestic customer, from
>   `gross_display` on `GET /subscriptions/checkout/quote`. Quoting the base understates the month-4
>   charge by the tax, on a charge the customer will not see for three months.
> - **§4, AFA threshold (~₹15,000).** The threshold applies to the debit, which is the gross. A tier
>   whose base sits just under ₹15,000 can cross it once GST is added, so audit plan prices at the
>   gross, not the base.
> - **§4, mandate max amount.** Still fine: it is derived from the Razorpay plan, and every INR plan
>   is minted at base + GST, so the cap already includes the tax.
>
> Current source of truth: `api/app/core/tax.py` and
> [`api-reference.md`](./api-reference.md#billing-and-pricing-routes).

**Status:** Plan / ready for review
**Author:** drafted with Claude, for Codex review → gpt-5.4 execution
**Scope:** `platform/api` (backend), `platform/app` (customer checkout UI), `superadmin` (campaign admin)

---

## 1. Offer spec (locked)

> **"Sign up in `[campaign month]` and get your first 3 months free — on any plan. Card required · cancel anytime."**

| Dimension | Decision |
|---|---|
| **Gate** | Signed up during the campaign window (`Client.created_at` within `[start, end]`). Time-window, **no cap**. |
| **Benefit** | 3 billing cycles at 100% off, then auto-converts to the plan's normal price in cycle 4. |
| **Plan choice** | Customer picks any active paid plan. Whatever they pick is what auto-charges in month 4. |
| **Payment mandate** | **Required upfront — card OR UPI Autopay.** Razorpay mandate authorised at checkout (₹0 / nominal auth, possibly a ₹1–2 auto-reversed validation on UPI), first real charge deferred 3 months. UPI Autopay is a first-class recurring rail here (`razorpay_service.py:4`); checkout already offers both (`subscription_routes.py:926`). |
| **Cost safety** | Super-admin **pause switch** (no hard cap). Flip off if signup volume makes token COGS spike. |
| **Abuse** | Email verification (already enforced on checkout), one active account subscription per client (already enforced), disposable-domain block, no stacking with referral discounts. |

**Non-negotiables:** payment mandate required (card or UPI Autopay) + pick-your-plan. These are what make it a conversion funnel rather than a giveaway.

---

## 2. Architecture fit — what we REUSE (do not rebuild)

The billing stack already has ~80% of this. The offer is a thin layer.

| Need | Existing machinery | File |
|---|---|---|
| Link/attribution (optional shareable variant) | `affiliate_service.record_click`, `attribute_signup`, `ReferralCode` (`"OFFER"` is already a reserved type) | `api/app/services/affiliate_service.py` |
| Full access on day 1 while billing deferred | `plan_id` (entitlements) decoupled from `razorpay_billing_plan_id` (billed) | `api/app/db/models.py:1237` |
| Free-period-then-charge on the gateway | Razorpay `subscription.create` payload built centrally | `api/app/services/razorpay_service.py:346` |
| Grant entitlements on mandate auth | `_handle_subscription_activated` | `api/app/services/razorpay_service.py:1344` |
| Month-4 first real charge | `_handle_subscription_charged` (period-keyed idempotent grant) | `razorpay_service.py:1345` |
| Reminder emails, idempotent cadence | `Subscription.trial_emails_sent` pattern + email crons | `models.py:1221` |
| No-stacking guard | `_assert_no_stacking(client, coupon_code)` | `subscription_routes.py:2330` |
| One-subscription guard | `existing_account_sub` 409 in `create_checkout` | `subscription_routes.py:1244` |
| Email verification gate | `require_verified_email` dependency on `/checkout` | `subscription_routes.py:1184` |

---

## 3. Key technical decision — `start_at`, NOT a discounted plan

Two ways to make "3 months free":

- **❌ Discounted plan swap** (`resolve_discounted_plan`, `razorpay_service.py:546`) — used today for referral %-off. It's **permanent**; it never reverts to full price. Wrong tool for a time-boxed free period.
- **✅ Razorpay `start_at`** — set the subscription's first-charge timestamp 3 months out. The mandate is authorised now (customer proves a valid card/UPI); Razorpay generates **no invoice** until `start_at`; the first real charge fires at cycle 4 at full price. This is the native "free trial on a subscription" primitive and it self-reverts.

**Injection point:** add a `start_at: int | None` (Unix seconds) kwarg to `create_subscription` and pass it straight into the `rzp.subscription.create(data={...})` payload. One line in the payload, one param on the signature.

```python
# razorpay_service.create_subscription(...)
data = {
    "plan_id": razorpay_plan_id,
    "total_count": int(total_count),
    "customer_notify": 1,
    "quantity": quantity,
    "notes": notes,
}
if start_at is not None:
    data["start_at"] = int(start_at)   # first charge deferred → free period
```

> Compute `start_at` from `add_months(now, free_cycles)` — reuse `app.core.dates.add_months` (already imported in `subscription_routes.py:27`), aligned to the billing cadence.

---

## 4. ⚠️ Verification item #1 (do this FIRST — it gates the design)

**Which Razorpay event fires, and when, for a subscription with a future `start_at`?**

Today `_handle_subscription_activated` grants the initial credits. We MUST confirm that with a deferred `start_at`, Razorpay fires an event **at mandate-authorisation time** (so entitlements are granted on day 1), not only at `start_at` (which would withhold access for 3 months).

- If `subscription.activated` fires at auth → no webhook change needed. ✅
- If only `subscription.authenticated` fires at auth (and `activated` waits until `start_at`) → we must add a `subscription.authenticated` handler that grants initial entitlements, and ensure `_handle_subscription_charged` at month 4 does **not** double-grant (it's already period-keyed via `last_granted_period_end`, so it should be safe).

**How to verify:** create test subscriptions with `start_at` = now+10min against the Razorpay test plan (`RAZORPAY_TEST_PLAN_ID`), authorise, and watch the webhook event stream. Do not proceed with the webhook design until this is answered.

**Run it on BOTH rails — card AND UPI Autopay** — they can differ. Specifically capture, per rail:
- which event fires at authorisation vs at `start_at` (the day-1 grant depends on it);
- whether registration triggers a small validation debit (₹1–2, usually auto-reversed) — if so, the confirmation copy must say "you may see a ₹1 verification charge that's refunded", not "₹0 today";
- that the mandate stays valid across the 3-month dormant gap and the first debit at `start_at` succeeds.

### UPI Autopay specifics (India rail — mostly favourable, one real risk)
- **NPCI 24h pre-debit notification** fires before every UPI Autopay debit (Razorpay auto-sends). A *bonus* — the month-4 charge is never silent; it reinforces our own reminder email. Cards have no equivalent.
- **AFA threshold (~₹15,000):** auto-debits below it run with no customer re-auth; **above it the customer must approve each debit (AFA)** — applies to cards too. If any plan's month-4 amount exceeds ₹15k, expect lower auto-conversion on that tier. Audit plan prices against the threshold.
- **Mandate max amount is fixed at registration** → month-4 price must be ≤ the cap Razorpay sets from the plan. Fine unless prices rise between signup and month 4.
- **⚠️ Revocable mandate = the offer's main leakage path.** A user can pause/revoke a UPI Autopay mandate from their own UPI app anytime — take 3 free months, kill the mandate before month 4, charge fails, no way to force collection. Larger leakage than cards. Mitigation: reminder email + graceful auto-downgrade to Free on failed charge (dunning already handles the retry/halt). Accept some leakage — UPI is the dominant Indian rail and worth it.
- **Higher auto-debit failure rate** than cards (balance, bank downtime). No new code — existing `subscription.halted → past_due` dunning carries it — but expect the UPI cohort to convert at month 4 at a lower rate.

---

## 5. Data model changes

### 5a. New `Promotion` table (`models.py`)
One row per campaign; super-admin owned. Keeps the offer configurable and pausable without a deploy.

```
Promotion
  id
  code                 str, unique              # e.g. "LAUNCH3" — optional; the gate can be pure date-window
  name                 str
  is_active            bool     default true    # the PAUSE SWITCH
  starts_at            datetime tz
  ends_at              datetime tz              # signup window
  free_cycles          int      default 3
  billing_cycles_unit  str      default "month"
  eligible_plan_ids    JSONB / null             # null = all active paid plans
  max_redemptions      int | null               # null = uncapped (our choice); non-null enables a future capped variant
  redeemed_count       int      default 0
  created_at / updated_at
```

### 5b. `Subscription` columns (audit + lifecycle)
```
promotion_id            FK Promotion, nullable
promo_free_until        datetime tz, nullable    # = start_at; when the first real charge lands
promo_reminder_sent     JSONB default {}         # idempotent reminder cadence, mirrors trial_emails_sent
```

Alembic migration for both. No backfill needed (nullable, additive).

---

## 6. Backend changes (by file)

### 6a. Eligibility resolution — new `promotion_service.py`
- `resolve_active_promotion(session, client, plan) -> Promotion | None`
  - active + `starts_at <= now <= ends_at`
  - `client.created_at <= ends_at` (signed up in window)
  - plan is in `eligible_plan_ids` (or all)
  - client hasn't already redeemed (one per account)
  - if `max_redemptions` set → atomic guarded increment (`UPDATE ... WHERE redeemed_count < max RETURNING`); for the uncapped launch this is a no-op path.
- Mirror `discount_service.resolve_customer_discount_bps`'s shape so `create_checkout` calls it the same way.

### 6b. `create_subscription` (`razorpay_service.py:346`)
- Add `start_at: int | None = None` kwarg → payload (see §3).
- Stamp `notes["oyechats_promotion_id"]` for webhook/audit traceability.

### 6c. `create_checkout` (`subscription_routes.py:1179`)
- After plan resolution and `_assert_no_stacking`, call `promotion_service.resolve_active_promotion`.
- If a promo applies: compute `start_at = add_months(now, promo.free_cycles)`, pass to `create_subscription`, and after commit stamp `Subscription.promotion_id`, `promo_free_until`, increment `Promotion.redeemed_count`.
- **No-stacking:** a promo and a referral %-discount must not combine. Extend `_assert_no_stacking` (or the promo resolver) so a client with a standing referral discount is not also given the free period (pick one — promo wins for a first purchase; document it).

### 6d. Webhooks (`razorpay_service.py`)
- Per §4: ensure the day-1 grant fires on the auth event; ensure the month-4 `subscription.charged` grant stays single (period-keyed idempotency already guarantees this).
- `subscription.charged` at month 4 also = the trigger to clear `promo_free_until` semantics (customer is now a normal paying sub — no code change if we key off dates, but assert the invoice/GST path treats month 4 as the first taxable charge).

### 6e. Reminder emails
- New cron stage (reuse the trial-email cron scaffolding) that, for subs with `promo_free_until` in ~10 days and no `promo_reminder_sent["pre_charge"]`, sends "your free period ends `[date]`, card ending `xxxx` will be charged `[amount]`". Idempotent via `promo_reminder_sent`.
- Reuse `email_service` + Brevo.

---

## 7. Frontend — customer (`platform/app`)
- **Pricing / checkout:** when an active promo applies, show each eligible plan with price struck through → **"Free for 3 months, then ₹X/mo"**, and a countdown to `promo.ends_at`.
- Checkout confirmation copy: "Full `[plan]` access now. First charge `[date]`. Cancel anytime before then."
- `checkout/quote` (`subscription_routes.py:939`) may need a `promo` block in its response so the UI renders the deferred-charge messaging from the server, not hardcoded.

## 8. Super admin (`superadmin` Next.js app)
- **Create/edit campaign:** name, code, window, free_cycles, eligible plans, (optional) max_redemptions.
- **Pause switch:** toggle `is_active` — instant kill without deleting.
- **Dashboard:** redemptions, verified vs card-authorised funnel, projected month-4 revenue, current token-cost exposure.
- New superadmin routes in `api/app/api/superadmin_*` + the Next.js UI.

---

## 9. Guardrails / abuse
- Email verification already required at `/checkout` (`require_verified_email`) — keep as the slot-confirmation wall.
- One active account subscription per client already enforced (`existing_account_sub` 409).
- Add disposable-email-domain block at signup/verification.
- No stacking with referral discounts (§6c).
- Pause switch as the cost circuit-breaker.

## 10. Testing
- **Unit:** `resolve_active_promotion` (window, plan-eligibility, one-per-account, paused, expired).
- **Concurrency:** if `max_redemptions` is used, assert the atomic increment never oversells (fire N concurrent redemptions, exactly max succeed).
- **Webhook:** simulate `authenticated` / `activated` / `charged(month 4)` ordering for a `start_at` sub; assert entitlements granted **once** on day 1 and the real charge grants **once** at month 4 (no double-grant).
- **Integration (staging):** full journey against Razorpay test plan with `start_at = now+10min`: signup → verify → card auth → full access → fast-forward → first real charge.
- **Pre-completion (per CLAUDE.md):** `cd platform/api && uv run ruff check . && uv run ruff format . && uv run pytest`; `cd platform/app && npm run lint && npm run build`.

## 11. Rollout
1. Verify §4 (Razorpay event timing) — blocker.
2. Ship migrations + `promotion_service` + webhook grant, **dark** (no promo rows) → prove no regression on normal checkout.
3. Seat the campaign row via super admin, `is_active = false`.
4. Staging dry-run of the full journey.
5. Flip `is_active = true` for the launch window. Watch the dashboard + token COGS.
6. At window end, `is_active = false`. Existing free-period subs continue to their month-4 charges untouched.

## 12. Open questions (confirm before build)
1. **Free-period length** — 3 calendar months, or 3 billing cycles (identical for monthly, differs if we later allow annual on the offer). Recommend: monthly plans only for the offer, 3 cycles.
2. **Annual plans in the offer?** Recommend excluding — "3 months free" on an annual plan is odd. Restrict `eligible_plan_ids` to monthly.
3. **Referral + promo collision** — confirm promo wins and referral discount is suppressed for that first subscription.
4. **Cancel during free period** — allowed, no charge ever; slot stays consumed. Confirm.
5. **GST/tax** — confirm the month-4 first charge is the first taxable event and `core/tax.py` / invoice path handle a subscription whose first invoice is 3 months after mandate.

---

### One-line summary
Add a `Promotion` config + a `start_at` kwarg on the existing Razorpay subscription builder; entitlements already grant on activation and renew on charge, so the offer is a thin, pausable layer over billing machinery that already exists. The only real risk is Razorpay's event timing with a deferred `start_at` (§4) — verify that first.
