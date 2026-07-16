# Razorpay Plan IDs — Canonical Reference

**Single source of truth** for which Razorpay plan IDs are wired into each environment.
Last updated: **16 Jul 2026** — new-pricing relaunch; all pre-relaunch plans purged.

> **Relaunch context.** OyeChats is relaunching on new pricing
> (**Starter ₹449 · Standard ₹949 · Professional ₹1,399**). The production database is
> being reset for a fresh start, so every pre-relaunch plan (the old ₹1,799 / ₹4,599 tiers,
> in both Test and Live) is **retired and intentionally not listed here** — no code or DB
> should reference them.

> **Test Mode and Live Mode are fully isolated** — separate keys, separate plans, separate IDs.
> A plan created in one mode does not exist in the other, and you cannot tell test vs live from
> the `plan_…` string alone (only from the dashboard mode toggle). Each environment's database
> stores the plan IDs that match the API keys it uses.
>
> Plans are **immutable**: they cannot be edited or deleted. To change an amount or billing
> cycle you create a NEW plan and re-point the DB.

---

## Test Mode — new pricing (`rzp_test_…`) ✅

Created 16 Jul 2026. Amounts are **GST-inclusive** (plan amount == displayed price); annual is
the full yearly charge at ~20% off monthly.

| Plan | Plan ID | Amount | Cycle |
|------|---------|--------|-------|
| Starter Monthly | `plan_TE3II9mLg0dQxp` | ₹449 | Monthly |
| Starter Annual | `plan_TE3MuL8gS38Ewv` | ₹4,308 | **Yearly** |
| Standard Monthly | `plan_TE3OX0Hws0c6Q7` | ₹949 | Monthly |
| Standard Annual | `plan_TE3QE2KpwbeQTd` | ₹9,108 | **Yearly** |
| Professional Monthly | `plan_TE3Rj85kkmkhQx` | ₹1,399 | Monthly |
| Professional Annual | `plan_TE3TU2vQsQJtHQ` | ₹13,428 | **Yearly** |

### Seed to a reset DB (Test)
A fresh DB is built and seeded by `scripts/reset_and_seed.sh` (schema baseline →
`seed_plans.py` → `seed_pricing_config.py` → `seed_superadmin.py`). That seeds the plan
rows and pricing config but **not** the Razorpay IDs (they are per-environment). After it
finishes, attach the Test IDs:
```bash
cd api && uv run python scripts/set_razorpay_plan_ids.py \
  --starter-monthly      plan_TE3II9mLg0dQxp \
  --starter-annual       plan_TE3MuL8gS38Ewv \
  --standard-monthly     plan_TE3OX0Hws0c6Q7 \
  --standard-annual      plan_TE3QE2KpwbeQTd \
  --professional-monthly plan_TE3Rj85kkmkhQx \
  --professional-annual  plan_TE3TU2vQsQJtHQ \
  --apply
```
The `--professional-*` flags and the Professional plan row are both in place. The extra-seat
add-on is configured via the `RAZORPAY_SEAT_PLAN_ID` env var (not a plan row).

---

## Live Mode — new pricing (`rzp_live_…`) ⏳ NOT CREATED YET

Mint these in the **Live** dashboard only after the Test flow is validated in production. Confirm
both Annual plans read "Every Year" before wiring.

| Plan | Plan ID | Amount | Cycle |
|------|---------|--------|-------|
| Starter Monthly | _to create_ | ₹449 | Monthly |
| Starter Annual | _to create_ | ₹4,308 | Yearly |
| Standard Monthly | _to create_ | ₹949 | Monthly |
| Standard Annual | _to create_ | ₹9,108 | Yearly |
| Professional Monthly | _to create_ | ₹1,399 | Monthly |
| Professional Annual | _to create_ | ₹13,428 | Yearly |

---

## USD plans ⏳ NOT CREATED YET

Deferred until the Razorpay account is enabled for USD plans. Prices:
$9 / $19 / $39 monthly; $84 / $180 / $372 yearly (Starter / Standard / Professional).

---

## Add-on / internal plans (to (re)create)

| Purpose | Env var | Status |
|---------|---------|--------|
| Extra seat (₹499/mo add-on) | `RAZORPAY_SEAT_PLAN_ID` | Create in Test + Live; env-driven, **no hardcoded default** in `config.py` |
| ₹1 test checkout | `RAZORPAY_TEST_PLAN_ID` | Create in Live if `CHECKOUT_TEST_CLIENT_IDS` is used; env-driven |

---

## Verify what's currently wired

```bash
cd api && uv run python scripts/set_razorpay_plan_ids.py
```

---

## Maintenance notes

- **Immutability** — never edit a plan's amount or cycle (Razorpay can't). Re-pricing = mint NEW
  plans, update the tables above, re-run the apply command, and invalidate `discounted_plan_cache`.
- **No hardcoded plan IDs in code** — `RAZORPAY_SEAT_PLAN_ID` / `RAZORPAY_TEST_PLAN_ID` are read
  from env only (no baked-in defaults). Set them per environment.
- **Discounted plans** (affiliate/coupon) — auto-created via API and cached in
  `discounted_plan_cache`; never created by hand and never listed here.
- **Updating this file** — whenever plans change in either dashboard, update the matching table
  and re-run the apply command for that environment.
