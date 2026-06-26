# Razorpay Plan IDs — by environment

> Razorpay **Test Mode** and **Live Mode** are fully isolated: separate keys, separate plans, separate plan IDs. A plan created in one mode does not exist in the other. Each environment's database stores the plan IDs that match the keys it uses.
>
> - **Local / staging** → `rzp_test_…` keys → **Test plan IDs** (this file, §Test)
> - **Production** → `rzp_live_…` keys → **Live plan IDs** (this file, §Production)
>
> Populate them per-DB with `api/scripts/set_razorpay_plan_ids.py --apply`.

---

## ⚠️ Action required — fix the Annual test plans' billing cycle

In the Test Mode dashboard, **OyeChats Starter Annual** and **OyeChats Standard Annual** were created with a **monthly** billing cycle ("Every Month") instead of **yearly**. As-is, an "annual" subscriber would be charged the full annual amount **every month** (e.g. ₹44,099/month).

**Fix:** Razorpay plans are immutable, so delete/disable these two test plans and recreate them with **Billing Cycle = Yearly (every 1 year)**, then update the test plan IDs below. The amount stays the same (Starter Annual ₹17,299/yr, Standard Annual ₹44,099/yr).

Also note: the **₹1 Test Plan** is **not yet created in Test Mode** (only 5 of 6 plans present). Create it for `RAZORPAY_TEST_PLAN_ID` if you want the ₹1 internal-smoke-test override to work under test keys.

---

## Test Mode plan IDs (`rzp_test_…`)

Created 26 Jun 2026. Use these in the **local / staging** database.

| Plan | Test Plan ID | Amount | Billing cycle | Status |
|------|--------------|--------|---------------|--------|
| Starter Monthly | `plan_T6EREtejBRJucw` | ₹1,799 | Monthly | ✅ correct |
| Starter Annual | `plan_T6ERX5WXBj2kB5` | ₹17,299 | **Monthly** | ⚠️ should be Yearly — recreate |
| Standard Monthly | `plan_T6ERnPJkl1vMhQ` | ₹4,599 | Monthly | ✅ correct |
| Standard Annual | `plan_T6ES55C6QYZ6kf` | ₹44,099 | **Monthly** | ⚠️ should be Yearly — recreate |
| Extra Seat Monthly | `plan_T6ESNBnNqJcgID` | ₹499 | Monthly | ✅ correct |
| Test Plan (₹1) | _not created yet_ | ₹1 | Monthly | ❌ create in Test Mode |

**Apply to local DB** (after fixing the two annual plans):

```bash
cd api && uv run python scripts/set_razorpay_plan_ids.py \
  --starter-monthly  plan_T6EREtejBRJucw \
  --starter-annual   <new-yearly-test-id> \
  --standard-monthly plan_T6ERnPJkl1vMhQ \
  --standard-annual  <new-yearly-test-id> \
  --apply
# then: RAZORPAY_TEST_PLAN_ID=<test-₹1-plan-id> in local .env
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
