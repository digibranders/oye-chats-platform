# OyeChats Payment & Credit System — End-to-End Review Report

> ## ✅ Remediation status — ALL DEFECTS FIXED 2026-06-30
> **Phase 0–2 (verified earlier):** C1, C2 (scope+lock), L1, N2, H1, H2, H3, H4, H5, H6.
> **Defect-remediation pass (this session, commits `a444aa5 → 68e86cf`, full suite 718 passed):** every remaining correctness/security/hardening finding is now fixed, tested, and committed — **C3** (caps/expiry/floor), **C2-precision** (`reference_id` invoice→grant link), **N1, N3, N4, N5, N6, N7**, **L2, L3, L5**, **M1–M8**, **T1/N9**, **M5/N8**, and the six new findings surfaced in the verification pass (**NV1–NV6**). Two additive migrations (`e1c3a5f7b9d2`, `f2d4b6a8c0e1`) verified up/down; single head.
> **Deferred (net-new features, not defects):** **F1** prorated upgrades, **R1** reconciliation cron, **INV-1…INV-10** GST invoicing/tax (incl. the INV-6 frontend currency display bug) — these need design/finance decisions and are tracked separately.
> Full per-finding → commit mapping in the [remediation plan §0a](2026-06-29-remediation-plan.md#0a-defect-remediation-pass--complete-2026-06-30).

**Date:** 2026-06-29 (status updated 2026-06-30)
**Reviewers (roles played):** Senior Software Engineer · Senior QA · CTO
**Scope:** Razorpay (primary, INR) + Stripe (fallback) billing, subscriptions, top-ups, the event-sourced credit ledger, discounts, affiliate/referral, plan entitlements, inbound/outbound webhooks, and the full money lifecycle (quote → checkout → capture → grant → consume → renew → refund → expire).
**Method:** Full reads of the critical files + parallel specialist audits + web research on known Razorpay/payment bug classes. Every "Confirmed" finding below was verified by direct code read; agent-reported items are marked and severity-adjusted for real exploitability.

**Files in scope**
- `api/app/services/credit_service.py` (720)
- `api/app/services/razorpay_service.py` (1419)
- `api/app/services/plan_service.py` (462)
- `api/app/services/plan_entitlements_service.py` (515)
- `api/app/services/discount_service.py` (49)
- `api/app/services/affiliate_service.py` (1309)
- `api/app/api/subscription_routes.py` (1352)
- `api/app/api/webhook_billing_routes.py` (71)
- `api/app/api/webhook_routes.py` (234, outbound)
- `api/app/core/money.py` · `core/pricing.py` · `core/dates.py`
- `api/app/db/models.py` (billing tables)

---

## 1. Executive summary (CTO view)

The system is **architecturally sound** in the places that matter most for a payments system:

- ✅ Webhook **signature verification** is present and fail-closed (HMAC over the **raw** body, per Razorpay's explicit requirement).
- ✅ **Idempotency** is enforced at the DB layer: `processed_webhooks.event_id` (PK), and unique constraints on `razorpay_subscription_id` and `razorpay_payment_id`. The dedup uses the correct atomic `INSERT … ON CONFLICT DO NOTHING` + `rowcount` pattern.
- ✅ Credit mutations take a **per-client/per-bot PG advisory lock**, and the ledger is an immutable signed-delta event store — the right shape for auditable balances.
- ✅ Top-up **credit amounts are bound server-side** to a pricing-config pack (`_match_topup_pack`), so a client cannot inflate the credit count from the browser.

However, there are **revenue-impacting and money-correctness defects** that should block "fully trusted" status until fixed. The three that matter most:

1. **Webhook failures are silently swallowed and ACKed 200** → a paid customer can pay and never receive credits/subscription, with no retry and no dead-letter. *(CRITICAL — Confirmed)*
2. **Refund clawback reverses credits from the wrong grant and the wrong ledger scope** → refunds mis-deduct, and for per-bot ledgers they hit the client pool instead, potentially driving balances negative while leaving the refunded credits intact. *(CRITICAL — Confirmed)*
3. **Affiliate/referral codes have no redemption cap, no expiry, and the customer discount can reach 100%** → a single leaked code is an unbounded discount liability. *(CRITICAL — design gap)*

Plus a systemic **lack of row-level locking on subscription mutation endpoints** (TOCTOU double-grant) and an **entitlement-resolution bug** that can silently downgrade a paying customer's features.

**Recommendation:** Fix the 3 Criticals + locking (Highs) before the next billing-affecting release. None require a schema rewrite; most are localized.

| Severity | Count |
|---|---|
| Critical | 3 |
| High | 6 |
| Medium | 8 |
| Low / hardening | 6 |
| Newly identified (§4b, post-verification) | 9 |

---

> ### ⚙️ Verification pass — 2026-06-29 (follow-up)
> Every finding below was re-checked line-by-line against the current source. Headline corrections:
> - **C3** — 100% discount does **not** mint a ₹0 plan: `resolve_discounted_plan` raises `ValueError` for `bps ≥ 10000` (`razorpay_service.py:418`). The real defect is the **missing minimum-price floor** (9999 bps collapses price to a few paise). The no-cap/no-expiry gap stands.
> - **M3** — the stale FX constant is **display-only**; it cannot reach a charge path (`display_price` has no service/route callers). Reclassified.
> - **M4** — the `(client_id, period_start)` unique index **already exists** (`models.py:993`); there is no double-create. Residual = no `IntegrityError` catch. Reclassified.
> - **L4** — the delivery worker **does** re-resolve DNS and block private ranges at send time (`webhook_service.py:83-93,103`). Original claim withdrawn; only a narrow check→connect TOCTOU remains (see §4b N7).
> - **L6** — `validate_code` does no extra INSERT and is symmetric; the (rate-limited) asymmetry is on `/affiliates/click`. Downgraded.
> - **M8** — the `None → TypeError` 500 is prevented by `operator_quantity` being `nullable=False default=1`; only the negative-value validation gap is real.
> - **C2(b)** — the negative-balance outcome is a consequence of the wrong-pool insert, **not** a missing clamp (the clamp is grant-bounded, not pool-bounded).
> - **Meta:** the "Stripe fallback" provider is **not implemented** — there is no `api/app/services/billing_service.py`. Stripe-specific items in the appendix are forward-looking design notes, not gaps in shipped code (see §4b N4).
> - **9 new findings** added in §4b. Line-number fixes noted inline.

---

## 2. Critical findings

### C1 — Webhook handler swallows all exceptions and returns HTTP 200 → permanent silent loss of paid events
**Location:** `api/app/api/webhook_billing_routes.py:61-69` · **Confirmed** · ✅ **RESOLVED 2026-06-30** (`webhook_billing_routes.py:79-127`: raw-bytes verify → `_dead_letter` to `FailedWebhook` → 5xx when `WEBHOOK_RETRY_ON_ERROR`)

```python
try:
    with get_session() as session:
        result = razorpay_service.handle_webhook_event(session, event, event_id)
        session.commit()
except Exception as exc:
    logger.error("Razorpay webhook processing error ...", exc_info=True)
    return {"status": "error", ...}   # ← HTTP 200
```

**Why it's a bug.** Returning 200 tells Razorpay "delivered — stop retrying." Razorpay's at-least-once delivery + retry is the *only* safety net for a transient failure (DB blip during `grant_topup`, a lock timeout, a deploy mid-request). With a 200 on error:
- The work rolled back (the `get_session()` context rolls back on exception — including the `processed_webhooks` dedup row, which is correct), **but** Razorpay will never re-deliver, so the credits/subscription are lost forever.
- There is **no dead-letter table** persisting the raw event for replay. The "reprocess manually" comment has nothing to reprocess from.

**Impact.** Customer pays → no credits / no subscription / no plan upgrade. Money in, value not delivered. Support ticket, refund, churn.

**Fix.**
- Return **5xx** for genuine processing failures so Razorpay retries (the idempotency layer makes retries safe).
- Continue returning **200** for success *and* for known duplicates (`WebhookReplay`).
- Add a `failed_webhooks` (dead-letter) table that stores the raw signed payload + headers *before* ACKing, so even a 200-on-error path is replayable.
- Separate the dedup-record commit from the handler so a handler failure cannot leave an event marked processed (today the rollback handles this, but make it explicit and test it).

---

### C2 — `clawback_refund` reverses credits from the wrong grant and the wrong ledger scope
**Location:** `api/app/services/credit_service.py:645-720`, called from `razorpay_service.py:1363-1419` · **Confirmed** · ✅ **RESOLVED 2026-06-30 (scope + lock); ⚠️ invoice→grant link deferred** — `clawback_refund` now scopes by `(client_id, bot_id, reason)` and locks the correct pool (`credit_service.py:684-730`), so per-bot refunds land in the right ledger and no pool goes negative. **Residual (tracked C2-precision):** grant selection is still most-recent-of-type, not linked via `reference_id`; refunding the older of two same-bot top-ups claws the newer (NV5 is the period-scope variant). Fix = stamp `reference_id = invoice.id` at grant time and select on it.

Two distinct defects in the same function:

**(a) Picks the most-recent grant, not the grant tied to the refunded invoice.**
```python
grant = session.execute(
    select(CreditLedger).where(
        CreditLedger.client_id == client_id,
        CreditLedger.reason.in_(("plan_grant", "topup")),
        CreditLedger.delta > 0,
    ).order_by(CreditLedger.created_at.desc()).limit(1)
).scalars().first()
```
If a customer buys a subscription (plan_grant) and *then* a top-up, and later refunds the **subscription**, the clawback hits the **top-up** grant (most recent). The refund amount/fraction is scaled against the wrong grant's `delta`.

**(b) Always writes to the client pool — ignores `bot_id`.**
The clawback acquires `_acquire_client_lock(session, client_id)` (bot_id defaults to 0) and inserts a `CreditLedger` row **with no `bot_id`** (→ `NULL` = client pool). But per-bot subscriptions and per-bot top-ups live in the bot's **isolated** ledger. So for any per-bot purchase, the refund:
- writes the negative delta into the **client pool** (wrong bucket),
- leaves the **bot ledger** credits fully intact (refund didn't reverse anything the customer can spend),
- can drive the **client-pool** balance **negative** — note the clamp at `credit_service.py:706-707` (`min(intended, remaining)`) is bounded by the matched *grant's* remaining, **not** the destination pool's balance, so when a per-bot grant is reversed into the client pool the pool can go below zero. (The docstring's "can never drive the balance negative" at `:660-661` is therefore false in this cross-pool case.)

**Impact.** Refunds don't reverse the right credits; per-bot refunds reverse nothing usable; the balance ≥ 0 invariant breaks in the client pool — as a consequence of the wrong-pool insert, not a missing clamp.

**Fix.**
- Add a hard link from invoice → grant (store `grant_id` / `ledger_entry_id` on the `Invoice`, or stamp `reference_id = invoice.id` on the grant) and claw back **that** grant.
- Thread `bot_id` through `clawback_refund` (derive it from the invoice/subscription) so the reversal lands in the same scope as the grant, and lock the correct scope.
- Add an invariant test: post-refund, no ledger scope balance is negative, and the refunded grant's remaining is reduced — not some unrelated grant's.

---

### C3 — Referral codes: no redemption cap, no expiry, and no minimum-price floor
**Location:** `affiliate_service.py` (`_validate_split` 298-324, `attribute_signup`), `discount_service.py:44`, `razorpay_service.py:418,433` · **Verified** (model gap & floor confirmed; "₹0 at 100%" corrected) · ✅ **RESOLVED 2026-06-30** (commit `1027ffe`) — `ReferralCode` gains `max_redemptions`/`redeemed_count`/`valid_until` (migration `e1c3a5f7b9d2`); `attribute_signup` atomically claims a redemption slot (cap+expiry re-checked in the UPDATE, released on race-loss); `_validate_split` caps customer discount at 50% independent of pool; `resolve_discounted_plan` enforces a ₹1 floor.

- **Confirmed — no redemption cap / no expiry.** `ReferralCode` (`models.py:1292-1340`) has **no `max_redemptions`, no `redeemed_count`, no `valid_until`/`expires_at`**. `attribute_signup` enforces only *first-touch per new client* (`affiliate_service.py:275-285`). A leaked code is redeemable by unlimited signups, forever; the only kill switch is `active=False` (all-or-nothing). *(The `max_redemptions`/`valid_until` columns that exist on the unrelated `Coupon` model do not apply to referral codes.)*
- **Confirmed — data layer permits a 100% pool→customer allocation.** `_validate_split` (298-324) permits `customer_discount_bps` up to `MAX_COMMISSION_BPS` (10000) as long as `commission + discount ≤ pool`, and the admin-set pool is DB-capped at 0–10000. `resolve_customer_discount_bps` (`discount_service.py:44`) returns it verbatim.
- **Corrected — 100% does NOT mint a ₹0 plan.** `resolve_discounted_plan` guards `if not (0 < discount_bps < 10000): raise ValueError(...)` (`razorpay_service.py:418`), so a stored 10000 bps raises at checkout → caught at `subscription_routes.py:606-607` → **HTTP 400** (the customer simply can't subscribe; no free plan is created). **The real defect is the missing floor:** `discounted_paise = base − (base × bps)//10000` (`:433`) has no minimum, so `bps = 9999` (~99.99% off) collapses an INR plan to a few paise (e.g. ₹4,599 → ~₹0.46), which Razorpay rejects or treats as effectively free.

**Impact.** Unlimited-redemption liability from a single leaked/abused code (forever, no expiry); and a near-free recurring plan reachable at 9999 bps if an admin sets the pool to 10000 and allocates it all to the customer.

**Fix.**
- Add `max_redemptions` + atomic `redeemed_count` (`UPDATE … WHERE redeemed_count < max_redemptions`) and `expires_at` checked in `validate_code`.
- Cap `customer_discount_bps` at a business max (e.g. 5000) **independent of the pool**, and add an explicit `discounted_paise >= MIN_PLAN_PAISE` floor in `resolve_discounted_plan` (the existing `0 < bps < 10000` guard already blocks exactly 100% but not 9999).

---

## 3. High findings

### H1 — No row-level locking on subscription mutation endpoints (TOCTOU double-grant / provider divergence)
**Location:** `subscription_routes.py` (`change-plan`, `seats`, `cancel`, free-downgrade grant ~701-711); `plan_service.py` trial/default-plan grant · *Confirmed pattern; route specifics agent-reported* · ✅ **MOSTLY RESOLVED 2026-06-30; ⚠️ one gap** — `lock_client_for_billing` (txn-scoped advisory lock) wired into change-plan/cancel-scheduled/cancel/resume/seats (`subscription_routes.py:650,852,891,925,965`) + `start_trial`/`assign_default_plan`. **GAP (NV1, High):** `create_checkout` (`:592`) takes **no** lock → concurrent checkouts double-subscribe. Must finish H1.

Every mutating handler does `get_client_subscription(...)` → mutate → `commit()` with **no `with_for_update()`**. Concurrent requests (double-clicked "Start trial", two seat changes, upgrade+cancel) both read the same row and last-writer-wins:
- **Double credit grant**: two trial/free-downgrade requests both call `reset_monthly_plan_credits` + `grant_for_subscription` → 2× credits. The credit-service advisory lock serializes the *ledger writes* but not the *decision* to grant, so both still grant.
- **Seat drift / double charge**: two `+1` requests both compute `current + 1`, both push to Razorpay; local mirror lands at +1 while provider may be at +2 (or vice-versa).

**Fix.** `SELECT … FOR UPDATE` the subscription (and/or client) row at the top of each mutating handler. Make `grant_for_subscription` idempotent per billing period (key on a period marker so a replay/retry within a period is a no-op).

---

### H2 — `get_client_subscription` resolves account entitlements to the newest-created subscription → silent feature downgrade
**Location:** `plan_service.py:38-49`, consumed by `get_client_plan` (52-71) and `plan_entitlements_service` · **Confirmed** · ✅ **RESOLVED 2026-06-30** — now `ORDER BY Plan.monthly_price_cents DESC, created_at DESC` (inner-joins Plan) at `plan_service.py:72-81`; Standard + later Free bot stays Standard.

```python
.where(Subscription.status.in_(("active","trialing","past_due")))
.order_by(Subscription.created_at.desc()).limit(1)
```
The per-bot model explicitly allows **multiple active subscriptions per client** (confirmed: partial-unique index on `(client_id, bot_id)` where `bot_id IS NOT NULL`, `models.py:938-946`). This collapses them to the **most recently created** one. If a Standard customer later adds a **lower-tier** second-bot subscription (Free or Starter, newer `created_at`), it becomes the account's resolved plan → account-level features (live chat, BANT, limits) **silently downgrade**.

> **Verification note:** the inline comment at `plan_entitlements_service.py:291-293` claims the resolver "returns the most-recent **non-canceled** subscription" — itself inaccurate: the query filters `status IN (active, trialing, past_due)`, so `paused`/`expired` rows are also excluded, not merely canceled ones. The mechanism the finding describes is correct; the code's own comment understates it.

**Fix.** When resolving *account-level* entitlements, pick the **highest-tier** active subscription (order by plan price/rank), not `created_at`. Keep per-bot entitlements scoped to the bot's own subscription.

---

### H3 — `session.commit()` inside `accept_invite_for_existing_client` breaks caller transaction atomicity
**Location:** `affiliate_service.py:1075-1078` · *Agent-reported; pattern high-confidence* · ✅ **RESOLVED 2026-06-30** — consumed-mark now written in a separate `Session(session.get_bind())` (`affiliate_service.py:1069-1083`); caller's txn no longer hijacked. *(Minor follow-up: wrap the side-session in try/except so a side-commit failure still raises the clean `AlreadyAffiliate`.)*

The function calls `session.commit()` then `raise AlreadyAffiliate(...)`. Every other service here uses `flush()` and lets the route own the transaction. Committing mid-service flushes **all** other pending work in the unit-of-work (possibly half-finished), and breaks the "raise → outer rollback" contract.

**Fix.** Never commit inside the service. Use a savepoint (`session.begin_nested()`) for the single row, or restructure so the route commits on the success path.

---

### H4 — `subscription.charged` first-cycle de-dupe is a fragile 24h time-window heuristic
**Location:** `razorpay_service.py:1153-1166` · **Confirmed** · ✅ **RESOLVED 2026-06-30** — 24h heuristic removed; `Subscription.last_granted_period_end` + idempotent `_grant_subscription_period()` (`razorpay_service.py:991-1019`, used at activation `:1139` and charged `:1227`).

```python
is_first_cycle = (
    local.current_period_start is not None and new_period_start is not None
    and abs((new_period_start - local.current_period_start).total_seconds()) < 86400
)
if not is_first_cycle:
    reset + grant
```
This guards against the activation grant + first charged grant double-counting by comparing period starts within 24h. It's brittle:
- If `subscription.activated` is delayed/lost and `subscription.charged` arrives first, `current_period_start` may be unset/equal → the renewal grant for a *real* new cycle could be **skipped**.
- Provider clock skew or a sub whose first cycle legitimately starts ~1 day off the stored value could **double-grant**.

**Fix.** Track the granted period explicitly — store the last-granted `current_period_end` (or a `(subscription_id, period_start)` grant marker) and grant iff the event's period hasn't already been granted. This is deterministic and also fixes ordering/replay edge cases.

---

### H5 — Top-up credit granting depends on `order.paid` carrying notes; `payment.captured` alone is a no-op
**Location:** `razorpay_service.py:1267-1346` (`_handle_payment_captured`) · **Confirmed (behavioral)** · ✅ **RESOLVED 2026-06-30** — `payment.captured` now fetches the order for its notes when absent (`razorpay_service.py:1352-1358`), so top-ups grant without `order.paid`. *(See NV2: still no money-vs-credits reconciliation on the grant.)*

Top-up `notes` (`purpose`, `client_id`, `credits`) are set on the **order** (`order.create`), not the payment. In a `payment.captured` webhook the payload is `payload.payment.entity`, whose `notes` are empty → `purpose != "topup"` → **ignored**. The grant therefore relies on the **`order.paid`** event (which carries the order entity + notes). Both event names map to the same handler, so this is fine **only if `order.paid` is enabled** in the Razorpay dashboard. If it isn't, top-ups capture money and **never credit**.

**Fix.** (1) Ensure `order.paid` is enabled (ops checklist). (2) Make it robust regardless: in `_handle_payment_captured`, when `pay_entity.order_id` is present and notes are empty, **fetch the order** (`rzp.order.fetch`) to read its notes, so `payment.captured` can grant on its own. (3) Add the top-up reconcile-on-verify below (L3). *(Verification note: the handler already has an order-entity fallback at `razorpay_service.py:1276-1280`, but it is dead for a real `payment.captured` envelope, which Razorpay sends without the order entity — so in practice grants still depend on `order.paid`.)*

---

### H6 — No dispute / chargeback handler (`payment.dispute.*` not dispatched)
**Location:** `razorpay_service.py:772-790` (dispatch table) · **Confirmed** · ✅ **RESOLVED 2026-06-30** — `payment.dispute.created` (flag invoice `disputed`), `.lost` (claw via C2 scope, deduped on `dispute_lost:{id}`), `.won` (clear flag) at `razorpay_service.py:796-798,1530-1593`. *(Pairs with still-open N1 `refund.failed` re-grant.)*

The webhook dispatch table handles `subscription.*`, `payment.captured`, `payment.failed`, `order.paid`, `refund.created`, `refund.processed` — but **no `payment.dispute.created` / `.lost` / `.won` / `.closed`**. A dispute event hits `handlers.get(event_name) → None` → `"Unhandled event type"`. So a customer can charge back a top-up or subscription payment and **retain the credits** (unlike `refund.*`, which at least attempts a clawback).

**Fix.** Add `payment.dispute.created` (claw + hold) / `.lost` (finalize) / `.won` (reinstate), reusing the **C2-corrected** clawback (scope + grant link). Depends on C2.

---

## 4. Medium findings

### M1 — Affiliate money split truncates independently and doesn't reconcile to the total
`affiliate_service.py:690, 730-732`. Each of `aff_cents`, `cust_saved_cents`, `platform_cents` uses `int(...)` (truncation); they won't sum to `full_cents`, and `// 12` drops up to 11 cents/yr. **Fix:** round half-up and compute the last bucket as the remainder so the split conserves every cent. **Verified context (severity ↓):** this function feeds the affiliate-dashboard *earnings-estimate display* only — there is **no payout, no `CreditLedger` write, no settlement** anywhere in `affiliate_service.py`. So the non-reconciliation affects displayed estimates, not money actually moved (cosmetic in v1; fix before any real payout ships).

### M2 — `format_amount` uses float equality + Western grouping for INR
`pricing.py:59-60`. `major == int(major)` on a `/100` float is imprecise for large totals; `f"{x:,}"` renders ₹12,34,567 as ₹1,234,567 (no lakh grouping). **Fix:** format from integer minor units (`divmod(minor,100)`); use Indian grouping for INR.

### M3 — Stale hardcoded FX rate (94.67) in the **display** fallback path  *(corrected: display-only, not a charge path)*
`pricing.py:25,46` (and `config.py:218` `DISPLAY_USD_TO_INR`). The module docstring claims "no live FX in the charge or display path," yet a NULL-USD legacy plan converts INR at a frozen constant in `display_price`. **Verified:** `display_price` has **no service/route callers** and `razorpay_service` never imports it — the constant is surfaced only via `GET /billing/geo` (`subscription_routes.py:315`) for *informational display*. It **cannot affect a captured amount**; the original "charge path" framing is withdrawn. Residual: a legacy NULL-USD plan shown to a non-Indian visitor displays a stale-rate USD figure that may not match the INR charge. **Fix:** treat NULL USD on a paid plan as a config error (block + alert) and update the docstring (FX *is* present, just static and display-only).

### M4 — `UsageRecord` creation: unique constraint **exists**, but no `IntegrityError` catch  *(corrected: not a double-create)*
`plan_service.py:160-209` (`get_or_create_usage_record`; the original `180-185` was the period-boundary math, not the INSERT). **Verified:** the `(client_id, period_start)` unique index **already exists** — `Index("ix_usage_records_client_period", "client_id", "period_start", unique=True)` at `models.py:993` — so a concurrent double-create is **blocked at the DB layer** (no silent duplicate). The real residual defect: there is **no `IntegrityError` catch** around the flush (`:207-208`), so the losing request of a genuine race gets an unhandled 500 instead of re-fetching the existing row. **Fix:** wrap the insert in `try/except IntegrityError` → re-`SELECT` the existing row.

### M5 — `add_months` preserves wall-clock tzinfo across DST boundaries
`dates.py:53-58`. Generic helper used for billing periods/top-up expiry; for DST zones, copying `tzinfo` shifts the real UTC instant and can produce a non-existent local time (spring-forward) with no `fold` handling. INR/IST has no DST so today it's latent. **Fix:** do period math in UTC, or normalize with `zoneinfo` + `fold`.

### M6 — `leads` usage counter ignores the billing period
`plan_entitlements_service.py:504-510`. Docstring says "this period"; query counts **all** leads ever. Latent because Free sets leads unlimited, but any finite-leads paid plan would mis-gate on lifetime totals. **Fix:** add `LeadInfo.created_at >= period_start`.

### M7 — `documents` quota classified by `document_name LIKE 'http%'`
`plan_entitlements_service.py:492-499`. A file named `https-notes.pdf` is silently excluded from the documents quota; a crawl page named oddly gets counted as an upload. **Fix:** add an explicit `source` column instead of string-sniffing.

### M8 — Superadmin revenue/plan endpoints: unbounded negative inputs  *(corrected: None→500 not reachable)*
`superadmin_plan_routes.py:291-300` (override setters), `:333,:335` (MRR math). **Corrected:** the `None → TypeError` 500 is **not reachable** — `Subscription.operator_quantity` is `nullable=False, default=1, server_default="1"` (`models.py:846`), so a persisted row can't be NULL. **Confirmed real gap:** `update_subscription` writes `operator_quantity` (`:291-292`, bare `int | None`, no `ge=`) and `extend_trial_days` (`:297-300`, bare `int | None`) verbatim — a negative `operator_quantity` yields negative MRR at `:333/:335`, and a negative `extend_trial_days` silently shortens/back-dates the trial. **Fix:** add `ge=0`/range bounds on the request schema and round (not floor) MRR.

---

## 4b. Newly identified findings (post-verification)

Surfaced while verifying the above against current source. IDs are `N#`.

### N1 — No `refund.failed` reversal → initiated-then-failed refund permanently strips credits  · 🟠 High
`razorpay_service.py:772-790,1374-1378`. `refund.created` claws back credits on *initiation*, but there is **no `refund.failed` handler** to re-grant if the refund is later rejected/reversed by the gateway. Combined with H6, the refund/dispute lifecycle is only half-modeled (claw on initiate, never restore). **Fix:** add `refund.failed` (re-grant the clawed amount) and only finalize on `refund.processed`.

### N2 — Double-clawback when a new grant lands between `refund.created` and `refund.processed`  · 🟡 Medium · ✅ **RESOLVED 2026-06-30** (`razorpay_service.py:1475-1477` dedups on `refund:{refund_id}`)
`razorpay_service.py:788-789` routes both `refund.created` and `refund.processed` to the same handler; they carry **different `x-razorpay-event-id`s**, so both pass event-id dedup. Because the clawback target is "newest positive grant" (C2a), if a renewal/top-up grant is created between the two refund events, the second event claws a **different (newer) grant** → double reversal. **Fix:** ties to C2 — claw the invoice-linked grant idempotently (key on refund id), so repeated refund events for one refund are a no-op.

### N3 — `cancel` / `resume` / `seats` target the wrong subscription under the per-bot model  · 🟠 High (functional)
`subscription_routes.py:883` (`cancel`), `:916` (`resume`), `:955` (`change_seat_count`) all resolve via `get_client_subscription` (newest active only) with **no `bot_id`/`subscription_id` parameter**. A client with multiple per-bot subscriptions can only ever act on the most-recently-created one — they **cannot cancel the older bot's subscription**, and the action silently hits the wrong row. This is a gap created by the per-bot migration that `/credits/balance` (which iterates bots, `:1061-1097`) was updated for but the mutation endpoints were not. **Fix:** accept and require a `bot_id`/`subscription_id`, resolve the specific row, and lock it (ties to H1).

### N4 — "Stripe fallback" billing provider is not implemented  · 🟠 High (correctness of the model + docs)
There is **no `api/app/services/billing_service.py`** (referenced by `discount_service.py:5-9` and by `CLAUDE.md`'s Key-Files table). Consequences: (a) a customer attributed to a referral discount who checks out on the *Stripe* path gets `discount_bps` resolved but **no provider applies it** — the discount is silently dropped; `subscription_routes.py:601` resolves the discount unconditionally regardless of provider. (b) All Stripe-specific recommendations in the appendix (dispute events, `Idempotency-Key`, Stripe refund timing) are **forward-looking design notes, not gaps in shipped code**. **Fix:** either implement the Stripe path or gate discount resolution + the "Stripe fallback" claim behind a real provider check, and correct the CLAUDE.md reference.

### N5 — `create_plan` reads `Plan.limits.default.arg` as an INSERT default  · 🟡 Medium
`superadmin_plan_routes.py:139-140`: `limits=request.limits or Plan.limits.default.arg`. This reaches into the SQLAlchemy `Column.default` internals; if the column default is a callable (`default=dict`) or a `server_default`, `.default` is `None` → `None.arg` raises `AttributeError` (500), or a callable is stored verbatim instead of being invoked. **Fix:** use an explicit literal (`request.limits or {}`). *(Also dead code at `:126` — a discarded `SELECT` duplicated by the loop on `:127`.)*

### N6 — `ReferralConversion.affiliate_id` hard-coded `None`  · 🔵 Low
`subscription_routes.py:610-618` writes the conversion snapshot with `affiliate_id=None` even though it is derivable from `disc_meta["referral_code_id"]`. The model comment (`models.py:1444-1447`) says these rows exist to immortalize the affiliate↔conversion link for payout; storing `None` means future payout reconciliation can't attribute conversions without re-joining the mutable/renameable code row. **Fix:** populate `affiliate_id` at write time.

### N7 — Residual outbound-SSRF TOCTOU between the DNS check and `urlopen`  · 🔵 Low
`webhook_service.py:90` (`getaddrinfo` via `_is_public_hostname`) and the subsequent `urllib.request.urlopen` (`:150`) perform **independent** DNS resolutions. A short-TTL hostname can return a public IP to the check and a private IP to `urlopen` microseconds later. (Narrower than the withdrawn L4 — the create→deliver window is already closed.) **Fix:** resolve once to a pinned public IP and connect to that IP with Host/SNI preserved.

### N8 — `add_months` anniversary drift if billing rolls from prior period-end  · 🔵 Low
`dates.py:58` clamps with `min(dt.day, last_of_month)`. If period rolls call `add_months(prev_period_end, 1)` rather than re-deriving from the original anchor, a Jan-31 anchor ratchets to Feb-28 → Mar-28 → … and never recovers. **Fix:** confirm callers pass the original anchor; otherwise carry the anchor day separately.

### N9 — Ingestion writes naive `ingest_date` while the app is aware-UTC  · 🔵 Low (extends T1)
`ingestion/pipeline.py:168,345` write `datetime.utcnow().isoformat()` (no offset) into chunk metadata, while every DB `timestamptz` / `datetime.now(UTC).isoformat()` carries `+00:00`. Any consumer comparing these aware-vs-naive hits `TypeError`. `:530,551` use server-local `datetime.now()` for filenames. **Fix:** `datetime.now(UTC)` everywhere (folds into T1).

---

## 4c. Newly identified findings (2026-06-30 verification pass) — ✅ ALL FIXED

Surfaced while verifying the Phase 0–2 fixes; all six were fixed in the same-day defect-remediation pass (commits `a444aa5`, `b521ffd`, `fdba33e`). Status per finding: **NV1** ✅ (`a444aa5`), **NV2** ✅ (`a444aa5`), **NV3** ✅ (`b521ffd`), **NV4** ✅ (`1027ffe`), **NV5** ✅ (`fdba33e`), **NV6** ✅ (`b521ffd`). IDs are `NV#`.

### NV1 — `create_checkout` is the one mutating money endpoint with no billing lock · 🟠 High
`subscription_routes.py:592`. Every other mutation (`change-plan`, `cancel`, `resume`, `seats`, `start_trial`) acquires `lock_client_for_billing`, but `create_checkout` does not. Two concurrent/double-clicked checkouts both create a Razorpay subscription **and** insert a `ReferralConversion` row → duplicate subscription + duplicate affiliate attribution for one client. **This is the unfinished tail of H1.** **Fix:** `lock_client_for_billing(session, client.id)` as the first statement inside the `with get_session()` block.

### NV2 — Top-up grant trusts `notes["credits"]`, never reconciles against captured amount · 🟠 High
`razorpay_service.py:1367,1383-1412`. The grant reads `credits`/`amount_inr` straight from order notes and grants them without asserting the captured `payment.amount` (paise) matches the pack price. Notes are server-set at `create_topup_order` today, so it's not directly exploitable — but there is zero defense-in-depth: any future order-create path or a mismatched note grants credits regardless of money received. **Fix:** assert `amount_paise == pack_price_paise` (modulo the documented test override) before granting; reject on mismatch.

### NV3 — `get_plan_limit` fail-opens to UNLIMITED on an unknown metric · 🟡 Medium (security-adjacent)
`plan_service.py:107-113` returns `UNLIMITED (-1)` for an unrecognized metric while `PlanEntitlements.limit_for` (`plan_entitlements_service.py:161-176`) fail-closes to `0`. A typo'd or renamed metric name silently grants unlimited quota through the `plan_service` gate. **Fix:** make both deny-by-default (return 0) for unknown metrics.

### NV4 — Magic-link-invited affiliates land with a 0% commission pool · 🟡 Medium
`affiliate_service.py:923-929,1016-1020,1093-1097`. `commission_bps` is set on the `Affiliate` only on the direct path; `AffiliateInvite` never captures it, so both accept paths create the affiliate with `commission_bps = 0`. Every earning split then fails `_validate_split` against a 0 pool — an invited affiliate can't create a single earning code. **Fix:** persist `commission_bps` on `AffiliateInvite` and thread it through both accept paths.

### NV5 — Refund of an old invoice claws the current period's `plan_grant` · 🟡 Medium
`credit_service.py:651-653,717`. `clawback_refund` selects the most-recent `plan_grant` in the pool with no period scoping, so refunding an old subscription invoice reverses the **current** month's credits. The period-scoped variant of the C2(a) residual; folds into the same `reference_id`-link precision fix.

### NV6 — `get_or_create_usage_record` resolves the period non-deterministically · 🟡 Medium
`plan_service.py:178-190`. Under the multi-subscription per-bot model, two active subscriptions can both satisfy `period_start <= now < period_end`; the query is `.limit(1)` with **no `ORDER BY`**, so it returns an arbitrary period row. **Fix:** add a deterministic `ORDER BY period_start DESC` and/or scope usage records per subscription. *(Also still open here: M4 — no `IntegrityError` catch around the insert.)*

### NV-misc — Low-severity cleanups found this pass
- Dead code: `_resolve_referral_discount` (`subscription_routes.py:1233-1259`) superseded by `discount_service` — and the two disagree on the active-code check. Remove it.
- `FailedWebhook.headers` column is defined but never populated by `_dead_letter` (`webhook_billing_routes.py:36-45`) → debug context lost; replay still works off raw payload.
- `delete_affiliate` reads `aff.client_id` **after** `session.delete(aff)` (`affiliate_service.py:1311-1315`) → possible `DetachedInstanceError`.
- `leads`/`operators` usage counters diverge between the live entitlements view (`is_active` filtered) and the persisted snapshot (unfiltered) — and `leads` still counts lifetime, not period (M6).
- N2 refund dedup is skipped when `refund_entity["id"]` is falsy — reject such refunds rather than processing un-deduped.

---

## 5. Low / hardening

- **L1 — Pass raw bytes to the SDK in `verify_webhook_signature`** (`razorpay_service.py:705-706`). · ✅ **RESOLVED 2026-06-30** — HMAC computed over raw `bytes` with `hmac.compare_digest` (`razorpay_service.py:711-713`). It currently `.decode("utf-8")`s before the SDK re-encodes. For valid-UTF-8 JSON this round-trips losslessly, so it is **not an exploitable bypass today**, but pass `bytes` directly (or compute HMAC manually with `hmac.compare_digest`) to remove the edge case. *(Downgraded from an agent's "Critical" — verified non-exploitable for normal payloads.)*
- **L2 — Reconcile-on-verify defense-in-depth** (`subscription_routes.py` verify endpoint): assert `notes.oyechats_client_id == caller.id` before upserting. The Razorpay signature already gates this (an attacker can't forge `HMAC(payment|subscription, secret)`), so it's hardening, not an open hole.
- **L3 — Add an idempotent top-up reconcile-on-verify** mirroring `reconcile_subscription_from_razorpay`, so a dropped top-up webhook still credits when the browser calls `/credits/topup/verify`. Compounds C1/H5.
- **L4 — Outbound webhook SSRF re-validation — ~~missing~~ already present** *(corrected)*. Original claim ("delivery worker does not re-validate") is **withdrawn**: `_deliver_webhook` calls `_is_safe_webhook_url` (`webhook_service.py:103`, docstring "Re-validate webhook URL at delivery time to block DNS rebinding SSRF") which runs a **fresh `getaddrinfo`** and blocks private/loopback/link-local at send time. The create→deliver rebind window is closed. Only a narrow residual remains (see §4b **N7**: TOCTOU between the `getaddrinfo` check and `urlopen`'s own resolution).
- **L5 — Alert on event-id-less webhooks** (`razorpay_service.py:732-734` rejects them — correct fail-closed, but a dashboard misconfig would silently drop all billing). Add monitoring.
- **L6 — timing oracle — mis-attributed & mitigated** *(corrected)*. `validate_code` (`affiliate_service.py:183-198`) does **no** extra INSERT and is symmetric on hit/miss (always 200 `{valid: bool}`). The extra-INSERT asymmetry is on a **different** endpoint, `/affiliates/click` → `record_click` (valid → `ReferralClick` insert; invalid → early return) — and both endpoints are **rate-limited** (`affiliate_routes.py:309,329`) and always return 204. Net: a marginal, noisy oracle on `/click`, not `/validate`. Low priority; equalize work on `/click` if desired.

---

## 6. Known payment bug classes — research checklist & how this codebase fares

| Bug class (industry) | Status here |
|---|---|
| Webhook signature over parsed (not raw) body | ✅ Raw body used (L1 is a cosmetic decode round-trip) |
| Non-timing-safe signature compare | ✅ SDK uses `hmac.compare_digest`; keep it if you hand-roll (L1) |
| Webhook replay / duplicate delivery | ✅ `processed_webhooks` PK + `ON CONFLICT` atomic dedup |
| Out-of-order events (charged before activated) | ⚠️ Partially — H4 time-window heuristic is fragile |
| Lost webhook → no retry / no DLQ | ❌ **C1** (200-on-error, no dead-letter) |
| Trusting client amount/credits | ✅ Credits bound to server pack; amounts in paise server-side |
| Amount/currency tampering | ✅ Razorpay rejects non-INR; pack matched server-side. ⚠️ quote(USD) vs charge(INR) mismatch — verify quote == charge |
| Double-credit race (concurrent grant) | ⚠️ Ledger writes locked, but **decision** to grant isn't — **H1** |
| Float money / paise rounding | ✅ Integer paise in core paths; ⚠️ M1/M2 display+split rounding |
| Refund not reversing credits / wrong scope | ❌ **C2** (+ **N1** no `refund.failed` re-grant, **N2** double-clawback) |
| Coupon reuse / stacking / no cap / 100% off | ⚠️ **C3** — no cap/expiry (real); exact 100% is rejected, but no min-price floor (9999 bps ≈ free) |
| Dispute / chargeback reverses credits | ❌ **H6** — no `payment.dispute.*` handler |
| Affiliate self-referral / pre-settlement credit | ⚠️ self-referral guard ineffective (C3 notes); commission is v2/not-yet-paid |
| IDOR on subscription/order endpoints | ✅ Responses client-scoped; ⚠️ add notes==caller assert (L2) |
| Subscription lifecycle (halted/past_due/grace) | ✅ `past_due_since` anchor + idempotent `_enter_past_due` |
| Timezone / billing-period math | ⚠️ M5 (DST), M6 (period filter) |
| Trial abuse / double trial | ⚠️ H1 (no lock on trial grant) |

**Verified Razorpay specifics (from razorpay.com/docs):** webhook header `X-Razorpay-Signature` = HMAC-SHA256 of the **raw body** keyed with the **webhook secret** ("Do not parse or cast the webhook request body"); payment callback `generated_signature = HMAC_SHA256(order_id + "|" + payment_id, key_secret)`; subscription callback uses `payment_id + "|" + subscription_id`; amounts are in the currency subunit (paise); events may arrive out of order; dedupe on `x-razorpay-event-id`; on secret rotation use the old secret while retries drain.

---

## 7. QA test plan (the cases this system must pass)

**Webhooks / idempotency**
1. Same event delivered twice (same `event_id`) → credits granted exactly once.
2. `payment.captured` **and** `order.paid` for one top-up → credited once (Invoice unique guard).
3. Handler raises mid-processing → returns 5xx, dedup row **not** persisted, Razorpay retry succeeds (after C1 fix).
4. Tampered signature → 400, no state change.
5. `subscription.charged` arrives before `subscription.activated` (out of order) → exactly one grant per period (after H4 fix).

**Credits / money**
6. Concurrent ×2 "start trial" / "free downgrade" → single grant (after H1 fix).
7. Refund a **subscription** while a **top-up** also exists → the subscription grant is clawed, top-up untouched (after C2 fix).
8. Refund a **per-bot** top-up → reversal lands in the **bot** ledger; no scope goes negative (after C2 fix).
9. Partial refund (50%) → ~50% of the *unconsumed* grant clawed, never below zero.
10. Concurrent chat deductions at low balance → never oversell (advisory lock holds).
11. Monthly reset → unused plan credits expire; balance breakdown matches raw `SUM(delta)`.

**Discounts / affiliate**
12. Code with `max_redemptions=N` → (N+1)th signup rejected; concurrent redemptions don't exceed N (after C3 fix).
13. Expired code → rejected.
14. Customer discount cannot drive plan price to ≤ 0 (after C3 fix).
15. Commission split sums exactly to `full_cents` (after M1 fix).

**Entitlements**
16. Standard customer adds a Free second bot → account features stay Standard (after H2 fix).

---

## 8. Prioritized remediation

> **Full phase-wise execution plan:** [`2026-06-29-remediation-plan.md`](2026-06-29-remediation-plan.md) — consolidates every finding below (plus the prorated-upgrades feature and timezone fixes) into a dependency-ordered, 8-phase plan with acceptance criteria, tests, flags, and rollback.


**✅ Done — ALL defects (Phase 0–2 + the 2026-06-30 defect-remediation pass):** C1, C2 (+`reference_id` precision), C3, L1, L2, L3, L5, N1–N9, M1–M8, T1, H1–H6, NV1–NV6 — fixed, tested (718 passed), committed (`a444aa5 → 68e86cf`). Per-finding → commit table in the [remediation plan §0a](2026-06-29-remediation-plan.md#0a-defect-remediation-pass--complete-2026-06-30).

**🔜 Remaining — net-new feature tracks only (deferred; need design/finance decisions):**
1. **F1** prorated upgrades · **R1** reconciliation cron · **INV-1…10** GST invoicing/tax (incl. the INV-6 frontend currency-display fix).

<details><summary>Original priority-ordered plan (now all complete)</summary>

1. **NV1** — add the missing `lock_client_for_billing` to `create_checkout` *(finishes H1; cheap, High)*.
2. **NV2** — reconcile top-up credits vs captured amount before granting *(defense-in-depth, High)*.
3. **C3** — add `max_redemptions`/`redeemed_count`/`expires_at` to `ReferralCode` + min-price floor + business cap on customer discount *(only remaining Critical)*.
4. **N1, N3** — `refund.failed` re-grant; per-bot targeting (`bot_id`) on cancel/resume/seats.
5. **C2-precision / NV5** — stamp `reference_id = invoice.id` at grant time, select on it (kills the wrong-grant clawback and period mis-attribution).
6. **L2, L3** — assert `notes.client_id == caller` on reconcile-on-verify; add idempotent top-up reconcile.
7. **NV3, NV4, NV6** — fail-closed `get_plan_limit`; affiliate `commission_bps` propagation; deterministic usage-record period.
8. **N4, N5, N6** — gate discount behind live provider; `create_plan` literal defaults; populate `ReferralConversion.affiliate_id`.
9. **Mediums** — money formatting/rounding (M1, M2), usage-period filters (M4, M6, M7), superadmin bounds (M8), FX (M3).
10. **Time hardening** — M5/N8 `add_months` DST + anchor drift; T1/N9 naive datetimes.
11. **Hardening** — N7 SSRF TOCTOU, L5 alerting, NV-misc cleanups.
12. **Features (separate tracks):** F1 prorated upgrades; R1 settlement reconciliation; INV-1…INV-10 invoicing/tax.

</details>

### Related design doc — prorated upgrades
The mid-cycle upgrade flow (e.g. Starter $19 → Standard $49) today charges the **full** new-plan price with no monetary proration, restarts the billing anchor, only rolls over credits, shows misleading "your unused time will be credited" copy, and cancels the old mandate before the new payment is confirmed (ties to H1/H2). The industry-standard fix — bill only the prorated difference, preserve the anchor, flip entitlements on capture, and make the checkout abandonment-safe — is specified in [`2026-06-29-prorated-upgrades-design.md`](2026-06-29-prorated-upgrades-design.md) (Option A). It depends on the **C2** and **H1** fixes landing first.

---

*No code was modified for this review; it is read-only. **Every finding was verified line-by-line against the current source in a follow-up pass (2026-06-29)** — see the verification banner in §1 and the corrected verdicts inline (M3/M4/L4/L6 reclassified, C3/C2b/H2/H5/M1/M8 refined) plus 9 new findings in §4b. The one item still requiring external confirmation is whether `order.paid` is enabled in the live Razorpay dashboard (H5).*
