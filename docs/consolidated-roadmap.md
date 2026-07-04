# OyeChats — Consolidated Outstanding-Work Roadmap

> **Created:** 2026-07-04 · **Owner:** platform eng
> **Purpose:** Single source of truth for *unfinished* work. This document aggregates every
> genuinely-outstanding item from the previously-scattered plan docs (per-bot billing,
> superadmin remediation, multi-currency billing Phase 2, the production-readiness master
> plan, the billing remediation register, and the invoicing v2 go-live gates). Those source
> plan docs have been deleted — their *shipped* content is now in the codebase and git
> history; their *remaining* content is here.
>
> Anything already implemented as of 2026-07-04 is **not** repeated here. For the verified
> audit evidence behind these items, see the two retained reference reports:
> [`PRODUCTION_READINESS_REVIEW_2026-07-03.md`](./PRODUCTION_READINESS_REVIEW_2026-07-03.md)
> and [`ai-response-audit-fynix-2026-04.md`](./ai-response-audit-fynix-2026-04.md).

**Status legend:** 🔴 not started · 🟡 partial / superseded-approach shipped · 🔵 non-code gate (business/legal/ops)

---

## 1. Billing & Payments

### 1.1 Multi-currency Phase 2 — international USD rail 🔴
*Source: `superpowers/plans/2026-07-03-multi-currency-billing.md`. Phase 1 (Indian INR
coherence + confirm-country gate) is shipped; a confirmed non-IN buyer today hits the
`intl_usd_pending` "contact sales" branch. Ships behind `MULTICURRENCY_V2_ENABLED` (default off).*

- **P2-T1 — Dual Razorpay plans + independent USD pricing.** Alembic migration adding
  `razorpay_plan_id_monthly_usd` / `razorpay_plan_id_annual_usd` to `Plan`; super-admin Plans
  UI to capture USD plan IDs + independent USD prices; `create_subscription` selects INR vs
  USD plan by confirmed country; extend the plan↔Razorpay price-integrity check to USD plans.
- **P2-T2 — International-card USD subscription + top-up.** Thread `currency` through
  `create_subscription` and `create_topup_order` (today hard-rejects non-INR at
  `razorpay_service.py:156-158`); restrict foreign flows to card; handle international webhooks
  with the same idempotency; flip the `intl_usd_pending` branch in
  `checkout_quote`/`create_checkout` to the live rail.
- **P2-T3 — Export-invoice branch.** Replace the INR-only finalize guard
  (`invoice_service.py:145`) with confirmed-country routing → zero-rated export invoice via the
  `core/tax.py` export path (LUT, place of supply "Outside India").
- **P2-T4 — INR-equivalent on export PDF (Rule 34).** Snapshot RBI/GAAP reference rate on date
  of supply; render "INR equivalent @ rate on <date>".
- **P2-T5 — FIRC/e-FIRA capture + three-rate reconciliation.** Persist FIRC/e-FIRA refs; extend
  `invoice_reports.py` to reconcile settlement/invoice/realization INR figures per export charge.
- **P2-T6 — Wire confirmed-country routing to the USD rail + FEMA note.**
- **Prerequisites 🔵:** verify international *recurring* card mandates are enabled on the Razorpay
  account; create + price USD Razorpay plans; LUT filed; CA sign-off on export invoicing + FX economics.

### 1.2 Settlement reconciliation cron — "R1" 🔴
*Source: `billing/2026-06-29-remediation-plan.md` §Phase 7. The existing
`invoice_reports.reconciliation_anomalies` + `task_invoice_reconciliation_alert` cron only checks
**invoice integrity** — it does not talk to Razorpay. Unblocked (C2 clawback scoping + H6 dispute
handler already shipped).*

- Daily cron that pulls the **Razorpay settlement / refund / dispute report** and compares it
  against `CreditLedger` + `Invoice` rows.
- **Self-heal** missed reversals — a dropped `refund.processed` / `dispute.lost` webhook should be
  caught and clawed back on the next run.
- Emit exception/alert on any mismatch (invoiced gross vs actual settled, per period). Use **actual
  settlement fees**, not an assumed 2% — fee rates vary by payment method (see invoicing v2 §1c).

### 1.3 Invoicing v2 go-live gates 🔵
*Source: `billing/2026-07-02-invoicing-implementation-plan-v2.md` §0 (retained). Feature is fully
built and running in shadow mode; these are the non-code gates to exit shadow mode.*

- **D1** — verify the Razorpay merchant account legal entity is **Digibranders Pvt Ltd** (the single
  hard gate to leave shadow mode).
- **D2** — CA picks the SAC code (997331 vs 998434).
- **D5** — LUT / export treatment confirmed (engine falls back to IGST 18% until confirmed — ties to §1.1).
- **D6** — invoice-number prefix branding decision.

### 1.4 Per-bot billing residuals 🟡
*Source: `per-bot-billing-plan.md`. Core is shipped (per-bot `plan_id`/`subscription_id`,
paywall gate, entitlements). These follow-ups remain.*

- Drop deprecated **`Client.extra_bot_seats`** column (`models.py:59`) — freeze writes, then drop in a
  follow-up migration after the 60-day window.
- Repurpose/remove **`Client.max_bots`** → `max_free_bots` (always 1); fix stale formula comment at
  `models.py:56` referencing `max_bots_cap`.
- **Landing-page pricing copy** (`../oyechats-website/src/lib/pricing.ts`, separate repo): "Up to 3
  chatbots (+$5/mo each extra)" → "1 chatbot included…"; drop the "Extra chatbots" feature-table row;
  add a multi-bot FAQ.
- **Admin Billing UI** (`app/`): per-bot "Bots & Subscriptions" section, `AddBotPaywallModal`,
  legacy-bot badges; remove `BotSeatsCard` / `AddSeatConfirmModal`.
- **Open product decisions (§9):** per-bot pricing (flat vs multi-bot discount); legacy-bot churn
  handling on downgrade (auto-pause / delete / migrate); mint new per-bot payment products vs reuse
  plan price IDs; Free-bot trial behavior.

### 1.5 Monetary prorated upgrades — "F1" 🟡 (deferred / likely superseded)
*Source: `billing/2026-06-29-prorated-upgrades-design.md`. A **different** upgrade model already
shipped (BL-2 re-auth: full new-plan checkout, old mandate retired at new-sub activation, unused
credits rolled over via `apply_pending_proration`) — this already fixed the abandoned-checkout
stranding and the misleading "time credited" copy that the design was written to solve. The dormant
`PRORATED_UPGRADES_ENABLED` flag is defined but read nowhere.*

**Only pursue if there is product appetite for charging just the money difference.** If so:
- Proration math in `transition_service` (one product, half-up, clamp ≥ 0): charge
  `(new − old) × remaining_fraction` today instead of the full new-plan price.
- One-time Razorpay **Order** for the difference (`purpose="plan_upgrade"`); new sub `start_at` =
  preserved period-end anchor.
- `POST /change-plan/preview` → `{upgrade_charge_minor, remaining_days, renewal_date, extra_credits}`.
- Prorated **incremental** credit grant (vs current full-rollover); webhook amount-tamper assertion.
- Wire the dormant `PRORATED_UPGRADES_ENABLED` flag; roll out test-clients → ₹1 plan → global.

*Otherwise: record the BL-2 credit-rollover model as the accepted approach and close this out.*

---

## 2. Production Readiness (Phases 2–4)

*Source: `superpowers/plans/2026-07-03-production-readiness-master.md` (Phases 0/1A/1B shipped) and
the verified `PRODUCTION_READINESS_REVIEW_2026-07-03.md` tail. Companion phase docs 2/3/4 were never
written — this section replaces them.*

### 2.1 Phase 2 — Serving & widget (P1) 🟡
- **RAG-TIMEOUT** — confirm the primary-stream timeout genuinely **falls back to Gemini on zero
  chunks** (`llm_service.py:336-343` has a `primary_chunks_yielded` guard but the timeout branch still
  yields a terminal message — verify the 0-chunk fall-through actually reaches Gemini).
- **RAG-LOOP / serving concurrency** — still `workers=1` (`gunicorn.conf.py:20`) and the DB session is
  held across the LLM stream (event-loop blocking / pool-pinning). Needs the Redis pub/sub +
  `WEB_CONCURRENCY` refactor.
- **EMAIL-LIVE** — surface ARQ worker liveness in `/health/full`; email-send failures are still
  fire-and-forget (no dead-letter / liveness alert).
- **OFFLINE-RL** — no cooldown/limit on offline-message routes / `submit_offline_form` WS path
  (email-bomb risk).
- **WIDGET-EB** — add a React error boundary; guard `ChatWindow.jsx` localStorage writes (Safari
  private mode throws).
- **NB-5** — `identify()` visitor data is never transmitted to the backend
  (`widget-controller.js:154`).
- *Done: NB-4 widget `destroy()`, OTP invalidation.*

### 2.2 Phase 3 — P2 correctness sweep 🔴 (mostly open)
- **DEPT-IDOR** — validate cross-tenant `department_id` on reference (IDOR-by-reference).
- **CSV-INJ** — lead-export formula-injection escaping (the shipped CSV-escaping commit was for the
  *invoicing* GSTR export, **not** leads).
- **LEAD-PAGE / LEADS-CAP** — `lead_routes.py:110-111` accepts `page/limit` but still slices in Python;
  push LIMIT/OFFSET into SQL; Leads currently hard-capped at 200.
- **CASCADE** — `delete_bot` needs `passive_deletes` on the ORM relationships.
- **RAG cluster:** injection-guard bypass via unfenced conversation history; visitor-driven credit
  drain (deduct-before-service, `reference_id=bot.id`, shared bot-key rate-limit); client-disconnect
  mid-stream charges without persisting; QA cache cross-serves personalized answers; SSE-contract
  refusal-persistence gaps.
- **SPA-RACE** — stale-response guards on `Leads.jsx` / `Dashboard.jsx`.
- *Done: BRAND-URL scheme validation.*

### 2.3 Phase 4 — Infra & hardening 🔴
- **TLS-1** — nginx 443 block is still commented out (`oyechats-api.conf:35`); no HSTS.
- **DOCS-1** — Swagger `/docs` still exposed in prod (`main.py:505`); set `docs_url=None` (+ redoc/openapi).
- **ROLLBACK-1** — no deploy rollback / prior-SHA restore in `deploy-api.yml`.
- **SYSTEMD-1** — no `TimeoutStopSec` on either unit (voids the 1650s graceful drain); services run as
  root with no systemd hardening.
- **DOCKER-1** — broken `api/Dockerfile` (playwright install path, now that Playwright is removed) + no
  `.dockerignore`.
- **PG-1** — single box, logical nightly dump only; no PITR / managed Postgres.
- **DEP-1** — drop the beta Vite pin; run `npm audit`.
- **Dashboard hardening** — API key stored plaintext in `localStorage` (move to short-lived / httpOnly);
  1.8 MB single bundle (code-split).
- **TEST-1…5** — no coverage for live-chat handoff, RAG generation orchestrators end-to-end,
  subscription lifecycle routes, outbound webhook delivery/retry; dashboard has zero tests.
- **Ops hygiene** — add secret-format validation + a weekly Sentry-event check (salvaged from the retired
  `sentry-dsn-repair` runbook — the 2-char-truncated DSN outage would have been caught by either).

---

## 3. Super-admin dashboard backlog
*Source: `superadmin-remediation-plan.md`. Backend endpoints are largely shipped; most remaining work
is wiring the admin UI (which lives in the sibling `oyechats-admin/` repo, not this tree) plus a few
backend gaps. Priorities as originally graded.*

### P0 — fake/placeholder data still shown
- **P0.1** — replace `Math.sin()` synthetic Command-Center/Revenue charts; backend `stats/timeseries`
  now exists → wire it and delete `syntheticSeries`.
- **P0.2** — `/integrations` hardcoded "connected" → drive from `health/full`.
- **P0.3** — contract drift: confirm `GET /superadmin/clients` returns `suspended_at` +
  `superadmin_role`; wire or drop `error_count` on `/superadmin/llm/usage`.
- **P0.4** — Revenue cohort placeholder → render `/cohorts` data inline (backend exists).

### P1
- **P1.1** — Permissions RBAC: promote/demote/role-edit wired to `PATCH /superadmin/clients/{id}`;
  guard last-owner self-demotion.
- **P1.2** — Settings page data-driven: surface `pricing-config` + `feature-flags` as editable; label
  the rest read-only (optional `GET /superadmin/system/config`).

### P2
- **Build the admin pages/types** for endpoints that already exist: Usage Records, Offline Messages,
  BANT Signals, Webhook Registrations, Payment Methods, Meeting Bookings, Create Client.
- **Missing backend endpoints:** `/superadmin/departments`, `/superadmin/canned-responses` (Tier 2);
  Tier 3/4 (OAuth accounts, failed-webhook DLQ replay, referral conversions, notifications viewer,
  growth events).
- **Superadmin CRUD gaps (backend absent):** `PATCH/DELETE /superadmin/bots/{id}`;
  `POST/PATCH/DELETE /superadmin/operators`; `DELETE /superadmin/sessions/{id}`.

---

## 4. AI response quality backlog
*Source: `ai-response-audit-fynix-2026-04.md` (retained as reference). The P0–P3 fix plan shipped
(`intent_router.py`, greeting/pronoun/no-info-pivot fixes, refusal-copy rotation). These were logged
as explicitly out-of-scope backlog and remain unbuilt.*

- **Canonical facts** — `Bot.canonical_facts` and `Document.is_canonical` do not exist in `models.py`;
  add a canonical-answer layer so key facts aren't drowned by retrieval.
- Per-bot brand-tone refusal copy.
- Homepage-priority re-crawl.

---

## 5. Documentation maintenance follow-ups
*Surfaced during the 2026-07-04 docs cleanup. Reference docs were kept but carry minor drift.*

- **`rag-pipeline.md`** — chunking section says 2000/300 but `config.py` defaults are 1000/200 (it even
  self-contradicts its own config table); add the newer CAG-lite / relevance-gate / rerank / MEDDIC /
  ARQ-background stages.
- **`architecture.md`** — rename `admin/` → `app/`; move the landing site to the separate
  `oyechats-website` repo; add ARQ/Redis, billing, webhooks, qualification to the system map.
- **`configuration.md`** — fix `admin/.env` → `app/.env`; add Razorpay/Stripe, Redis/ARQ, RAG
  feature-flag vars (`CAG_LITE_THRESHOLD`, `RELEVANCE_GATE_ENABLED`, `RERANK_ENABLED`), LLM fallback,
  `LANGFUSE_FORCE_DISABLE`.
- **`database-schema.md`** — accurate for the core 10 models but expand to cover the ~15 additional
  billing/qualification/webhook/affiliate/notification/OAuth tables now in `models.py` (~25 tables total).
- **`development-setup.md`** — `cd admin` → `cd app`; document the ARQ worker + Redis (required for
  invoice PDFs), `docker-compose`, and `scripts/dev.sh`.
- **`api-reference.md`** — expand to cover billing/subscription, webhook, affiliate, oauth, and
  qualification endpoints; add the `X-Operator-Key` scheme.
- **`billing/billing-system-overview.html`** — references Stripe 49× and the abandoned dual-provider
  architecture; update to Razorpay-only + invoicing v2.
- **`system-design/` site** — `index.md` hero says "23 tables" (schema-reference + CLAUDE.md say 25);
  `tech-stack.md` still lists a `landing/` project row (landing is a separate repo); pages are dated
  2026-04-28 and due a refresh sweep after the recent billing/PDF work.
- **`models.py:1401`** — the Affiliate model has a comment `see platform/docs/affiliate-program.md for
  details`; that plan doc was deleted (the affiliate program, incl. its deferred v2 money layer, is
  fully shipped). Drop or update the dangling reference.
