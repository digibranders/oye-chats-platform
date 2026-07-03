# OyeChats Production-Readiness Remediation — Master Program Plan

> **For agentic workers:** This is the PROGRAM plan. It sequences every finding from `docs/PRODUCTION_READINESS_REVIEW_2026-07-03.md` into phases with GA gates and per-finding acceptance criteria. Each phase has (or will have) a companion detailed TDD plan in this directory. Implement a phase only via its detailed plan using `superpowers:subagent-driven-development` or `superpowers:executing-plans`.

**Goal:** Take the OyeChats platform from "not production-ready" to a verifiable 100% GA-ready state by closing all 3 P0 blockers, ~15 P1s, ~20 P2s, and the 9 newly-discovered bugs, plus the infra/test/docs hardening track.

**Architecture:** Phased remediation with hard gates. Phase 0 (P0s) and Phase 1 (GA-blocking P1s) must both fully pass before onboarding paying multi-tenant traffic. Phases 2–4 are fast-follow and hardening; they do not block GA but are required for the "100%" target. Every fix is TDD-first against the existing real-Postgres test suite; frontend fixes are guarded by build + targeted tests.

**Tech Stack:** FastAPI · SQLAlchemy 2.0 · Alembic · pgvector · ARQ/Redis · Razorpay/Stripe · React 19/Vite · nginx · systemd · GitHub Actions · Cloudflare.

---

## How to read this document

- **Phase** = a shippable milestone with a gate. Do not start phase N+1 before phase N's gate passes (except where a task is explicitly marked parallelizable).
- **Finding ID** matches the review (`P0-1`, billing-lifecycle bullets are `BL-*`, new bugs are `NB-*`).
- Each task lists: **Files**, **Fix approach**, **Test**, **Acceptance criteria**, **Depends on**.
- **GA gate** = the checklist that must be green to declare that milestone done.

### Global conventions (apply to every task)

- **Branch:** all work on `development` (per CLAUDE.md — never touch `main` locally). One feature branch per phase is acceptable; PR `development → main` at each gate.
- **Backend tests:** `cd api && uv run pytest <target> -v`. Real-Postgres tests require `DB_URL`; they self-skip without it — CI provides it, so a fix touching DB behavior MUST include a real-DB test, not only a mock test.
- **Backend lint/format:** `cd api && uv run ruff check . && uv run ruff format .` before every commit.
- **Frontend:** `cd app && npm run lint && npm run build` (dashboard); `cd widget && npm run lint && npm run build` (widget).
- **Commit cadence:** commit after each red→green→refactor cycle. Conventional-commit prefixes (`fix(billing):`, `feat(security):`, `test(rag):`).
- **No placeholders in code.** Production-ready on every diff (Codex reviews every edit).

---

## Phase 0 — P0 launch blockers  ·  **detailed plan: `2026-07-03-phase-0-p0-blockers.md`**

The three findings that leak tenant data, overcharge customers, or nullify auth throttling. **Nothing ships until all three pass.**

| ID | Title | Files (primary) | Detailed plan |
|----|-------|-----------------|---------------|
| P0-2 | Cross-tenant KB contamination via shared upload dir | `api/app/api/document_routes.py`, `api/app/ingestion/pipeline.py`, `api/app/worker/tasks.py`, `api/app/config.py` | Phase 0 · Task 1 |
| P0-3 | Seat change bills `plan×qty` not `plan+seat` | `api/app/api/subscription_routes.py`, `api/app/services/razorpay_service.py`, `api/app/api/webhook_billing_routes.py` | Phase 0 · Task 2 |
| P0-1 | Rate-limit bypass via spoofed `CF-Connecting-IP` | `api/nginx/*.conf`, `api/gunicorn.conf.py`, `api/app/core/rate_limit.py`, ufw runbook | Phase 0 · Task 3 |

**Phase 0 GA gate:**
- [ ] P0-2: uploads are physically written under `documents/{client_id}/{bot_id}/`; ingestion sweeps only that tenant dir; delete unlink is tenant-scoped; a regression test proves tenant B's file is never ingested by tenant A's job.
- [ ] P0-3: `POST /subscriptions/seats` creates/edits a **separate** seat add-on subscription (never edits the main plan's quantity); the seat-addon `activated`/`charged` webhook is handled (no dead-letter); regression test asserts the main sub's quantity is untouched.
- [ ] P0-1: nginx derives the real client IP via `set_real_ip_from <CF ranges>` + `real_ip_header CF-Connecting-IP`; ufw restricts :80/:443 to Cloudflare ranges; a direct non-CF origin request cannot set its own rate-limit identity (documented + manually verified on the droplet).
- [ ] `uv run pytest` green; `ruff check`/`format` clean.

---

## Phase 1 — GA-blocking P1s

Correctness and trust bugs that would harm paying customers on day one. **Required before GA.**

### 1A · Billing lifecycle (companion plan: `2026-07-03-phase-1a-billing-lifecycle.md`)

| ID | Title | Files | Fix approach | Acceptance |
|----|-------|-------|--------------|------------|
| BL-1 | Scheduled downgrade lost (`cancelled` vs `completed`) | `razorpay_service.py:1534` (`_handle_subscription_cancelled`), `1558` (`_handle_subscription_completed`), `worker/tasks.py:444-456` | In `_handle_subscription_cancelled`, before flipping `status="canceled"`, check `local.scheduled_plan_id`; if set and the cancel is the scheduled-downgrade cutover, route to `promote_scheduled_change` instead of terminal-cancel. Make the cron promote off both `cancelled`+`scheduled_plan_id` and `completed`. | Real-DB test: schedule a downgrade → simulate `subscription.cancelled` webhook → assert customer lands on the lower tier with an active sub, not `canceled`. |
| BL-2 | Upgrade strands customer (cancel-before-pay) | `transition_service.py:132-152`, `276-327` | Reorder: create + confirm the new checkout/authorization BEFORE hard-cancelling the old mandate; keep old mandate until `subscription.activated` for the new sub fires; on modal-abandon, leave old mandate intact and clear `upgrade_credit_pending_cents` via a reconcile path. | Test: begin upgrade, abandon modal → old sub still active, no orphaned pending credits. |
| BL-3 | `/resume` is a gateway no-op | `subscription_routes.py:1120-1146` | Call Razorpay to actually resume/re-authorize (or return `mandate_action: reauthorise_required` like `/cancel-scheduled-change`); never return "resumed" without a gateway state change. | Test: resume when the gateway cancel is pending → route either re-authorizes at gateway or returns the reauthorise action; never silently lies. |
| BL-4 | Re-checkout while subscribed → double-charge | `subscription_routes.py:752-817`, `razorpay_service.py:279-392`, activated-webhook sibling-cancel `1273-1275` | Add an "already has active/pending sub" guard in `create_checkout`; when superseding, cancel the sibling **at the gateway** (call `cancel_subscription`) not just locally. | Test: checkout with an existing active sub → 409 or explicit supersede path that gateway-cancels the old mandate. |
| BL-5 | Renewal cron scope-blind | `worker/tasks.py:380-405` | Make the `already_granted` probe filter by `sub.id`/reference AND `bot_id`; pass `bot_id=sub.bot_id` to `reset_monthly_plan_credits`. | Real-DB test: two bots, same client, same-day renewal → both bots get exactly one grant; neither wipes the other. |
| NB-3 | Automated cutover strands customer | `transition_service.py:276-282` | Same pattern as BL-2 on the promotion path: don't `expire` the old sub until the new mandate is authorized. | Test: scheduled promotion with unauthorized new mandate → old sub remains serving. |
| NB-8 | Renewal probe ignores reference | folded into BL-5 | (same fix) | (same test extended: a same-day manual `plan_grant` must not suppress a renewal) |

**Related P2s to fix in this workstream (cheap while here):** `credit_service.py:616-624` per-bot expiry scope (write `bot_id=grant.bot_id`, lock on the grant's scope); `auth.py:541-550,609-618` subscription gate — select the **active** row (`status IN (active,trialing,past_due) ORDER BY created_at DESC`) not merely the latest row.

**1A gate:** all BL-*/NB-3/NB-8 tests green on real Postgres; the two P2s above fixed; `test_subscription_routes` grows from 4 pricing-only tests to cover checkout/resume/downgrade/upgrade/seats route behavior.

### 1B · Data & security foundations (companion plan: `2026-07-03-phase-1b-data-security.md`)

| ID | Title | Files | Fix approach | Acceptance |
|----|-------|-------|--------------|------------|
| IDX | Missing vector + `bot_id` indexes on `documents` | new alembic migration; `db/models.py:375-401` | New migration: `CREATE INDEX ... USING hnsw (embedding vector_cosine_ops)` and a b-tree on `bot_id` (+ `client_id`). Add `index=True` in the model for parity. | Migration applies cleanly; `EXPLAIN` on the retrieval query uses the index (documented). Coordinate with any re-embed backfill. |
| NB-2 | `documents.embedding` nullable, NOT-NULL never restored | new alembic migration; `db/models.py:393` | Backfill/purge NULL-embedding rows, then `ALTER COLUMN embedding SET NOT NULL`; restore `nullable=False` in the model. | Migration succeeds; no NULL-embedding rows remain; model matches DB. |
| CRED | Committed default superadmin creds | `alembic/.../b2c3d4e5f6a7...py`, ops runbook | Make the seed require an env-supplied bcrypt hash (fail if unset in prod); **rotate the live prod superadmin password now** (ops task, out-of-band). | Migration no longer contains a usable default; prod credential rotated + documented. |
| SUSP | Client suspension never enforced | `api/app/api/auth.py` (all client/bot deps) | Add a `suspended_at` check in `get_current_client`/`get_current_client_strict`/`get_current_bot` → 403 `account_suspended`. | Test: suspended client's API key + bot key are rejected on chat, upload, and admin routes. |
| ORIGIN | Widget bot-key spoofing (`domain_check_enabled` default false) | `db/models.py:340`, new migration, bot-creation path, `api/app/api/auth.py:377-378` | Default `domain_check_enabled=True` for new bots; migration to flip existing bots that HAVE an `allowed_domains` allowlist; force allowed-domains config at bot creation. Keep the X-API-Key exemption documented. | Test: a bot with the flag on rejects a foreign `Origin`/`Referer`; new bots default to enforced. |
| SOC2 | Fabricated SOC 2 + invented stats (dashboard) | `app/src/pages/Login.jsx:15,225-228`, `Register.jsx:15` | Remove "SOC 2 compliant"; replace fabricated `10K+/5M+/99.9%` with truthful or removed copy (mirror the July-1 website remediation). | `npm run build` green; grep shows no "SOC 2" / fabricated metrics in either page. |
| NB-1 | Stored XSS via chat-file upload content_type | `api/app/services/r2_service.py:145-160` (`upload_chat_file`), `_INLINE_SAFE_TYPES` in `main.py`, `client_routes.py:245`, `operator_routes.py:1344` | Never store caller-supplied `content_type` for chat files; sniff/allowlist and default to `application/octet-stream`; remove `image/svg+xml` from any inline-safe set; keep `nosniff`+attachment. | Test: upload an SVG-with-script as a chat file → stored `content_type` is not `image/svg+xml` and `/files/` serves it as attachment. |

**1B gate:** all tests green; migrations apply forward+backward on a throwaway DB; dashboard builds; prod superadmin rotated (ops sign-off).

---

## Phase 2 — Fast-follow P1s  ·  companion plan: `2026-07-03-phase-2-serving-and-widget.md`

Not day-one-fatal but high-impact; close before scaling traffic.

| ID | Title | Files | Fix approach | Acceptance |
|----|-------|-------|--------------|------------|
| RAG-TIMEOUT | Stream timeout never falls back to Gemini | `llm_service.py:336-339` | On `TimeoutError`, if `primary_chunks_yielded == 0`, fall through to the same fallback block the generic handler uses instead of returning the timeout string. | Test: primary times out at chunk 0 → fallback model is invoked and streams. |
| RAG-LOOP | Event-loop blocking + per-stream connection pinning | `rag_service.py:2984-3015,3523-3615`, `chat_routes.py`, `db/session.py`, `gunicorn.conf.py` | Move sync DB writes off the loop (`asyncio.to_thread` like the moderation call at `3062`); do NOT hold a pooled session open across the whole LLM stream — persist after the stream in a short-lived session. Document the path to `WEB_CONCURRENCY>1` (Redis pub/sub WS) as a follow-on. | Load test: N concurrent streams no longer exhaust the pool at ~15; a slow query does not freeze other streams. |
| EMAIL-LIVE | Email/worker liveness invisible | `email_service.py:251-314`, `/health/full`, alerting | Track enqueue failures; expose ARQ queue depth + worker heartbeat age in `/health/full` and make a degraded worker fail the probe; add an external alert consumer. | `/health/full` returns non-200 (or a `degraded` flag an alert can page on) when the worker is dead; test covers the probe logic. |
| OTP | Verify-email OTP not invalidated on wrong guess; login ignores `is_verified` | `auth_routes.py:560-561`, `634-662` | Mirror `reset_password:864-869` — null the OTP on wrong guess; decide + enforce the `is_verified` policy on login (block or step-up). | Test: second wrong OTP guess after a wrong one fails as "expired/invalid"; login policy for unverified accounts asserted. |
| NB-4 | `OyeChats.destroy()` is a no-op | `widget/src/app-entry.jsx:75-85,135-151`, `packages/react/src/index.js:60` | Implement `destroy()` in `buildPublicApi()` (unmount React root, reset `_registered`/`_root`, remove container); make the React wrapper's unmount actually tear down. | Test/e2e: mount → destroy → DOM container gone, no leak on remount. |
| WIDGET-EB | No React error boundary + unguarded `ChatWindow` localStorage | `widget/src/**` (add ErrorBoundary), `ChatWindow.jsx:896,899,975,1190,1556,586` | Add an error boundary around `<App/>`; wrap the unguarded `localStorage` writes in try/catch. | e2e in Safari-private-mode emulation: widget renders and survives a thrown `setItem`. |
| OFFLINE-RL | Offline-message + `submit_offline_form` unthrottled email amplification | `offline_message_routes.py:57-135`, `ws_routes.py:362-431` | Add a per-bot/per-session cooldown + SlowAPI limit on the HTTP endpoint; throttle the WS handler and send email off the event loop (enqueue). | Test: rapid submissions are rate-limited; email send is enqueued, not inline. |
| NB-5 | `identify()` never reaches backend | `widget-controller.js:154`, `widget/src/services/api.js` | Include visitor identity/attributes in the chat request body (and/or a dedicated identify call); persist to `LeadInfo`. | Test: `identify()` payload appears in the outbound request and is stored server-side. |

**Phase 2 gate:** all tests/e2e green; a documented concurrency load test shows the serving tier no longer cliffs at ~15 streams; widget builds and e2e passes locally.

---

## Phase 3 — P2 correctness sweep  ·  companion plan: `2026-07-03-phase-3-p2-correctness.md`

| ID | Title | Files | Fix |
|----|-------|-------|-----|
| REF-CONV | ReferralConversion written per checkout attempt | `subscription_routes.py:804-816`, `models.py:1603-1619`, `superadmin_ops_routes.py:1590-1593` | Add a `status`/`confirmed_at` column; write on payment-verified webhook, not checkout-creation; payout view filters to confirmed. |
| DEPT-IDOR | Cross-tenant `department_id` accepted | `operator_routes.py:385-393` | Validate the supplied `department_id` belongs to the caller's `client_id`. |
| LEAD-PAGE | Unbounded list + Python pagination | `lead_routes.py:68-113` | Push `LIMIT/OFFSET` into SQL; add real pagination params. |
| CSV-INJ | CSV formula injection in lead export | `lead_routes.py:299-318` | Prefix `= + - @ \t \r`-leading cells with `'` (or quote-escape). |
| CASCADE | `delete_bot` row-by-row cascade | `models.py:365-370`, `bot_routes.py:1540` | Add `passive_deletes=True` + DB-level `ON DELETE CASCADE`. |
| BRAND-URL | Unvalidated `branding_url` (latent XSS) | `bot_routes.py:203` | Validate scheme (http/https only) at write time. |
| RAG-REFUSAL | 2/3 refusal branches skip persist + FINAL_METADATA | `rag_service.py:3264-3303` | Persist + emit `FINAL_METADATA` on all refusal exits. |
| RAG-CREDIT | Credit deducted pre-service, no idempotency; public-key rate key | `chat_routes.py:285-409` | Add per-request idempotency key; add refund-on-failure; reconsider rate-limit key. |
| RAG-INJHIST | Injection guard skips conversation history | `rag_service.py:2400-2409,3125,3318`, prompt template | Fence + distrust history, or re-scan concatenated history. |
| RAG-DISCONNECT | Disconnect mid-stream drops reply, still charges | `rag_service.py:3351-3364` | Handle `GeneratorExit`/`CancelledError`: persist partial or refund. |
| QA-CACHE | QA cache cross-serves personalized answers | `rag_service.py:2488-2489,3546-3550` | Don't cache personalized/identity-bearing answers; or key by visitor context. |
| SPA-RACE | Stale-response races (Leads/Dashboard) | `Leads.jsx:181-199`, `Dashboard.jsx:199` | Shared `useAbortableEffect`/`cancelled` guard. |
| LEADS-CAP | Leads capped at 200, no pagination | `Leads.jsx:185` | Real pagination UI + API. |

**Phase 3 gate:** each fix has a test; backend suite green; both frontends build.

---

## Phase 4 — Hardening track  ·  companion plan: `2026-07-03-phase-4-hardening.md`

Infra, tests, docs, deps. Required for the "100%" target; parallelizable with Phases 2–3 by a separate owner.

**Infra:**
- TLS-1 · Commit real 443 block + HTTP→HTTPS redirect + HSTS (`oyechats-api.conf`); sync on deploy.
- ROLLBACK-1 · Capture prior SHA in `deploy-api.yml`; auto `git reset` + `alembic downgrade` + restart on gate failure. Covers NB-6 (stop `git reset --hard` destroying hotfixes; snapshot `.env` diff).
- SYSTEMD-1 · Set `TimeoutStopSec` (≥ `graceful_timeout`) + add hardening directives (`NoNewPrivileges`, `ProtectSystem=strict`, `PrivateTmp`, `User=` non-root) to both units.
- DOCKER-1 · Fix `api/Dockerfile` (drop removed playwright install) + add `.dockerignore` (exclude `.env`). (Or delete the Dockerfile if prod is systemd-only.)
- PG-1 · Migrate to managed Postgres + enable WAL/PITR (replaces nightly-dump-only RPO). Ops project.
- DOCS-1 · Swagger `/docs` off in prod (`docs_url=None` unless super-admin); NB-9 uvicorn `forwarded-allow-ips` (finish P0-1 at the app layer); SENTRY-1 pass `VITE_SENTRY_DSN` at widget build + load without `OYECHATS_DEBUG`; SCHEMA-1 stop `create_all`/raw `ALTER` at import (`main.py:157-190`) — alembic only.

**Tests:**
- TEST-1 · Live-chat handoff journey tests (`live_chat_service`, `ws_routes`, `transition_service`).
- TEST-2 · End-to-end `rag_pipeline` / `rag_pipeline_stream` tests.
- TEST-3 · Subscription lifecycle route tests (already seeded in Phase 1A — extend).
- TEST-4 · Wire widget e2e (Playwright) into CI; add dashboard smoke tests.
- TEST-5 · Raise `--cov-fail-under` to a real floor once coverage measured; webhook delivery/retry tests.

**Docs & deps:**
- DOCS-2 · Rewrite DEPLOYMENT.md/README to match reality (Redis/worker, embedding model, no playwright).
- DEP-1 · Re-run `npm audit` on both frontends; drop beta Vite (`^8.0.0-beta.13`) to a stable line; bump as needed.

**Phase 4 gate:** deploy dry-run proves rollback on induced gate failure; TLS live with HSTS; systemd SIGTERM drains gracefully; CI runs widget e2e; docs rebuild boots a working prod; `npm audit` clean-ish.

---

## Overall GA decision

**Minimum to onboard paying multi-tenant traffic:** Phase 0 gate ✅ **and** Phase 1 gate ✅.
**"100% production-ready" (the requested target):** Phases 0–4 all green, plus the ops-only items signed off (superadmin rotation, managed Postgres/PITR).

## Master finding → phase index (traceability)

| Review finding | Phase | Task ID |
|---|---|---|
| P0-1 rate-limit bypass | 0 | P0-1 |
| P0-2 upload contamination | 0 | P0-2 |
| P0-3 seat billing | 0 | P0-3 |
| BL scheduled downgrade lost | 1A | BL-1 |
| BL upgrade strands | 1A | BL-2 |
| BL resume no-op | 1A | BL-3 |
| BL re-checkout double-charge | 1A | BL-4 |
| BL renewal cron scope | 1A | BL-5 |
| P2 per-bot expiry scope | 1A | (folded) |
| P2 latest-vs-active gate | 1A | (folded) |
| documents indexes | 1B | IDX |
| superadmin creds | 1B | CRED |
| suspension unenforced | 1B | SUSP |
| widget origin default | 1B | ORIGIN |
| dashboard SOC2/stats | 1B | SOC2 |
| RAG timeout fallback | 2 | RAG-TIMEOUT |
| event-loop/pool | 2 | RAG-LOOP |
| email liveness | 2 | EMAIL-LIVE |
| OTP invalidation | 2 | OTP |
| offline endpoints RL | 2 | OFFLINE-RL |
| widget error boundary/localStorage | 2 | WIDGET-EB |
| ReferralConversion | 3 | REF-CONV |
| department_id IDOR | 3 | DEPT-IDOR |
| lead pagination | 3 | LEAD-PAGE |
| CSV injection | 3 | CSV-INJ |
| delete_bot cascade | 3 | CASCADE |
| branding_url | 3 | BRAND-URL |
| RAG refusal/credit/injhist/disconnect/qa-cache | 3 | RAG-* |
| SPA races / leads cap | 3 | SPA-RACE, LEADS-CAP |
| TLS / rollback / systemd / Dockerfile / PG / docs / schema | 4 | (infra) |
| test gaps / deps | 4 | TEST-*, DEP-1 |
| NB-1 chat-file XSS | 1B | NB-1 |
| NB-2 nullable embedding | 1B | NB-2 |
| NB-3 cutover strands | 1A | NB-3 |
| NB-4 destroy() no-op | 2 | NB-4 |
| NB-5 identify() not sent | 2 | NB-5 |
| NB-6 deploy wipes hotfix/.env | 4 | ROLLBACK-1 |
| NB-7 ingestion archives other tenant files | 0 | P0-2 (folded) |
| NB-8 renewal probe ignores reference | 1A | BL-5 |
| NB-9 uvicorn forwarded-allow-ips | 4 / 0 | P0-1 + DOCS-1 |
