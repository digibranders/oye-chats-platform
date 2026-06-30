# Invoicing & Tax — System Review

**Date:** 2026-06-29 · **Reviewers (roles):** Senior Engineer · QA · CTO
**Scope:** How invoices are modeled, created, displayed, delivered, and managed across OyeChats — plus the complete state of tax/GST handling.
**Method:** Direct source reads of the `Invoice` model, every creation site, the API + admin UI that surface it, the email service, and the Razorpay integration. Findings marked **Confirmed** were verified in code.

Related: [Payment review report](2026-06-29-payment-system-review-report.md) · [Remediation plan](2026-06-29-remediation-plan.md) · [Bug-class appendix](2026-06-29-payment-bug-classes-research-appendix.md)

---

## 1. Executive summary (CTO view)

**OyeChats has no first-class invoicing system, and no tax/GST handling whatsoever.**

What exists is a **payment-history mirror**: a local `invoices` table populated from two Razorpay webhook handlers, surfaced read-only in the admin app as a "Payment History" list. It is not a legal document — there is **no invoice number, no PDF, no tax breakup, no email delivery from OyeChats, and no credit notes**. The columns meant to link to a hosted invoice / PDF (`invoice_url`, `pdf_url`) are **never populated**.

The **de-facto invoice the customer actually receives** is whatever **Razorpay** emits on its side (subscription charges auto-generate a Razorpay invoice; `customer_notify=1` asks Razorpay to email the customer). OyeChats neither generates nor sends anything itself.

**For an India-registered business charging INR via Razorpay, the tax gap is the headline risk:** no GSTIN captured from customers, no CGST/SGST/IGST breakup, no place-of-supply logic, no HSN/SAC code, no tax-invoice document, and no defined tax-inclusive/exclusive policy. B2B customers cannot claim input tax credit, and GST-compliant tax invoices depend entirely on whatever is configured in the Razorpay dashboard (outside this codebase).

| Area | State |
|---|---|
| Invoice data model | ⚠️ Payment-history mirror only |
| Invoice numbering (legal serial) | ❌ None |
| Invoice PDF / hosted page | ❌ `invoice_url`/`pdf_url` never set (dead UI affordance) |
| Invoice/receipt email from OyeChats | ❌ None (relies on Razorpay) |
| Tax / GST (breakup, GSTIN, place of supply) | ❌ None |
| Credit note on refund | ❌ None (only flips `status`) |
| Where managed | Admin "Payment History" (read-only) + Razorpay dashboard |
| Currency display in history | 🐛 Hardcoded `$`, shows INR as dollars |

---

## 2. Data model — `Invoice` (a payment-history row, not a document)

[`api/app/db/models.py:997`](../../api/app/db/models.py) — docstring is explicit: *"Payment history — synced from Stripe/Razorpay via webhooks."*

```
id, client_id, subscription_id
amount_cents            # integer minor units (paise for Razorpay)
currency = "usd"        # ⚠️ model default 'usd'; actually stores provider currency lowercased ("inr")
status  = "pending"     # in practice only ever "paid" / "refunded" / "partially_refunded"
stripe_invoice_id, razorpay_payment_id   # unique
invoice_url, pdf_url    # ❌ NEVER populated by any code path
period_start, period_end, description, paid_at, created_at
```

What's **missing** for a real invoice: invoice number/serial, seller legal entity + GSTIN, buyer legal entity + GSTIN + address, place of supply, taxable value, tax rate, CGST/SGST/IGST amounts, HSN/SAC, line items, totals in words, credit-note linkage.

## 3. Lifecycle — how invoice rows are created

Only **two** code paths create `Invoice` rows, both in [`razorpay_service.py`](../../api/app/services/razorpay_service.py), both hard-coded `status="paid"`:

1. **`_handle_subscription_charged`** ([:1139](../../api/app/services/razorpay_service.py)) — on a recurring cycle, *if* a payment entity is present, inserts an invoice with `amount_cents = pay_entity.amount` (paise), `currency = payment.currency.lower()`, period start/end, description `"{Plan} — {cycle}"`.
2. **`_handle_payment_captured`** ([:1308](../../api/app/services/razorpay_service.py)) — on a top-up, inserts `description="Top-up ₹{amount} pack"`.

**Confirmed gaps in the lifecycle:**
- **Activation writes no invoice.** `_handle_subscription_activated` does *not* create an Invoice — the first charge is only recorded if `subscription.charged` fires with a payment entity (it normally does, but this is an implicit dependency, and ties to finding H4/H5 in the review).
- **Only paid invoices ever exist.** No row is created for `pending`/`failed` payments, so those `status` values are effectively dead. "Payment History" can never show a failed attempt.
- **Refunds flip status, don't issue a credit note.** `_handle_refund_created` sets `status = "refunded" | "partially_refunded"` — correct for display, but India GST requires a **credit note** for a refund/reduction, which doesn't exist.

## 4. Where invoices are surfaced & managed

- **API:** `GET /invoices` ([`subscription_routes.py:430`](../../api/app/api/subscription_routes.py)) — returns the client's last 50 rows (incl. the always-null `invoice_url`/`pdf_url`).
- **Admin UI:** `app/src/pages/Subscription.jsx` renders a **"Payment History"** card (last 10) — description, date, amount, status. It conditionally renders an external-link icon `{inv.invoice_url && …}` — but since `invoice_url` is always null, **the link never appears**. There is **no PDF download** anywhere.
- **Superadmin:** only **aggregate** invoice figures (`PricingInsights.jsx` — "All paid invoices to date"). No per-invoice management, regeneration, or correction.
- **Razorpay dashboard:** the actual system of record for real invoices/receipts (see §6).

**Display bug (Confirmed):** `formatCents` in `Subscription.jsx:41` is `` `$${(cents/100).toFixed(2)}` `` — it **hardcodes `$`** and divides paise by 100. A ₹3,999 charge (399900 paise) renders as **"$3999.00"** — wrong symbol and implies USD. Same helper mis-renders plan prices for INR.

## 5. How invoices are "sent" — they aren't (by OyeChats)

The email service ([`email_service.py`](../../api/app/services/email_service.py)) has ~20 templates (trial lifecycle, leads, transcripts, password reset, affiliate, …) but **no invoice, receipt, or payment-confirmation email**. OyeChats sends the customer **nothing** on a successful charge.

Delivery therefore depends entirely on **Razorpay**:
- Subscriptions are created with **`customer_notify: 1`** ([:356, :487](../../api/app/services/razorpay_service.py)) → Razorpay emails the customer about the mandate/charges and (for subscriptions) auto-generates a Razorpay invoice per cycle.
- **Top-ups use raw Razorpay Orders** (`create_topup_order`) with **no `customer_notify`** and the Razorpay **Invoices API is not used** anywhere (`rzp.invoice.*` appears nowhere). Whether the customer gets a top-up receipt depends on Razorpay dashboard email settings — **verify in the dashboard.**

## 6. Provider-side invoicing (the real records live in Razorpay)

- **Razorpay Subscriptions** auto-create an invoice for each successful charge; these are visible/downloadable in the Razorpay dashboard and emailed when `customer_notify=1`. This is the *actual* invoice the subscription customer receives.
- **Razorpay top-up Orders** do **not** produce a tax invoice by default — Orders are a payment primitive. To get a hosted invoice/PDF for one-time purchases you'd use the **Razorpay Invoices / Payment Links API**, which OyeChats does not call.
- **GST-compliant tax invoices** are produced by Razorpay only if your **GSTIN + tax settings are configured in the Razorpay dashboard** and tax is modeled on the plan/invoice. None of this is driven from code, so it must be **confirmed operationally**.

## 7. Tax / GST — complete gap (Confirmed)

A repo-wide search for `gst|gstin|tax|hsn|cgst|sgst|igst|vat|place_of_supply` returns **nothing** in the billing path. Concretely:

- **No customer tax identity.** `Client` has `company_name` only — **no GSTIN, no billing address, no state/country, no legal entity name.** Without buyer GSTIN + place of supply you cannot issue a B2B tax invoice, and **business customers cannot claim input tax credit** (a real purchase blocker for Indian SaaS buyers).
- **No tax computation or breakup.** Plan prices (`monthly_price_cents`, `annual_price_cents`, top-up packs) carry **no tax line**. There is no CGST/SGST (intra-state) vs IGST (inter-state) split, no tax rate, no taxable-value vs total.
- **Tax-inclusive vs exclusive is undefined.** If OyeChats is GST-registered and the charged amount is final, GST (typically 18% for SaaS) must be **carved out and reported** — today the full charge is treated as undifferentiated revenue.
- **No HSN/SAC code** (SaaS SAC is 9983/998314-style) on any line.
- **No credit note on refund** — GST requires one for refunds/reductions.
- **International (USD) sales:** export of services is either zero-rated under **LUT** or attracts **IGST**; additionally there's no handling of the buyer's local tax (EU VAT, US sales tax). Out of scope for the India market but a gap if selling abroad at volume.

**Net:** tax compliance currently rests entirely on Razorpay dashboard configuration. If that isn't set up with the company GSTIN and tax rates, **no compliant tax invoice is being issued at all.**

## 8. Findings & severity

| # | Finding | Sev |
|---|---|---|
| INV-1 | **No tax/GST at all** — no GSTIN capture, no CGST/SGST/IGST breakup, no place of supply, no HSN/SAC, no tax invoice. Compliance + B2B ITC blocker. | 🔴 |
| INV-2 | **No credit note on refund** (GST requires one); refund only flips `status`. | 🟠 |
| INV-3 | **No invoice/receipt email from OyeChats**; delivery depends on Razorpay `customer_notify`; top-up Orders may send nothing — verify dashboard. | 🟠 |
| INV-4 | **`invoice_url`/`pdf_url` never populated** → dead "download" affordance; no PDF anywhere. | 🟠 |
| INV-5 | **No invoice numbering / legal serial** (India requires unique sequential numbering per FY). | 🟠 |
| INV-6 | **Currency display bug** — `formatCents` hardcodes `$`, renders INR as dollars in Payment History + plan prices. | 🟡 |
| INV-7 | **Top-ups not invoiced provider-side** — raw Orders, Razorpay Invoices API unused; no tax invoice for credit purchases. | 🟡 |
| INV-8 | **Activation writes no Invoice row** — first charge recorded only via `subscription.charged`; implicit dependency. | 🟡 |
| INV-9 | **Only `paid` invoices created** — `pending`/`failed` never persisted; status field partially dead. | 🔵 |
| INV-10 | **`Invoice.currency` model default `"usd"`** while charges are INR; misleading default. | 🔵 |

## 9. Recommendations (phased, industry-standard)

> **Full execution plan:** [`2026-06-29-invoicing-implementation-plan.md`](2026-06-29-invoicing-implementation-plan.md) — an 8-phase, dependency-ordered build for own-issued GST tax invoices (numbering, tax engine, PDF, email, credit notes, reconciliation) with a finance/CA decision gate. The phases below are its executive shape.


**Phase A — Compliance now (mostly operational, low code):**
1. In the **Razorpay dashboard**, configure the company **GSTIN + tax settings** so subscription invoices are GST-compliant and emailed; confirm top-up/Order receipts are enabled. Document that Razorpay is the current invoice system of record.
2. Decide and document **tax-inclusive vs exclusive** pricing; if inclusive, ensure the GST carve-out is reported.
3. Fix **INV-6** (currency-aware formatting: ₹ vs $ by `inv.currency`) and the **INV-4** dead affordance (hide until populated).

**Phase B — Capture tax identity & link real invoices:**
4. Add billing fields to `Client`: legal name, **GSTIN**, billing address, **country/state** (place of supply). Collect at checkout for B2B.
5. Populate `invoice_url`/`pdf_url` from Razorpay's invoice for each subscription charge (and switch top-ups to the **Razorpay Invoices/Payment Links API** so one-time purchases get a hosted tax invoice + PDF).
6. Generate **credit notes** on refund (INV-2), linked to the original invoice.

**Phase C — First-class invoicing module (industry standard):**
7. Sequential **invoice numbering** per financial year; immutable tax-invoice PDF with full GST breakup (CGST/SGST/IGST), HSN/SAC, place of supply, seller+buyer GSTIN, amount in words.
8. **Email delivery** from OyeChats (Brevo template) on every charge + refund (credit note).
9. **Export-of-service** handling for USD (LUT/IGST); optionally a tax engine if expanding internationally.
10. Reconcile invoices to **Razorpay settlements** (ties to the settlement-reconciliation backstop, plan R1).

---

*Read-only review; no code changed. Two items depend on operational verification I can't do from code: (a) whether the Razorpay dashboard is configured with the company GSTIN / tax so compliant invoices are actually issued, and (b) whether top-up Order receipts are enabled. Both should be confirmed in the Razorpay dashboard before relying on provider-side invoicing.*
