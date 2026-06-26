# Razorpay Plan IDs — by environment

> Razorpay **Test Mode** and **Live Mode** are fully isolated: separate keys, separate plans, separate plan IDs. A plan created in one mode does not exist in the other. Each environment's database stores the plan IDs that match the keys it uses.
>
> - **Local / staging** → `rzp_test_…` keys → **Test plan IDs** (this file, §Test)
> - **Production** → `rzp_live_…` keys → **Live plan IDs** (this file, §Production)
>
> Populate them per-DB with `api/scripts/set_razorpay_plan_ids.py --apply`.

---

## ⚠️ Duplicate test plans exist — use Batch A, ignore Batch B

The Test Mode dashboard contains **two batches** of plans (Razorpay plans are immutable and **cannot be deleted or edited**, so duplicates are permanent — harmless as long as the wrong IDs are never referenced):

- **Batch A** (created ~04:13–04:14, `T6EO…`) — ✅ **canonical**. Annual plans are correctly **"Every Year"**.
- **Batch B** (created ~04:16–04:17, `T6ER/T6ES…`) — ❌ **defective duplicate**. Its two Annual plans were created as **"Every Month"** (would charge the annual amount monthly). **Do not use.**

The local DB is wired to **Batch A**. There is nothing to fix in Razorpay — the correct annual plans already exist.

Outstanding: the **₹1 Test Plan** is not created in Test Mode. Create it (Monthly, ₹1) only if you want the `RAZORPAY_TEST_PLAN_ID` ₹1 internal-override to work under test keys.

---

## Test Mode plan IDs (`rzp_test_…`) — Batch A (canonical)

Use these in the **local / staging** database. Currently wired in the local DB.

| Plan | Test Plan ID | Amount | Billing cycle |
|------|--------------|--------|---------------|
| Starter Monthly | `plan_T6EODsEtLr87wb` | ₹1,799 | Monthly ✓ |
| Starter Annual | `plan_T6EOE2v4XH5imU` | ₹17,299 | **Yearly** ✓ |
| Standard Monthly | `plan_T6EOEE8VVc2P6I` | ₹4,599 | Monthly ✓ |
| Standard Annual | `plan_T6EOEQRzgM5Mkz` | ₹44,099 | **Yearly** ✓ |
| Extra Seat Monthly | `plan_T6EOSLrKfQQrFU` | ₹499 | Monthly ✓ |
| Test Plan (₹1) | _not created yet_ | ₹1 | Monthly |

> **Ignore (Batch B, defective):** `plan_T6EREtejBRJucw`, `plan_T6ERX5WXBj2kB5` (annual=monthly ✗), `plan_T6ERnPJkl1vMhQ`, `plan_T6ES55C6QYZ6kf` (annual=monthly ✗), `plan_T6ESNBnNqJcgID`.

**Apply to local DB** (already done):

```bash
cd api && uv run python scripts/set_razorpay_plan_ids.py \
  --starter-monthly  plan_T6EODsEtLr87wb \
  --starter-annual   plan_T6EOE2v4XH5imU \
  --standard-monthly plan_T6EOEE8VVc2P6I \
  --standard-annual  plan_T6EOEQRzgM5Mkz \
  --apply
# then (optional): RAZORPAY_TEST_PLAN_ID=<test-₹1-plan-id> in local .env
```

---

## Production plan IDs (`rzp_live_…`) — LIVE / REAL MONEY

Created 25 Jun 2026. Use these in the **production** database only. **Real charges.**

| Plan | Live Plan ID | Amount | Billing cycle |
|------|--------------|--------|---------------|
| Starter Monthly | `plan_T5rJrWjfvN3Fk1` | ₹1,799 | Monthly |
| Starter Annual | `plan_T5rLP2lT30ZQuv` | ₹17,299 | Yearly |
| Standard Monthly | `plan_T5rLzlUCdXWQoD` | ₹4,599 | Monthly |
| Standard Annual | `plan_T5rMa0eevGsFPm` | ₹44,099 | Yearly |
| Extra Seat Monthly | `plan_T5rNFpt3vSkl4R` | ₹499 | Monthly |
| Test Plan (₹1) | `plan_T5rNgByd3zStZx` | ₹1 | Monthly |

> The live "Test Plan" (₹1) charges a **real** ₹1 — it exists for `CHECKOUT_TEST_CLIENT_IDS` to run a final production smoke test (a real ₹1 charge you can refund), **not** for development. Verify the live Annual plans show **Yearly** (they did at creation — confirm before go-live).

**Apply to production DB** (requires explicit approval; prod write):

```bash
cd api && uv run python scripts/set_razorpay_plan_ids.py \
  --starter-monthly  plan_T5rJrWjfvN3Fk1 \
  --starter-annual   plan_T5rLP2lT30ZQuv \
  --standard-monthly plan_T5rLzlUCdXWQoD \
  --standard-annual  plan_T5rMa0eevGsFPm \
  --apply
# then: RAZORPAY_TEST_PLAN_ID=plan_T5rNgByd3zStZx in production .env
```

---

## Notes

- The **Extra Seat** plan id is wired into the seat add-on flow (Phase 1 Task 1.4), not the per-plan `razorpay_plan_id_*` columns. Track it per environment here; the seat-addon code reads it from config/constant.
- When **re-pricing** (quarterly), new plans are minted in **both** modes and these tables updated. Plans are immutable — never edit an existing plan's amount.
- Discounted plans (affiliate/coupon) are **auto-created via API** per environment and cached in `discounted_plan_cache` — they are not listed here and never created by hand.
