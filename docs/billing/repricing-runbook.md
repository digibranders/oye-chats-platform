# Re-pricing Runbook

Run this when: (a) quarterly review, or (b) spot FX rate drifts >5% from the rate
recorded in the latest pricing migration header.

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
3. Copy the new `plan_XXXX` IDs.

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

## Step 8 — Communicate (if USD headline changed)

If the USD column changed (customer-facing headline price):
- Email existing subscribers 30 days in advance.
- Update the marketing site pricing page.
- Existing active subscribers are **grandfathered** — their mandate is locked
  at the amount they authorised. Only new signups get the new price.
