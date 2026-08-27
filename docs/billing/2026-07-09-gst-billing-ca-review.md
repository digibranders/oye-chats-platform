# OyeChats Billing & GST Invoicing — Senior CA / Tax & Billing-Systems Code Review

> ## ⚠️ Superseded on one point: pricing became GST-EXCLUSIVE on 26 Aug 2026
>
> This review was written on 2026-07-09 against a **GST-inclusive** catalogue: the listed price was
> the amount debited, and the invoice carved 18% back out of it. That is no longer how OyeChats
> charges. Every published price is now a **base** price, exclusive of GST. A domestic customer is
> debited base + GST (`core/tax.py::gross_charge_minor`); an international customer is an export,
> pays no Indian GST, and is charged the listed USD price. Discounts apply to the base and GST is
> computed on the discounted base, per Section 15(3) of the CGST Act.
>
> **The review is left unedited.** It is the record of what was decided in July and why, and the
> trade-off it names in Q8 is exactly the one that drove the change.
>
> Read with that in mind:
> - **Q7 (inclusive vs exclusive)** describes the model that was replaced. Its recommendation, that
>   B2B buyers prefer tax shown on top, is what shipped.
> - **Q8** and the `tax_rate_bps` row in the §3 checklist are inverted under the new model: a rate
>   change now moves the **customer's** price, not net realisation. It also breaks every existing
>   mandate, because each Razorpay plan is minted at base + GST and is immutable, so a rate change
>   means re-minting every plan and re-authorising every customer.
> - **The `price_inclusive = true` lock still holds, and is still correct.** The charge is
>   `base + tax`, so the captured amount is itself tax-inclusive of the base, and the existing
>   `inclusive=True` carve-out recovers the advertised base exactly. Unlocking it would invoice
>   `base × 1.18 × 1.18` against a `base × 1.18` charge. The invoicing engine was not changed.
>
> Current source of truth: `api/app/core/tax.py`, `api/app/services/seller_profile_service.py`, and
> [`razorpay-plan-ids.md`](./razorpay-plan-ids.md#re-minting-for-gst-exclusive-pricing).

> **Reviewer posture:** Chartered Accountant + billing-systems architect, reviewing for GST correctness, cross-border/FEMA exposure, and industry-standard invoicing practice.
> **Codebase:** `development` @ `e594f6d` (2026-07-09) · **Evidence:** read of `core/tax.py`, `core/gstin.py`, `seller_profile_service.py`, `invoice_service.py`, `subscription_routes.py`, `razorpay_service.py`, `invoice_reports.py`.
> **Legal frame:** CGST/IGST Acts 2017, IGST §2(6) (export of service), §2(17) (OIDAR), §12–13 (place of supply), §15 (value), §34 (credit notes), Rule 34/46/53/96A, FEMA (forex realisation), Notif. 12/2024 (B2CL ₹1L).

---

## 0. Verdict (read this first)

**For its *current live scope* — domestic (Indian), INR, GST-inclusive, single-SAC SaaS — the invoicing implementation is genuinely excellent and above the industry norm.** The number-series discipline, immutable snapshots, single-rounding-point tax math, credit-note reversal logic, and reconciliation surface are what I would expect from a mature fintech, not an early-stage SaaS. I would sign off on the **domestic INR** path with only minor items.

**However, the system is *not yet* safe to switch on for cross-border / USD billing.** The cross-border design has one **structural GST/FEMA exposure** (the "export of service" forex-realisation condition) and several **rate/LUT-lifecycle gaps** that must be closed *before* `INTL_PAYMENTS_ENABLED` is flipped. None of these are live bugs today (foreign checkout is correctly short-circuited to "contact sales"), so treat them as **Phase-2 launch blockers**, not production incidents.

**Scorecard**

| Dimension                                     | Grade                         | One-line                                                                                    |
| --------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------- |
| Number series / Rule 46 compliance            | **A**                   | Gapless, per-FY (IST), per-series, allocated only at finalize                               |
| Tax computation (domestic)                    | **A**                   | Integer paise, single rounding point, reconciling identities                                |
| Immutability & audit trail                    | **A**                   | Frozen seller/buyer snapshots; CN recomputes on original params                             |
| Credit notes (§34)                           | **A−**                 | Correct + over-reversal guard; missing 30-Nov time-bar guard                                |
| GSTR-1 sectioning & export                    | **A−**                 | B2B/B2CS/B2CL/EXP/CDNR/CDNUR, formula-injection safe                                        |
| Place of supply (domestic B2C)                | **B**                   | Defensible default, but under-captures recipient state                                      |
| **Cross-border / export zero-rating**   | **C**                   | **Forex-realisation condition not modelled → export claim unsafe on INR settlement** |
| **USD invoicing (statutory INR value)** | **C**                   | Fixed display FX rate ≠ Rule-34 notified rate                                              |
| Rate-change / LUT lifecycle                   | **C+**                  | No effective-dating; no LUT expiry tracking                                                 |
| Input-side GST (RCM on imported SaaS)         | **N/A (out of system)** | Flag for finance: OpenAI/Google/Razorpay = import of OIDAR, RCM                             |

---

## 1. What is implemented correctly (with evidence)

These are the things a GST auditor *specifically* checks, and they pass:

1. **Serial numbering — Rule 46(b).** `allocate_invoice_number()` (`invoice_service.py:74`) allocates a gapless serial per `(financial_year, prefix)` under `SELECT … FOR UPDATE`, **only at finalize**, so an abandoned/failed payment never burns a number. Format `DB/26-27/000042` ≤16 chars. Tax invoices, receipts (`RCT`), and credit notes (`CN`) run on **independent series** so the tax-invoice range stays consecutive (Rule 46 / GSTR-1 Table 13). This is exactly right and rarely done well.
2. **Financial year in IST.** `financial_year_label()` (`invoice_service.py:57`) converts to `Asia/Kolkata` before deciding the FY — a charge at 20:00 UTC on 31 Mar is correctly numbcered in the new FY. Correct and subtle.
3. **Tax identities always reconcile.** `core/tax.py` uses a **single rounding point** and splits the once-rounded `total_tax` (`cgst = total_tax // 2`, odd paisa → SGST). Guarantees `taxable + total_tax == total` and `cgst + sgst + igst == total_tax` — the two identities an audit reconciles. `reconciliation_anomalies.broken_totals` re-checks them in SQL.
4. **Immutability & snapshots.** `finalize_invoice()` (`invoice_service.py:129`) freezes `seller_snapshot`/`buyer_snapshot` and never re-touches a numbered invoice. Credit notes recompute with the **original document's frozen parameters** (`create_credit_note`, `invoice_service.py:234`) so a later rate/LUT change can't alter how an old invoice unwinds. This is the correct audit posture.
5. **Credit note over-reversal guard.** Cumulative reversals are capped at the invoiced consideration (`invoice_service.py:277`), so a partial refund + full chargeback can't over-reverse the tax. Idempotent on the Razorpay refund/dispute id.
6. **GSTIN validation.** `core/gstin.py` does the full structure regex + state-code set + **mod-36 checksum**. Applied to the seller profile and to `Client.billing_state_code`/`gstin` at input (`subscription_routes.py:600`).
7. **Discount handled at value level (§15(3)(a)).** Referral discounts are modelled as **lower-priced Razorpay plans** (`resolve_discounted_plan`), so the customer is charged less and the invoice taxable value derives from the *discounted* charge — the correct treatment for a discount known at the time of supply.
8. **Amount reconciliation (anti-fraud).** `payment.captured` refuses to mint credits unless captured paise == `notes.amount_inr × 100` (`razorpay_service`), raising `RazorpayBillingError` on mismatch.
9. **Activation gate.** No document is issued until the seller profile (legal name + GSTIN) is saved — a receipt bearing an empty legal name is worse than none (`invoice_service.py:158`).

---

## 2. The cross-border / currency question battery

The user's two questions, plus the full set a CA would ask, each answered against the actual code.

### Q1 — Indian user paying from the USA (billing_country = IN, IP = US)

**Handled correctly.** GST keys off the **recipient's place of supply on record**, not physical location or IP. `create_checkout` uses `confirmed_country` (`subscription_routes.py:873`), bills **INR + domestic GST**, and only **logs** the IP mismatch as a GST/FEMA signal (`_is_suspicious_geo_claim`, `:846`) without blocking. ✔ Correct: an Indian customer is a domestic supply wherever they physically sit. The FEMA log is the right instinct — *if* the person is actually a US resident using an Indian identity, that is a genuine forex concern worth a human review.

### Q2 — US citizen paying from India (billing_country = US, IP = IN)

**Handled, with a UX caveat.** A `confirmed_country != "IN"` is short-circuited to `409 intl_usd_pending → contact sales` (`:889`). GST, again, does not care about **citizenship** — it cares whether the recipient/place-of-supply is in India. So:

- If the person is a **US tax resident** consuming from India casually → treated as export (correct to route to the USD/contact-sales path).
- If the person is **resident in India** (US passport but Indian address/GSTIN) → they *should* set `billing_country = IN` and are then billed domestically. The system forces this via billing-details. ✔ legally correct, but a US-passport-holder resident in India who picks "US" cannot self-serve today (acceptable while INTL is off).

### Q3 — Is our cloud chatbot an "OIDAR" service? (the classification that governs everything)

**Yes — and this is not modelled explicitly.** An automated, internet-delivered SaaS with minimal human intervention is squarely **OIDAR** under IGST §2(17). Consequences:

- **Domestic recipients:** normal 18% forward charge. ✔ done.
- **Foreign B2B/B2C recipients:** an Indian supplier → foreign recipient is an **export of service** (the OIDAR *reverse-charge* rules bite **foreign suppliers supplying into India**, not us supplying out). So the export + LUT zero-rating path is the right shape. **But see Q4 — it only qualifies as export if the forex condition is met.**

> **Finding F1 (design):** the code has no notion of "this is OIDAR," which is fine *today* but matters when you add non-SaaS line items (a physical good, consulting) that carry a different SAC/rate — the single-rate model (Q10) would misprice them.

### Q4 — When a foreign customer eventually pays, is the "export of service" zero-rating actually valid? ⚠️ **Biggest finding**

**Not necessarily — and the current code would over-claim zero-rating.** IGST §2(6) requires **all five** conditions for "export of services," including **§2(6)(iv): payment received in convertible foreign exchange (or INR where RBI permits).** Razorpay's standard settlement — and per our own architecture notes, its **international settlement — is INR**. If OyeChats receives **INR** for a foreign sale **without a FIRC/eBRC evidencing forex realisation**, the transaction **fails the export test**, so:

- it is **not** a zero-rated export, and
- `core/tax.py` (`compute_tax`, export + `lut_active`) would nonetheless return **all-taxes-zero** (`tax.py:112`) → **you'd issue a zero-rated invoice on a supply that doesn't qualify → GST short-payment + FEMA (non-realisation of export proceeds) exposure.**

> **Finding F2 (Phase-2 blocker, HIGH):** Do **not** gate zero-rating on `lut_active` alone. Gate it on **evidenced forex receipt**: (a) settle foreign charges through a **forex-settling rail** (Razorpay International / PayPal / Stripe USD payout) that produces a **FIRC/eBRC**, and (b) only then set the invoice to zero-rated export. Absent forex evidence, either treat as a **taxable inter-state supply (IGST)** or do not transact. Retain FIRCs against each export invoice for the GSTR-1 Table 6A / refund trail.

### Q5 — When USD billing goes live, what INR value goes on the invoice?

**A GST invoice is always in INR** (Rule 46 requires the INR value; you may *additionally* show USD). The statutory INR value for an export/foreign sale must use the **rate of exchange under Rule 34** (RBI reference rate / GAAP rate on the **time of supply date**), **not** a static display rate. The code today uses a fixed `DISPLAY_USD_TO_INR = 94.67` for the *marketing display* only (`config.py:283`) — correct for display, **wrong if reused for the invoice's statutory INR value.**

> **Finding F3 (Phase-2 blocker, HIGH):** the USD→INR conversion on the *invoice* must pull the Rule-34 notified rate for `issued_at`, be **snapshotted** on the invoice, and reconcile with the forex actually realised. Also note the "**one USD charge → three different INR figures**" problem (checkout display rate ≠ Rule-34 invoice rate ≠ actual bank settlement rate) — pick the *legally correct* one per surface and record all three for reconciliation.

### Q6 — Place of supply for a **domestic B2C** sale where the customer gives no state?

**Defensible but under-captured.** `supply_kind()` (`tax.py:61`) treats "no buyer state" as **intra-state** (POS = supplier location, per Circular 242/36/2024) → CGST+SGST in the seller's home state. That is a valid default. **But** because `billing_state_code` is optional and most B2C buyers won't fill it, **the overwhelming majority of B2C invoices will default to the seller's state**, which (a) misreports genuinely inter-state B2C as intra-state and (b) parks SGST in the wrong state.

> **Finding F4 (MEDIUM):** capture recipient state at checkout for B2C — a mandatory state dropdown, or derive it from the card/UPI issuer/billing address — so POS reflects the recipient. Not a blocker for revenue, but it improves GSTR-1 accuracy and correct SGST attribution.

### Q7 — Inclusive vs exclusive pricing, and B2B Input Tax Credit

**Inclusive is legal and ITC-safe here.** Prices are GST-inclusive; the invoice still shows the CGST/SGST/IGST breakup, so a B2B buyer can claim ITC. `seller_profile` **hard-rejects `price_inclusive=false`** (`seller_profile_service.py:179`) because checkout collects the sticker price — a sound guard. **Trade-off:** B2B buyers usually prefer **exclusive** (tax shown on top) so the base price is unambiguous, and inclusive pricing means a **GST-rate change silently moves your net realisation** (see Q8). Business decision, not a defect.

### Q8 — What happens to our economics if the GST rate changes (e.g., 18% → some other)?

**With inclusive pricing, a rate change changes your *net revenue*, not the customer's price.** ₹4,599 inclusive: at 18% taxable = ₹3,897 (you keep ₹3,897, remit ₹702); at a lower rate you keep more, higher rate you keep less — the customer always pays ₹4,599. So a statutory rate change **forces a conscious choice**: absorb it (net revenue moves) or reprice the sticker to hold net. The system will silently absorb it unless you also reprice. → covered in the **tax-change checklist** (§3).

### Q9 — Do we handle the reverse case: GST we *owe* on the foreign SaaS we consume (OpenAI, Google, Razorpay, Spider, Jina)?

**Out of the billing system — flag for finance.** OyeChats *imports* OIDAR/services from foreign suppliers. Under IGST §2(11)+ RCM, the **recipient (OyeChats) must self-invoice and pay IGST under reverse charge** on those imports, then claim ITC. The billing codebase correctly doesn't touch this (it's a GSTR-3B/accounting matter), but a review must flag it:

> **Finding F5 (finance process, MEDIUM):** ensure monthly RCM self-invoicing + IGST payment on imported digital services (LLM APIs, crawlers, Razorpay fees where applicable), with ITC claimed. This is a common miss for AI startups.

### Q10 — Single global tax rate — is one `tax_rate_bps` enough?

**Yes for a single-SAC SaaS, no if the catalog diversifies.** One rate per invoice (`seller_profile.tax_rate_bps`, default 1800). SaaS access under SAC 997331 @ 18% is uniform, so fine today. The moment you sell a differently-rated item (a zero-rated export item alongside a taxable one, or a physical good), the header-level single-rate model breaks — `line_items` exists but tax is computed at the header, not per line.

> **Finding F6 (design, LOW today):** per-line tax (rate + HSN/SAC per line) is needed before any multi-rate catalog. `invoice_service.py:206` already notes this as a future enrichment.

### Q11 — Is SAC 997331 the right code?

**Defensible; confirm with your CA.** 997331 = "licensing services for the right to use software." SaaS access is commonly classified here or under 9983xx (IT services) / 998315 (hosting). All 18%. Low risk; document the rationale.

### Q12 — Credit-note timing (§34 time bar)

**Correct mechanics, missing the deadline guard.** GST credit notes that *reduce output-tax liability* must be issued by **30 November following the FY-end** (§34). After that you can still refund, but you **cannot** reduce the GST already remitted. The code issues CNs on any refund/dispute with no date guard.

> **Finding F7 (LOW/MEDIUM):** when creating a CN against an invoice from a prior FY past the 30-Nov window, still refund but **flag that the output-tax reduction is time-barred** (so finance bears the GST knowingly rather than silently mis-filing).

### Q13 — E-invoicing (IRN / signed QR)

**Correctly deferred.** Mandatory only above ₹5 cr aggregate turnover for B2B (and exports). Columns `irn`/`signed_qr` exist and are unused. Good foresight.

> **Finding F8 (watch item):** add a turnover monitor; once >₹5 cr, B2B + export invoices must be registered with the IRP (IRN + QR) within the notified window before issue. The schema is ready; the integration is not.

### Q14 — Merchant-of-record integrity (Digibranders vs OyeChats)

**Verify the legal entity chain.** Invoices are issued under the seller profile's legal name/GSTIN; the money is settled into the **Razorpay merchant account**. These **must be the same legal entity (same PAN/GSTIN)**. If Digibranders is MOR while "OyeChats" is only a trade/brand name, that's fine — *provided* the Razorpay account, PAN, and seller GSTIN all belong to Digibranders.

> **Finding F9 (compliance check, MEDIUM):** confirm Razorpay settlement entity == `seller_profile` legal entity (same PAN/GSTIN). A mismatch means money received by entity A and invoiced by entity B → GST + income-tax exposure.

### Q15 — Prepaid credit top-ups — when is GST due, at purchase or consumption?

**Taxed at purchase — the safe/standard choice.** `payment.captured` creates a tax invoice + GST at top-up time. Credits are a **single-purpose prepaid** usable only for OyeChats services, so time of supply = payment/invoice date is correct (analogous to a single-purpose voucher). Unused-credit refunds unwind via the CN path. ✔

### Q16 — LUT lifecycle

**Not tracked → latent exposure when exports go live.** An LUT is **valid for one FY** and must be renewed each year. `seller_profile.lut_active`/`lut_number` are static booleans with **no validity dates**. If the LUT lapses and `lut_active` stays `true`, every export invoice would be **wrongly zero-rated**.

> **Finding F10 (Phase-2 blocker, MEDIUM):** add `lut_valid_from`/`lut_valid_to`; zero-rate an export only when `issued_at` falls inside the LUT validity window; alert 30 days before expiry.

### Q17 — Rounding to the rupee (§170)

**Fine.** Law permits rounding total tax to the nearest rupee per invoice; the code rounds at paise (more precise). No issue; optionally add per-invoice rupee rounding for cleaner PDFs.

### Q18 — TDS / TCS

**None applicable to collection, but anticipate B2B TDS short-payment.** Razorpay is a payment aggregator (not a §52 e-commerce operator collecting TCS) and OyeChats sells its own service, so no GST TCS. However, some **B2B customers may deduct income-tax TDS** (treating software/SaaS as royalty/FTS under §194J/195). Expect occasional short-payments and reconcile against Form 26AS. Operational, not a code defect.

---

## 3. Parameters to consider for a **TAX-system change**

When GST rules, your registration, or LUT status change, these are the levers and their ripple effects:

| Parameter                                 | Where                      | Ripple effect / caution                                                                                                                                                                                                                                         |
| ----------------------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tax_rate_bps`                          | `seller_profile` (JSONB) | **Inclusive pricing → changes your net revenue, not the customer's price** (Q8). Decide absorb vs reprice. Only affects invoices finalized *after* the edit (snapshotted).                                                                             |
| **Effective date of a rate change** | *not modelled*           | Statutory changes have an effective date; the code applies whatever the profile says at`finalize` time. **Finding F11 (MEDIUM):** add effective-dated rate scheduling so a change lands on supplies *on/after* the notified date, not on deploy time. |
| `gstin` / `state_code`                | `seller_profile`         | New registration → new POS base. Snapshotted, so old docs unaffected.                                                                                                                                                                                          |
| `gst_enabled` (derived from GSTIN)      | `seller_profile`         | Toggling mid-FY switches new docs from`receipt` (RCT series) to `tax_invoice` (DB series). Series are independent, so no gap — correct by design.                                                                                                          |
| `lut_active` + validity                 | `seller_profile`         | Governs export zero-rating.**Needs validity dates (F10).** An expired-but-true LUT silently mis-zero-rates.                                                                                                                                               |
| `sac_code`                              | `seller_profile`         | Confirm classification with CA (Q11). Per-line SAC needs F6.                                                                                                                                                                                                    |
| `price_inclusive`                       | locked`true`             | Unlocking requires a checkout that*adds* tax on top (currently rejected — Q7).                                                                                                                                                                               |
| Export forex evidence                     | *not modelled*           | **F2 — the gating condition for zero-rating.** Must be added before cross-border.                                                                                                                                                                        |
| Rule-34 FX rate for USD invoices          | *not modelled*           | **F3 — statutory INR value.**                                                                                                                                                                                                                            |

**Golden rule:** because every tax field is **snapshotted at finalize**, changes are always prospective and never corrupt issued documents — this is the single best property of the design. The gaps are all about *when* a change should take effect and *what evidence* gates it, not about mutation safety.

---

## 4. Parameters to consider for a **PRICING change**

The one operational fact that surprises everyone:

> **Changing a plan's price in the database does NOT change what any existing customer pays, and does NOT change the amount Razorpay debits.** Razorpay plan amounts are **immutable**. A price change = **create a new Razorpay plan**, point `Plan.razorpay_plan_id_monthly/_annual` at it; existing subscribers stay on their old mandate/price (grandfathered) until they change plans.

| Parameter                                                    | Where                                                | Caution                                                                                                                                                           |
| ------------------------------------------------------------ | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `monthly_price_cents` / `annual_price_cents` (INR paise) | `plans`                                            | The**charged** amount comes from the linked Razorpay plan, not this column. Keep them in sync or `/subscriptions/admin/plan-price-check` will flag drift. |
| `razorpay_plan_id_monthly` / `_annual`                   | `plans`                                            | **The real lever.** New price → new Razorpay plan → repoint. Use `scripts/set_razorpay_plan_ids.py`.                                                    |
| `monthly_price_usd_cents` / `annual_price_usd_cents`     | `plans`                                            | Manually maintained; not live-converted. Update alongside INR on every reprice.                                                                                   |
| Discounted-plan clones                                       | `discounted_plan_cache`                            | On a base-price change the cache self-invalidates (validated against recomputed amount — audit F34) and clones a fresh discounted Razorpay plan. ✔              |
| `annual_discount_percent`                                  | `plans`                                            | **Display only** — the actual annual charge is `annual_price_cents`. Keep consistent or the pricing page lies.                                           |
| Entitlements                                                 | Redis (60s)                                          | Invalidated on plan edit — ✔.                                                                                                                                   |
| Website propagation                                          | DB →`/superadmin` catalog → `oyechats-website` | No deploy needed for copy/price display;**the Razorpay plan wiring is the manual step.**                                                                    |
| Existing subscribers                                         | mandates                                             | Grandfathered. To move them you must run the cancel-and-recreate`/change-plan` flow (proration flag is OFF).                                                    |
| Inclusive-price + rate interaction                           | —                                                   | If you reprice to hold*net* revenue after a rate change, remember the sticker is GST-inclusive (Q8).                                                            |

**Repricing runbook** already exists at `docs/billing/repricing-runbook.md` — cross-check it against this list; the Razorpay-plan-immutability + grandfathering points are the ones people forget.

---

## 5. INR / USD pricing & billing correctness

**Today (INR-only): correct.** Everything charged flows through Razorpay in INR paise; `finalize_invoice` **refuses to finalize any non-INR row** (`invoice_service.py:145`) so a stray non-INR charge can never be taxed as rupees or mint a false tax invoice. USD is purely a **display headline** (fixed columns + `DISPLAY_USD_TO_INR`). This is a clean, safe separation.

**Before USD goes live, the three-rate problem must be resolved.** One nominal "$249" charge spawns:

1. the **display** rate on the pricing page (`DISPLAY_USD_TO_INR`, marketing),
2. the **Rule-34 notified** rate for the invoice's statutory INR value (F3), and
3. the **actual bank settlement** rate when forex is realised (reconciliation).

These are legitimately different numbers. The design must **record all three** and use the *legally correct* one on each surface — the invoice must carry the Rule-34 INR value, snapshotted, and reconcile to the FIRC. And zero-rating must be gated on forex evidence (F2), not the LUT flag alone.

**Recommended cross-border rail decision (for the CTO + CA together):** to make exports genuinely zero-ratable, settle foreign charges through a **forex-settling PSP that issues FIRC/eBRC** (Razorpay International with forex payout, or PayPal/Stripe USD). INR-settled "international" collection defeats the export test and creates FEMA non-realisation risk — matching the `multicurrency-model-decision` and `razorpay-international-settlement` notes already on file.

---

## 6. Findings, ranked

| #               | Sev      | Finding                                                                                                   | Live today?                | Fix                                                          |
| --------------- | -------- | --------------------------------------------------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------ |
| **F2**    | 🔴 HIGH  | Export zero-rating gated on`lut_active`, not on **evidenced forex realisation** (IGST §2(6)(iv)) | No (INTL off)              | Gate zero-rate on FIRC/forex-settling rail; else charge IGST |
| **F3**    | 🔴 HIGH  | USD invoice's statutory INR value would use a fixed display FX, not the**Rule-34** rate             | No (INTL off)              | Pull + snapshot Rule-34 rate at`issued_at`                 |
| **F10**   | 🟠 MED   | **LUT has no validity dates** — an expired LUT still zero-rates                                    | No (INTL off)              | Add`lut_valid_from/to`; window-check + expiry alert        |
| **F9**    | 🟠 MED   | Verify Razorpay settlement entity == seller-profile legal entity (PAN/GSTIN)                              | **Yes**              | Compliance confirmation                                      |
| **F5**    | 🟠 MED   | RCM on**imported** OIDAR (OpenAI/Google/Razorpay/crawlers) — finance process                       | **Yes**              | Monthly self-invoice + IGST RCM + ITC                        |
| **F4**    | 🟠 MED   | Domestic B2C POS under-captures recipient**state** (defaults to seller state)                       | **Yes**              | Capture state at checkout                                    |
| **F11**   | 🟠 MED   | No**effective-dating** for a statutory rate change                                                  | **Yes**              | Effective-dated rate schedule                                |
| **F7**    | 🟡 LOW   | Credit note has no**30-Nov §34 time-bar** guard                                                    | **Yes**              | Warn on cross-FY CN past window                              |
| **F1/F6** | 🟡 LOW   | Single header-level rate; no per-line SAC/rate                                                            | **Yes** (single SAC) | Per-line tax before multi-rate catalog                       |
| **F8**    | ⚪ WATCH | **E-invoicing** unbuilt (fine <₹5 cr turnover)                                                     | **Yes**              | Turnover monitor → IRP integration                          |

None of the 🔴 items are live incidents — they are **conditions on flipping `INTL_PAYMENTS_ENABLED`**. The 🟠/🟡 items are improvements to an already-compliant domestic system.

---

## 7. Recommended sequence

**Now (domestic hygiene):**

1. F9 — confirm the MOR/PAN/GSTIN entity chain (one-time compliance check).
2. F5 — stand up the monthly RCM process for imported digital services.
3. F4 — add a recipient-state field to checkout (better GSTR-1 accuracy).
4. F7 — add the §34 30-Nov guard to `create_credit_note`.
5. F11 — effective-dated rate changes.

**Before `INTL_PAYMENTS_ENABLED = true` (hard gate — do not launch cross-border without these):**
6. F2 — forex-evidence-gated zero-rating + forex-settling rail + FIRC capture.
7. F3 — Rule-34 FX on the invoice, snapshotted, with three-rate reconciliation.
8. F10 — LUT validity window + expiry alerting.
9. Extend `finalize_invoice` to handle non-INR supplies (currently a hard skip at `:145`) with the statutory INR value.

**As you scale:**
10. F6/F1 — per-line SAC/rate when the catalog diversifies.
11. F8 — IRP e-invoicing integration ahead of the ₹5 cr threshold.

---

## 8. Bottom line for leadership

The invoicing engine is **built to a standard I would trust for domestic Indian GST** — the numbering, immutability, and reconciliation are genuinely best-practice and better than most funded startups ship. The risk is **entirely on the cross-border edge**, and the team has *correctly fenced it off* (foreign checkout → contact sales) rather than shipping it half-right. Keep that fence up until F2/F3/F10 are done. The single most important sentence in this review: **an "international" sale settled in INR is not an export for GST, and treating it as zero-rated is the one mistake that turns a clean system into a compliance liability.**

---

*Prepared as a code-grounded CA/tax review. File:line references are against `development` @ `e594f6d`. This is an internal engineering-compliance review, not a substitute for your practising CA's written opinion on OIDAR classification, LUT strategy, and the forex-settlement rail — commission that opinion before enabling cross-border billing.*
