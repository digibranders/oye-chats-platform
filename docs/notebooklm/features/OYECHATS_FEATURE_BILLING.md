# OyeChats Feature: Credit-Based Billing & Invoicing

*This document is a self-sufficient NotebookLM knowledge source on ONE OyeChats feature: usage-metered credits, real invoicing, and what happens when a subscription lapses. Evidence tags: [T1] = confirmed directly in current code, [T2] = confirmed in project documentation, [T3] = positioning/marketing language, [VERIFY] = could not be confirmed with certainty in this pass.*

---

## 1. What This Feature Is

OyeChats doesn't charge customers a flat fee for "unlimited AI." It runs on a **credit ledger** — every plan grants a pool of credits, and specific billable actions (like ingesting a document during training) draw from that pool. Alongside the ledger sits a **real invoicing system** — every charge produces a numbered, immutable, legally-formatted invoice, not just a payment-gateway receipt. [T1: `api/app/services/credit_service.py`, `invoice_service.py`]

The billing model is built around one deliberate design decision: **a lapsed subscription pauses a customer's trained knowledge — it does not delete it.** [T1: `api/app/services/knowledge_state_service.py`]

## 2. Who Cares & Why

- **The business owner / decision-maker (CEO/CMO/founder):** wants predictable, usage-aligned cost — not a black box, and not the fear that missing a payment wipes out weeks of training work.
- **Finance/accounts teams:** need real, numbered invoices for their own books, not just a card statement.
- **OyeChats itself:** needs a billing model resilient to failed payments, partial ingestion jobs, retried webhooks, and refunds — without ever silently double-charging or silently losing a customer's paid-for credits.

## 3. How It Actually Works

### The credit ledger
Every credit grant and deduction is an **append-only, event-sourced ledger entry** (`CreditLedger` table) — nothing is ever overwritten, only appended, so the full history of how a balance got where it is stays auditable. [T1: `credit_service.py`, `CLAUDE.md` schema section] Credits are granted from several sources:
- **Plan credits** — the monthly/period allotment tied to a subscription (`grant_for_subscription`, `grant_plan_credits`). [T1]
- **Top-ups** — one-off purchased credit packs (`grant_topup`), tracked with **FIFO expiry** via a self-referencing `grant_id` — oldest purchased credits are consumed first. [T1: `credit_service.py`, `CLAUDE.md`]
- **Manual grants** — support/ops-issued credits (`grant_manual`). [T1]

Deductions happen through a **kill-switch-aware** function: a global pricing-config flag can pause all deductions platform-wide if needed, and any deduction call raises a specific `InsufficientCredits` error rather than silently failing or overdrafting. [T1: `credit_service.py` — `KillSwitchActive`, `InsufficientCredits`]

Some billable actions carry an **idempotency key** — today this is used specifically for crawl/document ingestion (`ingest:{client_id}:{bot_id}:{crawl_job_id}:{url_sha}`), so a retried ingestion job (e.g., after a worker restart) can never double-charge for the same URL. The live visitor-facing `/chat` path deliberately does not use this mechanism the same way [T1: comment in `credit_service.py` — exact chat-path billing semantics not fully traced in this pass, flagged **[VERIFY]**].

Every billable action that isn't explicitly priced still costs credits — a defensive default (`_DEFAULT_CREDIT_COST = 1`) rather than silently being free, with the gap logged so pricing omissions get caught rather than hidden. [T1: `credit_service.py`]

### Plans and entitlements
A `Plan` record defines the commercial shape of a tier: price, `credits_per_month`, included operator seats, and feature flags (`plan_service.py`, `plan_entitlements_service.py`, `CLAUDE.md` schema). Entitlements — what a plan tier actually unlocks — are resolved through a dedicated service rather than scattered conditionals, so feature gating stays centralized. [T1]

### Invoicing
Every charge that reaches a terminal, chargeable state produces a real `Invoice` row with an **allocated, sequential invoice number** (`allocate_invoice_number`) and a rendered PDF (WeasyPrint-based — `invoice_pdf.py`). Invoice numbers are treated as **immutable once assigned** — the code explicitly refuses to re-touch a `finalized` invoice number. [T1: `invoice_service.py` — "already finalized — immutable, never re-touch"]

There's a **self-healing reconciliation** guard: the system can detect a charge that was captured by the payment gateway but somehow never got a legal invoice number (`invoice_number IS NULL`) and treat that as a state requiring active reconciliation rather than a silently un-documented charge. [T1: `invoice_service.py`, `gateway_reconciliation.py`] Refunds/adjustments are handled via **credit notes** issued against the original invoice number, not by mutating the original document. [T1: `invoice_service.py` — `CREDIT_NOTE_SERIES_PREFIX`]

### Cancellation, dunning, and the lapse-pauses-not-deletes model
Cancellation is a **two-state model**, confirmed directly in the current code:
- `cancel_at_period_end` — a **reversible intent** flag the customer sets (e.g., clicking "Cancel" in the dashboard). [T1: `razorpay_service.py`]
- `gateway_cancel_executed_at` — an **irreversible fact**, written only once the cancellation has actually been executed against the payment gateway (Razorpay) at period end. [T1: `razorpay_service.py` line ~2967]

Until the gateway-side execution happens, a customer can reverse their own cancellation for free (a flag flip, not a new checkout). [T1 — confirmed by direct code inspection of `cancel_subscription`, `cancel_subscription_by_id`, and the `/resume` guard logic]

**Failed-payment recovery (dunning)** follows a fixed cadence tied to how Razorpay itself retries a failed recurring charge: day 0 (`failed_0` — a calm heads-up), day 3 (`halted_3` — retries exhausted), day 5 (`warning_5` — urgent, before suspension). [T1: `dunning_service.py` — `DUNNING_CADENCE`] Recovery uses Razorpay's own hosted page to let the customer retry the same instrument or swap payment methods, **without creating a new subscription** — this matters because an at-cycle-end cancellation is irreversible at the gateway (nothing left to re-authorize), so a genuinely halted-but-still-alive subscription is deliberately *not* treated the same way. [T1: `dunning_service.py` module docstring]

**What actually happens on lapse:** when a bot's subscription lapses to the Free tier, `deactivate_bot_knowledge` sets every one of that bot's trained document chunks to `is_active = False`. It does **not** delete rows. The function explicitly no-ops if the bot still has a funded subscription (so an upgrade cutover isn't mistaken for a real lapse), and is idempotent (a repeated call, e.g., from a redelivered webhook, is a no-op). [T1: `knowledge_state_service.py` — `deactivate_bot_knowledge`, direct code read] This is the literal mechanism behind the "lapse pauses, doesn't delete" claim — not a marketing simplification.

## 4. What It Looks Like

- **Admin Dashboard → Billing page** — current plan, next payment date, cancel/reactivate controls, payment method management. [T1: `app/src/pages/Billing.jsx`, referenced in `CLAUDE.md` Key Files]
- **Admin Dashboard → Usage page** — credit balance, consumption over time, per-bot credit usage, a scoped top-up action.
- **Invoices** — downloadable, numbered PDF documents (WeasyPrint-rendered), delivered via email as well as available for download in-dashboard.
- **Dunning emails** — the day-0/day-3/day-5 sequence, each with a recovery link to Razorpay's hosted retry page when the subscription state is still recoverable.

## 5. A Real Scenario Walkthrough

A growing e-commerce business is on a mid-tier plan with a monthly credit allotment. Mid-month, a large product-catalog re-crawl consumes more credits than expected and the balance runs low before the next billing cycle. Rather than the chatbot silently breaking, the dashboard's Usage page shows the shrinking balance, and the business tops up with a one-off credit pack — the FIFO ledger means those new credits sit correctly in queue behind any still-unexpired ones from a prior top-up.

Three months later, a card on file expires and the monthly renewal charge fails. The system doesn't suspend the account instantly — it follows the day-0/day-3/day-5 dunning cadence, giving the business several chances to update payment details via Razorpay's own recovery page. If the business genuinely lets it lapse — say, they're mid-transition to a new card and miss every email — the bot's trained knowledge is deactivated, not deleted. When they finally update payment and the subscription becomes funded again, the same documents are simply reactivated rather than the business having to re-train the bot from scratch.

## 6. Capabilities vs Limits

- **Live and confirmed:** Razorpay is the **sole live payment rail**, and billing/settlement is in **INR**. [T1: `CLAUDE.md` — "Billing (Razorpay, INR — single rail)"; confirmed again directly in `razorpay_service.py`]
- **Built but explicitly gated off:** a USD payment rail exists in the codebase (`INTL_PAYMENTS_ENABLED` env flag, USD-specific Razorpay plan IDs, an `IntlPaymentsDisabled` exception raised whenever a USD charge is attempted while the flag is off). The flag **defaults to `false`** and code explicitly refuses USD charges unless it's turned on. [T1: `api/app/config.py` — `INTL_PAYMENTS_ENABLED = os.getenv(..., "false")`; `razorpay_service.py` kill-switch checks] **Do not present multi-currency/USD billing as a live capability** — it is a built, tested, but currently disabled rail. [Ties to prior session finding: `multicurrency-model-decision` memory — a geo-split INR/USD plan was designed; this pass confirms the USD side exists in code but is off by default.]
- **Not found in this pass:** a specific published table of "which action costs how many credits" outside the code's internal pricing-config keys — the exact customer-facing credit-cost menu was not located as a single document. **[VERIFY]**

## 7. Evidence & Open [VERIFY] Items

- Confirmed via direct code read (this session): `credit_service.py` (ledger, kill switch, idempotency, default credit cost), `invoice_service.py` (invoice numbering, immutability, credit notes), `invoice_pdf.py` (WeasyPrint rendering), `dunning_service.py` (full file read — cadence, recovery-link semantics), `razorpay_service.py` (cancel-intent vs. cancel-executed fields, USD kill switch), `knowledge_state_service.py` (`deactivate_bot_knowledge` — exact lapse mechanism), `api/app/config.py` (`INTL_PAYMENTS_ENABLED` default), root `CLAUDE.md` ("Billing (Razorpay, INR — single rail)" schema section).
- **[VERIFY]** Exact chat-path (visitor conversation) credit-billing semantics vs. the ingestion path's idempotency-key mechanism — the code comments imply a difference but this pass didn't fully trace the chat-path deduction call site.
- **[VERIFY]** A single customer-facing "what costs how many credits" reference document was not located — only internal pricing-config key names (`credit_cost.<action>`) were confirmed.
- **Resolved this pass, contradicting a possible assumption:** multi-currency/USD is **not** a live claim to make — it's real, tested code sitting behind a default-off flag.
