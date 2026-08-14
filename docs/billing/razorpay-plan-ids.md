# Razorpay Plan IDs — Canonical Reference

**Single source of truth** for which Razorpay plan IDs are wired into each environment.
Last updated: **14 Aug 2026** — Enterprise INR corrected to ₹5,999, and every Test plan
re-minted against the current `scripts/seed_plans.py` on both rails **except Enterprise
USD**, which already matched the seed file (8999 / 86388) and was deliberately left as
minted on 13 Aug (see the USD plans section below).

> **Pricing lineage.** The 16 Jul relaunch shipped **Starter ₹449 · Standard ₹949 ·
> Professional ₹1,399**. Those amounts are **no longer what the product displays** —
> `scripts/seed_plans.py` now holds **₹599 · ₹1,199 · ₹2,999 · ₹5,999**. Everything
> older than that (the pre-relaunch ₹1,799 / ₹4,599 tiers) is retired and intentionally
> not listed here.
>
> **`scripts/seed_plans.py` is the price source of truth.** These tables only record which
> immutable Razorpay object carries each amount. If a table and the seed file disagree, the
> plan needs re-minting — the table is never the thing to "correct".

> **Test Mode and Live Mode are fully isolated** — separate keys, separate plans, separate IDs.
> A plan created in one mode does not exist in the other, and you cannot tell test vs live from
> the `plan_…` string alone (only from the dashboard mode toggle). Each environment's database
> stores the plan IDs that match the API keys it uses.
>
> Plans are **immutable**: they cannot be edited or deleted. To change an amount or billing
> cycle you create a NEW plan and re-point the DB.

---

## Test Mode — INR rail (`rzp_test_…`) ✅ CURRENT

Created **14 Aug 2026**, re-minted from `scripts/seed_plans.py`. Amounts are **GST-inclusive**
(plan amount == displayed price); annual is the full yearly charge, discounted 20.0% off monthly
on Starter, Standard and Enterprise and **21.7% on Professional** (₹28,188 vs ₹35,988 — the plan
row rounds that to `annual_discount_percent: 22`). Each carries
`notes = {"oyechats_slug": …, "cycle": …, "rail": "INR"}`.

| Plan | Plan ID | Amount | Cycle |
|------|---------|--------|-------|
| Starter Monthly | `plan_TPWQmN57OaBc5k` | ₹599 | Monthly |
| Starter Annual | `plan_TPWQoAGVD82M3K` | ₹5,748 | **Yearly** |
| Standard Monthly | `plan_TPWQpxMT7XNnNf` | ₹1,199 | Monthly |
| Standard Annual | `plan_TPWQrkJ2lMblai` | ₹11,508 | **Yearly** |
| Professional Monthly | `plan_TPWQtWl2CjxUBN` | ₹2,999 | Monthly |
| Professional Annual | `plan_TPWQvKMoG1tws9` | ₹28,188 | **Yearly** |
| Enterprise Monthly | `plan_TPWQx9mE8O7GRR` | ₹5,999 | Monthly |
| Enterprise Annual | `plan_TPWQyy9LrhoA7S` | ₹57,588 | **Yearly** |

Every id above was re-fetched individually from the API after creation and asserted on
amount, currency, period and interval — not trusted from the create response.

### Retired Test INR plans — DO NOT WIRE

Razorpay plans are immutable, so these still exist in the Test dashboard. They are listed
so a stale id found in a DB or a script can be *recognised* rather than guessed at.

| Plan ID | Amount | Cycle | Minted | Retired because |
|---------|--------|-------|--------|-----------------|
| `plan_TE3II9mLg0dQxp` | ₹449 | Monthly | 16 Jul 2026 | Starter re-priced to ₹599 |
| `plan_TE3MuL8gS38Ewv` | ₹4,308 | Yearly | 16 Jul 2026 | Starter re-priced to ₹5,748 |
| `plan_TE3OX0Hws0c6Q7` | ₹949 | Monthly | 16 Jul 2026 | Standard re-priced to ₹1,199 |
| `plan_TE3QE2KpwbeQTd` | ₹9,108 | Yearly | 16 Jul 2026 | Standard re-priced to ₹11,508 |
| `plan_TE3Rj85kkmkhQx` | ₹1,399 | Monthly | 16 Jul 2026 | Professional re-priced to ₹2,999 |
| `plan_TE3TU2vQsQJtHQ` | ₹13,428 | Yearly | 16 Jul 2026 | Professional re-priced to ₹28,188 |
| `plan_TMWSBeJVLdm4Eg` | ₹449 | Monthly | 06 Aug 2026 | duplicate 16 Jul amounts (see below) |
| `plan_TMWSBvo8k0qfs5` | ₹4,308 | Yearly | 06 Aug 2026 | duplicate 16 Jul amounts |
| `plan_TMWSCz0nxoHp4R` | ₹949 | Monthly | 06 Aug 2026 | duplicate 16 Jul amounts |
| `plan_TMWSDImrWyYs3p` | ₹9,108 | Yearly | 06 Aug 2026 | duplicate 16 Jul amounts |
| `plan_TMWSEOwKDFNfVx` | ₹1,399 | Monthly | 06 Aug 2026 | duplicate 16 Jul amounts |
| `plan_TMWSEisARB2Mck` | ₹13,428 | Yearly | 06 Aug 2026 | duplicate 16 Jul amounts |
| `plan_TPIlGXkYkdihvl` | ₹2,799 | Monthly | 13 Aug 2026 | Enterprise corrected to ₹5,999 |
| `plan_TPIlGiLEiZ027p` | ₹26,868 | Yearly | 13 Aug 2026 | Enterprise corrected to ₹57,588 |

> **The `plan_TMWS…` batch was undocumented.** It was minted 06 Aug 2026 tagged
> `notes = {"oyechats_env": "test-mode-prod"}` at the *same* 16 Jul amounts, and it — not the
> `plan_TE3…` batch this file used to list — was what the dev database actually had attached.
> Two independent id sets for one set of prices is how a table drifts from reality; anything
> minted from now on is recorded here at creation time.

### Seed to a reset DB (Test)
A fresh DB is built and seeded by `scripts/reset_and_seed.sh` (schema baseline →
`seed_plans.py` → `seed_pricing_config.py` → `seed_superadmin.py`). That seeds the plan
rows and pricing config but **not** the Razorpay IDs (they are per-environment). Every tier the
seed creates is therefore **listed but not self-serve**: listing and checkout wiring are separate
decisions. `is_active` is written on INSERT only and never on UPDATE (so a reseed cannot resurrect
a row something deactivated on purpose), while a paid tier with no INR gateway ids simply degrades
— its quote answers `checkout_supported: false` / `reason: "inr_plan_unconfigured"` with a
contact-sales address, and checkout refuses with a **409** in that same shape. The command below is
what opens **self-serve** checkout; it does not put anything "on sale" that was hidden. After the
reset finishes, attach the Test IDs:
```bash
cd api && uv run python scripts/set_razorpay_plan_ids.py \
  --starter-monthly          plan_TPWQmN57OaBc5k \
  --starter-annual           plan_TPWQoAGVD82M3K \
  --standard-monthly         plan_TPWQpxMT7XNnNf \
  --standard-annual          plan_TPWQrkJ2lMblai \
  --professional-monthly     plan_TPWQtWl2CjxUBN \
  --professional-annual      plan_TPWQvKMoG1tws9 \
  --enterprise-monthly       plan_TPWQx9mE8O7GRR \
  --enterprise-annual        plan_TPWQyy9LrhoA7S \
  --starter-monthly-usd      plan_TPWR0ltxG5VCrk \
  --starter-annual-usd       plan_TPWR2cn2GNjIaR \
  --standard-monthly-usd     plan_TPWR4Qq9wZEBSr \
  --standard-annual-usd      plan_TPWR6F90foLfA2 \
  --professional-monthly-usd plan_TPWR83U8rK7Bni \
  --professional-annual-usd  plan_TPWR9rXizbETnJ \
  --enterprise-monthly-usd   plan_TPIlGtrKGvGxKZ \
  --enterprise-annual-usd    plan_TPIlH5qqhl60dD \
  --apply
```
That one command wires **both** rails. The `--professional-*` / `--enterprise-*` flags and the
Professional and Enterprise plan rows are all in place. The extra-seat add-on is configured via
the `RAZORPAY_SEAT_PLAN_ID` env var (not a plan row) — Enterprise includes unlimited seats, so it
never bills the add-on.

---

## Live Mode — 16 Jul relaunch pricing (`rzp_live_…`) ⚠️ BEHIND THE SEED FILE

Created via the Razorpay API and seeded into the prod `plans` table during the DB reset.
This is what production currently charges.

| Plan | Plan ID | Amount | Cycle | `seed_plans.py` now says |
|------|---------|--------|-------|--------------------------|
| Starter Monthly | `plan_TE6Pae1HaV4bNx` | ₹449 | Monthly | ₹599 |
| Starter Annual | `plan_TE6PasUXZc3sbL` | ₹4,308 | Yearly | ₹5,748 |
| Standard Monthly | `plan_TE6Pb9a4XXVKB5` | ₹949 | Monthly | ₹1,199 |
| Standard Annual | `plan_TE6PbQEmXZhhtm` | ₹9,108 | Yearly | ₹11,508 |
| Professional Monthly | `plan_TE6PbfKUnVNB6q` | ₹1,399 | Monthly | ₹2,999 |
| Professional Annual | `plan_TE6Pbuixn7mmDB` | ₹13,428 | Yearly | ₹28,188 |

> ⚠️ **Live has the same drift Test just had fixed, and is NOT yet re-minted.** The ids above
> bill the 16 Jul amounts while `seed_plans.py` holds the new ones. A production DB seeded from
> the current file therefore breaks, in one specific and expensive way:
>
> **Silent under-collection on every paid subscription.** Prod would *display* the seed file's
> prices and *charge* what these immutable ids carry — always in the customer's favour, never
> flagged:
>
> | Tier | Displayed | Charged | Under-collected |
> |------|-----------|---------|-----------------|
> | Starter monthly | ₹599 | ₹449 | **−25.0%** |
> | Starter annual | ₹5,748 | ₹4,308 | **−25.1%** |
> | Standard monthly | ₹1,199 | ₹949 | **−20.9%** |
> | Standard annual | ₹11,508 | ₹9,108 | **−20.9%** |
> | Professional monthly | ₹2,999 | ₹1,399 | **−53.4%** |
> | Professional annual | ₹28,188 | ₹13,428 | **−52.4%** |
>
> That is **21–53% of gross revenue lost per subscription, on every renewal, with no error
> raised anywhere** — checkout succeeds, the webhook is accepted, and the invoice is issued at
> the charged amount, so the platform's own records are internally consistent and the gap is
> invisible until someone reconciles displayed price against settled amount by hand.
>
> **Enterprise is NOT part of this blocker.** There is **no Live Enterprise plan**, in either
> currency, and that is fine: a contact-sales tier needs no gateway plan id to be listed. Nothing
> derives `plans.is_active` from gateway wiring — `plan_service.plan_checkout_is_wired` is
> reporting only (the seed and `set_razorpay_plan_ids.py` print it, and the super-admin plan
> routes warn on it), and must never be written to the column. A prod reseed therefore leaves
> Enterprise **listed**: it appears in `GET /public/pricing-catalog` and so on
> oyechats.com/pricing, its quote answers `checkout_supported: false` /
> `reason: "inr_plan_unconfigured"` with a contact-sales address, and `POST /subscriptions/checkout`
> refuses with a **409** in that same shape (`razorpay_service.PlanNotCheckoutable`) instead of a
> bare 400 carrying an operator instruction. That is the intended behaviour for a tier whose entire
> go-to-market is contact-sales. Minting Live Enterprise ids is what would turn it self-serve, and
> is not a prerequisite for a reseed.
>
> Re-minting Live is a deliberate, separately-authorised commercial act — it re-prices real
> customers — so it was intentionally left alone here.
> **Before any prod reseed:** mint the Live replacements, record them in this table, and
> re-point the prod DB, or explicitly revert `seed_plans.py` to the amounts Live charges.

Seat add-on (live, unchanged ₹499): `RAZORPAY_SEAT_PLAN_ID=plan_T5rNFpt3vSkl4R` (GHA variable).

---

## USD plans — international rail

Separate Razorpay plan objects priced in USD. A plan's currency is fixed at creation,
so these are the ONLY ids that can serve an international charge — the INR ids above
cannot. Stored on `plans.razorpay_plan_id_monthly_usd` / `razorpay_plan_id_annual_usd`
(migration `b4e7c2f9a801`), seeded with the `--*-usd` flags of
`scripts/set_razorpay_plan_ids.py`.

Amounts track the `*_usd_cents` columns in `scripts/seed_plans.py` — a deliberate USD
headline, never FX-converted.

> **The USD rail drifts on its own schedule.** The 13 Aug re-pricing changed the USD columns
> too ($9/$19/$39 → $7.99/$15.99/$45.99), which silently invalidated the whole 3 Aug USD batch.
> USD drift is easy to miss because an INR price change *reads* like an INR-only event —
> **when a tier is re-priced, check both `*_cents` and `*_usd_cents` before assuming one rail
> is unaffected.**

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

### Test Mode (`rzp_test_…`) ✅ CURRENT

Starter / Standard / Professional re-minted **14 Aug 2026**. Enterprise's two rows are the
originals from 13 Aug 2026 — the 14 Aug correction moved Enterprise's **INR** price only, so
its USD plans still match `seed_plans.py` (8999 / 86388) and were deliberately **not** re-minted.

| Plan | Plan ID | Amount | Cycle | Minted |
|------|---------|--------|-------|--------|
| Starter Monthly | `plan_TPWR0ltxG5VCrk` | $7.99 | Monthly | 14 Aug 2026 |
| Starter Annual | `plan_TPWR2cn2GNjIaR` | $77.88 | Yearly | 14 Aug 2026 |
| Standard Monthly | `plan_TPWR4Qq9wZEBSr` | $15.99 | Monthly | 14 Aug 2026 |
| Standard Annual | `plan_TPWR6F90foLfA2` | $155.88 | Yearly | 14 Aug 2026 |
| Professional Monthly | `plan_TPWR83U8rK7Bni` | $45.99 | Monthly | 14 Aug 2026 |
| Professional Annual | `plan_TPWR9rXizbETnJ` | $455.88 | Yearly | 14 Aug 2026 |
| Enterprise Monthly | `plan_TPIlGtrKGvGxKZ` | $89.99 | Monthly | 13 Aug 2026 |
| Enterprise Annual | `plan_TPIlH5qqhl60dD` | $863.88 | Yearly | 13 Aug 2026 |

Seat add-on (test): `RAZORPAY_SEAT_PLAN_ID_USD=plan_TLFBRlMIoz1QeC` ($5/seat/month) — unchanged.

There is **no Live-mode Enterprise plan** — the tier exists in Test only.

#### Retired Test USD plans — DO NOT WIRE

| Plan ID | Amount | Cycle | Minted | Retired because |
|---------|--------|-------|--------|-----------------|
| `plan_TLFB8lG6zmggVB` | $9 | Monthly | 3 Aug 2026 | Starter re-priced to $7.99 |
| `plan_TLFBQoPTonDDwh` | $84 | Yearly | 3 Aug 2026 | Starter re-priced to $77.88 |
| `plan_TLFBQzoxkBVVar` | $19 | Monthly | 3 Aug 2026 | Standard re-priced to $15.99 |
| `plan_TLFBRC1uN9YHjj` | $180 | Yearly | 3 Aug 2026 | Standard re-priced to $155.88 |
| `plan_TLFBROcMoO4A9R` | $39 | Monthly | 3 Aug 2026 | Professional re-priced to $45.99 |
| `plan_TLFBRaOh3Dv5rq` | $372 | Yearly | 3 Aug 2026 | Professional re-priced to $455.88 |
| `plan_TMWSCDPIDcFxiX` | $9 | Monthly | 6 Aug 2026 | undocumented `test-mode-prod` duplicate |
| `plan_TMWSCZs5JhcCL8` | $84 | Yearly | 6 Aug 2026 | undocumented `test-mode-prod` duplicate |
| `plan_TMWSDa4WMmMTjL` | $19 | Monthly | 6 Aug 2026 | undocumented `test-mode-prod` duplicate |
| `plan_TMWSDvMqxoCB1V` | $180 | Yearly | 6 Aug 2026 | undocumented `test-mode-prod` duplicate |
| `plan_TMWSF0TzgWXs18` | $39 | Monthly | 6 Aug 2026 | undocumented `test-mode-prod` duplicate |
| `plan_TMWSFJ7KnDPnNu` | $372 | Yearly | 6 Aug 2026 | undocumented `test-mode-prod` duplicate |

The **Live** USD plans ($9 / $84 / $19 / $180 / $39 / $372) are equally behind the seed file,
and are left alone for the same reason as the Live INR rail. `INTL_PAYMENTS_ENABLED=false`
means nothing charges against them today.

### Seed the USD ids

For **Test**, use the single combined command in
[Seed to a reset DB (Test)](#seed-to-a-reset-db-test) — it already carries the real ids for
both rails. The USD-only form below is a template for wiring a *different* environment:

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

### Re-minting checklist

Editing a `*_price_*` field in `scripts/seed_plans.py` is only half a price change — the
Razorpay side does not follow automatically, and nothing fails loudly when the two disagree.
A checkout will happily *display* the new price and *charge* the old one.

1. **Assert the mode.** Confirm `RAZORPAY_KEY_ID` starts with `rzp_test` before any API call.
   Parse `api/.env` in Python — never `source` it.
2. **Do both rails.** Check `*_cents` **and** `*_usd_cents`. An "INR-only" re-price has twice
   silently invalidated USD plans.
3. **Print, then reconcile, then create.** Amounts come from `seed_plans.py`, never retyped.
4. **Re-fetch every new plan individually** and assert amount, currency, period *and* interval.
   The create response is not proof — the 3 Aug live batch produced a wrong-currency and a
   wrong-cycle plan that were only caught later.
5. **Record the new ids here at creation time**, and move the old rows to the retired tables
   rather than deleting them — an immutable plan that still exists is worth recognising.
6. **Confirm `DB_URL` is local** before `seed_plans.py --apply`, then attach with
   `set_razorpay_plan_ids.py --apply`.
7. **Verify against the DB**, not the script output: every tier's price and id, cross-checked
   against the live plan the id resolves to.
