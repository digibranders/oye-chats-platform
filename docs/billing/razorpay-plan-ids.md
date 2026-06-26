# Razorpay Plan IDs — Canonical Reference

**Single source of truth** for which Razorpay plan IDs are wired into each environment.
Last verified: **26 Jun 2026.**

> **Test Mode and Live Mode are fully isolated** — separate keys, separate plans, separate IDs.
> A plan created in one mode does not exist in the other, and you cannot tell test vs live from
> the `plan_…` string alone (only from the dashboard mode toggle). Each environment's database
> stores the plan IDs that match the API keys it uses:
>
> | Environment | API keys | Plan IDs to use |
> |---|---|---|
> | Local / staging | `rzp_test_…` | **Test Mode — Batch A** (below) |
> | Production | `rzp_live_…` | **Live Mode** (below) |
>
> Plans are **immutable**: they cannot be edited or deleted. To change an amount or billing
> cycle you create a NEW plan and re-point the DB. Wrong/duplicate plans are harmless as long
> as their IDs are never referenced.

---

## ✅ In-use IDs (quick reference)

These are the only IDs that should be wired into the application.

| Plan | Amount | Cycle | **Test** (`rzp_test_`) | **Live** (`rzp_live_`) |
|------|--------|-------|------------------------|------------------------|
| Starter Monthly | ₹1,799 | Monthly | `plan_T6EODsEtLr87wb` | `plan_T5rJrWjfvN3Fk1` |
| Starter Annual | ₹17,299 | Yearly | `plan_T6EOE2v4XH5imU` | `plan_T5rLP2lT30ZQuv` |
| Standard Monthly | ₹4,599 | Monthly | `plan_T6EOEE8VVc2P6I` | `plan_T5rLzlUCdXWQoD` |
| Standard Annual | ₹44,099 | Yearly | `plan_T6EOEQRzgM5Mkz` | `plan_T5rMa0eevGsFPm` |
| Extra Seat Monthly | ₹499 | Monthly | `plan_T6EOSLrKfQQrFU` | `plan_T5rNFpt3vSkl4R` |
| Test Plan (₹1) | ₹1 | Monthly | _not created_ | `plan_T5rNgByd3zStZx` |

**Wiring status**
- Local DB → Test Batch A: **wired ✓** (Starter + Standard monthly/annual). Extra Seat is read by the seat-addon code, not the `razorpay_plan_id_*` columns.
- Production DB → Live: **pending** (run the apply command in §Production when ready).

---

## Test Mode inventory (`rzp_test_…`)

The Test dashboard contains **two batches** (duplicates are permanent — Razorpay can't delete plans).

### Batch A — canonical ✅ (created ~04:13–04:14, 26 Jun 2026)

| Plan | Plan ID | Amount | Cycle |
|------|---------|--------|-------|
| Starter Monthly | `plan_T6EODsEtLr87wb` | ₹1,799 | Monthly ✓ |
| Starter Annual | `plan_T6EOE2v4XH5imU` | ₹17,299 | **Yearly** ✓ |
| Standard Monthly | `plan_T6EOEE8VVc2P6I` | ₹4,599 | Monthly ✓ |
| Standard Annual | `plan_T6EOEQRzgM5Mkz` | ₹44,099 | **Yearly** ✓ |
| Extra Seat Monthly | `plan_T6EOSLrKfQQrFU` | ₹499 | Monthly ✓ |

### Batch B — DO NOT USE ❌ (created ~04:16–04:17, 26 Jun 2026)

Defective duplicate: both Annual plans were created with a **monthly** cycle (would bill the
annual amount every month). Cannot be deleted — just never reference these IDs.

| Plan | Plan ID | Amount | Cycle |
|------|---------|--------|-------|
| Starter Monthly | `plan_T6EREtejBRJucw` | ₹1,799 | Monthly |
| Starter Annual | `plan_T6ERX5WXBj2kB5` | ₹17,299 | **Monthly ✗** |
| Standard Monthly | `plan_T6ERnPJkl1vMhQ` | ₹4,599 | Monthly |
| Standard Annual | `plan_T6ES55C6QYZ6kf` | ₹44,099 | **Monthly ✗** |
| Extra Seat Monthly | `plan_T6ESNBnNqJcgID` | ₹499 | Monthly |

### Outstanding
- **₹1 Test Plan** not yet created in Test Mode. Create it (Monthly, ₹1) only if you need the
  `RAZORPAY_TEST_PLAN_ID` ₹1 internal-override under test keys.

### Apply to local DB (Batch A — already done)
```bash
cd api && uv run python scripts/set_razorpay_plan_ids.py \
  --starter-monthly  plan_T6EODsEtLr87wb \
  --starter-annual   plan_T6EOE2v4XH5imU \
  --standard-monthly plan_T6EOEE8VVc2P6I \
  --standard-annual  plan_T6EOEQRzgM5Mkz \
  --apply
```

---

## Live Mode inventory (`rzp_live_…`) — REAL MONEY 💳

Created 25 Jun 2026. Use only in the **production** database. Charges are real.

| Plan | Plan ID | Amount | Cycle |
|------|---------|--------|-------|
| Starter Monthly | `plan_T5rJrWjfvN3Fk1` | ₹1,799 | Monthly |
| Starter Annual | `plan_T5rLP2lT30ZQuv` | ₹17,299 | Yearly |
| Standard Monthly | `plan_T5rLzlUCdXWQoD` | ₹4,599 | Monthly |
| Standard Annual | `plan_T5rMa0eevGsFPm` | ₹44,099 | Yearly |
| Extra Seat Monthly | `plan_T5rNFpt3vSkl4R` | ₹499 | Monthly |
| Test Plan (₹1) | `plan_T5rNgByd3zStZx` | ₹1 | Monthly |

> The live ₹1 "Test Plan" charges a **real** ₹1 — it exists for `CHECKOUT_TEST_CLIENT_IDS` to run a
> final production smoke test (refundable), **not** for development. **Before go-live, confirm in the
> Live dashboard that both Annual plans show "Every Year"** (avoid the Batch-B mistake in prod).

### Apply to production DB (requires explicit approval — prod write)
```bash
cd api && uv run python scripts/set_razorpay_plan_ids.py \
  --starter-monthly  plan_T5rJrWjfvN3Fk1 \
  --starter-annual   plan_T5rLP2lT30ZQuv \
  --standard-monthly plan_T5rLzlUCdXWQoD \
  --standard-annual  plan_T5rMa0eevGsFPm \
  --apply
# then set in production .env:  RAZORPAY_TEST_PLAN_ID=plan_T5rNgByd3zStZx
```

---

## Verify what's currently wired

Run with no arguments to print the plan IDs stored in the active DB:
```bash
cd api && uv run python scripts/set_razorpay_plan_ids.py
```

---

## Maintenance notes

- **Immutability** — never edit a plan's amount or cycle (Razorpay can't). Re-pricing = mint NEW
  plans in both modes, update the tables above, re-run the apply command, and invalidate
  `discounted_plan_cache` for affected base plans. Existing subscribers are grandfathered.
- **Extra Seat plan** — wired into the seat add-on flow, not the per-plan `razorpay_plan_id_*`
  columns. Tracked per environment in the tables above.
- **Discounted plans** (affiliate/coupon) — auto-created via API and cached in
  `discounted_plan_cache`; never created by hand and never listed here.
- **Updating this file** — whenever plans change in either dashboard, update the matching table
  and the "In-use IDs" quick reference, and re-run the apply command for that environment.
