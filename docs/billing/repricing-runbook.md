# Re-pricing Runbook

Run this when: (a) quarterly review, or (b) spot FX rate drifts >5% from the rate
recorded in the latest pricing migration header.

> **Prices are GST-exclusive (changed 26 Aug 2026).** Every amount in the `plans` table and in the
> add-on price env vars is a **base** price. The GST is added at charge time by
> `core/tax.py::gross_charge_minor`, so a domestic customer is debited base + GST. An international
> customer is an export, pays no Indian GST, and is charged the listed USD price.
>
> This changes Step 3: a **Razorpay plan on the INR rail must be minted at base + GST**, not at the
> DB amount. Razorpay Subscriptions have no tax layer of their own (the plan item's `tax_rate` field
> is metadata only, measured in `api/scripts/razorpay_tax_probe.py`), so the tax has to be inside the
> minted amount. USD plans are minted at the base.
>
> Discounts apply to the base, and GST is computed on the discounted base, per Section 15(3) of the
> CGST Act.

> **The Step 2 example figures are from the retired pre-relaunch catalogue.** Take the live bases
> from `api/scripts/seed_plans.py`, not from the table below.

## Step 1 — Decide whether to re-price

Check spot ₹/$ (e.g. `exchangerate.host` or Google Finance). Compare to the
reference rate in the most recent pricing migration file header
(`api/alembic/versions/*_usd_columns_and_topup_reanchor.py` — currently **₹94.67/$1**).

- Drift < 5% → stop. Prices are deliberately sticky; micro-adjustments erode trust.
- Drift ≥ 5% → continue.

## Step 2 — Set new INR amounts

Use psychological rounding (₹1,799 not ₹1,794). Anchored to the new spot rate:

| Plan | Cycle | Formula | Example at ₹98 |
|------|-------|---------|-----------------|
| Starter | Monthly | $19 × rate, round to nearest ₹50 | ₹1,850 |
| Starter | Annual | $182 × rate, round to nearest ₹100 | ₹17,800 |
| Standard | Monthly | $49 × rate, round to nearest ₹100 | ₹4,800 |
| Standard | Annual | $470 × rate, round to nearest ₹500 | ₹46,000 |
| Extra Seat | Monthly | $5 × rate, round to nearest ₹50 | ₹500 |

USD headline columns change only if the product pricing strategy changes —
FX drift alone does NOT change the USD column.

## Step 3 — Create new Razorpay plans

Razorpay plan amounts are **immutable** — never edit an existing plan.

1. Razorpay Dashboard → Subscriptions → Plans → Create Plan.
2. Create one plan per row above that changed (period + interval + amount in paise).
   **INR plans are minted at the gross**, `gross_charge_minor(base, rate_bps, "intra")`, not at the
   base you are about to write into `plans`. USD plans are minted at the base.
3. Copy the new `plan_XXXX` IDs.

The same rule applies to the operator-seat and branding-removal add-on plans
(`RAZORPAY_SEAT_PLAN_ID`, `RAZORPAY_BRANDING_PLAN_ID`). Each moves together with its price env var.
Full procedure and the current expected amounts:
[`razorpay-plan-ids.md`](./razorpay-plan-ids.md#re-minting-for-gst-exclusive-pricing).

## Step 4 — Write the migration

```python
# api/alembic/versions/<rev>_reprice_<month>_<year>.py
# Reference rate: ₹<new_rate>/$1 (<date>)
...
op.execute("UPDATE plans SET monthly_price_cents=<new_paise> WHERE slug='starter'")
# etc. — update all changed rows.
# Update USD columns only if headline pricing changed:
# op.execute("UPDATE plans SET monthly_price_usd_cents=<new_cents> WHERE slug='starter'")
```

Apply:

```bash
cd api && uv run alembic upgrade head
```

## Step 5 — Update plan IDs in the database

```bash
cd api && uv run python scripts/set_razorpay_plan_ids.py \
  --starter-monthly  plan_XXXX \
  --starter-annual   plan_XXXX \
  --standard-monthly plan_XXXX \
  --standard-annual  plan_XXXX
# Dry-run first (no --apply), then:
uv run python scripts/set_razorpay_plan_ids.py ... --apply
```

## Step 6 — Invalidate discounted plan cache

Cached discounted plans were computed off the old base amount. They must be
cleared so the next checkout creates new discounted plans at the correct base.

```sql
DELETE FROM discounted_plan_cache
WHERE base_plan_id IN (
    SELECT id FROM plans WHERE slug IN ('starter', 'standard')
);
```

Run this on production after the migration is applied and plan IDs are updated.

## Step 7 — Verify

```bash
uv run python scripts/set_razorpay_plan_ids.py   # no args → prints current DB state
```

Confirm all changed plans show their new IDs and new `monthly_price_cents` values.

Then call `GET /subscriptions/admin/plan-price-check` (superadmin). It fetches each live Razorpay
plan and compares its amount against `expected_charge_minor`, the **gross**. Every row must report
`in_sync: true`. A row still showing the base amount is a plan that was minted without the GST.

## Step 8 — Communicate (if USD headline changed)

If the USD column changed (customer-facing headline price):
- Email existing subscribers 30 days in advance.
- Update the marketing site pricing page.
- Existing active subscribers are **grandfathered** — their mandate is locked
  at the amount they authorised. Only new signups get the new price.
