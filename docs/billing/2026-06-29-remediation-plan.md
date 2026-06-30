# Payment, Credit & Platform — Remediation Plan

**Status:** Proposed · **Date:** 2026-06-29 · **Owner:** Engineering
**Consolidates everything identified in the 2026-06-29 review session.**

Source docs:
- [Payment system review report](2026-06-29-payment-system-review-report.md) (findings C1–C3, H1–H5, M1–M8, L1–L6)
- [Bug-class research appendix](2026-06-29-payment-bug-classes-research-appendix.md)
- [Prorated upgrades design (Option A)](2026-06-29-prorated-upgrades-design.md)
- [Timezone & datetime handling](../timezone-handling.md)

This is the single source of truth for sequencing and acceptance. It is **dependency-ordered and risk-ranked**: foundational correctness and safety nets first, then the features that depend on them.

---

## 1. Guiding principles (senior engineering standards)

Applied to **every** task below — these are acceptance gates, not suggestions:

1. **TDD.** Write the failing test first (the review's §7 QA cases are the seed suite). No fix merges without a regression test that fails before and passes after.
2. **Feature-flag risky behavior.** Money-path changes ship behind a config flag, default-off, enabled for `CHECKOUT_TEST_CLIENT_IDS` → ₹1 test plan → global.
3. **Idempotency & atomicity are non-negotiable** on money paths: DB-enforced uniqueness, `INSERT … ON CONFLICT`, atomic `UPDATE`, and `SELECT … FOR UPDATE` for read-decide-write — never check-then-act in Python.
4. **Append-only ledger stays append-only.** Reversals are new signed-delta rows; never mutate a grant. Balance is always `SUM(delta)`.
5. **Money in integer minor units (paise)**; one explicit rounding point (half-up); never float; never negative.
6. **Migrations are reversible** (Alembic up/down), additive-first (add column/table → backfill → switch reads → drop), zero-downtime.
7. **Backward compatible.** Old webhook deliveries, legacy rows, and in-flight checkouts must keep working through each deploy.
8. **Observability per change.** Structured logs + a metric/alert for each new failure mode (dead-letters, signature failures, clawback mismatches, lock timeouts).
9. **Pre-completion checks** (per `CLAUDE.md`): `ruff check` · `ruff format` · `pytest` for `api/`; `npm run lint` + `npm run build` for any `app/` or `widget/` change. Fix before reporting.
10. **Branch workflow:** all work on `development`; PR → `main`. One PR per task (or tight cluster), each independently revertible.

---

## 2. Consolidated issue register

| ID | Title | Sev | Phase | Primary file(s) | Depends on |
|----|-------|-----|-------|-----------------|-----------|
| C1 | Webhook returns 200 on error → lost paid events; no dead-letter | 🔴 | 1 | `api/webhook_billing_routes.py` | P0 dead-letter table |
| C2 | Refund clawback hits wrong grant + wrong ledger scope (`bot_id`) | 🔴 | 1 | `services/credit_service.py`, `services/razorpay_service.py` | invoice→grant link |
| C3 | Referral codes: no redemption cap/expiry; **no min-price floor** (9999 bps ≈ free; exact 100% already rejected) | 🔴 | 3 | `services/affiliate_service.py`, `discount_service.py`, `razorpay_service.py` | schema (codes) |
| H1 | No row-locking on subscription/trial mutations → TOCTOU double-grant | 🟠 | 1 | `subscription_routes.py`, `plan_service.py`, `transition_service.py` | — |
| H2 | Account entitlements resolved by newest `created_at` → silent downgrade | 🟠 | 2 | `plan_service.py`, `plan_entitlements_service.py` | — |
| H3 | `session.commit()` inside affiliate service breaks atomicity | 🟠 | 2 | `services/affiliate_service.py` | — |
| H4 | `subscription.charged` first-cycle dedup is a fragile 24h heuristic | 🟠 | 2 | `services/razorpay_service.py` | period-grant marker |
| H5 | Top-up grant depends on `order.paid` notes; `payment.captured` is a no-op | 🟠 | 2 | `services/razorpay_service.py` | — |
| H6 | **No dispute/chargeback handler** (`payment.dispute.*` not dispatched) | 🟠 | 2 | `services/razorpay_service.py` | C2 (clawback scope) |
| M1 | Affiliate money split truncates independently; doesn't reconcile to total | 🟡 | 3 | `services/affiliate_service.py`, `core/money.py` | — |
| M2 | `format_amount` float equality + Western grouping for INR | 🟡 | 4 | `core/pricing.py` | — |
| M3 | Stale hardcoded FX (94.67) in **display** fallback (corrected: not a charge path) + docstring fix | 🟢 | 4 | `core/pricing.py` | — |
| M4 | `UsageRecord` race: **unique index exists** — add `IntegrityError` catch only (corrected: not a double-create) | 🟢 | 4 | `plan_service.py:160-209` | — |
| M5 | `add_months` preserves wall-clock across DST (no `fold`) | 🟡 | 5 | `core/dates.py` | — |
| M6 | `leads` usage counter ignores billing period | 🟡 | 4 | `plan_entitlements_service.py` | — |
| M7 | `documents` quota classified by `name LIKE 'http%'` heuristic | 🟡 | 4 | `plan_entitlements_service.py`, models | migration (`source` col) |
| M8 | Superadmin endpoints: unbounded **negative** inputs (corrected: `None` crash not reachable — `default=1`) | 🟡 | 4 | `superadmin_plan_routes.py` | — |
| L1 | Pass raw bytes (not decoded str) to webhook HMAC verify | 🔵 | 1 | `services/razorpay_service.py` | — |
| L2 | Reconcile-on-verify: assert `notes.client_id == caller` | 🔵 | 2 | `subscription_routes.py` | — |
| L3 | Add idempotent top-up reconcile-on-verify (safety net for C1) | 🔵 | 2 | `subscription_routes.py`, `razorpay_service.py` | — |
| L4 | ~~Outbound SSRF re-validate at send time~~ **already implemented** (corrected) — only narrow N7 residual remains | ✅ | 7 | `services/webhook_service.py` | — |
| L5 | Alert on event-id-less webhook deliveries | 🔵 | 7 | `services/razorpay_service.py` | metrics |
| L6 | Timing oracle (corrected: on rate-limited `/click`, not `validate_code`; marginal) | 🔵 | 3 | `services/affiliate_service.py` (`record_click`) | — |
| F1 | **Prorated upgrades** (Option A) + fix misleading "time credited" copy | ✨ | 6 | `transition_service.py`, `razorpay_service.py`, `subscription_routes.py`, `app/` | C2, H1 |
| R1 | Daily settlement reconciliation backstop (self-heal missed reversals) | 🛡️ | 7 | new cron/service | C2, H6 |
| T1 | Deprecated naive `utcnow()`/`now()` in ingestion → `now(UTC)` | 🟡 | 5 | `ingestion/pipeline.py` | — |
| N1 | No `refund.failed` reversal → initiated-then-failed refund permanently strips credits | 🟠 | 2 | `services/razorpay_service.py` | C2 |
| N2 | Double-clawback when a grant lands between `refund.created`/`refund.processed` | 🟡 | 1 | `services/razorpay_service.py`, `credit_service.py` | C2 |
| N3 | `cancel`/`resume`/`seats` target the wrong subscription under per-bot model | 🟠 | 2 | `subscription_routes.py` | H1 |
| N4 | "Stripe fallback" provider unimplemented → discount dropped on Stripe path; doc/CLAUDE.md ref wrong | 🟠 | 3 | `services/discount_service.py`, (missing `billing_service.py`) | — |
| N5 | `create_plan` reads `Plan.limits.default.arg` ORM internals → 500 risk; dead `SELECT` | 🟡 | 4 | `superadmin_plan_routes.py` | — |
| N6 | `ReferralConversion.affiliate_id` hard-coded `None` → broken payout audit trail | 🔵 | 3 | `subscription_routes.py` | — |
| N7 | Residual outbound-SSRF TOCTOU between `getaddrinfo` check and `urlopen` | 🔵 | 7 | `services/webhook_service.py` | — |
| N8 | `add_months` anniversary drift if billing rolls from prior period-end | 🔵 | 5 | `core/dates.py` | — |
| N9 | Ingestion writes naive `ingest_date` while app is aware-UTC (extends T1) | 🔵 | 5 | `ingestion/pipeline.py` | T1 |

> **Verification pass (2026-06-29 follow-up):** every row was re-checked against current source. Corrections: **M3/M4 downgraded** (🟢 — not the originally-claimed defect), **L4 closed** (✅ — already implemented), **L6/M8 refined**, **C3 reframed** (no min-price floor, not "₹0 at 100%"). **9 new findings (N1–N9)** added. Severity legend: 🔴 Critical · 🟠 High · 🟡 Medium · 🔵 Low · 🟢 reduced-to-minor · ✅ resolved/withdrawn.

## 3. Phase plan

Each phase is independently shippable and leaves the system in a better, consistent state. Effort is rough engineer-days (excluding review/QA latency).

### Phase 0 — Foundations & safety nets *(enable everything else)*  · ~2–3 d
**Objective:** make the money paths testable and reversible before touching them.
- **Webhook test harness:** signed-payload fixtures + a replay/duplicate/out-of-order simulator; encode the review §7 cases as pytest skeletons (red).
- **`failed_webhooks` (dead-letter) table** — stores raw signed payload + headers + error, with a replay command. (Unblocks C1.)
- **Feature-flag plumbing:** `WEBHOOK_RETRY_ON_ERROR`, `PRORATED_UPGRADES_ENABLED`, etc. (config + tests).
- **Shared helpers:** a `locked_subscription(session, client_id)` (`SELECT … FOR UPDATE`) utility and an assertion helper for "no ledger scope is negative" used across tests.
- **Acceptance:** harness can fire a signed webhook in a test; dead-letter table migrates up/down; flags read in tests.

### Phase 1 — Critical money integrity & webhook reliability  · ~4–6 d
**Objective:** stop revenue loss and ledger corruption. Also unblocks the upgrade feature.
- **C1** — return **5xx** on processing failure (so Razorpay retries; dedupe makes it safe); persist to `failed_webhooks` before ACK; keep 200 only for success + known duplicate (`WebhookReplay`). Decouple the dedup-record commit from the handler.
- **C2** — link refund → originating grant (store `reference_id`/grant id on the grant, or `grant_id` on `Invoice`); thread `bot_id` so the reversal lands in the **same** ledger scope; lock that scope. Invariant test: post-refund no scope goes negative and the *correct* grant shrinks.
- **H1** — `SELECT … FOR UPDATE` on the subscription/client row in every mutating handler (`change-plan`, `seats`, `cancel`, free-downgrade grant, `start_trial`, `assign_default_plan`); make `grant_for_subscription` idempotent per billing period.
- **L1** — pass raw `bytes` to the HMAC verifier (defense-in-depth; keep `compare_digest`).
- **N2** — make the clawback idempotent per refund id so `refund.created`+`refund.processed` (distinct event-ids) can't double-claw when a grant lands between them (folds into the C2 fix).
- **Acceptance:** double-click trial → single grant; refund of subscription-while-topup-exists claws the right grant in the right scope; `refund.created`+`refund.processed` for one refund → single reversal; injected handler failure → 5xx + dead-letter + successful Razorpay retry; tamper/replay rejected.
- **Rollout:** C1 behind `WEBHOOK_RETRY_ON_ERROR` (default-on after soak); others direct (pure correctness, covered by tests).

### Phase 2 — Subscription lifecycle correctness  · ~5–7 d
**Objective:** make grants, entitlements, and reversals deterministic and order-independent.
- **H2** — resolve **account-level** entitlements by **highest tier** (plan rank/price), not `created_at`; keep per-bot entitlements scoped to the bot's sub. Regression: Standard + later Free bot stays Standard.
- **H4** — replace the 24h heuristic with a **period-grant marker** (store last-granted `current_period_end` or a `(subscription_id, period_start)` row); grant iff that period hasn't been granted. Fixes out-of-order + replay.
- **H5** — in `_handle_payment_captured`, when `pay_entity.order_id` is present and notes are empty, **fetch the order** for its notes so `payment.captured` can grant on its own; verify `order.paid` is enabled (ops checklist).
- **H6** — add `payment.dispute.created` (claw + hold) / `.lost` (finalize) / `.won` (reinstate) handlers; reuse the C2-corrected clawback. (Depends on C2.)
- **H3** — remove `session.commit()` from `accept_invite_for_existing_client`; use a savepoint or let the route own the transaction.
- **L2** — assert `notes.oyechats_client_id == caller.id` before reconcile-on-verify.
- **L3** — idempotent **top-up reconcile-on-verify** mirroring the subscription path (safety net compounding C1).
- **N1** — add a `refund.failed` handler that re-grants the clawed amount; finalize only on `refund.processed`. (Pairs with H6 dispute lifecycle; depends on C2.)
- **N3** — make `cancel`/`resume`/`seats` accept and require a `bot_id`/`subscription_id`, resolve the specific per-bot row, and lock it (ties to H1). Regression: a 2-bot client can cancel either bot's subscription.
- **Acceptance:** out-of-order `activated`/`charged` → exactly one grant per period; dispute lifecycle reverses then reinstates correctly; failed refund re-grants; cancel targets the chosen bot's sub; invite "already affiliate" path doesn't commit foreign work.

### Phase 3 — Discount / affiliate abuse controls  · ~4–5 d
**Objective:** cap discount liability and close fraud vectors.
- **C3** — add `max_redemptions` + atomic `redeemed_count` (`UPDATE … WHERE redeemed_count < max_redemptions`) and `expires_at` (checked in `validate_code`, ideally folded into the atomic UPDATE with `valid_until >= now()`); cap `customer_discount_bps` at a product max (e.g. 5000) **independent of the pool**; assert resolved discounted price `> 0`.
- **C3 (self-referral)** — correlate new signup vs affiliate on email/hashed-IP; block or flag.
- **M1** — round half-up and compute the **last split bucket as the remainder** so `aff + platform + customer == full_cents` exactly (largest-remainder discipline).
- **L6** — equalize work on `/affiliates/click` for hit/miss (already rate-limited) — low priority.
- **N4** — implement the Stripe discount path **or** gate discount resolution behind a live-provider check so non-Razorpay checkouts don't silently drop the discount; correct the CLAUDE.md / appendix "Stripe fallback" claim.
- **N6** — populate `ReferralConversion.affiliate_id` from `referral_code_id` at write time (payout audit trail).
- **Acceptance:** (N+1)th redemption rejected (incl. concurrent); expired code rejected; discount can't drive price below `MIN_PLAN_PAISE`; commission split reconciles to the cent; conversion rows carry a non-null `affiliate_id`.

### Phase 4 — Money formatting & data-correctness mediums  · ~3–4 d
- **M2** — format `format_amount` from integer minor units (`divmod`), no float equality; Indian (lakh) grouping for INR.
- **M3** — treat NULL-USD on a paid plan as a config error (block checkout + alert); remove the frozen FX path from anything that can charge.
- **M4** — rely on / add the `(client_id, period_start)` unique constraint for `UsageRecord`; handle `IntegrityError`; single-default enforcement for plans.
- **M6** — add `LeadInfo.created_at >= period_start` to the leads usage counter.
- **M7** — add an explicit `source` column to `Document` (upload vs crawl) and backfill; stop sniffing `name LIKE 'http%'`.
- **M8** — validate ranges on superadmin endpoints (`operator_quantity >= 0`, bound `extend_trial_days`); round MRR instead of floor. (None-crash already prevented by `default=1`.)
- **M4** — add an `IntegrityError` catch around `get_or_create_usage_record`'s insert → re-`SELECT` (the unique index already prevents the duplicate row).
- **N5** — replace `Plan.limits.default.arg` / `Plan.features.default.arg` with explicit literals (`or {}`); remove the dead `SELECT` at `superadmin_plan_routes.py:126`.
- **Acceptance:** INR amounts render with correct grouping; revenue endpoint can't 500 on negative/None quantity; `create_plan` without `limits`/`features` succeeds; quotas count the right rows.

### Phase 5 — Time / datetime hardening  · ~1–2 d
- **M5** — make `add_months` DST-safe: do the arithmetic in UTC (or normalize with `zoneinfo` + `fold`), preserving the documented anniversary semantics for IST.
- **T1 / N9** — replace naive `datetime.utcnow()` / `datetime.now()` in `ingestion/pipeline.py` (`:168,345,530,551`) with `datetime.now(UTC)`; emit aware-UTC `ingest_date` so chunk metadata isn't naive-vs-aware against the rest of the app (future-proofs for Python 3.14).
- **N8** — confirm billing-period rolls pass the **original anchor** to `add_months` (not the prior period-end); otherwise carry the anchor day separately to stop 29/30/31 drift.
- **Acceptance:** `add_months` unit tests across a DST boundary and a multi-month 31st-anchor chain; ruff clean; no naive `utcnow()` remaining (add a lint guard); `ingest_date` parses as aware-UTC.

### Phase 6 — Prorated upgrades feature (Option A)  · ~6–9 d · **depends on C2, H1**
**Objective:** charge only the prorated difference on mid-cycle upgrade, preserve the anchor, abandonment-safe. Full spec in [prorated upgrades design](2026-06-29-prorated-upgrades-design.md).
- Proration math in `transition_service` (one rounding point, clamp ≥ 0).
- One-time Razorpay **Order** for the difference → new subscription `start_at` = preserved anchor; **cancel old mandate only inside the webhook after capture** (fixes H1's abandoned-checkout gap).
- `POST /change-plan/preview` for "you'll be charged ₹X today"; fix the misleading "time credited" copy.
- Prorated incremental credit grant; webhook amount-tamper assertion.
- **Rollout:** behind `PRORATED_UPGRADES_ENABLED`; test clients → ₹1 plan → global.
- **Acceptance:** the design doc's 12-case test plan, incl. abandoned-checkout regression and anchor-preserved renewal.

### Phase 7 — Hardening, reconciliation & observability  · ~3–4 d
- **R1** — daily **settlement reconciliation** cron: compare Razorpay settlement/refund/dispute report vs ledger; emit exceptions and self-heal missed reversals (backstop for any dropped webhook). Depends on C2 + H6.
- **L4** — ✅ already implemented (`webhook_service.py:103`). **N7** (residual): close the narrow TOCTOU between the `getaddrinfo` check and `urlopen`'s own resolution — resolve once to a pinned public IP and connect to it with Host/SNI preserved.
- **L5** — metric + alert on event-id-less deliveries and on dead-letter inserts / clawback mismatches / lock timeouts.
- **Acceptance:** a deliberately-dropped webhook is healed by the next reconcile run; SSRF attempt to link-local is blocked at send; dashboards show the new metrics.

---

## 4. Sequencing & dependencies

```
P0 ─► P1 ─┬─► P2 ─► (H6) ─┐
          │                 ├─► P7 (R1 needs C2 + H6)
          ├─► P6 (needs C2 + H1)
          └─► P3
P4, P5  ── independent, schedule in any gap (no money-path deps)
```

- **Critical path to the upgrade feature:** P0 → P1 (C2, H1) → P6.
- **Critical path to reconciliation:** P0 → P1 (C2) → P2 (H6) → P7 (R1).
- P3, P4, P5 are parallelizable by a second engineer (different files, no shared locks).

**Suggested calendar:** P0+P1 first (revenue-protecting), then P2 and P3 in parallel, P4/P5 as fillers, P6 once P1 lands, P7 last.

---

## 5. Cross-cutting deliverables

- **Regression suite** seeded from review §7 and each design doc's test plan; runs in CI on every PR.
- **Migrations:** dead-letter table (P0); refund grant-link (P1); period-grant marker (P2); referral cap/expiry columns (P3); usage unique-constraint + `Document.source` (P4). All additive-first, reversible.
- **Runbook updates:** webhook replay from dead-letter; reconciliation exception triage; flag rollout steps (`docs/runbooks/`).
- **Doc updates on completion** (`document-release`): mark findings resolved in the review report; update billing overview.

---

## 6. Risk & rollback

| Risk | Mitigation |
|---|---|
| C1 5xx causes Razorpay retry storm on a real outage | Idempotency makes retries safe; dead-letter caps blast radius; flag to revert to 200 |
| C2 refund link migration on historical invoices | Backfill best-effort; clawback degrades to "most-recent in correct scope" for un-linkable legacy rows, logged |
| H1 lock contention / deadlock | Consistent lock ordering (client → subscription); `nowait`/timeout + retry; load test |
| P6 proration mis-charge | Flag-gated, test-client soak, preview endpoint shows exact charge, amount-tamper assertion |
| Migration downtime | Additive-first, online; no destructive drops until reads switched and soaked |

Every task is its own revertible PR; flags allow instant behavior rollback without redeploy where used.

---

## 7. Definition of done (per task)

1. Failing test written first; passes after; added to CI.
2. Code reviewed (Codex gate per `CLAUDE.md`); types/error-handling/conventions clean.
3. `ruff check` · `ruff format` · `pytest` green (and `npm run lint`/`build` for FE).
4. Migration up+down verified locally.
5. Observability (log/metric/alert) added for the new failure mode.
6. Flag default + rollout step documented.
7. Review report finding marked resolved; relevant doc updated.
