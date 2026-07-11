# Billing Remediation — Pre-Merge Runbook (PR #260)

> **Branch:** `development` → `main` (production) · **PR:** https://github.com/digibranders/oye-chats-platform/pull/260
> **Status of automated gates:** full backend suite **2295 passed** · `ruff check` + `ruff format` clean · single alembic head `e3c9a17f2b64` · admin app lint 0 errors + build ✓ · widget lint 0 errors + build ✓ + 50 tests.
> **This is not "merge and forget."** Work top-to-bottom: changes → staging smoke tests → deploy procedure → sign-offs. Do not merge to `main` until §B, §E, §F are satisfied.

---

## 1. What changed — full changelog

15 billing commits (`7a2b5ee` … `8cad022`). Grouped by area; every fix is TDD-covered.

### Credit ledger (`credit_service.py`, `ingestion/pipeline.py`, `worker/tasks.py`, `crawl_orchestrator.py`)
- **E** — refunds are FIFO-allocatable; `get_balance` == spendable set again.
- **H** — opt-in `idempotency_key` on `check_and_deduct` (+ column, partial unique index, migration); wired into the crawl ARQ path (`ingest:{client}:{bot}:{job}:{url_sha}`) so a retried crawl never re-charges billed pages. **Chat NOT wired** (a client-held key on the public `/chat` endpoint is a free-chat exploit).
- **O1** — `expire_old_topups` takes the advisory lock *before* reading consumption (was a TOCTOU that could over-sweep).
- **O3** — `get_balance` subtracts the unconsumed remainder of expired-but-unswept top-ups (removes the up-to-24h stuck-balance window).
- **O4** — corrected `reverse_refund_clawback` docstring (it is NOT self-idempotent).
- **§5** — `get_credit_cost` fails **closed** (unknown/non-numeric action → charge 1, not free).
- **H hardening** — idempotent-reuse now warns on an amount/reason mismatch instead of silently skipping.

### Razorpay / subscriptions (`razorpay_service.py`, `transition_service.py`, `subscription_routes.py`)
- **C** — a top-up whose `order.fetch` fails now **raises → dead-letters → retries** instead of being acked as "ignored" and lost.
- **B** — editing a plan's price **re-mints the immutable Razorpay plan** (`create_plan_for_price`), maps gateway failure → 502, logs orphaned plan ids, pins currency INR.
- **D** — sequential upgrade double-submit **reuses the in-flight checkout** (`upgrade_pending_subscription_id`/`_plan_id` marker + `rebuild_upgrade_checkout`) instead of minting a 2nd sub; a dead/abandoned checkout is re-minted; a different target supersedes.
- **F** — upgrade rollover credit **clamped to live remaining** at activation (no leakage).
- **I** — irreversible gateway cancels of superseded mandates now run **after** every fail-prone local write, so a rollback can't strand a cancelled-at-Razorpay-but-active-locally sub.
- **N** — first-period end is **derived** (`current_start + interval`) when `activated` lacks `current_end`, so the first `charged` doesn't grant a second time.
- **A** — **operator seats gated on mandate authorization** (`seat_addon_pending_quantity`); seat charge emits a GST invoice (no credit grant); dedicated `_handle_seat_addon_event`; `halted` suspends but keeps count; dismiss-then-retry re-authorizes (C1); reactivation re-derives `operator_quantity` (no seat clobber).
- **J** — seat responses surface the **actually-charged** price (`RAZORPAY_SEAT_PLAN_PRICE_CENTS`) and warn on per-plan mismatch.
- **Seat cutover-carry re-auth** — a plan change now **gates** carried seats and **emails** a re-auth link (`send_seat_reauth_email`) instead of silently suspending them.

### Invoicing / GST (`invoice_service.py`, `invoice_pdf.py`, `core/gstin.py`, `db/models.py`)
- **G** — invoices + FY serial dated from the real Razorpay **capture instant** (`_capture_paid_at`), correct GSTR period at a month/FY boundary.
- **L** — `before_update` guard makes a numbered invoice **immutable** (only delivery/lifecycle columns mutable).
- **M** — Rule 46 PDF: IGST-paid export endorsement; place-of-supply **State name** (`GST_STATE_NAMES`); Rule 46(f) warning for high-value B2C missing name/address.

### Admin dashboard (`superadmin_plan_routes.py`)
- **K** — MRR counts the plan at quantity 1 + `extra_seats × per-seat`, not `plan × operator_quantity` (was double/triple-counting).
- **O2** — pricing/kill-switch config setter invalidates the 60s cache on write (no fail-open window).
- **§5** — `Field(ge=0)` bounds on plan price/quantity fields.

### Frontend (`app/`)
- **A** — Billing seat flow opens the returned Razorpay checkout; seats not shown until the webhook confirms.
- **O5** — single `FALLBACK_USD_TO_INR = 94.67` (was divergent 83/94.67).
- **O6** — Billing success toasts no longer assert confirmation from the redirect URL alone.
- **§5** — deleted orphaned `Subscription.jsx` (unrouted; contained a broken checkout).

### Docs
- Landed the review deliverables + remediation plan under `docs/billing/`; removed the Stripe doc-drift in `CLAUDE.md`; gitignored `.superpowers/`.

### ⚠️ NOT part of the billing work (already on `development`, ride along in this PR)
- `5bfb876 fix(app): make bot Live Preview match the real widget 1:1` — touches `app/src/pages/BotSettings.jsx`, `AdminLayout.jsx`, `index.css`.
- `6ec24d1 feat(app): periwinkle light-theme tint`.
- **Decide:** merge these together, or rebase them out.

---

## 2. Schema / migration changes

Three additive migrations, single linear head `e3c9a17f2b64`, all reversible (up/down/up verified):

| Revision | Change | Risk |
|---|---|---|
| `b8f3d21a9c47` | `credit_ledger.idempotency_key` (nullable) + **partial UNIQUE index built `CONCURRENTLY`** | ⚠️ see deploy §C |
| `c2a7f4e91b83` | `subscriptions.upgrade_pending_subscription_id` + `upgrade_pending_plan_id` (+ FK) | low (small table) |
| `e3c9a17f2b64` | `subscriptions.seat_addon_pending_quantity` (nullable) | trivial (metadata) |

All column adds are nullable metadata-only; **no backfill needed** (historical `idempotency_key` is all NULL, so nothing enters the unique index).

---

## 3. Behavior changes to be aware of (not just code)

- **Seats no longer appear instantly.** A first seat purchase now returns a checkout; seats activate on the `activated` webhook.
- **Plan-change seat carry** now **suspends** carried seats and **emails a re-auth link** (new customer-facing email). Confirm this is the desired UX.
- **`get_credit_cost` charges 1 for an unknown action** (was free). If any live action is unpriced it will start billing.
- **MRR numbers in the admin dashboard will change** (drop for multi-seat customers — they were inflated).
- **Billing toasts reworded** ("Finalizing…"/"Processing…" instead of "confirmed/successful").
- **A finalized invoice can no longer be mutated via the ORM** — any prod code path that edits a numbered invoice's tax columns will now raise.

---

## 4. Pre-merge testing checklist

### A. Automated gates — ✅ done (re-run before merge)
- [ ] `cd api && DB_URL=… uv run pytest` → **2295 passed** (run in natural order; a `-k` subset can trip a *pre-existing* `INVOICE_EMAILS_ENABLED` config-leak in another test file).
- [ ] `cd api && uv run ruff check . && uv run ruff format --check .`
- [ ] `cd api && uv run alembic heads` → single head `e3c9a17f2b64`.
- [ ] `cd app && npm run lint && npm run build`
- [ ] `cd widget && npm run lint && npm run build && npm test`

### B. Staging smoke tests — ⬜ REQUIRED (tests mock Razorpay; nothing here has been driven for real)
Deploy the branch to staging (Razorpay **test mode**) and verify each money path end-to-end:
- [ ] **Subscribe (new)** → checkout → authorize → `subscription.activated` webhook → plan active, credits granted **once**, GST tax-invoice created + numbered + PDF renders + email received.
- [ ] **Renewal** (`subscription.charged`) → credits reset+granted once (not twice); invoice dated from capture time.
- [ ] **Top-up** → checkout → credits granted once + numbered invoice. Then simulate an `order.fetch` failure (or a webhook redelivery) → credits still granted **exactly once**, none lost.
- [ ] **Upgrade** paid→paid → double-click the button → **only one** Razorpay subscription minted; rollover credits ≈ what was actually left (not the click-time snapshot).
- [ ] **Add operator seat** → response has `requires_authorization` → checkout opens → authorize → `activated` → `operator_quantity` bumps → seat `charged` → **seat GST invoice** created. Dismiss the checkout and retry → re-authorizes, seats NOT free.
- [ ] **Plan change with existing seats** → new plan authorizes → carried seats **suspended** + **seat re-auth email received** and its link works.
- [ ] **Plan price edit** (super-admin) → new Razorpay plan minted, `razorpay_plan_id_*` swapped → a fresh checkout quotes and charges the **new** price.
- [ ] **Refund** a credit → balance reflects it AND it is spendable (no "insufficient credits" with a positive balance).
- [ ] **Kill switch** toggle → deductions halt **immediately** (not after 60s).
- [ ] **Invoice PDF** for an inter-state supply shows `27 – Maharashtra`; an IGST-paid export shows the export endorsement. (ARQ worker must be running — see local-dev-runtime notes.)
- [ ] **Render the new seat re-auth email** and eyeball it (regenerate `emails/gallery/` if used).

### C. Deploy procedure — ⬜ REQUIRED
- [ ] Confirm prod `credit_ledger` row count (`SELECT reltuples FROM pg_class WHERE relname='credit_ledger'`). The unique index builds `CONCURRENTLY` in an autocommit block — **verify the deploy's alembic env allows autocommit-block DDL** (it worked on a throwaway DB; confirm on prod's runner). If it fails mid-build it leaves an `INVALID` index to drop manually.
- [ ] Run `alembic upgrade head` (3 migrations) **before** the code restart (matches the existing migrate-then-restart flow).
- [ ] Ensure the **ARQ worker is running** post-deploy (seat/invoice PDFs + emails depend on it).
- [ ] **Consider pausing crawls across the deploy window** — a crawl retrying from an old→new worker could re-charge already-billed pages (the old attempt's ledger rows have no idempotency key). Narrow, one-deploy-only.
- [ ] Set the seat-price env if you want it explicit: `RAZORPAY_SEAT_PLAN_PRICE_CENTS` (defaults to 49900).

### D. Post-deploy verification — ⬜
- [ ] Health endpoints green; do one real (or test-mode) checkout + webhook and confirm the invoice + email.
- [ ] Watch logs for the new WARN lines: `Rule 46(f)`, seat-price mismatch, `credit_cost.* non-numeric`, `idempotency_key reused`, `gateway_cancel_failed_mandate_live`.
- [ ] Spot-check MRR on the admin dashboard looks sane (lower than before for multi-seat accounts).

### E. Sign-offs — ⬜ REQUIRED
- [ ] **Product/support**: seat gating + cutover re-auth email UX is intended.
- [ ] **CA / finance**: GST changes (Rule 46 endorsement, state-name POS, 46(f) high-value B2C, capture-time invoice dating) — closes the pending CA-review items.

### F. Rollback plan — ⬜
- [ ] Migrations are reversible: `alembic downgrade -3` drops the 3 new columns/index. But note the columns are additive and harmless if left; prefer a **code rollback** (redeploy previous SHA) over a schema downgrade if only behavior needs reverting.
- [ ] If only the invoice-immutability guard (L) causes a prod issue, it can be hot-patched out (single `@event.listens_for` in `models.py`) without a migration.

---

## 5. Deferred (documented — NOT in this PR)
- `RAZORPAY_SEAT_PLAN_ID` fail-closed default — prod relies on the default; needs env verification first.
- Same-plan monthly↔annual cycle switch — needs change-flow routing work.
- Cross-border / USD billing (CA-review Phase-2 blockers) — keep gated behind `INTL_PAYMENTS_ENABLED`.
- Review's remaining low/cosmetic notes (serial 16-char cap, ±1 paisa partial-credit-note drift, float tax labels, top-up `pack_id`).
- Test-isolation cleanup for the pre-existing `INVOICE_EMAILS_ENABLED` `-k`-subset flakiness.
