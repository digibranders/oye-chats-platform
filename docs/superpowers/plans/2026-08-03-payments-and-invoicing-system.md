# Payments & Invoicing System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn OyeChats' payment stack from "a working charge path with no customer identity" into a complete, industry-standard billing system — durable buyer identity, RBI-compliant saved payment instruments, involuntary-churn recovery, and GST/export invoices that actually reach the customer — on Razorpay alone, serving both Indian and international buyers.

**Architecture:** A Razorpay **Customer** becomes the identity anchor for every paying account (today there is none — verified NULL even on live subscriptions). Payment instruments split into two genuinely different objects on Razorpay: the **subscription mandate** (cannot be swapped in place; replacing it is a re-mandate flow) and **saved tokens** (real CRUD, used for one-off credit top-ups). Card data is never stored — only RBI-permitted metadata mirrored from Razorpay's token API. International buyers ride the same Razorpay account through per-currency Plan objects on the card rail only, because UPI Autopay and eMandate are INR-only.

**Tech Stack:** FastAPI · SQLAlchemy 2.0 · Alembic · PostgreSQL 16 · ARQ/Redis · razorpay-python 2.0.1 · React 19 + TypeScript (app) · Next.js (super-admin console) · pytest

---

## 0. Audit findings — verified current state

Every claim below was verified by direct file read, live API call, or SQL against the dev database on 2026-08-03. This is not a summary of the docs; the docs were treated as claims.

### 0.1 What is genuinely solid

The invoicing **engine** is strong and should not be rewritten. Verified working: the GST tax engine (`api/app/core/tax.py`), gapless per-FY numbering (`invoice_service.allocate_invoice_number`), invoice immutability via a `before_update` guard (`api/app/db/models.py:1447`), credit-note reversal on refund and dispute (`razorpay_service.py:2595`, `:2696`), PDF render + email + recovery sweep (`api/app/worker/tasks.py:1600-1735`), GSTR-1 CSV export (`superadmin_routes_v2.py:1740`), and reconciliation anomalies (`:1845`). 14 invoice test files, 109 passing / 1 skipped.

**The gap is not the engine. It is everything around it: identity, instruments, recovery, and delivery.**

### 0.2 Verified defects and gaps

| #   | Finding                                                                                                                                                                                                                                                                                                                                    | Evidence                                                                                                               |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| F1  | **Invoices are filtered by `bot_id` with no account-level fallback.** `/subscription/current` falls back to the account subscription when an agent has none (`subscription_routes.py:277-281`); `/invoices` does not (`:533`). The Billing page renders an account subscription beside an empty agent-scoped invoice list. | Live API:`GET /subscriptions/invoices` → 2 rows; `?bot_id=1` → 0 rows. Both invoice rows have `bot_id = NULL`. |
| F2  | **The Invoices tab's own Refresh silently changes scope.** `refetchInvoices` calls `getInvoices()` unscoped while the page load is scoped.                                                                                                                                                                                       | `app/src/features/workspace/BillingPage.tsx:602`                                                                     |
| F3  | **`payment_methods` is a dead table.** Nothing in the codebase ever constructs a `PaymentMethod`. Zero rows. Only a super-admin read endpoint touches it.                                                                                                                                                                        | `grep "PaymentMethod("` → only the class definition. `SELECT count(*)` → 0.                                      |
| F4  | **No Razorpay Customer is ever created.** `razorpay_customer_id` lives on `Subscription`, not `Client`, and is only passively scraped from webhook payloads — it is `NULL` on the live active subscription. Without a customer there can be no tokens, so saved payment methods are structurally impossible today.          | `subscriptions.id=3` is `active` with `razorpay_customer_id = NULL`.                                             |
| F5  | **Zero dunning.** `payment.failed` logs and returns (`razorpay_service.py:_handle_payment_failed`). `subscription.halted` silently sets `past_due`. No email, no in-app banner, no recovery CTA — `past_due` only changes a badge colour (`billingModel.ts:311`). The grace cron then expires the plan.                 | Verified by reading both handlers and grepping the frontend for`past_due`.                                           |
| F6  | **Paid checkout does not require billing identity.** `/checkout` gates only on billing *country*. A customer can pay without legal name, address, or GSTIN — so the invoice buyer snapshot is near-empty and Rule 46(f) cannot be satisfied.                                                                                    | `subscription_routes.py:944-1010`; client 2 has 2 paid charges and every billing field `NULL`.                     |
| F7  | **Invoicing is inactive because the seller profile was never saved.** `pricing_config` has no `billing.seller_profile` row, `invoice_counters` is empty, and both existing charges are un-numbered `legacy` rows. Nothing surfaces this state operationally.                                                                 | SQL: 0 rows in both.`invoice_service.py:162` is the activation gate.                                                 |
| F8  | **`POST /superadmin/invoices/{id}/mark-paid` is broken on any numbered invoice.** It writes `paid_at`, which is not in `_INVOICE_FROZEN_EXEMPT`, so the immutability guard raises → 500.                                                                                                                                      | `superadmin_ops_routes.py:185` vs `models.py:1440`                                                                 |
| F9  | **A dead shadowed route.** `superadmin_ops_routes.py:98` registers `GET /superadmin/invoices` on the same prefix as `superadmin_routes_v2.py:1602`, and v2 is included first (`main.py:164-165`). The ops handler is unreachable; its `?status=` filter would silently no-op.                                              | Router prefixes + include order.                                                                                       |
| F10 | **GSTR-1 export and reconciliation have no UI.** Both endpoints exist; `grep -i "gstr\|reconcil"` across `oyechats-admin/src` returns nothing. The monthly CA filing requires a manual curl.                                                                                                                                      | Verified by grep.                                                                                                      |
| F11 | **`finalize_invoice` hard-skips non-INR.** Any USD charge produces no document at all — a blocker for the international rail already in progress.                                                                                                                                                                                 | `invoice_service.py:149`                                                                                             |

### 0.3 Work already in flight (do not duplicate)

There is uncommitted work on the USD rail: migration `b4e7c2f9a801_plan_usd_razorpay_plan_ids.py` adds `plans.razorpay_plan_id_monthly_usd` / `_annual_usd`, and `DiscountedPlanCache` gains a `currency` column in its uniqueness key. This plan builds on that; it does not re-specify it.

---

## 1. Research findings — Razorpay reality vs the Stripe model

The reference model in the brief was Stripe (what Claude uses): billing info captured at checkout and mirrored into the app, payment methods managed in-app. Most of that maps to Razorpay, but **three things do not**, and they reshape the design.

### 1.1 What maps cleanly

| Stripe concept                           | Razorpay equivalent                                                | Status in our code                                     |
| ---------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------ |
| `Customer`                             | `POST /v1/customers` — holds name, email, contact, GSTIN, notes | **Missing (F4)**                                 |
| `PaymentMethod` attached to a customer | Token:`GET /v1/customers/{id}/tokens`                            | **Missing (F3)**                                 |
| Detach a payment method                  | `DELETE /v1/customers/{id}/tokens/{token_id}`                    | Missing                                                |
| Save a card at checkout                  | Checkout options`customer_id` + `save: 1`                      | Missing                                                |
| Hosted card entry (never touch PAN)      | Razorpay Standard Checkout (hosted iframe)                         | **Already correct** — keeps us in PCI-DSS SAQ-A |
| Invoice PDF + hosted URL + email         | Self-issued (required for GST Rule 46)                             | **Already built**                                |

All four token operations exist in the installed SDK (razorpay 2.0.1): `client.customer.create/fetch/edit`, `client.token.all(customer_id)`, `client.token.fetch(customer_id, token_id)`, `client.token.delete(customer_id, token_id)`.

### 1.2 The three divergences that change the design

**D-1 — You cannot change the payment method on a live subscription.** Razorpay's subscription update works only for card-authorized subscriptions and only for plan amount/duration/quantity — not the instrument — and does not work at all for UPI or eMandate mandates. So "update my card" cannot be a `PUT default_payment_method`. It must be: mint a new subscription → customer authorizes the new mandate → cancel the old one. **The codebase already implements exactly this dance** for plan upgrades (`transition_service.execute_paid_upgrade` + `rebuild_upgrade_checkout` + the `upgrade_pending_subscription_id` marker). Reuse it. Do not build an API that cannot work.

**D-2 — Card data cannot be stored, including expiry.** Under RBI card-on-file tokenization, merchants may retain only the last four digits, the network, and issuer metadata. Cardholder name, BIN/IIN, and **expiry** may not be stored. Our existing `payment_methods` table has `expiry_month` / `expiry_year` columns — they must be dropped, and Razorpay must be the source of truth with a local mirror for display only.

**D-3 — International recurring is card-only.** Razorpay accepts 100+ currencies but **always settles in INR**, at the FX rate fixed at payment creation, and the International Payments feature is activation-gated on the account (an application, not a code change). Card recurring supports foreign currencies; **UPI Autopay and eMandate/eNACH are INR-only.** Consequence: a USD checkout must offer the card rail only, and a Razorpay Plan's currency is fixed at creation — hence the per-currency plan IDs already in flight.

**D-4 — RBI's E-mandate Framework 2026 caps silent auto-debit at ₹15,000 per transaction, and it now covers cross-border.** The RBI notified the consolidated *Digital Payments – E-mandate Framework, 2026* on **21 April 2026, effective immediately**. It applies to all providers processing recurring **domestic and cross-border** transactions over cards, PPIs and UPI. Key provisions:

- **₹15,000 per transaction** is the ceiling for recurring debit without Additional Factor of Authentication. Above it, the customer must complete AFA **for that specific charge** — the debit does not happen silently. The ₹1,00,000 ceiling applies only to insurance premiums, mutual fund subscriptions and credit card bills; **SaaS does not qualify**.
- Issuers must send a **pre-debit notification at least 24 hours** before each charge and a post-debit notification after, each with an opt-out. **Acquirers are required to ensure merchant compliance.**
- Mandate registration, modification and withdrawal each require AFA, and every mandate must carry a validity period.

*Already handled:* `razorpay_service.py:431` sets `customer_notify: 1` on subscription creation, delegating the pre-debit notification to Razorpay, and `total_count` (100 annual / 120 monthly cycles) supplies a validity period. No code change needed for those.

*Not handled — and this is a pricing constraint, not a technical one:*

| Plan | Annual price | Headroom to ₹15,000 |
|---|---|---|
| Starter | ₹4,308 | 71% |
| Standard | ₹9,108 | 39% |
| **Professional** | **₹13,428** | **10.5%** |

**Professional annual sits ₹1,572 below a hard regulatory cliff.** Raise it past ₹15,000 — or launch any annual tier above that — and every renewal on that plan requires the customer to manually authenticate. That converts a silent renewal into a churn event. Task 3b adds a guardrail so this can never be crossed by accident; the pricing decision itself is the CEO's, not the code's.

*Consequence for Plan C:* because the 2026 framework explicitly covers **cross-border** recurring, the international card rail is inside RBI scope, not merely card-network scope. Do not assume foreign-issued cards escape the ₹15,000 rule — confirm the treatment with Razorpay in the same support thread that requests international recurring.

### 1.3 Prerequisites that are not code

**Razorpay account activation (gates Plan C entirely — start now).** Dashboard state as of 2026-08-03, from `dashboard.razorpay.com/app/payment-methods/international-payments`:

| Product | Dashboard state | Needed for recurring international? |
|---|---|---|
| **International Cards** | **Not requested** ("Request for international cards") | **YES — the only rail that works.** Card is the sole method supporting non-INR recurring; UPI Autopay and eMandate are INR-only (D-3). |
| International Bank Transfers (MoneySaver) | KYC docs verified; **Video KYC failed** | **No.** A collection product — local USD/GBP/EUR virtual accounts for inbound wires. Each wire is customer-initiated, so there is no mandate and nothing can auto-debit a subscription. Useful later for high-ticket annual enterprise invoices; not on this path. |
| PayPal | Activated | **No for subscriptions** — documented as supported on **Standard Checkout only** (not Subscriptions, Payment Links, or Invoices) and has no mandate concept. **Possible for one-off top-ups**, which are Standard Checkout payments — see the caveats below. |

**PayPal is a settlement exception, not just another method.** Unlike every other Razorpay method, PayPal payments settle **directly into the merchant's PayPal wallet** (PayPal then settles to us in INR) rather than through Razorpay settlement. Three consequences before anything is built on it:

- [ ] **Verify a Razorpay `payment.captured` webhook actually fires for a PayPal payment.** Our entire money path — credit grants, `Invoice` creation, GST finalization — is webhook-driven. The docs do not confirm this and settlement demonstrably diverges. Run one test-mode PayPal payment and check `processed_webhooks`. If no webhook fires, an international customer pays and receives nothing.
- [ ] Reconciliation becomes two-sourced: PayPal revenue will not appear in Razorpay settlement reports. Confirm the export-of-services documentation trail (FIRC / e-BRC) with the CA — it differs from the card rail.
- [ ] Refunds draw on the PayPal wallet balance, not Razorpay's. A zero balance blocks refunds.

PayPal is international-currency-only, so it hits the same F11 blocker as the USD card rail: no tax document is issued until Plan C removes the non-INR skip.

- [ ] Request **International Cards** on the live account, **and separately ask Razorpay Support to enable recurring/Subscriptions on international cards**. These are distinct capabilities — enabling one-time international cards does not enable international recurring.
- [ ] In Razorpay's reply, confirm **which currencies are approved**. A Plan's currency is fixed at creation, so each approved currency needs its own Plan objects (the `b4e7c2f9a801` migration covers USD only).
- [ ] Confirm with Razorpay support whether **tokenization is available for foreign-issued cards** on our account. The public docs do not state this, and it determines whether Phase 2's saved-cards feature is India-only.
- [ ] The **seller profile** must be saved in production (F7). Until then every real charge is an un-numbered `legacy` row with no tax document.

> Independent of Razorpay approval, `invoice_service.py:149` hard-skips non-INR (F11), so an approved USD rail would still issue **no tax document** until Plan C fixes it. Approval alone does not make USD safe to sell.

---

## 2. Architecture decisions

**A-1. `clients.razorpay_customer_id` is the anchor.** Created lazily on the first paid intent (checkout or top-up), idempotently, and synced with the buyer's billing identity. Subscription-level `razorpay_customer_id` stays as a passive mirror; the client-level column is authoritative.

**A-2. The UI presents two distinct concepts, not one list.**

- *Subscription mandate* — read-only ("UPI · gaurav@okhdfcbank" / "Visa ···· 4242"), with a **Replace** action that runs the re-mandate flow (D-1).
- *Saved cards* — genuine add/remove, used for one-click credit top-ups.

Collapsing these into one "Payment methods" list would promise a swap that Razorpay cannot perform.

**A-3. `payment_methods` becomes a display mirror, never a source of truth.** Razorpay's token list is authoritative; we mirror only `last4`, `network`, `issuer`, `type`, `token_id` so the UI and the super-admin console render without a live API call. Expiry columns are dropped (D-2).

**A-4. Dunning is a first-class subsystem, not a webhook side-effect.** Failure → email + in-app banner + a recovery CTA that runs the re-mandate flow, with the existing grace window as the deadline.

**A-5. International is a currency dimension on the existing rail, not a second provider.** One Razorpay account, per-currency Plan objects, card-only for non-INR, export-of-services GST treatment via the existing `supply_kind` / `is_export` / LUT logic in `core/tax.py`.

---

## 3. File structure

**Phase 0 — unblock**

- Modify: `api/app/api/subscription_routes.py` — invoice scope fallback (F1)
- Modify: `app/src/features/workspace/BillingPage.tsx` — scoped refresh (F2)
- Modify: `api/app/api/superadmin_ops_routes.py` — delete shadowed route (F9), fix mark-paid (F8)
- Modify: `api/app/main.py` — billing-readiness signal (F7)
- Test: `api/tests/test_invoice_scope.py`, `api/tests/test_billing_readiness.py`

**Phase 1 — customer identity**

- Create: `api/app/services/razorpay_customer_service.py` — create/fetch/sync the Razorpay customer
- Create: `api/alembic/versions/*_client_razorpay_customer_id.py`
- Modify: `api/app/db/models.py` — `Client.razorpay_customer_id`
- Modify: `api/app/api/subscription_routes.py` — billing-identity gate on `/checkout`
- Modify: `app/src/features/workspace/billing/usePlanCheckout.ts` — handle the gate
- Test: `api/tests/test_razorpay_customer.py`, `api/tests/test_checkout_billing_gate.py`

**Phase 2 — saved instruments**

- Create: `api/app/services/payment_method_service.py` — token sync + delete
- Create: `api/app/api/payment_method_routes.py` — customer-facing CRUD
- Create: `api/alembic/versions/*_payment_methods_rbi_columns.py`
- Create: `app/src/features/workspace/billing/PaymentMethodsPanel.tsx`
- Test: `api/tests/test_payment_methods.py`

Each file has one responsibility: the customer service owns identity, the payment-method service owns instruments, the routes own HTTP shape and authorization. No business logic in route handlers — matching the existing `invoice_service` / `credit_service` convention.

---

## 4. Phase 0 — Unblock (ship first)

Outcome: your two existing charges become real, numbered, downloadable GST invoices, and the console stops lying about invoice state.

### Task 1: Invoice list falls back to account scope

**Files:**

- Modify: `api/app/api/subscription_routes.py:520-533`
- Test: `api/tests/test_invoice_scope.py`

- [ ] **Step 1: Write the failing test**

```python
"""Invoice list scoping — an agent with no subscription of its own must show
the ACCOUNT's invoices, mirroring /subscription/current's fallback (F1)."""

import os

import pytest

from app.db.models import Bot, Client, Invoice, Plan, Subscription

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")


def _client(db, email="scope@test.dev"):
    c = Client(name="Scope", email=email, api_key=f"key-{email}")
    db.add(c)
    db.flush()
    return c


def _bot(db, client, key="bot-scope-1"):
    b = Bot(client_id=client.id, bot_key=key, name="Agent")
    db.add(b)
    db.flush()
    return b


def _invoice(db, client, *, bot_id=None, amount=94900):
    inv = Invoice(client_id=client.id, bot_id=bot_id, amount_cents=amount, currency="inr", status="paid")
    db.add(inv)
    db.flush()
    return inv


def test_agent_without_own_subscription_sees_account_invoices(db):
    from app.api.subscription_routes import _resolve_invoice_scope

    client = _client(db)
    bot = _bot(db, client)
    _invoice(db, client, bot_id=None)

    # No Subscription row for this bot → scope collapses to account-wide.
    assert _resolve_invoice_scope(db, client.id, bot.id) is None


def test_agent_with_own_subscription_stays_scoped(db):
    from app.api.subscription_routes import _resolve_invoice_scope

    client = _client(db, "scope2@test.dev")
    bot = _bot(db, client, "bot-scope-2")
    plan = Plan(name="Standard", slug="standard-scope", monthly_price_cents=94900, credits_per_month=6000)
    db.add(plan)
    db.flush()
    db.add(Subscription(client_id=client.id, bot_id=bot.id, plan_id=plan.id, status="active"))
    db.flush()

    assert _resolve_invoice_scope(db, client.id, bot.id) == bot.id


def test_no_bot_id_is_always_account_wide(db):
    from app.api.subscription_routes import _resolve_invoice_scope

    client = _client(db, "scope3@test.dev")
    assert _resolve_invoice_scope(db, client.id, None) is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && uv run pytest tests/test_invoice_scope.py -v`
Expected: FAIL with `ImportError: cannot import name '_resolve_invoice_scope'`

- [ ] **Step 3: Write the implementation**

In `api/app/api/subscription_routes.py`, add above `list_invoices`:

```python
def _resolve_invoice_scope(session: Session, client_id: int, bot_id: int | None) -> int | None:
    """Resolve which invoices a Billing view should show.

    Mirrors ``get_current_subscription``'s fallback exactly: an agent with no
    subscription of its own draws on the ACCOUNT plan, so it must show the
    account's invoices. Without this the Billing page renders an account
    subscription beside an agent-scoped (empty) invoice list — the two panels
    can never agree, which is what made a paying customer see "No invoices yet"
    while their plan showed Active.
    """
    if bot_id is None:
        return None
    return bot_id if get_subscription_for_bot(session, client_id, bot_id) is not None else None
```

Then in `list_invoices`, replace the filter construction:

```python
    with get_session() as session:
        scope_bot_id = _resolve_invoice_scope(session, client.id, bot_id)
        stmt = (
            select(Invoice)
            .where(
                Invoice.client_id == client.id,
                *([Invoice.bot_id == scope_bot_id] if scope_bot_id is not None else []),
            )
            .order_by(Invoice.created_at.desc())
            .limit(50)
        )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd api && uv run pytest tests/test_invoice_scope.py -v`
Expected: 3 passed

- [ ] **Step 5: Verify against the real dev data**

Run:

```bash
KEY=$(psql "$DB_URL" -tAc "SELECT api_key FROM clients WHERE id=2;")
curl -s -H "X-API-Key: $KEY" "http://127.0.0.1:8000/subscriptions/invoices?bot_id=1" | python3 -c "import sys,json; print(len(json.load(sys.stdin)), 'rows')"
```

Expected: `2 rows` (was `0 rows`)

- [ ] **Step 6: Commit**

```bash
git add api/app/api/subscription_routes.py api/tests/test_invoice_scope.py
git commit -m "fix(billing): invoice list falls back to account scope like /current (F1)"
```

---

### Task 2: The Invoices tab refresh keeps its scope

**Files:**

- Modify: `app/src/features/workspace/BillingPage.tsx:339, 569-605`

- [ ] **Step 1: Thread `botId` into the tab**

At the render site (line 339), pass the scope down:

```tsx
          {activeTab === 'invoices' && (
            <InvoicesTab
              invoices={data.invoices}
              hasError={data.invoicesError}
              onRetry={reload}
              botId={billingBotId}
            />
          )}
```

- [ ] **Step 2: Accept and use it**

Change the `InvoicesTab` signature and its refetch:

```tsx
function InvoicesTab({
  invoices,
  hasError,
  onRetry,
  botId,
}: {
  invoices: InvoiceView[];
  hasError: boolean;
  onRetry: () => void;
  botId: number | null;
}): ReactElement {
```

```tsx
  // Silent, in-place refetch of just the invoices list - never the parent's
  // page-blanking reload. MUST carry the same scope as the parent load, or
  // Refresh silently swaps between agent-scoped and account-wide results.
  const refetchInvoices = useCallback(async (): Promise<void> => {
    const raw = await getInvoices(botId ?? undefined);
    const next = (Array.isArray(raw) ? raw : []).map((row, index) => buildInvoice(row, index));
    setPolled(next);
  }, [botId]);
```

- [ ] **Step 3: Verify lint and build**

Run: `cd app && npm run lint && npm run build`
Expected: 0 errors, build succeeds

- [ ] **Step 4: Commit**

```bash
git add app/src/features/workspace/BillingPage.tsx
git commit -m "fix(billing): invoice tab refresh keeps the page's agent scope (F2)"
```

---

### Task 3: Surface billing readiness so invoicing can never be silently off

Rationale: F7 cost you two un-numbered charges and was invisible. An unset seller profile must not page oncall as "API down", so this adds a `billing` block to the health payload **without** affecting `fully_ok`.

**Files:**

- Modify: `api/app/main.py` (inside `_gather_health`)
- Test: `api/tests/test_billing_readiness.py`

- [ ] **Step 1: Write the failing test**

```python
"""Billing readiness is reported in /health/full without gating fully_ok (F7)."""

import os

import pytest

from app.services.seller_profile_service import save_seller_profile

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")


def test_billing_block_reports_inactive_when_seller_profile_unset(db):
    from app.main import _billing_readiness

    assert _billing_readiness(db) == {
        "invoicing_active": False,
        "reason": "seller profile not configured",
    }


def test_billing_block_reports_active_once_configured(db):
    from app.main import _billing_readiness

    save_seller_profile(db, {"legal_name": "Digibranders Pvt Ltd", "gstin": "27AAPFU0939F1ZV"}, actor_id=None)
    assert _billing_readiness(db) == {"invoicing_active": True, "reason": None}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && uv run pytest tests/test_billing_readiness.py -v`
Expected: FAIL with `ImportError: cannot import name '_billing_readiness'`

- [ ] **Step 3: Write the implementation**

In `api/app/main.py`, add near the other health probes:

```python
def _billing_readiness(session) -> dict:
    """Is invoicing actually issuing documents?

    The v2 flags default ON, so the seller profile is the real activation gate
    (``invoice_service.finalize_invoice``). An unset profile means every charge
    silently becomes an un-numbered legacy row with no tax document — invisible
    until a customer or a CA asks for an invoice. Reported here so it is
    monitorable, but deliberately NOT folded into ``fully_ok``: it is a
    configuration gap, not an outage, and must not page oncall as "API down".
    """
    from app.services.seller_profile_service import get_seller_profile

    try:
        if get_seller_profile(session).configured:
            return {"invoicing_active": True, "reason": None}
        return {"invoicing_active": False, "reason": "seller profile not configured"}
    except Exception as exc:  # noqa: BLE001 — health checks never raise
        return {"invoicing_active": False, "reason": f"probe failed: {type(exc).__name__}"}
```

Then inside `_gather_health`, after the database check block:

```python
    billing_block = {"invoicing_active": False, "reason": "db unreachable"}
    if db_ok:
        billing_block = _cached_billing_readiness()
```

and include `"billing": billing_block` in the returned payload.

- [ ] **Step 4: Cache the probe**

Two external monitors poll the health endpoints every ~60s. An uncached probe means a fresh ORM session and a `pricing_config` read on every poll, forever, to answer a question whose value changes roughly once in the product's lifetime. The codebase already solved this shape for the LLM probe (`_LLM_PROBE_TTL_SECONDS`, `main.py:262`) — follow it:

```python
_BILLING_PROBE_TTL_SECONDS = float(os.getenv("HEALTH_BILLING_PROBE_TTL_SECONDS", "300"))
_billing_probe_lock = threading.Lock()
_billing_probe_cache: dict = {"ts": 0.0, "value": None}


def _cached_billing_readiness() -> dict:
    """TTL-cached wrapper around :func:`_billing_readiness`.

    Cheap, but polled ~2880×/day across both monitors; the underlying answer
    changes about once ever. 5 minutes is fast enough to catch a
    just-configured profile during a deploy and slow enough to be free.
    """
    now = time.monotonic()
    with _billing_probe_lock:
        cached = _billing_probe_cache
        if cached["value"] is not None and now - cached["ts"] < _BILLING_PROBE_TTL_SECONDS:
            return cached["value"]

    from app.db.session import get_session

    with get_session() as session:
        value = _billing_readiness(session)

    with _billing_probe_lock:
        _billing_probe_cache.update({"ts": now, "value": value})
    return value
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd api && uv run pytest tests/test_billing_readiness.py -v`
Expected: 2 passed

- [ ] **Step 6: Commit**

```bash
git add api/app/main.py api/tests/test_billing_readiness.py
git commit -m "feat(billing): report invoicing activation state in /health/full (F7)"
```

---

### Task 3b: Guardrail — no plan may cross the RBI ₹15,000 auto-debit ceiling

> Added during the CTO review (§9). Numbered 3b because it belongs beside Task 3 — both are guardrails that make an invisible failure visible — and renumbering the rest would break references.

Professional annual is ₹13,428, 10.5% below a hard regulatory cliff (D-4). Nothing in the code knows that. A routine price rise would silently convert every annual renewal on that plan into a manual-authentication event.

**Files:**
- Modify: `api/app/api/superadmin_plan_routes.py` (`update_plan`, `create_plan`)
- Test: `api/tests/test_emandate_ceiling.py`

- [ ] **Step 1: Write the failing test**

```python
"""RBI E-mandate Framework 2026: recurring debit above Rs 15,000 per
transaction requires AFA on every charge, which breaks silent auto-renewal."""

import pytest

from app.api.superadmin_plan_routes import EMANDATE_AFA_CEILING_MINOR, emandate_warning


def test_ceiling_is_fifteen_thousand_rupees_in_paise():
    assert EMANDATE_AFA_CEILING_MINOR == 1_500_000


@pytest.mark.parametrize("amount", [1_342_800, 1_499_999, 1_500_000])
def test_at_or_below_ceiling_is_clean(amount):
    assert emandate_warning(amount, "INR") is None


def test_above_ceiling_warns():
    warning = emandate_warning(1_500_100, "INR")
    assert warning is not None and "15,000" in warning


def test_non_inr_is_out_of_scope_for_the_paise_ceiling():
    # The framework covers cross-border too, but the threshold is expressed in
    # rupees; a USD amount cannot be compared against a paise figure. Plan C
    # resolves the FX-converted test once Razorpay confirms the treatment.
    assert emandate_warning(50_000, "USD") is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && uv run pytest tests/test_emandate_ceiling.py -v`
Expected: FAIL with `ImportError: cannot import name 'EMANDATE_AFA_CEILING_MINOR'`

- [ ] **Step 3: Write the implementation**

In `api/app/api/superadmin_plan_routes.py`:

```python
# RBI Digital Payments — E-mandate Framework, 2026 (notified 21 Apr 2026):
# a recurring debit above this amount requires Additional Factor of
# Authentication on EVERY charge, so the renewal stops being silent and the
# customer must re-authenticate each cycle. The Rs 1,00,000 ceiling applies
# only to insurance, mutual funds and credit card bills — SaaS does not
# qualify. Expressed in paise to match the column.
EMANDATE_AFA_CEILING_MINOR = 1_500_000


def emandate_warning(amount_minor: int, currency: str) -> str | None:
    """Warn when a per-charge amount would forfeit AFA-exempt auto-debit.

    Deliberately a WARNING, not a hard block: pricing above the ceiling is a
    legitimate business decision (an enterprise tier may accept manual
    re-authentication, or bill by invoice instead of mandate). The failure this
    prevents is crossing it *unknowingly*.
    """
    if (currency or "INR").upper() != "INR":
        return None
    if int(amount_minor or 0) <= EMANDATE_AFA_CEILING_MINOR:
        return None
    return (
        f"₹{int(amount_minor) / 100:,.0f} per charge exceeds the RBI e-mandate AFA-exempt "
        f"ceiling of ₹15,000. Auto-debit will require the customer to authenticate every "
        f"renewal. Consider monthly billing or invoice-based collection for this tier."
    )
```

Then in both `create_plan` and `update_plan`, after the plan row is written, collect warnings for each billed amount and return them in the response body (do not raise):

```python
        warnings = [
            w
            for w in (
                emandate_warning(plan.monthly_price_cents, plan.currency),
                emandate_warning(plan.annual_price_cents, plan.currency),
            )
            if w
        ]
```

Add `"warnings": warnings` to the returned dict.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd api && uv run pytest tests/test_emandate_ceiling.py -v`
Expected: 6 passed

- [ ] **Step 5: Surface the warning in the admin plan editor**

In `oyechats-admin/src/app/(dashboard)/plans/`, render any `warnings[]` from the save response as an amber callout above the form. Silent warnings in a JSON body help nobody.

- [ ] **Step 6: Verify current plans are clean**

```bash
psql "$DB_URL" -c "SELECT name, annual_price_cents FROM plans WHERE is_active AND annual_price_cents > 1500000;"
```
Expected: 0 rows (Professional is ₹13,428 — the closest at 10.5% headroom)

- [ ] **Step 7: Commit**

```bash
git add api/app/api/superadmin_plan_routes.py api/tests/test_emandate_ceiling.py oyechats-admin/src
git commit -m "feat(billing): warn when a plan price crosses the RBI e-mandate AFA ceiling"
```

---

### Task 4: Fix the broken mark-paid endpoint and delete the shadowed route

**Files:**

- Modify: `api/app/api/superadmin_ops_routes.py:98-117` (delete), `:169-200` (fix)
- Test: `api/tests/test_superadmin_invoice_ops.py`

- [ ] **Step 1: Write the failing test**

```python
"""mark-paid must not violate the finalized-invoice immutability guard (F8)."""

import os
from datetime import UTC, datetime

import pytest

from app.db.models import Client, Invoice
from app.services import invoice_service
from app.services.seller_profile_service import save_seller_profile

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")


def test_mark_paid_on_a_numbered_invoice_does_not_raise(db, monkeypatch):
    from app import config
    from app.api.superadmin_ops_routes import _apply_mark_paid

    monkeypatch.setattr(config, "INVOICING_V2_ENABLED", True)
    save_seller_profile(db, {"legal_name": "Digibranders Pvt Ltd", "gstin": "27AAPFU0939F1ZV"}, actor_id=None)

    client = Client(name="MP", email="mp@test.dev", api_key="key-mp")
    db.add(client)
    db.flush()
    inv = Invoice(
        client_id=client.id,
        amount_cents=94900,
        currency="inr",
        status="issued",
        paid_at=datetime.now(UTC),
    )
    db.add(inv)
    db.flush()
    assert invoice_service.finalize_invoice(db, inv) is True
    assert inv.invoice_number is not None

    # Must not raise the frozen-column ValueError.
    _apply_mark_paid(inv)
    db.flush()
    assert inv.status == "paid"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && uv run pytest tests/test_superadmin_invoice_ops.py -v`
Expected: FAIL with `ImportError: cannot import name '_apply_mark_paid'`

- [ ] **Step 3: Write the implementation**

In `api/app/api/superadmin_ops_routes.py`, add the helper:

```python
def _apply_mark_paid(inv: Invoice) -> None:
    """Mark an invoice paid without violating the immutability guard.

    ``paid_at`` is a frozen column once an invoice is numbered (models.py
    ``_INVOICE_FROZEN_EXEMPT``) — and rightly so: a numbered document's supply
    date is what its FY serial and GSTR period were derived from. A numbered
    invoice is by definition already paid (it is created from a captured
    charge), so manual reconciliation only ever applies to un-numbered legacy
    rows. For those we stamp both fields; for numbered rows we move ``status``
    only, which IS exempt.
    """
    inv.status = "paid"
    if inv.invoice_number is None:
        inv.paid_at = datetime.now(UTC)
```

Replace the two assignments in `mark_invoice_paid` with `_apply_mark_paid(inv)`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd api && uv run pytest tests/test_superadmin_invoice_ops.py -v`
Expected: 1 passed

- [ ] **Step 5: Delete the shadowed route**

Delete the entire `list_invoices` function and its `@router.get("/invoices")` decorator at `superadmin_ops_routes.py:98-117`, plus the now-unused `_invoice_dict` and `_invoice_provider` helpers at `:74-96` if nothing else references them. It is unreachable: `superadmin_v2_router` registers the same path and is included first (`main.py:164-165`).

Verify nothing else calls it:

```bash
grep -rn "_invoice_dict\|_invoice_provider" api/app --include=*.py
```

Expected: no matches outside the deleted block.

- [ ] **Step 6: Run the full billing suite**

Run: `cd api && uv run pytest tests/ -k "invoice or superadmin" -q`
Expected: all pass

- [ ] **Step 7: Commit**

```bash
git add api/app/api/superadmin_ops_routes.py api/tests/test_superadmin_invoice_ops.py
git commit -m "fix(billing): mark-paid respects invoice immutability; drop shadowed route (F8, F9)"
```

---

### Task 5: Activate invoicing (operational, not code)

> **Executed 2026-08-03 on the dev DB.** Profile saved as `Oyechats pvt ltd`, GSTIN `27AAICD9268J1Z0`, Thane West address, prefix `DB`, SAC `997331`, 18%. Backfill numbered **3** invoices (`DB/26-27/000001-3`); tax math verified (`taxable + tax == total`, intra-state CGST/SGST with correct largest-remainder paisa split); all three PDFs render (~48 KB each) with a Rule 46-compliant layout including `Place of supply: 27 – Maharashtra`.
>
> **The supplied GSTIN `27AAICD9268J1ZO` failed checksum** — final char was the letter `O` where the algorithm requires the digit `0`. There is exactly one valid check digit for that body, so this was an unambiguous O/0 slip; corrected to `…Z0`. **Verify against the GST registration certificate before using it in production.**
>
> Deliberately NOT done: PDFs were rendered to a scratch directory, not uploaded to R2, and **no invoice emails were sent** — running the worker sweep would email real documents to the account holder. `pdf_url` is still NULL, so the customer UI shows the rows without a Download link until the ARQ worker runs.
>
> **Decision now locked in dev, still open for production: the invoice prefix.** `DB` (Digibranders) is the code default and is now baked into the dev FY 26-27 series. Production gets exactly one chance to choose before its first invoice — a numbered series cannot be renamed afterwards without breaking Rule 46(b) consecutiveness.

- [ ] **Step 1: Save the seller profile locally**

Open the super-admin console at `/billing-settings` and save: legal name, GSTIN, registered address, state code, SAC (`997331`), invoice prefix. Or via API:

```bash
curl -X PUT http://127.0.0.1:8000/superadmin/billing/seller-profile \
  -H "X-API-Key: $SUPERADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"legal_name":"<REGISTERED LEGAL NAME>","gstin":"<15-CHAR GSTIN>","address_lines":["<line1>","<line2>"],"invoice_prefix":"DB"}'
```

- [ ] **Step 2: Confirm the backfill numbers the existing charges**

The 5-minute `task_render_invoice_pdfs` cron calls `backfill_unnumbered_invoices` first. With the ARQ worker running (and `DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib` set directly on the python binary — see root `CLAUDE.md`), wait one cycle then:

```bash
psql "$DB_URL" -c "SELECT id, invoice_number, invoice_type, pdf_url IS NOT NULL AS has_pdf FROM invoices WHERE client_id=2;"
```

Expected: both rows numbered `DB/26-27/000001` and `DB/26-27/000002`, `invoice_type = tax_invoice`, `has_pdf = t`

- [x] **Step 3: Check production** — done 2026-08-03, read-only, with authorization.

**Result: production has never taken a real payment. There is nothing to backfill.**

| Probe | Value |
|---|---|
| `pricing_config` rows for `billing.seller_profile` | **0 — not configured** |
| `invoices` | **0 rows** |
| `invoice_counters` | 0 rows |
| `processed_webhooks` | **0 — Razorpay has never delivered a webhook** |
| `credit_ledger` top-up grants | 0 |
| subscriptions | 4 active / 1 canceled / 1 trial_expired — **all with `razorpay_subscription_id` NULL** (manual grants, no gateway mandate) |
| clients | 6 |
| `RAZORPAY_KEY_ID` | `rzp_live_…` — **live mode** |
| `INVOICING_V2_ENABLED` / `INVOICE_EMAILS_ENABLED` | unset in `.env` → both default **True** |

**Interpretation.** This is a clean runway, not a mess: no customer is holding a missing invoice, because no customer has paid. The exposure is forward-looking — the account is on **live** Razorpay keys, so the *first* real payment would land into an unconfigured seller profile and become an un-numbered legacy row with no tax document and no invoice email.

Mitigating factor: `backfill_unnumbered_invoices` heals such a row once the profile is saved, and finding G's fix dates the document from `paid_at`, so a late backfill still lands in the correct FY and GSTR period. The customer would receive their invoice late rather than never.

**Action: save the production seller profile before launch, not after the first sale.** Once Task 3 is deployed, `/health/full` reports `billing.invoicing_active: false` until it is, so this can no longer go unnoticed.

> Verified with read-only SELECTs only. Env file at `/opt/oyechats/platform/api/.env`; `oyechats-api` and `oyechats-worker` both active. Note the SSH key documented in `CLAUDE.md` (`~/.ssh/oyechats_deploy`) does not exist locally — the connection succeeded via ssh-agent. Worth correcting in the docs.

---

## 5. Phase 1 — Razorpay customer identity + billing-info gate

Outcome: every paying account has a durable Razorpay Customer and a complete buyer identity before money moves. This is the precondition for Phase 2 — without a customer there are no tokens.

### Task 6: Add `clients.razorpay_customer_id`

**Files:**

- Modify: `api/app/db/models.py` (Client, near the billing columns at `:37-42`)
- Create: `api/alembic/versions/<rev>_client_razorpay_customer_id.py`

- [ ] **Step 1: Add the column to the model**

In `api/app/db/models.py`, in the `Client` class after `billing_email`:

```python
    # Razorpay Customer id — the identity anchor for saved payment instruments.
    # Tokens hang off a customer (GET /v1/customers/{id}/tokens), so without
    # this there is no saved-card capability at all. Distinct from
    # ``Subscription.razorpay_customer_id``, which is a passive mirror scraped
    # from webhook payloads and is frequently NULL; this column is the one we
    # create and own.
    razorpay_customer_id = Column(String, unique=True, index=True, nullable=True)
```

- [ ] **Step 2: Generate the migration**

Run: `cd api && uv run alembic revision --autogenerate -m "client razorpay customer id"`

- [ ] **Step 3: Verify it is additive and reversible**

Read the generated file; it must contain exactly one `op.add_column` on `clients` plus the unique index, and a matching `downgrade`. Then:

```bash
cd api && uv run alembic upgrade head && uv run alembic downgrade -1 && uv run alembic upgrade head
```

Expected: all three succeed; `uv run alembic heads` shows a single head.

- [ ] **Step 4: Commit**

```bash
git add api/app/db/models.py api/alembic/versions/
git commit -m "feat(billing): add clients.razorpay_customer_id"
```

---

### Task 7: `razorpay_customer_service.ensure_customer`

**Files:**

- Create: `api/app/services/razorpay_customer_service.py`
- Test: `api/tests/test_razorpay_customer.py`

- [ ] **Step 1: Write the failing test**

```python
"""Razorpay Customer identity — created once, reused, never duplicated."""

import os

import pytest

from app.db.models import Client

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")


class _FakeCustomerAPI:
    def __init__(self):
        self.created = []

    def create(self, data):
        self.created.append(data)
        return {"id": f"cust_fake{len(self.created)}"}

    def edit(self, customer_id, data):
        return {"id": customer_id, **data}


class _FakeClient:
    def __init__(self):
        self.customer = _FakeCustomerAPI()


def _client_row(db, email="cust@test.dev", **fields):
    c = Client(name="Cust", email=email, api_key=f"key-{email}", **fields)
    db.add(c)
    db.flush()
    return c


def test_creates_customer_on_first_call(db, monkeypatch):
    from app.services import razorpay_customer_service as svc

    fake = _FakeClient()
    monkeypatch.setattr(svc, "_client", lambda: fake)

    client = _client_row(db, legal_name="Fynix Digital", gstin="27AAPFU0939F1ZV")
    cid = svc.ensure_customer(db, client)

    assert cid == "cust_fake1"
    assert client.razorpay_customer_id == "cust_fake1"
    assert fake.customer.created[0]["name"] == "Fynix Digital"
    assert fake.customer.created[0]["email"] == "cust@test.dev"
    assert fake.customer.created[0]["gstin"] == "27AAPFU0939F1ZV"
    # fail_existing=0 → Razorpay returns the existing customer instead of a 400
    # when this email was already registered (e.g. from a wiped local DB).
    assert fake.customer.created[0]["fail_existing"] == "0"


def test_is_idempotent(db, monkeypatch):
    from app.services import razorpay_customer_service as svc

    fake = _FakeClient()
    monkeypatch.setattr(svc, "_client", lambda: fake)

    client = _client_row(db, "idem@test.dev")
    first = svc.ensure_customer(db, client)
    second = svc.ensure_customer(db, client)

    assert first == second
    assert len(fake.customer.created) == 1


def test_falls_back_to_account_name_when_legal_name_missing(db, monkeypatch):
    from app.services import razorpay_customer_service as svc

    fake = _FakeClient()
    monkeypatch.setattr(svc, "_client", lambda: fake)

    client = _client_row(db, "noname@test.dev")
    svc.ensure_customer(db, client)

    assert fake.customer.created[0]["name"] == "Cust"


def test_gateway_failure_raises_and_leaves_column_null(db, monkeypatch):
    from app.services import razorpay_customer_service as svc

    class _Boom:
        customer = type("C", (), {"create": staticmethod(lambda data: (_ for _ in ()).throw(RuntimeError("boom")))})()

    monkeypatch.setattr(svc, "_client", lambda: _Boom())

    client = _client_row(db, "boom@test.dev")
    with pytest.raises(svc.RazorpayCustomerError):
        svc.ensure_customer(db, client)
    assert client.razorpay_customer_id is None


def test_detached_client_is_rejected_not_silently_dropped(db, monkeypatch):
    """The failure mode this guards against is invisible without it.

    ``get_current_client`` hands routes a DETACHED Client. Assigning
    ``razorpay_customer_id`` on a detached instance is a silent no-op — the id
    is created at Razorpay, never persisted, and re-created on every checkout.
    Tests that build their own attached rows would all pass while production
    quietly never saved a customer.
    """
    from app.services import razorpay_customer_service as svc

    monkeypatch.setattr(svc, "_client", lambda: _FakeClient())
    client = _client_row(db, "detached@test.dev")
    db.expunge(client)

    with pytest.raises(svc.RazorpayCustomerError, match="session-attached"):
        svc.ensure_customer(db, client)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && uv run pytest tests/test_razorpay_customer.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.services.razorpay_customer_service'`

- [ ] **Step 3: Write the implementation**

Create `api/app/services/razorpay_customer_service.py`:

```python
"""Razorpay Customer identity for a client.

The Customer is the anchor every saved payment instrument hangs off
(``GET /v1/customers/{id}/tokens``). Until this existed, ``razorpay_customer_id``
was only ever scraped passively off subscription webhooks and was routinely
NULL — which made saved cards structurally impossible.

Created lazily at the first paid intent (checkout / top-up) rather than at
signup, so free accounts never touch the gateway.
"""

from __future__ import annotations

import logging

from sqlalchemy.orm import Session

from app.db.models import Client

logger = logging.getLogger(__name__)


class RazorpayCustomerError(RuntimeError):
    """The gateway refused to create or update the customer."""


def _client():
    """Indirection so tests can substitute a fake without patching razorpay.

    ``_get_razorpay`` is the codebase's single SDK factory; it raises
    ``RuntimeError`` when ``RAZORPAY_ENABLED`` is false, which is the behaviour
    we want — a customer cannot be created without credentials.
    """
    from app.services.razorpay_service import _get_razorpay

    return _get_razorpay()


def _payload(client: Client) -> dict:
    payload = {
        # Razorpay's `name` is the payer-facing label; prefer the registered
        # legal name (what the tax invoice carries) and fall back to the
        # account name so this never sends an empty string.
        "name": (client.legal_name or client.name or "Customer").strip(),
        "email": (client.billing_email or client.email or "").strip(),
        # Razorpay 400s on a duplicate email unless told otherwise; "0" makes it
        # return the EXISTING customer instead, which is the behaviour we want
        # for a re-created local row pointing at the same real buyer.
        "fail_existing": "0",
    }
    if client.gstin:
        payload["gstin"] = client.gstin
    return payload


def ensure_customer(session: Session, client: Client) -> str:
    """Return this client's Razorpay customer id, creating it if needed.

    Idempotent: a client that already has an id short-circuits without a
    gateway call. On gateway failure the column is left NULL and the caller
    decides whether that is fatal — a customer is required for saving an
    instrument, but not for a plain one-off charge.

    ``client`` MUST be attached to ``session``. ``get_current_client`` returns a
    DETACHED row loaded in another session, and assigning to a detached
    instance silently does nothing — the write is simply lost, with no error
    and a green test suite. Every caller therefore re-reads the row with
    ``session.get(Client, client.id)`` first, which is the established pattern
    in ``subscription_routes`` (`:649`, `:1057`, `:2168`). The assertion below
    turns that silent no-op into an immediate failure.
    """
    if client not in session:
        raise RazorpayCustomerError(
            "ensure_customer requires a session-attached Client; "
            "re-read it with session.get(Client, client.id) first"
        )
    if client.razorpay_customer_id:
        return client.razorpay_customer_id

    try:
        created = _client().customer.create(_payload(client))
    except Exception as exc:  # noqa: BLE001 — normalised into our own error type
        logger.warning("razorpay customer create failed for client %s: %s", client.id, exc)
        raise RazorpayCustomerError(str(exc)) from exc

    customer_id = (created or {}).get("id")
    if not customer_id:
        raise RazorpayCustomerError("Razorpay returned no customer id")

    client.razorpay_customer_id = customer_id
    session.flush()
    logger.info("razorpay customer %s created for client %s", customer_id, client.id)
    return customer_id


def sync_customer(session: Session, client: Client) -> None:
    """Push updated billing identity to Razorpay. Best-effort.

    Called after a billing-details save so the gateway's record matches the
    invoice buyer snapshot. A failure here must never block the customer's
    edit — the local row is authoritative for invoicing.
    """
    if not client.razorpay_customer_id:
        return
    try:
        _client().customer.edit(client.razorpay_customer_id, _payload(client))
    except Exception as exc:  # noqa: BLE001
        logger.warning("razorpay customer sync failed for client %s: %s", client.id, exc)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd api && uv run pytest tests/test_razorpay_customer.py -v`
Expected: 5 passed

- [ ] **Step 5: Commit**

```bash
git add api/app/services/razorpay_customer_service.py api/tests/test_razorpay_customer.py
git commit -m "feat(billing): Razorpay customer identity service"
```

---

### Task 8: Require billing identity before a paid checkout

Today a customer can pay with every billing field NULL (F6), which is why the two existing invoices have an empty buyer snapshot. GST Rule 46 needs the recipient's name and address; Rule 46(f) makes it mandatory for B2C at or above ₹50,000.

**Files:**

- Modify: `api/app/api/subscription_routes.py` (`create_checkout`)
- Test: `api/tests/test_checkout_billing_gate.py`

- [ ] **Step 1: Write the failing test**

```python
"""Paid checkout requires a complete buyer identity (F6)."""

import os

import pytest

from app.db.models import Client

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")


def _client_row(db, email, **fields):
    c = Client(name="Gate", email=email, api_key=f"key-{email}", **fields)
    db.add(c)
    db.flush()
    return c


def test_missing_identity_lists_every_missing_field(db):
    from app.api.subscription_routes import _missing_billing_fields

    client = _client_row(db, "bare@test.dev", billing_country="IN")
    assert _missing_billing_fields(client) == ["legal_name", "billing_address", "billing_state_code"]


def test_complete_indian_identity_passes(db):
    from app.api.subscription_routes import _missing_billing_fields

    client = _client_row(
        db,
        "full@test.dev",
        legal_name="Fynix Digital",
        billing_address={"line1": "1 MG Road", "city": "Pune", "postal_code": "411001"},
        billing_country="IN",
        billing_state_code="27",
    )
    assert _missing_billing_fields(client) == []


def test_state_code_not_required_outside_india(db):
    from app.api.subscription_routes import _missing_billing_fields

    client = _client_row(
        db,
        "export@test.dev",
        legal_name="Acme Inc",
        billing_address={"line1": "1 Market St", "city": "SF", "postal_code": "94105"},
        billing_country="US",
    )
    assert _missing_billing_fields(client) == []


def test_address_missing_line1_counts_as_missing(db):
    from app.api.subscription_routes import _missing_billing_fields

    client = _client_row(
        db, "partial@test.dev", legal_name="X", billing_address={"city": "Pune"}, billing_country="IN",
        billing_state_code="27",
    )
    assert _missing_billing_fields(client) == ["billing_address"]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && uv run pytest tests/test_checkout_billing_gate.py -v`
Expected: FAIL with `ImportError: cannot import name '_missing_billing_fields'`

- [ ] **Step 3: Write the implementation**

In `api/app/api/subscription_routes.py`:

```python
def _missing_billing_fields(client: Client) -> list[str]:
    """Which statutory buyer fields are absent, in display order.

    GST Rule 46 requires the recipient's name and address on a tax invoice, and
    the place of supply (buyer state) drives the CGST/SGST vs IGST split. We
    collect these BEFORE the charge because an invoice is issued from the
    webhook — there is no second chance to ask. State code is India-only; an
    export invoice has no place of supply.
    """
    missing: list[str] = []
    if not (client.legal_name or "").strip():
        missing.append("legal_name")
    address = client.billing_address or {}
    if not (isinstance(address, dict) and str(address.get("line1") or "").strip()):
        missing.append("billing_address")
    if (client.billing_country or "IN").upper() == "IN" and not (client.billing_state_code or "").strip():
        missing.append("billing_state_code")
    return missing
```

Then inside `create_checkout`, immediately after `_assert_no_stacking(...)`:

```python
    missing = _missing_billing_fields(client)
    if missing:
        # 409 (not 400): the request is well-formed, the ACCOUNT is not ready.
        # The machine-readable code lets the UI open the billing-details modal
        # and pre-focus the first missing field rather than showing a toast.
        raise HTTPException(
            status_code=409,
            detail={
                "code": "billing_details_required",
                "missing": missing,
                "message": "Add your billing details so we can issue a valid tax invoice.",
            },
        )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd api && uv run pytest tests/test_checkout_billing_gate.py -v`
Expected: 4 passed

- [ ] **Step 5: Apply the same gate to top-ups**

Find the top-up checkout initiation (`grep -n "def initiate_topup" api/app/`), and add the identical `_missing_billing_fields` check. A top-up produces a tax invoice too, so the two money paths must gate identically — the codebase already holds this principle for billing country (`_resolve_confirmed_billing_country_or_409`).

- [ ] **Step 6: Handle the gate in the UI**

In `app/src/features/workspace/billing/usePlanCheckout.ts`, before opening Razorpay, catch the 409 and route the user to the billing-details modal:

```ts
      if (err instanceof ApiError && err.status === 409 && err.detail?.code === 'billing_details_required') {
        // Not an error state — the account simply isn't ready to be invoiced.
        // Open the details modal with the missing fields highlighted, and
        // resume checkout once it saves.
        onBillingDetailsRequired(err.detail.missing as string[]);
        return;
      }
```

Wire `onBillingDetailsRequired` from `BillingPage.tsx` to open `BillingDetailsModal` and re-invoke checkout on successful save.

- [ ] **Step 7: Verify lint and build**

Run: `cd app && npm run lint && npm run build`
Expected: 0 errors

- [ ] **Step 8: Commit**

```bash
git add api/app/api/subscription_routes.py api/tests/test_checkout_billing_gate.py app/src/features/workspace/
git commit -m "feat(billing): require statutory buyer identity before a paid checkout (F6)"
```

---

### Task 9: Create the customer at checkout and pass it to Razorpay

**Files:**

- Modify: `api/app/api/subscription_routes.py` (`create_checkout`), `api/app/services/razorpay_service.py`
- Modify: `api/app/api/subscription_routes.py` (`update_billing_details`)

- [ ] **Step 1: Ensure the customer exists at checkout**

In `create_checkout`, after the billing gate passes and inside the session block:

```python
        from app.services.razorpay_customer_service import RazorpayCustomerError, ensure_customer

        # Re-read inside this session: `client` from the dependency is DETACHED,
        # so writing to it would be silently discarded (see ensure_customer).
        client_row = session.get(Client, client.id)
        try:
            customer_id = ensure_customer(session, client_row)
        except RazorpayCustomerError:
            # Non-fatal: the subscription itself does not need a pre-made
            # customer. Losing it only costs the saved-instrument feature, and
            # the next checkout retries. Never block a purchase on it.
            customer_id = None
```

- [ ] **Step 2: Return it in the checkout payload**

Add `"customer_id": customer_id` to the dict `create_checkout` returns, alongside `prefill` and `theme`.

- [ ] **Step 3: Sync identity edits back to the gateway**

In `update_billing_details`, after the client row is updated and flushed. Note this route already holds the attached row as `row` (`subscription_routes.py:649`) — pass that, never the detached `client`:

```python
        from app.services.razorpay_customer_service import sync_customer

        # Best-effort: keep the gateway's record aligned with the invoice buyer
        # snapshot. Never raises — the local row is authoritative for invoicing.
        sync_customer(session, row)
```

- [ ] **Step 4: Run the billing suite**

Run: `cd api && uv run pytest tests/ -k "checkout or subscription or customer" -q`
Expected: all pass

- [ ] **Step 5: Verify end-to-end against Razorpay test mode**

With `api/scripts/dev.sh` running (migrations → ngrok → worker → API), complete a test-mode checkout, then:

```bash
psql "$DB_URL" -c "SELECT id, email, razorpay_customer_id FROM clients WHERE id=2;"
```

Expected: `razorpay_customer_id` populated with a `cust_...` value

- [ ] **Step 6: Commit**

```bash
git add api/app/api/subscription_routes.py
git commit -m "feat(billing): create and sync the Razorpay customer at checkout"
```

---

## 6. Phase 2 — Saved instruments (one-click top-ups)

Outcome: a customer saves a card at their first credit top-up and pays with one click (CVV only) thereafter, with a real list they can remove from. This is the half of "manage payment methods" that Razorpay genuinely supports (D-1).

### Task 10: Reshape `payment_methods` for RBI compliance

**Files:**

- Modify: `api/app/db/models.py:1491-1514`
- Create: `api/alembic/versions/<rev>_payment_methods_rbi_columns.py`

- [ ] **Step 1: Update the model**

Replace the `PaymentMethod` class body with:

```python
class PaymentMethod(Base):
    """A saved payment instrument — a DISPLAY MIRROR of Razorpay's token list.

    Razorpay is the source of truth (``GET /v1/customers/{id}/tokens``); this
    table exists so the app and the super-admin console can render an
    instrument list without a live gateway call.

    RBI card-on-file rules permit a merchant to retain ONLY the last four
    digits, the network, and issuer metadata. Cardholder name, BIN/IIN and
    EXPIRY must not be stored — hence no expiry columns here. Anything richer
    must be fetched live and never persisted.
    """

    __tablename__ = "payment_methods"

    id = Column(Integer, primary_key=True, autoincrement=True)
    client_id = Column(Integer, ForeignKey("clients.id", ondelete="CASCADE"), nullable=False, index=True)

    provider = Column(String, nullable=False, default="razorpay")
    type = Column(String, nullable=False)  # card|upi|emandate
    last4 = Column(String(4), nullable=True)
    network = Column(String, nullable=True)  # Visa|MasterCard|RuPay|Amex
    issuer = Column(String, nullable=True)  # bank code, e.g. HDFC
    upi_handle = Column(String, nullable=True)  # UPI VPA, for mandate display

    is_default = Column(Boolean, default=False, server_default="false", nullable=False)

    razorpay_token_id = Column(String, unique=True, index=True, nullable=True)
    razorpay_customer_id = Column(String, index=True, nullable=True)

    created_at = Column(DateTime(timezone=True), server_default=func.now())
    synced_at = Column(DateTime(timezone=True), nullable=True)

    client = relationship("Client")
```

- [ ] **Step 2: Generate and inspect the migration**

Run: `cd api && uv run alembic revision --autogenerate -m "payment methods rbi columns"`

The migration must drop `brand`, `expiry_month`, `expiry_year` and add `network`, `issuer`, `upi_handle`, `razorpay_customer_id`, `synced_at`. Safe to drop unconditionally: the table has zero rows in every environment (verified) — confirm before running:

```bash
psql "$DB_URL" -c "SELECT count(*) FROM payment_methods;"
```

Expected: `0`

- [ ] **Step 3: Verify up/down/up**

Run: `cd api && uv run alembic upgrade head && uv run alembic downgrade -1 && uv run alembic upgrade head`
Expected: all succeed; single head

- [ ] **Step 4: Fix the super-admin reader**

`superadmin_ops_routes.py:1436` selects `PaymentMethod` and the console renders `brand`. Update both to `network` / `issuer`. Run `grep -rn "brand\|expiry_month" oyechats-admin/src | grep -i payment` and update every hit.

- [ ] **Step 5: Commit**

```bash
git add api/app/db/models.py api/alembic/versions/ api/app/api/superadmin_ops_routes.py oyechats-admin/src
git commit -m "feat(billing): reshape payment_methods to RBI-permitted fields only"
```

---

### Task 11: Token sync service

**Files:**

- Create: `api/app/services/payment_method_service.py`
- Test: `api/tests/test_payment_methods.py`

- [ ] **Step 1: Write the failing test**

```python
"""Saved-instrument mirror — synced from Razorpay, never invented locally."""

import os

import pytest

from app.db.models import Client, PaymentMethod

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")

_TOKEN_PAGE = {
    "entity": "collection",
    "count": 2,
    "items": [
        {
            "id": "token_A",
            "method": "card",
            "card": {"last4": "8950", "network": "Visa", "type": "credit", "issuer": "HDFC"},
            "recurring": True,
        },
        {
            "id": "token_B",
            "method": "upi",
            "vpa": {"username": "gaurav", "handle": "okhdfcbank"},
            "recurring": True,
        },
    ],
}


class _FakeTokenAPI:
    def __init__(self, page):
        self.page = page
        self.deleted = []

    def all(self, customer_id):
        return self.page

    def delete(self, customer_id, token_id):
        self.deleted.append((customer_id, token_id))
        return {"deleted": True}


class _FakeClient:
    def __init__(self, page):
        self.token = _FakeTokenAPI(page)


def _paying_client(db, email="pm@test.dev"):
    c = Client(name="PM", email=email, api_key=f"key-{email}", razorpay_customer_id="cust_1")
    db.add(c)
    db.flush()
    return c


def test_sync_mirrors_card_and_upi_tokens(db, monkeypatch):
    from app.services import payment_method_service as svc

    monkeypatch.setattr(svc, "_client", lambda: _FakeClient(_TOKEN_PAGE))
    client = _paying_client(db)

    rows = svc.sync_payment_methods(db, client)

    assert {r.razorpay_token_id for r in rows} == {"token_A", "token_B"}
    card = next(r for r in rows if r.type == "card")
    assert (card.last4, card.network, card.issuer) == ("8950", "Visa", "HDFC")
    upi = next(r for r in rows if r.type == "upi")
    assert upi.upi_handle == "gaurav@okhdfcbank"


def test_sync_never_stores_expiry_or_name(db, monkeypatch):
    from app.services import payment_method_service as svc

    monkeypatch.setattr(svc, "_client", lambda: _FakeClient(_TOKEN_PAGE))
    client = _paying_client(db, "noexp@test.dev")
    svc.sync_payment_methods(db, client)

    columns = {c.key for c in PaymentMethod.__mapper__.column_attrs}
    assert "expiry_month" not in columns and "expiry_year" not in columns


def test_sync_is_idempotent(db, monkeypatch):
    from app.services import payment_method_service as svc

    monkeypatch.setattr(svc, "_client", lambda: _FakeClient(_TOKEN_PAGE))
    client = _paying_client(db, "idem-pm@test.dev")

    svc.sync_payment_methods(db, client)
    rows = svc.sync_payment_methods(db, client)

    assert len(rows) == 2
    assert db.query(PaymentMethod).filter_by(client_id=client.id).count() == 2


def test_sync_prunes_tokens_deleted_at_the_gateway(db, monkeypatch):
    from app.services import payment_method_service as svc

    fake = _FakeClient(_TOKEN_PAGE)
    monkeypatch.setattr(svc, "_client", lambda: fake)
    client = _paying_client(db, "prune@test.dev")
    svc.sync_payment_methods(db, client)

    fake.token.page = {"entity": "collection", "count": 1, "items": [_TOKEN_PAGE["items"][0]]}
    rows = svc.sync_payment_methods(db, client)

    assert {r.razorpay_token_id for r in rows} == {"token_A"}


def test_delete_removes_at_gateway_then_locally(db, monkeypatch):
    from app.services import payment_method_service as svc

    fake = _FakeClient(_TOKEN_PAGE)
    monkeypatch.setattr(svc, "_client", lambda: fake)
    client = _paying_client(db, "del@test.dev")
    svc.sync_payment_methods(db, client)

    svc.delete_payment_method(db, client, "token_A")

    assert fake.token.deleted == [("cust_1", "token_A")]
    assert db.query(PaymentMethod).filter_by(razorpay_token_id="token_A").count() == 0


def test_client_without_customer_id_syncs_to_empty(db, monkeypatch):
    from app.services import payment_method_service as svc

    monkeypatch.setattr(svc, "_client", lambda: _FakeClient(_TOKEN_PAGE))
    client = Client(name="Free", email="free@test.dev", api_key="key-free")
    db.add(client)
    db.flush()

    assert svc.sync_payment_methods(db, client) == []
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && uv run pytest tests/test_payment_methods.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.services.payment_method_service'`

- [ ] **Step 3: Write the implementation**

Create `api/app/services/payment_method_service.py`:

```python
"""Saved payment instruments — a mirror of Razorpay's per-customer token list.

Razorpay is authoritative. This module never invents an instrument locally; it
reflects ``GET /v1/customers/{id}/tokens`` into ``payment_methods`` so the UI
renders without a gateway round-trip, and prunes anything the gateway no longer
returns (a token deleted from the issuer's portal must disappear here too).

RBI card-on-file rules cap what may be persisted at last4 + network + issuer.
``_row_from_token`` is the single place that decides this — keep it that way.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import Client, PaymentMethod

logger = logging.getLogger(__name__)


class PaymentMethodError(RuntimeError):
    """The gateway refused a token operation."""


def _client():
    """Indirection so tests can substitute a fake without patching razorpay."""
    from app.services.razorpay_service import _get_razorpay

    return _get_razorpay()


def _row_from_token(client_id: int, customer_id: str, token: dict) -> dict:
    """Project a Razorpay token onto the RBI-permitted subset.

    Deliberately drops ``card.name`` and ``card.expiry_*``: retaining either
    after 1 Oct 2022 breaches the card-on-file guidelines. If the UI needs an
    expiry it must fetch it live and discard it.
    """
    method = token.get("method") or "card"
    card = token.get("card") or {}
    vpa = token.get("vpa") or {}
    handle = None
    if vpa.get("username") and vpa.get("handle"):
        handle = f"{vpa['username']}@{vpa['handle']}"
    return {
        "client_id": client_id,
        "provider": "razorpay",
        "type": method,
        "last4": card.get("last4"),
        "network": card.get("network"),
        "issuer": card.get("issuer"),
        "upi_handle": handle,
        "razorpay_token_id": token.get("id"),
        "razorpay_customer_id": customer_id,
        "synced_at": datetime.now(UTC),
    }


def sync_payment_methods(session: Session, client: Client) -> list[PaymentMethod]:
    """Refresh this client's instrument mirror from Razorpay.

    A client with no ``razorpay_customer_id`` has never paid, so it has no
    tokens by definition — return empty rather than calling the gateway.
    """
    customer_id = client.razorpay_customer_id
    if not customer_id:
        return []

    try:
        page = _client().token.all(customer_id) or {}
    except Exception as exc:  # noqa: BLE001
        logger.warning("token list failed for client %s: %s", client.id, exc)
        raise PaymentMethodError(str(exc)) from exc

    tokens = [t for t in (page.get("items") or []) if t.get("id")]
    seen = {t["id"] for t in tokens}

    existing = {
        row.razorpay_token_id: row
        for row in session.execute(
            select(PaymentMethod).where(PaymentMethod.client_id == client.id)
        ).scalars()
    }

    rows: list[PaymentMethod] = []
    for token in tokens:
        values = _row_from_token(client.id, customer_id, token)
        row = existing.get(token["id"])
        if row is None:
            row = PaymentMethod(**values)
            session.add(row)
        else:
            for key, value in values.items():
                setattr(row, key, value)
        rows.append(row)

    # Prune: a token revoked at the issuer or in Razorpay's dashboard must not
    # linger in our list, or we would offer the customer an instrument that
    # cannot be charged.
    for token_id, row in existing.items():
        if token_id not in seen:
            session.delete(row)

    session.flush()
    return rows


def delete_payment_method(session: Session, client: Client, token_id: str) -> None:
    """Revoke a saved instrument at the gateway, then drop the mirror row.

    Gateway first: if Razorpay refuses, the local row must survive so the list
    keeps reflecting what can actually be charged.
    """
    customer_id = client.razorpay_customer_id
    if not customer_id:
        raise PaymentMethodError("No Razorpay customer for this account")

    try:
        _client().token.delete(customer_id, token_id)
    except Exception as exc:  # noqa: BLE001
        logger.warning("token delete failed for client %s token %s: %s", client.id, token_id, exc)
        raise PaymentMethodError(str(exc)) from exc

    row = session.execute(
        select(PaymentMethod).where(
            PaymentMethod.client_id == client.id,
            PaymentMethod.razorpay_token_id == token_id,
        )
    ).scalar_one_or_none()
    if row is not None:
        session.delete(row)
        session.flush()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd api && uv run pytest tests/test_payment_methods.py -v`
Expected: 6 passed

- [ ] **Step 5: Commit**

```bash
git add api/app/services/payment_method_service.py api/tests/test_payment_methods.py
git commit -m "feat(billing): sync saved payment instruments from Razorpay tokens"
```

---

### Task 12: Customer-facing payment-method endpoints

**Files:**

- Create: `api/app/api/payment_method_routes.py`
- Modify: `api/app/main.py` (router wiring)

- [ ] **Step 1: Write the routes**

Create `api/app/api/payment_method_routes.py`:

```python
"""Customer-facing saved payment instruments.

Scope note: these are instruments for ONE-OFF payments (credit top-ups). The
instrument funding a subscription is its MANDATE, which Razorpay cannot swap in
place — replacing it runs the re-mandate flow in ``transition_service``, not an
endpoint here. Conflating the two would promise a swap the gateway can't do.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from app.api.auth import get_current_client
from app.db.models import Client
from app.db.session import get_session
from app.services.payment_method_service import (
    PaymentMethodError,
    delete_payment_method,
    sync_payment_methods,
)

router = APIRouter(prefix="/payment-methods", tags=["billing"])


def _serialize(row) -> dict:
    return {
        "id": row.id,
        "token_id": row.razorpay_token_id,
        "type": row.type,
        "last4": row.last4,
        "network": row.network,
        "issuer": row.issuer,
        "upi_handle": row.upi_handle,
        "is_default": row.is_default,
    }


@router.get("")
@limiter.limit("20/minute")
def list_payment_methods(request: Request, client: Client = Depends(get_current_client)):
    """Saved instruments.

    Serves the local mirror by default and only calls Razorpay when the mirror
    is stale (``_SYNC_TTL``) or ``?refresh=true``. A naive read-through would
    fire one gateway call per Billing page load — burning our Razorpay rate
    limit and turning a page refresh into a DoS vector against our own
    account. The rate limit is a second backstop; SlowAPI is already wired
    app-wide.

    A stale-mirror read that fails at the gateway degrades to the cached rows
    rather than erroring: showing a slightly old list beats blanking the
    Billing page over a transient gateway blip. Only an explicit ?refresh
    surfaces the failure.
    """
    refresh = request.query_params.get("refresh") == "true"
    with get_session() as session:
        row = session.get(Client, client.id)
        cached = _cached_rows(session, row.id)
        if not refresh and cached and not _is_stale(cached, _SYNC_TTL):
            return [_serialize(r) for r in cached]
        try:
            rows = sync_payment_methods(session, row)
            session.commit()  # persist the refreshed mirror
        except PaymentMethodError as exc:
            if refresh:
                raise HTTPException(status_code=502, detail=str(exc)) from exc
            return [_serialize(r) for r in cached]
        return [_serialize(r) for r in rows]


@router.delete("/{token_id}")
@limiter.limit("10/minute")
def remove_payment_method(
    token_id: str, request: Request, client: Client = Depends(get_current_client)
):
    """Revoke a saved instrument.

    ``token_id`` is resolved against THIS client's customer id inside the
    service, so a foreign token id fails at the gateway rather than deleting
    another account's instrument.
    """
    with get_session() as session:
        row = session.get(Client, client.id)
        try:
            delete_payment_method(session, row, token_id)
        except PaymentMethodError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc
        session.commit()
        return {"ok": True}
```

`_SYNC_TTL`, `_cached_rows` and `_is_stale` live in `payment_method_service` alongside the sync itself:

```python
_SYNC_TTL = timedelta(minutes=10)


def _cached_rows(session: Session, client_id: int) -> list[PaymentMethod]:
    return list(
        session.execute(
            select(PaymentMethod).where(PaymentMethod.client_id == client_id)
        ).scalars()
    )


def _is_stale(rows: list[PaymentMethod], ttl: timedelta) -> bool:
    """Stale if any row has never synced or the oldest sync is past the TTL."""
    stamps = [r.synced_at for r in rows]
    if not stamps or any(s is None for s in stamps):
        return True
    return (datetime.now(UTC) - min(stamps)) > ttl
```

The limiter is the app-wide SlowAPI instance — `from app.core.rate_limit import limiter` (defined at `app/core/rate_limit.py:60`, used the same way at `auth_routes.py:592`). SlowAPI requires the decorated function to accept `request: Request`, which is why both handlers take it.

- [ ] **Step 2: Wire the router**

In `api/app/main.py`, import alongside the other billing routers and add after `app.include_router(credits_router)`:

```python
app.include_router(payment_method_router)
```

Verify no path collision — the prefix `/payment-methods` is new at the root level (the existing `/superadmin/payment-methods` is under a different prefix):

```bash
grep -rn '"/payment-methods"' api/app/api/
```

Expected: exactly two hits, on different routers.

- [ ] **Step 3: Verify the routes are reachable**

Run: `cd api && uv run pytest tests/ -k "payment_method" -q` then start the API and:

```bash
KEY=$(psql "$DB_URL" -tAc "SELECT api_key FROM clients WHERE id=2;")
curl -s -H "X-API-Key: $KEY" http://127.0.0.1:8000/payment-methods
```

Expected: `[]` (client 2 has no `razorpay_customer_id` yet — it gets one at the next checkout)

- [ ] **Step 4: Commit**

```bash
git add api/app/api/payment_method_routes.py api/app/main.py
git commit -m "feat(billing): customer endpoints to list and revoke saved instruments"
```

---

### Task 13: Save the card at top-up checkout

**Files:**

- Modify: the top-up initiation route (`grep -n "def initiate_topup" api/app/`)
- Modify: `app/src/features/workspace/billing/TopupModal.tsx`

- [ ] **Step 1: Return the customer id from top-up initiation**

In the top-up route, mirror Task 9: call `ensure_customer(session, client)` and include `"customer_id": customer_id` in the response payload.

- [ ] **Step 2: Pass the save flags to Checkout**

In `TopupModal.tsx`, where `openRazorpayCheckout` is invoked, add the two options Razorpay requires to tokenize:

```ts
        cb = await openRazorpayCheckout({
          key: res.key_id as string,
          order_id: res.order_id as string,
          amount: res.amount as number,
          currency: res.currency as string,
          name: res.name as string,
          description: res.description as string,
          prefill: res.prefill as Record<string, unknown> | undefined,
          // Tokenize on success so repeat top-ups need only a CVV. Razorpay
          // requires BOTH: customer_id identifies who the token belongs to,
          // save=1 opts this payment into tokenization. The customer still
          // confirms consent inside Razorpay's own UI — we never see the PAN.
          customer_id: res.customer_id as string | undefined,
          save: res.customer_id ? 1 : undefined,
        });
```

- [ ] **Step 3: Verify a token appears after a test-mode top-up**

Complete a test-mode top-up with a test card, then:

```bash
KEY=$(psql "$DB_URL" -tAc "SELECT api_key FROM clients WHERE id=2;")
curl -s -H "X-API-Key: $KEY" http://127.0.0.1:8000/payment-methods
```

Expected: one entry with `type: "card"` and a real `last4`

- [ ] **Step 4: Verify lint and build**

Run: `cd app && npm run lint && npm run build`
Expected: 0 errors

- [ ] **Step 5: Commit**

```bash
git add api/app/api/ app/src/features/workspace/billing/TopupModal.tsx
git commit -m "feat(billing): tokenize the card at top-up checkout for one-click repeat top-ups"
```

---

### Task 14: Payment methods UI

**Files:**

- Create: `app/src/features/workspace/billing/PaymentMethodsPanel.tsx`
- Modify: `app/src/features/workspace/BillingPage.tsx` (Overview tab)

- [ ] **Step 1: Build the panel**

The panel renders **two clearly separated sections** (decision A-2):

1. *Subscription mandate* — derived from the active subscription, read-only, with a **Replace** button that calls the existing `/subscriptions/change-plan` re-mandate flow targeting the same plan. Copy must say what actually happens: "You'll authorize a new mandate; the old one is cancelled once the new one is active."
2. *Saved cards* — from `GET /payment-methods`, each row showing `network ···· last4` with a Remove action calling `DELETE /payment-methods/{token_id}`, and empty-state copy: "Cards you save at checkout appear here for one-click top-ups."

- [ ] **Step 2: Mount it on the Overview tab**

Render `<PaymentMethodsPanel />` beneath the current-plan card in `BillingPage.tsx`, replacing the static `Razorpay - UPI, card, or NetBanking` line, which today tells the customer nothing about their actual instrument.

- [ ] **Step 3: Verify lint and build**

Run: `cd app && npm run lint && npm run build`
Expected: 0 errors

- [ ] **Step 4: Commit**

```bash
git add app/src/features/workspace/billing/PaymentMethodsPanel.tsx app/src/features/workspace/BillingPage.tsx
git commit -m "feat(billing): payment methods panel — mandate vs saved cards"
```

---

## 7. Follow-on plans (not specified here)

Per the writing-plans scope check, the remaining work covers independent subsystems that each produce shippable software on their own. Each needs its own plan file rather than being half-specified here. Scope and acceptance criteria are fixed below so they can be written and executed in order.

### Plan B — Dunning & involuntary-churn recovery (F5) — *highest revenue impact*

**Scope:** `payment.failed` and `subscription.halted` become customer-visible events. A `DunningEvent` model tracks attempt/notified/recovered state. Emails at failure, mid-grace, and final notice (extending `email_service`'s existing `send_seat_reauth_email` pattern). An in-app `past_due` banner with a one-click **Fix payment** CTA that runs the re-mandate flow. A recovery-rate metric on the super-admin revenue page.

**Acceptance:** a halted subscription produces an email within 5 minutes and an in-app banner on next load; the CTA completes a re-mandate and clears `past_due_since`; recovered vs churned counts are queryable.

**Why separate:** it is behavioural and email-heavy, touches no schema that Phases 0–2 touch, and is independently shippable.

### Plan C — International/USD rail (F11, D-3)

**Scope:** completes the in-flight `b4e7c2f9a801` work. Per-currency Razorpay Plan resolution at checkout; card-only method restriction for non-INR (UPI Autopay and eMandate are INR-only); **remove the non-INR hard-skip in `invoice_service.py:149`** so USD charges produce export invoices via the existing `supply_kind` / `is_export` / LUT path; a separate serial series or currency column on the invoice document; FX-at-capture recorded on the invoice for reconciliation, since Razorpay settles in INR at the payment-creation rate. Flip `INTL_PAYMENTS_ENABLED` (`config.py:324`) only at the end, once every item below is closed.

**Four items surfaced by the CTO review that are easy to miss:**

1. **Zero-rating depends on how the money arrives, not just where the buyer is.** Export of services is zero-rated only where payment is received in convertible foreign exchange (or in INR where RBI permits). Razorpay **converts to INR before settling**, so the e-FIRS / FIRC trail from the AD bank is what evidences the foreign inward remittance. **Confirm with the CA before selling a single USD subscription** — the answer decides whether these invoices are zero-rated under LUT or must carry IGST, and that is baked into each document at finalize with no second chance.
2. **Operator seats have no international rail.** Seats bill against one hard-wired INR plan id (`RAZORPAY_SEAT_PLAN_ID`, `config.py:259`) at a canonical ₹499. A USD customer cannot buy a seat at all. Either mint a USD seat plan or hide seats for non-INR accounts — silently failing is not an option.
3. **RBI's 2026 framework covers cross-border recurring** (D-4), so foreign-issued cards are not automatically outside the ₹15,000 AFA regime. Get Razorpay's written position in the same thread that requests international recurring, and extend `emandate_warning` (Task 3b) to the FX-converted amount once you have it.
4. **MRR already normalises currency** via `_plan_monthly_usd_cents` / `_to_usd_cents` (`superadmin_plan_routes.py:576`) — verified during review, no change needed. Noted so nobody "fixes" it twice.

**Blocked on:** International Cards approval **plus** international-recurring enablement on the live account (see §1.3 — these are two separate asks, and the dashboard shows International Cards not yet requested). Neither MoneySaver nor PayPal unblocks this.

**Acceptance:** a US-billing-country customer completes a USD card checkout, receives an export invoice with the correct Rule 46 endorsement, and the GSTR export files it under EXP.

### Plan D — Finance & CA surfaces (F10)

**Scope:** a `/billing-reports` page in the super-admin console with a month picker that downloads the GSTR-1 CSV from the existing `/superadmin/billing/gstr-export`, and a reconciliation panel rendering `/superadmin/billing/reconciliation` anomalies with drill-through to each invoice.

**Acceptance:** the monthly CA filing needs no curl and no shell access.

### Plan E — Cleanup

**Scope:** delete the orphaned `app/src/components/billing/` (136K) and `components/credits/` (12K) — verified unreferenced by `features/`, `app/`, or `shell/`. Note `components/ui/` and `GoogleAuthButton` are still live via the auth pages; do not delete the whole tree.

### Plan F — Token lifecycle webhooks

**Scope:** the webhook dispatch table (`razorpay_service.handle_webhook_event`) handles subscription and payment events but **no `token.*` events** — verified. When an issuer or the customer revokes a saved card, we learn about it only on the next read-sync. Add `token.cancelled` / `token.paused` handling to prune the mirror immediately, and confirm which token events Razorpay actually emits for our account.

**Acceptance:** a token revoked at the issuer disappears from `GET /payment-methods` without waiting for a TTL.

**Why separate:** it is a Phase 2 hardening pass, not a Phase 2 blocker — the read-through sync already converges.

---

## 8. Self-review

**Spec coverage.** The brief asked for four things. Billing info capture → Task 8 (gate) + Task 9 (gateway sync); the F1/F2 fixes make what is already captured visible. Saved payment methods → Tasks 10–14, with decision D-1 explaining why the subscription mandate is deliberately *not* editable. Secure transactions → already correct (hosted Razorpay Checkout keeps us in PCI-DSS SAQ-A, HMAC-verified webhooks, idempotency), reinforced by A-3's no-card-storage rule; no task needed, and inventing one would be make-work. Invoicing → Phase 0 makes the existing engine actually deliver, Plan C and Plan D finish it. Both chosen payment-method goals are covered: one-click top-ups in Phase 2, failed-renewal recovery in Plan B.

**Placeholder scan.** No TBDs. Two steps deliberately instruct a `grep` before editing (Task 12 Step 2, Task 13 Step 1) because the exact top-up route name was not verified during this review — the grep resolves it rather than guessing a path that may not exist. Task 5 and the Plan C prerequisite are operational, not code, and are labelled as such.

**Type consistency.** `_resolve_invoice_scope`, `_missing_billing_fields`, `_apply_mark_paid`, `_billing_readiness`, `ensure_customer`, `sync_customer`, `sync_payment_methods`, `delete_payment_method`, `_row_from_token` are each defined once and referenced with the same signature everywhere. `PaymentMethod` column names in Task 10 match the projections in Task 11 and the serializer in Task 12 (`network`, `issuer`, `upi_handle`, `razorpay_token_id`, `razorpay_customer_id`, `synced_at`).

**One risk worth flagging.** Task 8 changes checkout behaviour for existing users: anyone with incomplete billing details will hit the modal before their next purchase. That is the intended fix for F6, but it is a conversion-sensitive change — ship it with the modal pre-filled from whatever is already on record, and watch checkout completion rate for the first week.

---

## 9. CTO review pass (2026-08-03)

The first draft was reviewed against the codebase line by line and the research re-run. Six defects in the plan itself and five omissions were found and fixed above. Recording them because the *class* of error matters more than the individual fixes.

### Defects that were in the plan

| # | Defect | Why it mattered |
|---|---|---|
| 1 | `get_razorpay_client()` does not exist — the factory is `_get_razorpay()` | Every gateway call in Tasks 7 and 11 would have failed at import. |
| 2 | `session.merge(client)` is not a pattern in this codebase | The convention is `session.get(Client, client.id)` (`subscription_routes.py:649`). `merge` on a detached row has different write semantics. |
| 3 | **`ensure_customer` was passed a detached `Client`** | The worst of the six. `get_current_client` returns a row from another session; assigning to it is a silent no-op. A Razorpay customer would be created on every checkout and never persisted — **with a fully green test suite**, because the tests built their own attached rows. Fixed with an explicit guard *and* a test that expunges the row to prove the guard fires. |
| 4 | `list_payment_methods` never committed | The synced mirror was flushed but discarded on session close. |
| 5 | Read-through sync on every GET, unthrottled | One Razorpay call per Billing page load — a page refresh becomes a DoS against our own gateway quota. Now TTL-cached with a `?refresh=true` escape and a SlowAPI limit. |
| 6 | `_billing_readiness` uncached inside `_gather_health` | ~2880 probes/day across two monitors, each opening an ORM session, to answer a question that changes once. The codebase already caches the LLM probe for exactly this reason. |

**The pattern behind 3 and 4:** both are writes that vanish without erroring. Tests that construct their own session-attached fixtures cannot catch either. Any future task in this plan that writes through a route must assert persistence by re-reading in a *separate* session, not by inspecting the object it just mutated.

### Omissions that were added

- **RBI E-mandate Framework 2026** (D-4, Task 3b) — the whole regime was missing. Effective 21 Apr 2026, ₹15,000 AFA-exempt ceiling per transaction, covers cross-border. **Professional annual sits 10.5% below the cliff.**
- **Export zero-rating vs INR settlement** (Plan C) — Razorpay converts before settling, so the FIRC/e-BRC trail is what supports zero-rating. A CA decision, needed *before* the first USD sale because it is frozen onto each invoice.
- **Seats have no international rail** (Plan C) — hard-wired to an INR plan id.
- **`token.*` webhooks unhandled** (Plan F) — a revoked card lingers until the next sync.
- **No rate limiting** on the new endpoints — now added.

### Claims that were checked and found FINE (no action — do not "fix" these)

- MRR already normalises currency through `_to_usd_cents` (`superadmin_plan_routes.py:576`).
- `customer_notify: 1` is set at subscription creation (`razorpay_service.py:431`), delegating the RBI pre-debit notification to Razorpay.
- `total_count` (100 annual / 120 monthly) satisfies the framework's mandate-validity requirement.
- The `Bot`, `Invoice`, `Plan` and `Subscription` constructors used in the test code above all match the models.
- `get_session` is a proper `@contextmanager` (`db/session.py:65`).

### Two decisions this plan makes explicitly, rather than leaving open

**Refunds stay in the Razorpay dashboard.** `POST /superadmin/invoices/{id}/refund` exists with no UI, and the console tells operators to use Razorpay. That is a deliberate choice, not an oversight: refunds are rare, high-blast-radius, and already produce a correct credit note through the `refund.created` webhook (`razorpay_service.py:2595`). Building a refund button would add a destructive action to the console for no throughput gain. Revisit only if refund volume makes dashboard round-trips a real cost.

**Rollback is per-phase, code-first.** Every migration in this plan is additive and nullable, so a bad deploy is recovered by redeploying the previous SHA, **not** by a schema downgrade — the same posture as `docs/billing/2026-07-11-pre-merge-runbook.md` §F. The one exception is Task 10, which *drops* columns (`brand`, `expiry_month`, `expiry_year`); it is safe only because the table is empty in every environment, and the task requires confirming `count(*) = 0` before running. If that check ever returns non-zero, stop and rewrite the migration as additive.

### Still open — needs a human, not a task

1. **CA sign-off** on export zero-rating with INR settlement (blocks Plan C).
2. **Razorpay written confirmation** on three points, in one thread: international recurring enablement, foreign-card tokenisation, and whether the ₹15,000 AFA ceiling applies to foreign-issued cards.
3. **A pricing decision** on Professional annual's 10.5% headroom — hold below ₹15,000, or accept per-renewal AFA above it.
