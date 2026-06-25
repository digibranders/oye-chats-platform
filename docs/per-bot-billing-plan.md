# Per-Bot Billing Migration Plan

**Owner:** admin@digibranders.com
**Date:** 2026-06-24
**Status:** Draft — awaiting approval before any code edits

---

## 1. Goal (new model)

- **Plan attaches to the Bot, not the Client.**
- **Free** account → max **1 bot** per account. Adding a 2nd bot hits an upgrade paywall.
- **Paid plans** (Starter / Standard / Enterprise) → **unlimited bots** per account, but **each bot carries its own paid subscription** with **isolated credits**. No pooling, no shared monthly grant.
- **Kill the "+$5 extra bot seat" addon** everywhere.
- **Kill the per-plan bot caps** (`max_bots_cap` 3/5).
- **Grandfather** existing multi-bot customers: their current bots keep working under a "legacy pooled" flag; only *new* bots created after rollout follow the new per-bot model.

---

## 2. Schema changes (`platform/api/app/db/models.py` + Alembic)

### `Bot` (new columns)
| Column | Type | Purpose |
|---|---|---|
| `plan_id` | FK → `plans.id`, nullable | The plan this specific bot is on. `NULL` = legacy pooled bot. |
| `subscription_id` | FK → `subscriptions.id`, nullable | The Stripe/Razorpay subscription funding this bot. |
| `is_legacy_pooled` | Boolean, default `false` | Set `true` on rollout for every existing bot belonging to a multi-bot client. Means credits still come from `Client`-level pool. |
| `credits_balance` | Integer, default `0` | Per-bot credit balance (replaces pooled `CreditLedger` for new bots). |

### `Subscription` (new column)
| Column | Type | Purpose |
|---|---|---|
| `bot_id` | FK → `bots.id`, nullable | Which bot this subscription funds. `NULL` = legacy client-level subscription. |

### `Client` (deprecate, don't drop yet)
- `max_bots` → keep, repurpose as `max_free_bots` (always 1). Drop in a follow-up migration after 60 days.
- `extra_bot_seats` → freeze writes; keep column for legacy reads. Drop in follow-up.

### `Plan` (`Plan.limits` JSONB)
- `bots` → always `1` (a plan funds one bot).
- `max_bots_cap` → **remove from new plan rows**. Loaders default missing key to `1`. Existing legacy plans keep their value for the grandfathered code path.

### `CreditLedger`
- Add nullable `bot_id` FK. New entries (non-legacy) must set it. Legacy entries leave it `NULL` and continue to read at client level.

### Migration file
`alembic/versions/<new>_per_bot_billing.py`
- Adds the columns above.
- One-shot data backfill:
  - For each `client` with `>1` active bot: set `bot.is_legacy_pooled = true` on all their bots, copy the client's `subscription_id` onto each.
  - For each `client` with `==1` bot and an active subscription: set `bot.plan_id` + `bot.subscription_id` from the client; leave `is_legacy_pooled = false`.
  - For each `client` with `==1` bot on Free: leave `plan_id = NULL`, `is_legacy_pooled = false`.

---

## 3. Backend changes

### Delete / gut
- `platform/api/app/services/bot_seat_service.py` — delete the entire bot-seat addon module.
- `platform/api/app/services/razorpay_service.py:150-230` — remove `on_addon_payment_captured()` and bot-seat addon comments.
- `platform/api/app/api/subscription_routes.py:1575-1770` — remove `get_bot_seats`, `change_bot_seats`, `create_bot_seat_checkout`, `verify_bot_seat_payment` endpoints.

### Rewrite
- `platform/api/app/services/plan_entitlements_service.py`
  - Replace client-level `get_entitlements()` with `get_bot_entitlements(bot_id)`.
  - Drop `extra_bot_seats`, `max_bots_cap`, `effective_limit` logic.
  - Add `can_client_add_new_bot(client_id) -> {allowed: bool, reason: str}`:
    - If client has 0 bots → allowed (will become their Free bot).
    - If client has ≥1 bot and no paid subscription → blocked, reason `"upgrade_required"`.
    - If client has ≥1 paid bot → allowed (new bot triggers new per-bot checkout).
- `platform/api/app/services/credit_service.py`
  - `grant_plan_credits(bot_id)` instead of `(client_id)` for non-legacy bots.
  - `reset_monthly_plan_credits(bot_id)` — per-bot billing period.
  - For `bot.is_legacy_pooled = true`: fall back to the existing client-level path unchanged.
  - All credit deductions in `rag_service.py` / chat routes must resolve `bot.is_legacy_pooled` first, then route to bot-level or client-level ledger.
- `platform/api/app/api/bot_routes.py:45-75` `create_bot()`
  - Call `can_client_add_new_bot()`.
  - If client has 0 bots → create as Free, no checkout.
  - If client has ≥1 bot → require a `plan_id` in the request, create the bot in `pending_payment` state, return a checkout URL (Stripe + Razorpay), only activate after webhook confirms.

### New
- `platform/api/app/api/bot_routes.py` — new `POST /bots/{bot_id}/subscribe` to trigger checkout for a pending bot.
- `platform/api/app/services/stripe_service.py` & `razorpay_service.py` — add `create_per_bot_subscription(bot_id, plan_id)` and webhook handlers that write back to `Subscription` + `Bot`.

---

## 4. Admin Dashboard (`platform/app/`)

### Rewrite
- `src/hooks/useEntitlements.js` — drop `extra_bot_seats`, `max_bots_cap`, `effective_bot_limit`. Replace with `useBotEntitlements(botId)` for per-bot info and `useAccountBotState()` for "can I add another bot".
- `src/pages/Billing.jsx`
  - **Delete** `BotSeatsCard` (lines 1293–1439) and the "$5/mo extra bot seat" button + confirm modal (`AddSeatConfirmModal.jsx`).
  - **Add** a "Bots & Subscriptions" section listing each bot with its plan, billing period, credit balance, manage/cancel buttons. Legacy bots show a "Legacy plan" badge and link to the client-level subscription.
- `src/pages/Chatbot.jsx` — "Add Bot" button always enabled; on click, call `can_client_add_new_bot` → if blocked, open new `<AddBotPaywallModal>` that lists Starter/Standard/Enterprise and starts checkout; if allowed, normal create flow.
- `src/components/UpgradeModal.jsx` — reword from "up to X bots" to "1 bot per plan — subscribe again to add more."
- `src/layouts/Sidebar.jsx` — remove "2 / 5 bots" quota; show just bot count.

### New
- `src/components/AddBotPaywallModal.jsx` — plan picker + checkout entry.
- `src/components/billing/PerBotSubscriptionRow.jsx` — one row per bot in Billing.

### Delete
- `src/components/billing/AddSeatConfirmModal.jsx` — bot-seat half (keep operator-seat half if shared; otherwise delete the file).

---

## 5. Landing page (`oyechats-website/`)

- `src/lib/pricing.ts`
  - Line 52: Starter — change `"Up to 3 chatbots (+$5/mo each extra)"` → `"1 chatbot included — add more by subscribing again"`.
  - Line 77: Standard — same treatment.
  - Line 102: Enterprise — keep "Unlimited chatbots" but clarify "unlimited under one master subscription."
  - Lines 174–189 (feature table): drop the "Extra chatbots" row entirely. Update "Chatbots included" to `1 / 1 / 1 / Unlimited`.
- Add a short FAQ entry: "How do I run multiple chatbots? Each chatbot is its own subscription — create another bot in the dashboard and pick a plan for it."
- `src/components/pricing/PricingCards.tsx` — no logic change, will render new copy automatically.

---

## 6. Superadmin (`superadmin/`)
- No required changes (read-only). Optional polish: surface `bot.plan_id` and `bot.is_legacy_pooled` in the client detail view so support can see which bots are grandfathered.

---

## 7. Widget (`platform/widget/`)
- **No changes.** Widget already handles `402 out_of_credits` generically; per-bot credit isolation is invisible to it.

---

## 8. Rollout order (so nothing breaks mid-deploy)

1. **DB migration + data backfill** (`is_legacy_pooled = true` for everyone existing). All current code keeps working because the new fields are nullable and unused.
2. **Backend**: ship dual-path credit + entitlement logic (legacy path unchanged, new path behind feature flag `PER_BOT_BILLING`).
3. **Backend**: ship new `create_bot` paywall logic behind the same flag.
4. **Admin dashboard**: ship new `AddBotPaywallModal` and per-bot billing UI behind the flag.
5. **Landing page**: ship new pricing copy (safe to ship anytime — purely cosmetic).
6. **Flip flag on.** New bots created from this point follow the new model. Existing bots untouched.
7. **Delete bot-seat endpoints + UI** after 7 days of stable operation.
8. **Drop `clients.max_bots` + `clients.extra_bot_seats`** in a follow-up migration after 60 days.

---

## 9. Decisions still needed from you

1. **Pricing for per-bot subscriptions** — same prices as today (Starter $X, Standard $Y) applied per bot? Or a small multi-bot discount (e.g. 2nd bot 20% off) so existing multi-bot customers don't churn when their next bot costs full price?
2. **Legacy bot rename trigger** — if a legacy-pooled customer downgrades or churns, what happens to bots 2..N? Auto-pause? Auto-delete after 30 days? Force them into the new per-bot model?
3. **Stripe + Razorpay product/price IDs** — do I create new "per-bot" Stripe Products, or reuse the existing Plan price IDs and just mint one subscription per bot?
4. **Free bot trial** — keep the existing trial behavior for the single Free bot, or change anything?

---

## 10. Out of scope

- Operator seats — unchanged, still per-account.
- Knowledge base ingestion limits — unchanged.
- Email integrations — unchanged.
- Live chat — unchanged.
- Widget code — unchanged.
