# OyeChats — Consolidated Outstanding-Work Roadmap

> **Created:** 2026-07-04 · **Verified against code:** 2026-07-04 · **Owner:** platform eng
>
> **2026-07-04 audit note:** Every claim below was checked against the actual code (incl. the sibling
> `oyechats-admin` repo). §1/§2/§4/§5 verified accurate (line refs literal); §3 was ~80% stale and has
> been rewritten to the 5 real backend gaps; §0 (Security) was added from an independent review — these
> items appeared in no prior plan doc.
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

## 0. Security — must-fix
*Surfaced by the 2026-07-04 independent code review; **not present in any of the source plan docs.**
The codebase is otherwise well-built (webhook idempotency, credit-ledger advisory locks, and tenant
scoping across documents/leads/invoices/subscriptions/operators are all solid). These are the real
gaps. The two cross-tenant/escalation bugs are small, high-value fixes — do them before net-new work.*

### 0.1 Operator handoff — cross-tenant write (IDOR) ✅ FIXED 2026-07-04
`POST /operators/handoff` (`operator_routes.py`) loaded the session by `ChatSession.id` with no
`bot_id` filter — unlike siblings (`cancel_handoff` etc.). Authenticated only by the public
`X-Bot-Key`, a known-but-foreign `session_id` let an attacker flip another tenant's session to
`waiting` and overwrite `handoff_reason`/`department_id`. **Fix:** explicit ownership guard after the
load — an existing session whose `bot_id != bot.id` now returns 404 (the create-path already sets
`bot_id = bot.id`, so a genuine miss still works). Regression: `tests/test_handoff_tenant_isolation.py`.

### 0.2 Operator key can escalate to super-admin ✅ FIXED 2026-07-04
`get_superadmin` (`auth.py`) depended on `get_current_client`, which accepts `X-Operator-Key` and
resolves it to the owning Client — so an operator in a super-admin's workspace could reach
`/superadmin/*`. **Fix:** `get_superadmin` now depends on `get_current_client_strict` (X-API-Key only;
the super-admin console already authenticates that way). Covers all `/superadmin/*` routes (they all
funnel through this dep). Regression: `tests/test_superadmin_auth_strict.py`.

### 0.3 Anonymous credit-drain is default-open 🟡 P1 — partially fixed 2026-07-04
*(Sharper restatement of the §2.2 "visitor-driven credit drain" note.)* `/chat` + `/chat/stream`
deduct the **bot owner's** credits per request, authenticated only by the cleartext-embedded
`X-Bot-Key`. The widget rate limit was keyed on the bot key **alone** (`key_from_bot_key`), so all
visitors shared one `30/min` bucket — a copied key could exhaust it, starve the legitimate widget, and
help drain credits.

**Fixed:** `key_from_bot_key` now buckets per `<bot-key>:<client-ip>` (`rate_limit.py`), so a single
abusive IP can no longer monopolise the limit or lock out other visitors. Regression:
`tests/test_rate_limit_keys.py`.

**Still open (follow-ups):**
- The origin defense **fails open** by design: `domain_check_enabled` defaults `true` but
  `allowed_domains` defaults **empty**, and `_enforce_bot_origin` (`auth.py:~432`) no-ops on an empty
  allowlist (kept intentionally so the default-on flag doesn't brick unconfigured bots). Consider a
  softer default — e.g. a stricter per-IP limit while the allowlist is empty.
- Per-IP keying does not stop a **distributed (many-IP)** drain — needs a **per-bot daily credit
  ceiling**. (Also fold into the §2.2 RAG-cluster deduct-before-service work + the §0.4 refund path.)

### 0.4 P2 hardening (omitted from prior plans) 🔴
- ~~**`/chat/transcript`** emails a full transcript to an arbitrary `recipient_email`~~ ✅ FIXED
  2026-07-04 (`chat_routes.py`): when the session has a captured lead email, the recipient must match
  it (case-insensitive); no-lead sessions keep the anonymous self-send flow. Regression:
  `tests/test_transcript_recipient_lock.py`.
- ~~**Presigned R2 upload URLs** mintable by any holder of the public bot key~~ ✅ FIXED 2026-07-04
  (`chat_routes.py` + `widget/src/components/LiveChatMode.jsx`): the upload-url route now requires a
  `session_id` that belongs to the authenticated bot before issuing a presigned PUT, tying CDN uploads
  to a real chat session. Regression: `tests/test_upload_url_session_scope.py`.
- **`window.OYECHATS_API_KEY`** legacy embed (`widget/src/main.jsx:27`) places a client-level
  `X-API-Key` on `window` on third-party pages — deprecate the api-key embed path. *(Still open —
  customer-facing breaking change, needs a product/migration decision.)*
- ~~**Credits deducted-and-committed before generation** with no refund on failure~~ ✅ FIXED
  2026-07-04: the LLM layer never raises (it returns a canned error), so the pipeline now signals
  `generation_failed` (non-stream result dict; stream FINAL_METADATA via `chunk_count==0`/`_stream_error`)
  and `chat_routes` refunds the `ai_chat` credit on both paths via `_refund_ai_chat_credit`. A client
  disconnect before the terminal frame skips the refund (never over-refunds a delivered answer).
  Regression: `tests/test_credit_refund_on_failure.py`.
- Lower-severity: unbounded multi-session history query (`chat_routes.py:764-793`), unscoped
  `GET /ingest/status/{job_id}` (`document_routes.py:429`), implicit-only widget XSS defense (no
  DOMPurify; breaks if `rehype-raw` is ever added), `verify_email` OTP not burned on wrong guess.

---

## 1. Billing & Payments

### 1.1 Multi-currency Phase 2 — international USD rail 🔴
*Source: `superpowers/plans/2026-07-03-multi-currency-billing.md`. Phase 1 (Indian INR
coherence + confirm-country gate) is shipped; a confirmed non-IN buyer today hits the
`intl_usd_pending` "contact sales" branch. Intended to ship behind a `MULTICURRENCY_V2_ENABLED` flag
that **does not exist in the code yet** (0 hits) — creating it is part of P2-T6.*

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
- ~~**Landing-page pricing copy** (`pricing.ts`)~~ ✅ **DONE** (audit 2026-07-04): already reads
  "1 chatbot included (subscribe again to add more)", the feature-table row is "Chatbots included",
  and the multi-bot FAQ exists. (The remaining "+$5/mo each extra" refers to operator **seats**, not
  bots.)
- **Admin Billing UI** (`app/`): add a per-bot "Bots & Subscriptions" section, `AddBotPaywallModal`,
  and legacy-bot badges; remove `AddSeatConfirmModal`. *(`BotSeatsCard` is already gone — audit
  2026-07-04.)*
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
- **EMAIL-LIVE** — *worker-liveness in `/health/full` is already shipped* (`main.py:276-303`:
  `worker.status` alive/missing/disabled + `fully_ok` 503). **Remaining:** email-send failures are
  still fire-and-forget — no dead-letter queue / retry / send-failure alert.
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
- **DOCS-1** — Swagger `/docs` still exposed in prod. Set `docs_url=None` (+ `redoc_url`/`openapi_url`)
  on the `FastAPI(...)` init at **`main.py:116`** (the earlier `main.py:505` ref was wrong — that line
  is just the root route's JSON message field, not where docs are enabled).
- **ROLLBACK-1** — no deploy rollback / prior-SHA restore in `deploy-api.yml`.
- **SYSTEMD-1** — no `TimeoutStopSec` on either unit (voids the 1650s graceful drain); services run as
  root with no systemd hardening.
- **DOCKER-1** — broken `api/Dockerfile` (playwright install path, now that Playwright is removed) + no
  `.dockerignore`.
- **PG-1** — single box, logical nightly dump only; no PITR / managed Postgres.
- **DEP-1** — drop the beta Vite pin; run `npm audit`.
- **Dashboard hardening** — API key stored plaintext in `localStorage` (move to short-lived / httpOnly);
  1.8 MB single bundle (code-split).
- **TEST-1…5** — no end-to-end coverage for live-chat visitor→operator handoff, RAG generation
  orchestrators (`generate_response_stream`/`rag_pipeline_stream`), or outbound webhook
  delivery/retry (the 30s/2m/10m/1h/4h schedule); dashboard (`app/`) has **zero** tests. *(Correction:
  subscription **routes** are not uncovered — `test_subscription_routes_pricing.py`,
  `test_subscription_seats.py`, `test_subscription_renewal_grants.py`, `test_billing_*` exist; what's
  missing is a full trialing→active→past_due→canceled→expired state-machine e2e test.)*
- **Ops hygiene** — add secret-format validation + a weekly Sentry-event check (salvaged from the retired
  `sentry-dsn-repair` runbook — the 2-char-truncated DSN outage would have been caught by either).

---

## 3. Super-admin dashboard backlog
*Source: `superadmin-remediation-plan.md`. **Rewritten 2026-07-04 after a code audit against the
sibling `oyechats-admin/` repo (branch `development`) + the API `superadmin_*` routes.** The original
backlog is now ~80% stale: every P0/P1 item and all the P2 "pages to build" have shipped — the admin
UI is wired to live endpoints, and the repo's own `SUPERADMIN_REVIEW.md` (2026-06-30) is itself
stale. Only five backend gaps genuinely remain.*

### 3.1 Missing backend endpoints (Tier 2) 🔴
- **`GET /superadmin/departments`** — no superadmin route exists.
- **`GET /superadmin/canned-responses`** — no superadmin route exists.

### 3.2 Super-admin CRUD gaps (backend absent) 🔴
Read routes exist; mutations do not.
- **`PATCH` / `DELETE /superadmin/bots/{id}`** — only `GET /bots` + `GET /bots/{id}`
  (`superadmin_routes_v2.py:338,357`) today.
- **`POST` / `PATCH` / `DELETE /superadmin/operators`** — only `GET /operators`
  (`superadmin_routes_v2.py:511`).
- **`DELETE /superadmin/sessions/{id}`** — only `GET /sessions` + `GET /sessions/{id}`
  (`superadmin_routes_v2.py:415,436`).

### 3.3 Already shipped — struck from the backlog ✅
For the record (audit evidence in git history), all of the following — previously graded P0/P1/P2 —
are **done**: P0.1 synthetic-chart removal (`stats/timeseries` wired), P0.2 `/integrations` from
`health/full`, P0.3 client-contract fields (`suspended_at`/`superadmin_role`, `error_count`), P0.4
revenue cohorts, P1.1 RBAC promote/demote with last-owner guard, P1.2 data-driven settings
(`pricing-config`/`feature-flags` editable), and **every** P2 admin page (Usage Records, Offline
Messages, BANT Signals, Webhook Registrations, Payment Methods, Meeting Bookings, Create Client) plus
the formerly-"Tier 3/4 missing" backend + pages: OAuth accounts, failed-webhook DLQ replay, referral
conversions, notifications viewer, growth events, and the invoices/affiliate/GST-reconciliation ops.

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
- **`database-schema.md`** — accurate for the core 10 models but expand to cover the **~32 additional**
  billing/qualification/webhook/affiliate/notification/OAuth/audit tables now in `models.py`. **Actual
  count is 42 tables** (42 `__tablename__` declarations) — not the "~25" cited elsewhere in these docs.
- **`development-setup.md`** — `cd admin` → `cd app`; document the ARQ worker + Redis (required for
  invoice PDFs), `docker-compose`, and `scripts/dev.sh`.
- **`api-reference.md`** — expand to cover billing/subscription, webhook, affiliate, oauth, and
  qualification endpoints; add the `X-Operator-Key` scheme.
- **`billing/billing-system-overview.html`** — references Stripe 49× and the abandoned dual-provider
  architecture; update to Razorpay-only + invoicing v2.
- **`system-design/` site** — `index.md` hero + `er-diagram.md` say "23 tables" (CLAUDE.md says 25);
  **both are wrong — the real count is 42.** `tech-stack.md` still lists a `landing/` project row
  (landing is a separate repo); pages are dated 2026-04-28 and due a refresh sweep after the recent
  billing/PDF work.
- **`models.py:1401`** — the Affiliate model has a comment `see platform/docs/affiliate-program.md for
  details`; that plan doc was deleted (the affiliate program, incl. its deferred v2 money layer, is
  fully shipped). Drop or update the dangling reference.
