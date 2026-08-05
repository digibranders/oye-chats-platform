# USD (international) rail — local test plan

> **Scope:** driving the USD rail end-to-end on a dev box against Razorpay **test mode**.
> The INR equivalent is the staging checklist in
> [`2026-07-11-pre-merge-runbook.md` §4B](./2026-07-11-pre-merge-runbook.md).
> **Status of the rail:** code complete and unit-tested; never driven against a real gateway.
> `INTL_PAYMENTS_ENABLED` must stay `false` in production — see
> [`razorpay-plan-ids.md`](./razorpay-plan-ids.md) for why.

---

## 0. What is already covered — do not re-test by hand

The currency decision itself is unit-tested. Re-running these by hand buys nothing;
spend the manual effort on §3 instead.

| File | Proves |
|---|---|
| `tests/test_usd_checkout_rail.py` | `charge_currency` mapping; USD plan selection per cycle; **hard raise** (never an INR fallback) when a tier has no USD id; seat add-on picks `RAZORPAY_SEAT_PLAN_ID_USD`; discounted-plan cache does not leak across currencies; quote returns `card`-only; top-up still 409s with the flag on |
| `tests/test_checkout_currency_routing.py` | `/subscriptions/geo` and `/checkout/quote` currency per buyer; stored `billing_country` beats IP geo |
| `tests/test_checkout_country_gate.py`, `test_topup_country_gate.py`, `test_checkout_geo_crosscheck.py` | the 409 gate and the geo-mismatch audit log |

```bash
cd api && .venv/bin/python -m pytest tests/test_usd_checkout_rail.py \
  tests/test_checkout_currency_routing.py tests/test_checkout_country_gate.py \
  tests/test_topup_country_gate.py tests/test_checkout_geo_crosscheck.py
```

**What no unit test can tell you:** whether Razorpay will actually *authorize a recurring
USD mandate on this account*. That is what §1 exists to answer, and it gates everything else.

---

## 1. Preconditions

### 1a. Already true on this machine — verified 4 Aug 2026

| Thing | State |
|---|---|
| `RAZORPAY_KEY_ID` | `rzp_test_…` ✅ test mode |
| `INTL_PAYMENTS_ENABLED` | `true` in `api/.env` ✅ |
| `RAZORPAY_SEAT_PLAN_ID_USD` | `plan_TLFBRlMIoz1QeC` ($5/seat, test) ✅ |
| USD plan ids on all three tiers | wired in the local DB ✅ |

Re-confirm the plan ids at any time (read-only):

```bash
cd api && .venv/bin/python scripts/set_razorpay_plan_ids.py
```

Expect a populated **USD rail** table (`plan_TLFB…` ids). A blank cell means that
tier/cycle will 400 at checkout by design — that is scenario **S7**, not a setup failure.

### 1b. Bring the stack up

```bash
cd api && ./scripts/dev.sh          # migrations → ngrok tunnel → ARQ worker → uvicorn:8000
```

The tunnel is **required**, not optional: `subscription.activated` / `.charged` are what
grant credits and create the invoice row. Without it you are only testing the synchronous
`/verify` fallback and will draw wrong conclusions about the webhook path.
Full procedure and the macOS pango trap: [`local-razorpay-webhooks.md`](./local-razorpay-webhooks.md).

---

## 2. Gate — can this Razorpay test account authorize a USD mandate at all?

**Run this before anything else.** International Cards is *not* enabled on the live account
(PayPal is the only activated international method, and it does not do subscriptions). If
test mode mirrors that restriction, every scenario below dies at the payment step and the
result says nothing about our code.

```bash
cd api && .venv/bin/python scripts/verify_recovery_short_url.py --create \
  --plan-id plan_TLFB8lG6zmggVB          # Starter Monthly USD, $9, test mode
```

Open the printed `short_url` and try to authorize with an **international** test card from
Razorpay's [test card reference](https://razorpay.com/docs/payments/payments/test-card-details/).

| Outcome | Meaning | Next |
|---|---|---|
| Card form accepts the international card and the subscription reaches `authenticated`/`active` | Test mode allows it | Continue to §3 |
| The modal rejects the card, or offers no international option | Test mode mirrors the live restriction | **Stop.** §3 is unrunnable until Razorpay approves International Cards *with recurring enabled*. Record the exact error and move on — this is not a code defect |

> The `--create` path mints a subscription in `created` state only. Nothing is charged
> until a human authorizes it, and the script refuses to run against live keys.

---

## 3. Scenarios

Every scenario uses a **US test client**. Create one and record its `X-API-Key`:

```bash
# 1. Register a throwaway client through the app, then set its billing identity.
#    legal_name + billing_address.line1 are mandatory (Rule 46 buyer identity);
#    billing_state_code is India-only and must stay unset.
curl -s -X PUT http://localhost:8000/subscriptions/billing-details \
  -H "X-API-Key: $US_KEY" -H 'Content-Type: application/json' \
  -d '{"legal_name":"Northwind Labs LLC",
       "billing_country":"US",
       "billing_address":{"line1":"1209 Orange St","city":"Wilmington","state":"DE","postal_code":"19801"},
       "billing_email":"ap@northwind.test"}'
```

Keep a second **IN client** (`$IN_KEY`) on hand — several scenarios are only meaningful as
a contrast against the domestic rail.

---

### S1 — Quote routes to USD, cards only

```bash
curl -s "http://localhost:8000/subscriptions/checkout/quote?plan_id=<STARTER_ID>&billing_cycle=monthly" \
  -H "X-API-Key: $US_KEY" | jq
```

- [ ] `currency: "USD"`, `amount_minor: 900`, `amount_display` renders **$9**
- [ ] `methods: ["card"]` — **no `"upi"`**. UPI cannot settle a USD charge; if it appears, stop and file it
- [ ] `checkout_supported: true`, `contact_sales: null`
- [ ] Same call with `$IN_KEY` → `INR` / `44900` / `["card","upi"]`

Repeat for `billing_cycle=annual` → `$84` (`8400`).

---

### S2 — Checkout mints a **USD** subscription against the USD plan id

```bash
curl -s -X POST http://localhost:8000/subscriptions/checkout \
  -H "X-API-Key: $US_KEY" -H 'Content-Type: application/json' \
  -d '{"plan_id":<STARTER_ID>,"billing_cycle":"monthly","billing_country":"US"}' | jq
```

- [ ] Response carries a Razorpay subscription id and a checkout handle (no `intl_usd_pending` 409)
- [ ] In the **Razorpay test dashboard**, the subscription's plan is `plan_TLFB8lG6zmggVB` and
      the amount reads **$9 / USD** — not ₹9, not ₹449
- [ ] `subscriptions.razorpay_subscription_id` is stored locally

The failure this catches is the expensive one: a US customer silently charged ₹449 instead
of $9 because the rail fell back to INR.

---

### S3 — Authorize → `subscription.activated` → credits granted once

Authorize the mandate in the hosted page (international test card).

- [ ] `subscription.activated` lands in the ngrok inspector (`http://127.0.0.1:4040`)
- [ ] Local `subscriptions.status` → `active`, plan flipped
- [ ] `credit_ledger` shows **exactly one** grant of the tier's `credits_per_month`
      (identical to the INR rail — the plan row is shared, only the mandate currency differs)
- [ ] Replay the same webhook from the inspector → **no second grant**

---

### S4 — The export tax invoice, with its INR mirror

```sql
SELECT id, currency, amount_cents, invoice_number, invoice_type, is_export,
       taxable_value_minor, total_tax_minor,
       inr_amount_minor, inr_taxable_value_minor, inr_total_tax_minor,
       fx_rate_micros, fx_rate_source, pdf_url
FROM invoices WHERE client_id = <US_CLIENT_ID> ORDER BY id DESC LIMIT 1;
```

- [ ] `currency = 'usd'`, `amount_cents = 900`, `invoice_number` allocated, `is_export = true`
- [ ] `inr_amount_minor` equals Razorpay's `base_amount` for that payment **exactly** —
      check the payment in the dashboard; the document must tie to the settlement to the paisa
- [ ] `fx_rate_source = 'razorpay_base_amount'`, `fx_rate_micros` ÷ 1e6 ≈ the day's USD rate
- [ ] `inr_taxable_value_minor + inr_total_tax_minor = inr_amount_minor`
- [ ] With a **LUT** filed: `total_tax_minor = 0` and the PDF prints
      *"Supply meant for export under LUT without payment of IGST (…)"*
- [ ] Without a LUT: IGST is carved out of the $9 and the PDF prints
      *"SUPPLY MEANT FOR EXPORT ON PAYMENT OF INTEGRATED TAX"* — and the **rupee** IGST figure
      is what you actually remit
- [ ] PDF shows `$9.00` as the total, `Place of supply: 96 – Outside India`, the country of
      destination, and an INR block: `1 USD = ₹…`, `Total (INR) ₹…`, *Rule 34(2)*
- [ ] PDF does **not** contain a rupee sign on the document total, and does not state the
      dollar total in rupee words
- [ ] The invoice **email** announces `$9.00`, not `₹9.00`

**Then check the refusal paths** — each must leave the row legacy, retryable and visible,
never a wrong document:

- [ ] Clear `inr_amount_minor` on an un-numbered paid row → stays legacy; appears in
      `unnumbered_charges` in `GET /superadmin/billing/reconciliation`
- [ ] A USD charge whose client `billing_country` is `IN` → refused (a foreign charge on a
      domestic supply is a contradiction, not an edge case)

---

### S5 — Top-ups stay closed even with the flag on ⚠️ expected

```bash
# `amount` is the pack's INR price — see GET /credits/packs for the live list.
curl -s -X POST http://localhost:8000/credits/topup \
  -H "X-API-Key: $US_KEY" -H 'Content-Type: application/json' \
  -d '{"amount":<PACK_INR>,"billing_country":"US"}' | jq
```

- [ ] **409** with `reason: "intl_usd_pending"` and the Contact-sales payload
- [ ] Same call with `$IN_KEY` → succeeds

`create_topup_order` still charges the INR pack price. Opening it would bill a foreign buyer
rupees on a supply classified as an export. USD top-up packs are a follow-up.

---

### S6 — Extra operator seat bills in USD

```bash
# `delta` is the CHANGE, not the total: +1 adds one seat above the plan's included floor.
curl -s -X POST http://localhost:8000/subscriptions/seats \
  -H "X-API-Key: $US_KEY" -H 'Content-Type: application/json' -d '{"delta":1}' | jq
```

- [ ] Response quotes **$5** (`EXTRA_SEAT_PRICE_USD_CENTS`), not ₹499
- [ ] The Razorpay add-on hangs off `plan_TLFBRlMIoz1QeC` (the USD seat plan)
- [ ] After authorization, `operator_quantity` bumps by 1
- [ ] Unset `RAZORPAY_SEAT_PLAN_ID_USD` and retry → clean failure naming that env var; it must
      **never** silently bill the ₹499 INR seat plan

---

### S7 — A missing USD plan id fails loudly

```bash
cd api && .venv/bin/python scripts/set_razorpay_plan_ids.py --starter-monthly-usd null --apply
```

- [ ] `/checkout/quote` now returns `checkout_supported: false`, `reason: "intl_usd_pending"`,
      `contact_sales` set — the quote must not promise a checkout the charge path would reject
- [ ] `POST /checkout` returns **400**, not a rupee charge
- [ ] **Restore it:** `--starter-monthly-usd plan_TLFB8lG6zmggVB --apply`

---

### S8 — Referral / coupon discount mints a USD plan, not a rupee one

Apply a discount code to a USD checkout, then:

```sql
SELECT base_plan_id, billing_cycle, discount_bps, currency, razorpay_plan_id
FROM discounted_plan_cache ORDER BY id DESC LIMIT 5;
```

- [ ] The new row has `currency = 'USD'` and its Razorpay plan is priced in dollars
      (10% off $9 → **$8.10**)
- [ ] Running the same discount on `$IN_KEY` produces a **separate** row with `currency = 'INR'` —
      two rails, two cached plans. A shared row would charge one of them in the wrong currency
      (this is what migration `c5a8d3e0b912` fixed)

---

### S9 — Flag off restores the Contact-sales path

Set `INTL_PAYMENTS_ENABLED=false`, restart the API.

- [ ] `/checkout/quote` → `checkout_supported: false`, `reason: "intl_usd_pending"`
- [ ] `POST /checkout` → **409** with the same contract
- [ ] The billing UI renders the **Contact sales** CTA, not a dead payment button
- [ ] The domestic rail is completely unaffected — re-run S1 with `$IN_KEY`

Restore `true` before continuing.

---

### S10 — Geo mismatch is logged, not enforced

From a foreign-looking IP (or with `resolve_country` stubbed), send a checkout claiming
`billing_country: "IN"`.

- [ ] The charge proceeds on the **INR** rail (the claim wins — an Indian resident abroad must
      not be forced onto USD; FEMA-safe)
- [ ] The API log contains `Billing geo mismatch: client=… claims billing_country=IN but IP geo detected …`

---

### S11 — Lifecycle stays on the USD rail

- [ ] **Change plan** Starter → Standard on the US client → new mandate uses
      `plan_TLFBQzoxkBVVar` ($19), never the INR Standard id
- [ ] **Cancel** → the Razorpay dashboard shows the subscription **still active** (the
      gateway cancel is deferred to `task_execute_pending_cancellations`), and the mutation
      targets the *account-level* subscription (`bot_id IS NULL`)
- [ ] **Resume** before the sweep → `mandate_action: "none"`, **no checkout opens**, the
      banner clears immediately, and `current_period_end` + the credit balance are unchanged
- [ ] **Resume after the sweep** (stamp `gateway_cancel_executed_at`, or pull
      `current_period_end` inside the lead window and run the cron) → still USD, and the
      new subscription carries `start_at = current_period_end` so the customer is **not**
      charged a full cycle today
- [ ] **Dunning:** drive the USD subscription to `halted`, then
      `GET /subscriptions/payment-recovery` → returns the existing subscription's `short_url`.
      It must **never mint a new mandate** — two live mandates double-charge

---

## 4. Known-good failures — do not chase these

| Observation | Why it is correct |
|---|---|
| A USD charge with no `base_amount` never gets numbered | No defensible Rule 34(2) rate → no document, rather than a guessed one (S4) |
| Top-up 409s for a US client with the flag on | `create_topup_order` is INR-only (S5) |
| No UPI on a USD quote | UPI is a domestic rail (S1) |
| A tier with no USD id hard-errors | Deliberate; the alternative is charging rupees (S7) |
| An account with `billing_country IS NULL` charges INR | Unconfirmed ⇒ domestic; every pre-relaunch account is an INR mandate |

---

## 5. Teardown

- [ ] Cancel every test-mode subscription created during the run (they keep attempting charges)
- [ ] Restore any plan id cleared in S7 — verify with
      `.venv/bin/python scripts/set_razorpay_plan_ids.py`
- [ ] Restore `INTL_PAYMENTS_ENABLED=true` if S9 left it off
- [ ] Delete the throwaway US client, or leave it — it is a useful fixture for the next run

---

## 6. Not covered locally

- **Real settlement.** Razorpay settles to an INR bank account; the FX rate and settlement
  timing on a USD charge cannot be observed in test mode. Test-mode `base_amount` values are
  not a real bank rate, so S4 proves the *plumbing*, not the *number*.
- **The FIRC / eFIRA.** Export status under s.2(6)(iv) IGST Act requires receipt in
  convertible foreign exchange. Razorpay issues the FIRC on live settlements only — confirm
  with the CA that its Razorpay documentation satisfies the condition before filing.
- **Whether International Cards will be approved.** The only gate that matters for production,
  and it is a Razorpay account decision, not a code path.
