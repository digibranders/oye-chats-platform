# Razorpay Plan IDs — Canonical Reference

**Single source of truth** for which Razorpay plan IDs are wired into each environment.
Last updated: **13 Aug 2026** — Enterprise tier created in Test (INR + USD).

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
| Enterprise Monthly | `plan_TPIlGXkYkdihvl` | ₹2,799 | Monthly |
| Enterprise Annual | `plan_TPIlGiLEiZ027p` | ₹26,868 | **Yearly** |

The two **Enterprise** rows were created 13 Aug 2026 (the rest are from the 16 Jul batch) and
carry `notes = {"oyechats_slug": "enterprise", "cycle": …}`.

> ⚠️ **The Starter / Standard / Professional ids above bill the 16 Jul amounts (₹449 / ₹949 /
> ₹1,399), which `scripts/seed_plans.py` no longer holds** — it now seeds ₹599 / ₹1,199 / ₹2,999.
> Only Enterprise's ids match what the seed writes. Until those three tiers get re-minted plans,
> a Test checkout on them displays the new price and charges the old one. Enterprise is unaffected.

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
  --enterprise-monthly   plan_TPIlGXkYkdihvl \
  --enterprise-annual    plan_TPIlGiLEiZ027p \
  --apply
```
The `--professional-*` / `--enterprise-*` flags and the Professional and Enterprise plan rows are
all in place. The extra-seat add-on is configured via the `RAZORPAY_SEAT_PLAN_ID` env var (not a
plan row) — Enterprise includes unlimited seats, so it never bills the add-on.

---

## Live Mode — new pricing (`rzp_live_…`) ✅ WIRED (relaunch 16 Jul 2026)

Created via the Razorpay API and seeded into the prod `plans` table during the DB reset.
This is what production currently charges.

| Plan | Plan ID | Amount | Cycle |
|------|---------|--------|-------|
| Starter Monthly | `plan_TE6Pae1HaV4bNx` | ₹449 | Monthly |
| Starter Annual | `plan_TE6PasUXZc3sbL` | ₹4,308 | Yearly |
| Standard Monthly | `plan_TE6Pb9a4XXVKB5` | ₹949 | Monthly |
| Standard Annual | `plan_TE6PbQEmXZhhtm` | ₹9,108 | Yearly |
| Professional Monthly | `plan_TE6PbfKUnVNB6q` | ₹1,399 | Monthly |
| Professional Annual | `plan_TE6Pbuixn7mmDB` | ₹13,428 | Yearly |

Seat add-on (live, unchanged ₹499): `RAZORPAY_SEAT_PLAN_ID=plan_T5rNFpt3vSkl4R` (GHA variable).

---

## USD plans — international rail ✅ CREATED (3 Aug 2026)

Separate Razorpay plan objects priced in USD. A plan's currency is fixed at creation,
so these are the ONLY ids that can serve an international charge — the INR ids above
cannot. Stored on `plans.razorpay_plan_id_monthly_usd` / `razorpay_plan_id_annual_usd`
(migration `b4e7c2f9a801`), seeded with the `--*-usd` flags of
`scripts/set_razorpay_plan_ids.py`.

Amounts match the `*_usd_cents` columns in `scripts/seed_plans.py` — a deliberate USD
headline, never FX-converted. Annual = 12 × the discounted monthly ($7 / $15 / $31).

### Live Mode (`rzp_live_…`)

| Plan | Plan ID | Amount | Cycle |
|------|---------|--------|-------|
| Starter Monthly | `plan_TLF32pi2eo9RAG` | $9 | Monthly |
| Starter Annual | `plan_TLF55omvXJIr5w` | $84 | Yearly |
| Standard Monthly | `plan_TLF5RZlXtS00zU` | $19 | Monthly |
| Standard Annual | `plan_TLF6HQmR1um1aY` | $180 | Yearly |
| Professional Monthly | `plan_TLF6f2FuSkTHjK` | $39 | Monthly |
| Professional Annual | `plan_TLF72mxUqNXlb5` | $372 | Yearly |

Seat add-on (live): `RAZORPAY_SEAT_PLAN_ID_USD=plan_TLF7UFHVzhJU0R` ($5/seat/month).

### Test Mode (`rzp_test_…`)

| Plan | Plan ID | Amount | Cycle |
|------|---------|--------|-------|
| Starter Monthly | `plan_TLFB8lG6zmggVB` | $9 | Monthly |
| Starter Annual | `plan_TLFBQoPTonDDwh` | $84 | Yearly |
| Standard Monthly | `plan_TLFBQzoxkBVVar` | $19 | Monthly |
| Standard Annual | `plan_TLFBRC1uN9YHjj` | $180 | Yearly |
| Professional Monthly | `plan_TLFBROcMoO4A9R` | $39 | Monthly |
| Professional Annual | `plan_TLFBRaOh3Dv5rq` | $372 | Yearly |
| Enterprise Monthly | `plan_TPIlGtrKGvGxKZ` | $89.99 | Monthly |
| Enterprise Annual | `plan_TPIlH5qqhl60dD` | $863.88 | Yearly |

Seat add-on (test): `RAZORPAY_SEAT_PLAN_ID_USD=plan_TLFBRlMIoz1QeC` ($5/seat/month).

The two **Enterprise** rows were created 13 Aug 2026 and match `seed_plans.py`'s
`monthly_price_usd_cents` / `annual_price_usd_cents` (8999 / 86388). There is **no Live-mode
Enterprise plan** — the tier exists in Test only.

### Seed the USD ids

```bash
cd api && uv run python scripts/set_razorpay_plan_ids.py \
  --starter-monthly-usd      plan_XXXXXXXXXXXXXXXX \
  --starter-annual-usd       plan_XXXXXXXXXXXXXXXX \
  --standard-monthly-usd     plan_XXXXXXXXXXXXXXXX \
  --standard-annual-usd      plan_XXXXXXXXXXXXXXXX \
  --professional-monthly-usd plan_XXXXXXXXXXXXXXXX \
  --professional-annual-usd  plan_XXXXXXXXXXXXXXXX \
  --enterprise-monthly-usd   plan_XXXXXXXXXXXXXXXX \
  --enterprise-annual-usd    plan_XXXXXXXXXXXXXXXX \
  --apply
```

### ⚠️ Live plans created in error — DO NOT USE

Three plans from the 3 Aug live batch are misconfigured. Razorpay plans cannot be
edited or deleted, so they stay in the dashboard; they are listed here only so nobody
wires them up by mistake.

| Plan ID | Named | Actually created as | Fault |
|---------|-------|---------------------|-------|
| `plan_TLF5tOp8DljHNG` | Standard Annual USD 180 | $180 **monthly** | Wrong billing cycle |
| `plan_TLF4XFj8uJLsql` | Standard Monthly USD 19 | **₹19** monthly | Wrong currency |
| `plan_TLF3nxE1CGe9p2` | Starter Annual USD 84 | **₹84** yearly | Wrong currency |

### Switching the USD rail on

The code path is wired and gated by one env var:

```bash
INTL_PAYMENTS_ENABLED=true
```

While it is **off** (the default), a confirmed non-IN buyer gets the existing
`intl_usd_pending` 409 and the Contact-sales CTA. While it is **on**, checkout
routes them to the USD plan ids above. What follows the flag automatically:

| Path | Behaviour on the USD rail |
|------|---------------------------|
| `/subscriptions/checkout`, `/change-plan`, per-bot, cutovers | `create_subscription` resolves the rail from `client.billing_country` — the same field `invoice_service` reads for place-of-supply, so charge currency and invoice classification can never disagree |
| Extra operator seats | Bills against `RAZORPAY_SEAT_PLAN_ID_USD` at `EXTRA_SEAT_PRICE_USD_CENTS` |
| Referral / affiliate discounts | `discounted_plan_cache` is keyed by currency (migration `c5a8d3e0b912`), so the two rails mint and cache separate discounted plans |
| `/checkout/quote` | Returns `checkout_supported: true` with `methods: ["card"]` — UPI is domestic-only and cannot settle a USD charge |
| **Top-ups** (`/credits/topup`) | **Still 409s for non-IN buyers even with the flag on** — `create_topup_order` charges the INR pack price, so opening it would bill a foreign buyer in rupees on a supply invoiced as an export. Needs USD top-up packs first. |

A tier with no USD plan id fails loudly (`ValueError`, surfaced as a 400) rather
than falling back to the INR plan — the quote checks the id for the same reason,
so it never promises a checkout the charge path would reject.

To drive all of this end-to-end on a dev box, follow
[`2026-08-04-usd-rail-local-test-plan.md`](./2026-08-04-usd-rail-local-test-plan.md).

### ⚠️ Do not flip the flag yet — the account cannot take the payment

The plans exist and the code is ready, but the Razorpay account cannot yet take a
recurring international payment: **International Cards is not enabled** (still a
"Request for international cards" button) and **PayPal — the only activated
international method — does not support subscriptions**. International Bank
Transfers is also incomplete (video KYC failed). Until international cards are
approved *with recurring/subscriptions enabled*, USD checkout will reach Razorpay
and fail at the payment step. Keep `INTL_PAYMENTS_ENABLED=false` in production
until then.

---

## Add-on / internal plans (to (re)create)

| Purpose | Env var | Status |
|---------|---------|--------|
| Extra seat (₹499/mo add-on) | `RAZORPAY_SEAT_PLAN_ID` | Create in Test + Live; env-driven, **no hardcoded default** in `config.py` |
| Extra seat ($5/mo add-on, USD rail) | `RAZORPAY_SEAT_PLAN_ID_USD` | ✅ Created in Test + Live (ids in the USD section above); env-driven, no hardcoded default |
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
