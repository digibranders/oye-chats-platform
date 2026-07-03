# OyeChats Platform — Production-Readiness Review (Verified)

**Date:** 2026-07-03
**Supersedes:** `PRODUCTION_READINESS_REVIEW_2026-07-02.md` (safe to delete — this document is a complete replacement, not a supplement).
**Scope:** Full platform repo — API backend (~46k LOC Python), customer dashboard SPA (~37k LOC JS/JSX), embeddable widget (~2k LOC), infra/deploy config, test suite (963 test functions).
**Method:** The 2026-07-02 review's every claim was re-verified against source line-by-line via eight parallel deep-read audits (P0 blockers, billing lifecycle, data layer, security/RAG, infra/deploy, dashboard/widget, test suite/hygiene). Each finding below carries a verification verdict — **CONFIRMED**, **PARTIAL** (core holds, detail corrected), or **REFUTED** — with the actual verified file:line. Line numbers reflect the **current** tree (the billing code was refactored after 07-02, so several original references were stale and have been updated here).

---

## 1. Executive verdict

**Not production-ready as-is. Engineering quality is genuinely high — well above typical startup standard — but there are 3 verified P0 blockers and a cluster of real P1 issues that must be closed before onboarding paying, multi-tenant traffic.**

The codebase shows strong, incident-driven discipline: multi-tenant data scoping is enforced at the query layer with fail-loud guards (no IDOR or cross-bot retrieval found in row-level access), the OAuth flow and inbound-webhook trust boundary are textbook, credit accounting is event-sourced with advisory locks and FIFO attribution, the crawl/ingest pipeline is impressively hardened, and past outages (the July 1 litellm corruption) left visible scar tissue in health probes and deploy assertions. The money paths that already shipped are tested against a real Postgres to a production-grade standard.

But the platform is let down by foundational gaps clustered at the edges: an ingestion path that leaks one tenant's documents into another's bot, a billing seat-change flow that overcharges ~2x, an auth rate-limiter any attacker can trivially bypass, and a serving tier pinned to a single worker that blocks its own event loop. Around those sit real correctness bugs in the subscription lifecycle (downgrade/upgrade/resume/re-checkout), a widget with a broken teardown API, a stored-XSS vector in chat-file uploads, and large untested surfaces (live chat, RAG generation end-to-end, subscription routes, both frontends).

**Recommendation:** Fix the 3 P0s and the confirmed P1 cluster (billing lifecycle, missing indexes, origin-enforcement default, rate-limit trust boundary, worker/connection model) before GA. Most are small, well-scoped fixes — not rewrites.

### What changed from the 07-02 review

This verification confirmed the substance of the review but corrected **five refuted claims** and **eight overstated/partial claims**, updated stale line numbers, corrected the test-count headline (963, not 898), and added **nine newly-discovered bugs** (§6). The refuted/corrected items are called out inline and summarized in §7 so nothing acts on a claim that doesn't hold.

### Severity scorecard (post-verification)

| Area | P0 | P1 | P2 | Notes |
|------|----|----|----|-------|
| Security / auth | 1\* | 1 | 3 | Solid core, one bypass |
| Billing / payments | 1 | 4 confirmed, 1 partial | 3 confirmed, 1 refuted | Core good, lifecycle edges broken |
| RAG / chat pipeline | 0 | 2 | 6 | Good, capacity + fallback gaps |
| Data layer / CRUD | 1 | 4 confirmed, 2 partial | 4 confirmed, 1 partial | Strong, two foundational gaps |
| Infra / deploy | 1\* | 4 | 6 | Thoughtful, single-box fragile |
| Dashboard (SPA) | 0 | 2 | 3 | Good, no blockers |
| Widget | 0 | 1 confirmed, 1 refuted | 1 partial, 2 refuted | Strong; teardown API broken |
| Test suite / hygiene | 0 | 3 | mixed (3 refuted) | Great money paths, big gaps |

\* The `CF-Connecting-IP` rate-limit bypass was flagged by both the security and infra audits; counted once as a P0.

---

## 2. P0 — Launch blockers (all CONFIRMED)

### P0-1 · Rate limiting is bypassable via spoofed `CF-Connecting-IP` header — **CONFIRMED**
**Files:** `api/nginx/oyechats-locations.conf` (every location block, incl. default `location /`), `api/nginx/oyechats-api.conf:21-31`, `api/app/core/rate_limit.py:46-48`, `api/gunicorn.conf.py`

Nginx copies the **client-supplied** `CF-Connecting-IP` header into `X-Real-IP`/`X-Forwarded-For` verbatim (`proxy_set_header X-Real-IP $http_cf_connecting_ip;`) with **no** `set_real_ip_from` Cloudflare-range allowlist and **no** `real_ip_header` directive anywhere in either conf. `oyechats-api.conf:21-31` has an active plain `listen 80;` block with the HTTPS redirect commented out, so the origin is reachable directly. SlowAPI keys every auth limit on `get_remote_address` (`rate_limit.py:46-48`), which resolves to the attacker-chosen value; the `key_from_bot_key`/`key_from_api_key` helpers fall back to `get_remote_address` too.

**Impact:** An attacker rotates the header per request → every request lands in a fresh rate-limit bucket → login, register, password-reset (3/min), and OTP limits are all nullified → unlimited credential stuffing and OTP/verification brute-force. Also poisons IP-based audit/geo data.

**Fix:** Restrict origin ingress to Cloudflare IP ranges (ufw + nginx `set_real_ip_from` with `real_ip_header CF-Connecting-IP`), or use authenticated origin pull / a Tunnel. **Also fix the app layer** — set uvicorn/gunicorn `forwarded-allow-ips` to the trusted proxy only, or Starlette will still honor the spoofed `X-Forwarded-For` (see §6-9).

### P0-2 · Cross-tenant knowledge-base contamination via shared upload directory — **CONFIRMED**
**Files:** `api/app/config.py:389` (`DOCUMENTS_DIR = "documents"`), `api/app/api/document_routes.py:330-332,387-389,146-151`, `api/app/ingestion/pipeline.py:216-234`

Uploads are written to one global folder keyed only by original filename (`base_dir / filename`), then ingestion is enqueued against the **whole shared dir** (`enqueue_sync("task_ingest_documents", client_id, DOCUMENTS_DIR, bot_id)`). `run_folder_ingestion(client_id, folder_path, bot_id)` sweeps the **entire folder** via `os.listdir` and attributes **every** file it finds to the caller's `client_id`/`bot_id`.

**Impact:** Client A uploads `pricing.pdf`; before A's ARQ job runs, Client B uploads files. The first job to run ingests **both** tenants' files into its own bot and archives them — B's confidential document is now served verbatim by A's public chatbot, and B's job finds nothing. Same-name uploads silently overwrite; `DELETE /documents/{name}` unlinks by filename in the shared dir, so A deleting `report.pdf` can remove B's `report.pdf` from disk (DB rows are correctly tenant-scoped; the delete's cross-tenant reach is the on-disk unlink and fires only when A owns a same-named row).

**Fix:** Namespace storage to `documents/{client_id}/{bot_id}/`; pass explicit per-request file lists (not a folder sweep) to ingestion; scope the delete-time unlink identically. Note: `run_folder_ingestion` also **archives other tenants' pending files** out from under their jobs (§6-7) — the namespacing fix resolves both.

### P0-3 · Seat change bills `plan_price × quantity` instead of `plan + seat_price` — **CONFIRMED**
**Files:** `api/app/api/subscription_routes.py:1157-1158,1180,1204`, `api/app/services/razorpay_service.py:688-712` (anti-pattern), `504-533` (correct-but-dead mechanism), `377-380` (the comment warning against it)

`POST /subscriptions/seats` → `change_seat_count` → `update_subscription_quantity(session, sub, new_total)` where `sub` is the **main plan** subscription; this calls `rzp.subscription.edit(..., quantity=N)`, which multiplies the whole plan amount. The code's own comment (`razorpay_service.py:377-380`) documents that Razorpay quantity multiplies the whole plan (₹4,599×2 = ₹9,198, *not* ₹4,599+₹499). The correct mechanism, `create_seat_addon_subscription` (`RAZORPAY_SEAT_PLAN_ID`), has **zero production callers** (grep-verified — only its own def + two test references).

**Impact:** A ₹4,599/mo customer adding one extra seat (advertised ~₹499) is charged **₹9,198 every cycle** — a recurring ~₹4,100 overcharge. Adding an *included* seat also doubles the bill. The `change_seat_count` docstring is also stale/self-contradictory (claims a per-seat price the invoked mechanism cannot charge), which masked the bug from the original reviewer.

**Fix:** Route seat deltas through a separate seat add-on subscription; never edit the main sub's quantity. Wire up activation/charged webhook handling for the add-on (its notes carry `purpose=seat_addon` and would currently dead-letter).

---

## 3. P1 — Fix before launch

### Billing lifecycle

- **Scheduled downgrade silently lost — CONFIRMED (most dangerous P1).** `transition_service.schedule_paid_downgrade` (`transition_service.py:190-196`) calls `cancel_subscription(sub, at_period_end=True)` and stashes `scheduled_plan_id`, leaving status active. Promotion runs **only** in `_handle_subscription_completed` (`razorpay_service.py:1558`). But a cancel-at-cycle-end mandate fires **`subscription.cancelled`** at cutover (not `.completed`, which only fires after `total_count` cycles ≈ 10 yr), and `_handle_subscription_cancelled` (`razorpay_service.py:1534`) blindly sets `status="canceled"`. The cron safety-net then excludes the row (`tasks.py:451` filters `status in (active,trialing,past_due)`). Net: the queued downgrade never happens → customer drops to no active subscription → widget offline.
- **Upgrade strands the customer — CONFIRMED.** `transition_service.py:138-144` hard-cancels the old mandate (`at_period_end=False`) and sets `upgrade_credit_pending_cents` **before** creating the new checkout. Abandon the Razorpay modal → old mandate already gone, `apply_pending_proration` never runs, rollover credits stuck in `upgrade_credit_pending_cents` forever, service lost mid-cycle. (The automated cutover path has the same defect — see §6-3.)
- **`/subscriptions/resume` is a gateway no-op — CONFIRMED.** `subscription_routes.py:1139-1146` clears local flags (`cancel_at_period_end=False`, `canceled_at=None`) and returns "resumed successfully" with **no Razorpay call**. The cancel was issued to Razorpay with `cancel_at_cycle_end=1`, so the gateway still cancels at period end → involuntary churn despite the customer choosing to stay. (The sibling `/cancel-scheduled-change` route honestly surfaces `mandate_action: reauthorise_required`; `/resume` does not.)
- **Re-checkout while subscribed → double-charge — CONFIRMED.** `POST /checkout` (`subscription_routes.py:752-817`) has no "already subscribed" guard and calls `create_subscription` for any plan. `create_subscription` (`razorpay_service.py:279-392`) unconditionally creates a fresh Razorpay sub. Sibling cancellation happens only later in the `subscription.activated` webhook and is **local-only** (`razorpay_service.py:1273-1275` sets `old.status="canceled"` with no gateway cancel) → the old UPI mandate keeps debiting. (`change_plan` guards with "already on this plan"; the raw `/checkout` route does not.)
- **Renewal cron scope-blind under per-bot billing — PARTIAL (core confirmed).** In `tasks.py:380-405`: the `already_granted` probe (`tasks.py:382-393`) is **client-wide with no `bot_id` and no subscription/reference filter**, so bot A's grant today makes the probe truthy for bot B → bot B's renewal skipped while its period still rolls forward (permanent one-month credit loss). `reset_monthly_plan_credits(session, sub.client_id)` (`tasks.py:401`) omits `bot_id` → resets the **client pool** not the per-bot ledger, while `grant_for_subscription` (`tasks.py:402`) correctly scopes to `sub.bot_id` — a scope mismatch. *Correction vs 07-02:* the "two same-day renewals" framing is imprecise; the real defect is the unscoped probe + wrong-scope reset.

### Data layer

- **No vector index, no `bot_id`/`client_id` index on `documents` — CONFIRMED.** Migration `3424f908d31a…:32-34` **drops** the HNSW/ivfflat indexes and no later migration recreates any (grep-verified). `models.py:375-401`: `Document.bot_id`/`client_id` are plain FKs with no `index=True`; the only index is the GIN full-text index. Query `repository.py:561-580` runs `embedding <=> CAST(:emb AS vector)` filtered by `bot_id` — with no ANN index and no `bot_id` b-tree, Postgres seq-scans the tenant's rows and computes exact cosine distance per row every chat turn. One large customer's crawl degrades everyone's latency. Add HNSW (`vector_cosine_ops`) + b-tree on `bot_id`. **Related:** `documents.embedding` is nullable and the NOT-NULL constraint was never restored (§6-2).
- **Committed default superadmin credentials — CONFIRMED.** `b2c3d4e5f6a7_seed_superadmin_user.py:18-20`: `admin@oyechats.com` / bcrypt hash of `Admin@123`, inserted `is_superadmin=true`, in public repo history. Rotate in prod now; make the migration require an env-supplied hash.
- **Client suspension never enforced — CONFIRMED.** `superadmin_routes_v2.py:186` sets `suspended_at`; the only reads are admin-display serialization. `auth.py` never checks `suspended_at` in any dependency → a suspended customer's API key, bots, crawls, and emails keep working.
- **`/client/upload-logo`: unbounded read (DoS) — PARTIAL.** `client_routes.py:256-274`: `await file.read()` has no size limit → memory-exhaustion DoS (**confirmed**). *Correction vs 07-02:* the "stored XSS via content_type" half is **REFUTED** — `upload_to_r2` re-encodes the image and hard-codes `ContentType="image/png"`, and `/files/` sets `nosniff` + `Content-Disposition: attachment`, so the attacker's content_type never reaches storage. (The real XSS is on the *chat-file* path — see §6-1.)
- **Public offline-message endpoint: no rate limit + email amplification — PARTIAL.** `offline_message_routes.py:57-135`: no `@limiter.limit` and the global limiter is `default_limits=[]`, so only a public `bot_key` is required (**confirmed**). *Correction vs 07-02:* "arbitrary-recipient email to every team recipient + attacker address" is refined — team recipients are **bot-configured**, not attacker-chosen; the attacker controls only the single confirmation recipient. Still a real unauthenticated Brevo-quota-exhaustion / email-amplification / row-spam vector.
- **Email delivery failures invisible; worker-down = silent queue — CONFIRMED.** `email_service.py:251-314`: `send_email_async`/`send_template_async` are fire-and-forget (enqueue-and-return, or daemon thread); return values and exceptions discarded. No queue-depth metric, worker-liveness alert, or send-failure dead-letter — the exact class of the past OTP-never-sends incident remains structurally possible. `/health/full` reports worker readiness but does not gate the status code (a degraded worker still returns 200).

### Security

- **Email-verification OTP not invalidated on wrong guess — CONFIRMED.** `auth_routes.py:560-561`: the wrong-guess branch raises immediately and does **not** null `email_otp`/`email_otp_expires_at`, unlike the correct `reset_password` pattern at `864-869` (which invalidates on miss). The 6-digit OTP stays valid its full 15-min window; the `10/minute` limit is IP-keyed (spoofable per P0-1), so a rotating-IP attacker faces no per-OTP attempt ceiling. `login` (`634-662`) never checks `is_verified` — it returns the API key regardless and only reports verification status in the payload → verification is cosmetic.

### RAG / serving

- **Primary-stream timeout never falls back to Gemini — CONFIRMED.** `llm_service.py:336-339`: the `except TimeoutError` handler yields `" [Response timed out...]"` and `return`s unconditionally — it never inspects `primary_chunks_yielded`, so a stalled primary (zero chunks) skips the fallback block at `354-372`. The generic `except Exception` path *does* fall back correctly; only the timeout path — the exact case fallback exists for — is broken.
- **Event-loop blocking + per-stream DB-connection pinning on one worker — CONFIRMED.** `gunicorn.conf.py:20` `workers=1`; `db/session.py:18-20` pool `5+10=15`, `pool_timeout=30`. `rag_service.py:2984` opens `with get_session()` and `yield`s LLM chunks *inside* that block, holding the pooled sync connection for the full 10-30s stream; the post-stream `add_chat_message`/`commit` (`3523-3615`) run inside the same `with`. Every `session.query`/`flush`/`commit` is a blocking sync call on the event loop (contrast: moderation is offloaded via `asyncio.to_thread` at `3062` — the pattern was known but not applied to DB I/O). ~15 concurrent streams exhaust the pool; the 16th stalls/500s; any slow query freezes every live-chat WebSocket. A hard capacity cliff.

### Infra

- **Repo nginx serves plain HTTP — CONFIRMED (HSTS nuance).** `oyechats-api.conf:20-25`: active `listen 80;` only, redirect commented (`# return 301 …`); `32-43`: the entire `listen 443 ssl` block is commented out. *Correction vs 07-02:* HSTS is **not "commented out" — it is entirely absent** (`Strict-Transport-Security` never appears). TLS is presumably terminated at Cloudflare, but the repo origin config is HTTP-only with no redirect and no HSTS. Commit the real TLS config and sync on deploy.
- **No rollback path — CONFIRMED.** `deploy-api.yml:119-281` (single SSH script): `git reset --hard origin/main` (no prior-SHA capture) → `uv sync` → `alembic upgrade head` → `systemctl restart`, all **before** the health gate (`267-281`). On gate failure it prints logs and `exit 1` — no `git reset` to the old SHA, no `alembic downgrade`, no service restore. A failed gate leaves the broken build/deps/migrations live. Record the prior SHA and auto-restore on gate failure. (See §6-6: the same `git reset --hard` also destroys emergency hotfixes.)
- **Single box, 1 gunicorn worker, no PITR — CONFIRMED (sizing unverifiable from repo).** `gunicorn.conf.py:20` defaults to 1 worker (deploy never sets `WEB_CONCURRENCY`). `scripts/backup.sh:41` is a logical nightly `pg_dump` (cron `0 3 * * *`) — no `archive_command`, no WAL shipping, no PITR → up to ~24h RPO. Co-location of Postgres/Redis/API/worker/nginx is corroborated by CLAUDE.md; exact droplet RAM/vCPU is not in the repo. Stage: managed Postgres first, then Redis-pub/sub WS refactor to raise `WEB_CONCURRENCY`.
- **systemd default 90s `TimeoutStopSec` voids the graceful drain — CONFIRMED.** `gunicorn.conf.py:35` `graceful_timeout=1650` (to finish in-flight crawls, `SPIDER_TIMEOUT=1600`), but neither `oyechats-api.service` nor `oyechats-worker.service` sets `TimeoutStopSec` (grep-verified). Deploy uses `systemctl restart` → systemd SIGKILLs at the distro-default 90s, well before the 1650s window; ARQ re-runs the killed crawl, doubling crawl spend. Set `TimeoutStopSec` deliberately.

### Dashboard

- **Fabricated "SOC 2 compliant" + invented usage/uptime stats — CONFIRMED.** `Login.jsx:15` and `Register.jsx:15`: `'SOC 2 compliant & secure'` (SOC 2 is an audited certification, not a self-assertion). `Login.jsx:225-228`: hardcoded `10K+ Active bots / 5M+ Conversations / 99.9% Uptime`. Legal/compliance exposure; the marketing site was remediated for exactly this on July 1, the dashboard was missed. (Register's bottom stats — `Free / <5min / 24-7` — are aspirational-but-defensible, not fabricated metrics.)
- **Permanent API key in `localStorage`/`sessionStorage` — CONFIRMED.** `authStorage.js:50-63` writes the raw token plaintext; `api.js:53-67` attaches it as `X-API-Key`/`X-Operator-Key` on every request. Non-expiring client-side (the "Remember for 30 days" copy sets no TTL; `X-API-Key` maps to a long-lived `clients.api_key`), XSS-exfiltratable, gating the whole workspace incl. superadmin. Move to short-lived tokens / httpOnly cookies.

### Widget

- **Bot-key spoofing / cross-site embedding (origin enforcement defaults off) — CONFIRMED.** `_enforce_bot_origin` short-circuits when `domain_check_enabled` is false (`auth.py:377-378`), and the column defaults false (`models.py:340` `default=False, server_default="false"`; migration `b3d4e5f6a7c8`). Enforcement is correctly wired to `/chat`, `/chat/stream`, lead-capture, behavioral, public-settings, and WS (`ws_routes.py:220-230`), **but out of the box any site can embed any customer's public bot key**, drain their LLM credits, and exfiltrate their RAG knowledge base. Two extra nuances: the migration backfills `allowed_domains` from `bots.website` but leaves the flag off (so even bots with an allowlist are unprotected until an admin flips it), and the `X-API-Key` fallback path is intentionally exempt. Default `domain_check_enabled` to true, or force allowed-domains configuration at bot creation.
- **~~Duplicate script tag remounts brick `window.OyeChats`~~ — REFUTED as described; real teardown bug instead.** *Correction vs 07-02:* the loader uses a stub-and-queue design guarded by `window.OyeChats || stub` (`loader.js:65`) and a `_bootPromise` guard (`117`), so a second `<script>` tag or duplicate loader does **not** clobber the live impl — `open()/on()/identify()` keep working. **However** the real bug (see §6-4) is that `OyeChats.destroy()` is advertised but never implemented, so React-wrapper remounts leak the widget. The mechanism the original review described (`_registered` guard + cached ESM) is not the cause.

### Test suite

- **Live-chat handoff journey has essentially zero tests — CONFIRMED.** No test imports `live_chat_service.py`, `ws_routes.py`, or `transition_service.py`. (`test_live_chat_availability_service.py` covers the availability/routing-*decision* helper — 8 tests — but the handoff *execution* path is at zero.)
- **Core RAG generation pipeline untested end-to-end — PARTIAL.** `test_chat_routes.py:92` patches `rag_pipeline` with a static dict → the route never exercises real generation. *Correction vs 07-02:* `test_rag_service.py` (98 tests) does unit-test many `rag_service` internals (RRF, sanitizers, injection detection, BANT). The accurate statement: **the assembled `rag_pipeline()` / `rag_pipeline_stream()` orchestrators are untested end-to-end**; components are covered.
- **Subscription lifecycle routes untested — CONFIRMED.** The only route-level test (`test_subscription_routes_pricing.py`) is 4 pure `display_price` unit tests ("do not hit the database or the network"). No test posts to checkout callback / change-plan / cancel / resume / seats — exactly where the billing P0/P1s live. (Service-layer logic is partially covered in `test_subscription_renewal_grants.py` / `test_subscription_seats.py`.)

---

## 4. P2 — Fix soon (verified)

**Billing:**
- Per-bot top-up expiry writes to wrong ledger scope — **CONFIRMED** (`credit_service.py:616-624` writes the expiry debit with no `bot_id`, so a per-bot top-up's expiry lands in the client pool; per-bot balance stays inflated / spendable, client pool driven negative; the lock is also taken on the wrong scope).
- Subscription gate reads "latest row" not "active row" → paying customer locked out — **CONFIRMED** (`auth.py:541-550` and `609-618` select `ORDER BY created_at DESC LIMIT 1`; a newer terminal row — created by the lifecycle bugs above — 403s an actively-paying customer).
- ReferralConversion written per checkout **attempt** → payout landmine — **CONFIRMED** (`subscription_routes.py:804-816` inserts + commits at checkout-creation, before payment; model has no status/confirmed column; superadmin payout view lists all rows unfiltered → abandoned checkouts mint phantom conversions).
- ~~Downgrade-to-Free ends with no subscription → widget offline~~ — **REFUTED at the cited location** (`change_plan` keeps the row active — `cancel_at_period_end` for gateway subs, or flips to Free + re-grants for manual). The real widget-offline path is the lifecycle downgrade bug (§3), not a distinct Free-downgrade defect.

**Data layer:**
- Cross-tenant `department_id` accepted (IDOR-by-reference) — **CONFIRMED** (`operator_routes.py:385-393`: supplied `department_id` never ownership-validated against `client_id`).
- Unbounded list endpoints with Python-side pagination — **CONFIRMED** (`lead_routes.py:68-113`: no `.limit()/.offset()`; loads every session, paginates in Python).
- CSV formula-injection in lead export — **CONFIRMED** (`lead_routes.py:299-318`: visitor-supplied name/email/company written raw; no neutralization of leading `= + - @`).
- `delete_bot` ORM cascade without `passive_deletes` — **CONFIRMED** (`bot_routes.py:1540` + `models.py:365-370` `cascade="all, delete-orphan"` with no `passive_deletes=True` → row-by-row Python delete of documents/sessions/messages).
- `update_bot` accepts unvalidated `branding_url` — **PARTIAL** (`bot_routes.py:203`: scheme never validated, `javascript:` accepted and stored — **confirmed unvalidated**; but *correction vs 07-02:* not exploitable today — no UI renders `branding_url` as a live `href`; footer is hardcoded `https://oyechats.com`. Latent, fix before any UI wires it to an anchor).

**RAG:**
- Streaming refusal paths violate the SSE contract & never persisted — **PARTIAL** (`rag_service.py:3264-3303`: the gate-fired and empty-retrieval refusal branches skip `FINAL_METADATA` and don't persist; the middle `no_info_pivot` branch *does* — so 2 of 3 refusal exits, not all).
- Credits deducted before service, no retry idempotency + public-bot-key rate-limit key → visitor-driven credit drain — **CONFIRMED** (`chat_routes.py:401-409` deducts+commits before the RAG call; `check_and_deduct` uses `reference_id=bot.id` not a per-request key → retries double-charge; `30/minute` limit keyed on the public `x-bot-key` shared across all visitors).
- Injection-guard bypass via unfenced conversation history — **CONFIRMED** (`is_visitor_injection_attempt` scans only the current question; prior turns are flattened into the prompt under a plain `CONVERSATION HISTORY` header with no distrust fencing and never re-scanned).
- Client disconnect mid-stream drops the reply while still charging — **CONFIRMED** (no `GeneratorExit`/`CancelledError`/refund handling anywhere; on disconnect `full_answer` is never persisted but the credit was already committed).
- QA cache can replay one visitor's personalized answer to another — **CONFIRMED** (`rag_service.py:2488-2489` keys on `bot_id + sha256(question)` only, not session/visitor; personalized narrative answers are cacheable and cross-served. Compounds with the timeout bug — a truncated timed-out answer with `chunk_count>0` can be cached).
- Unthrottled `submit_offline_form` WS message → email bomb — **CONFIRMED** (`ws_routes.py:362-431`: no per-socket throttle; each frame inserts a row and sends one email per recipient **synchronously on the event loop**, so it both bombs inboxes and stalls the single worker's loop for all live-chat sockets).

**Infra:**
- Schema mutated from 3 places besides alembic — **CONFIRMED** (`main.py:166-187`: `CREATE EXTENSION`, `Base.metadata.create_all`, raw `ALTER TABLE … SET DEFAULT` at import time on every boot).
- Swagger `/docs` exposed in prod — **CONFIRMED** (`main.py:116` no `docs_url=None`; `/docs`, `/redoc`, `/openapi.json` live in all envs; `main.py:505` even advertises it).
- No alerting consumer of `/health/full` — **CONFIRMED** (only the one-shot deploy gate and a manual auth-gated superadmin route hit it; nothing polls it to page anyone despite the docstring claiming it does).
- Widget Sentry DSN never passed at build → dead in prod — **CONFIRMED** (`app-entry.jsx:9-10` reads `VITE_SENTRY_DSN` and returns if absent; `deploy-widget.yml` build sets only `VITE_API_URL`/`VITE_BUILD_TIMESTAMP`/`VITE_WIDGET_BASE` — no DSN; and Sentry only loads when `OYECHATS_DEBUG===true`, so it's doubly dead).
- `api/Dockerfile` broken + bakes `.env` — **CONFIRMED** (`Dockerfile:22` `uv run playwright install` but playwright/crawl4ai are removed from `pyproject.toml` → build fails; `COPY . .` with no `.dockerignore` → any local `api/.env` baked into the image. Prod uses systemd+uv, not Docker, so this is stale/local-only but broken and leaky as written).
- Services run as root, zero systemd hardening — **CONFIRMED** (both units `User=root`; no `NoNewPrivileges`/`ProtectSystem`/`PrivateTmp`/`ReadOnlyPaths`/`CapabilityBoundingSet`).

**Dashboard:**
- Stale-response races on bot switch — **PARTIAL** (`Leads.jsx:181-199` and `Dashboard.jsx:199` have no cancellation guard — **confirmed**; but `KnowledgeBase.jsx:135-166` *does* use a `cancelled` flag on the doc-fetch path — the claim was over-broad).
- Leads hard-capped at 200 with no pagination — **CONFIRMED** (`Leads.jsx:185` `getLeads(..., { limit: 200 })`; no offset/page/cursor; accounts with >200 leads silently truncate).
- 1.8 MB single bundle, no code splitting, beta Vite pinned — **CONFIRMED** (`app/dist/assets/index-*.js` ≈ 1.74 MB single chunk; no `manualChunks`; `package.json` pins `vite ^8.0.0-beta.13` — a beta major in a prod dashboard).

**Widget:**
- No React error boundary + unguarded `localStorage` → blanks for cookie-blocking users — **PARTIAL** (no error boundary anywhere — **confirmed**; but most `localStorage` access *is* try/catch-guarded — the real crash risk is `ChatWindow.jsx` unguarded writes at 896/899/975/1190/1556 which, with no boundary, blank the widget in Safari private mode).
- ~~Public docs/types promise 7 events + `identify()`/`update()` the code never delivers~~ — **REFUTED** (docs, `.d.ts`, and `VALID_EVENTS` all agree on 10 events; `identify()` and `update()` are both implemented. Real adjacent gaps: `destroy()` is unimplemented (§6-4) and `identify()` data is never sent to the backend (§6-5)).
- ~~Zcal booking auto-detection speculative/over-broad~~ — **REFUTED** (booking is server-driven: `finalMeta.show_booking && calendly_url`, provider from explicit `settings.meeting_provider`, gated on `meeting_booking_enabled` — no client-side heuristic exists).

**Tests / hygiene:**
- Dashboard has zero tests — **CONFIRMED** (no test files/script/deps under `app/`; CI runs lint+build only).
- Widget e2e never runs in CI — **CONFIRMED** (`widget/tests/e2e/smoke.spec.js` exists but no workflow invokes Playwright; deploy does only a file-existence smoke).
- Coverage gate decorative — **PARTIAL** (`pyproject.toml:79` `--cov-fail-under=15` confirmed and trivially low for a 963-test suite; the "45% actual" figure is unverifiable without running coverage).
- ~~Tests send real events to Sentry~~ — **REFUTED** (init gated on `SENTRY_ENABLED = bool(SENTRY_DSN)`; CI/conftest set no DSN → no init).
- Affiliate payout untested — **CONFIRMED but a non-gap** (`affiliate_service.py` v1 is explicitly money-free — "no payouts, those land in v2"; there is no payout code to test; the v1 surface is well covered).
- Outbound webhook delivery/retry untested — **CONFIRMED** (`fire_webhook`/`_deliver_webhook`/`process_pending_retries`/`_retry_worker_loop` have zero delivery/retry tests; existing tests cover only SSRF, signature verify, model shape, and *inbound* billing webhooks).

---

## 5. Dependency & hygiene (verified, with corrections)

- **Secrets:** clean — **CONFIRMED**. `.gitignore:8` = `.env`; `git ls-files` shows only `*.env.example` tracked; on-disk `api/.env`/`app/.env.local` exist but are correctly untracked.
- **Python deps:** sane — **CONFIRMED**. `litellm==1.89.4` (post-outage pin), `python-jose[cryptography]>=3.5.0` (CVE-remediated floor).
- **~~pytest-timeout referenced but not installed~~ — REFUTED.** It is neither referenced nor installed — no `--timeout`, no `@pytest.mark.timeout` anywhere. Adding it is a *nice-to-have* (the event-loop-blocking streams could hang a test run), not fixing a broken reference.
- **~~Frontend npm vulns (axios ~20 advisories, react-router-dom)~~ — REFUTED / stale.** Both apps pin `axios 1.14.0` (patched line); `app` uses `react-router-dom ^7.13.1` (current v7); **widget has no react-router-dom at all**. Re-run `npm audit` to get a current, accurate list before asserting counts.
- **Test count headline — CORRECTED.** Actual `def test_` count is **963** (not 898); ~25 files are `skipif(no DB_URL)`-gated and CI runs `pytest -x` (fail-fast), so a green CI badge does not by itself prove all pass. Re-state as "963 tests, green in CI on real pgvector" only after confirming a full non-`-x` run.
- **Docs drift:** DEPLOYMENT.md and README diverge from reality (Redis/worker undocumented, wrong embedding model, removed playwright still instructed) — a from-scratch rebuild following the docs produces a non-booting prod. Note the dashboard also pins a **beta major of Vite** (`^8.0.0-beta.13`) — a hygiene risk in its own right.

---

## 6. Newly-discovered bugs (not in the 07-02 review)

These surfaced during verification and should be triaged alongside the confirmed findings.

1. **🔴 Stored XSS via chat-file upload (higher-confidence than the two XSS items the original flagged).** `upload_chat_file` (`client_routes.py:245`, `operator_routes.py:1344`) stores the **caller-supplied `content_type` verbatim** (`r2_service.py:145-160`), unlike the logo path. The `/files/` route mitigates via `nosniff`+attachment for non-`_INLINE_SAFE_TYPES`, but if `image/svg+xml` (or any active type) is in `_INLINE_SAFE_TYPES`, an SVG-with-script served `inline` from the app origin is stored XSS. **Audit `_INLINE_SAFE_TYPES` in `main.py`.**
2. **🟠 `documents.embedding` is nullable and NOT-NULL was never restored** (`models.py:393`; migration `3424f908d31a` deferred it, no follow-up exists). Rows with `embedding IS NULL` silently drop out of vector search — a data-integrity gap compounding the missing-index P1.
3. **🟠 Automated downgrade cutover also strands the customer.** `promote_scheduled_change` (`transition_service.py:276-282`) sets the old sub `status="expired"` and flushes **before** creating the new (authorization-required) checkout → zero active subscription between promotion and the customer authorizing the new mandate → the latest-row auth gate (§4) 403s them and the widget goes offline. Same class as the manual-upgrade stranding, on the cron path.
4. **🟠 `OyeChats.destroy()` is a silent no-op after load.** Advertised in the loader stub (`loader.js:35`) and `types/oyechats.d.ts`, but `buildPublicApi()` (`app-entry.jsx:75-85`) never implements it. The official React wrapper calls `window.OyeChats?.destroy?.()` on unmount (`packages/react/src/index.js:60`) → shadow-DOM widget leaks across SPA route changes / logout. This is the true root cause of the remount hazard the original review mis-attributed to the `_registered` guard.
5. **🟡 `identify()` visitor identity never reaches the backend.** `widget-controller.js:154` only calls `setVisitor` (client-side); no chat request body in `widget/src/services/api.js` carries visitor name/email/phone/attributes. Customers wiring `identify()` for lead attribution get nothing server-side.
6. **🟡 Deploy destroys emergency hotfixes and can blank prod config.** `deploy-api.yml:134` `git reset --hard origin/main` with no prior-SHA capture wipes any scp'd hotfix (compounds the no-rollback P1); the workflow rewrites `.env` from CI each deploy (`141-200`), so any unset GitHub secret/var **silently blanks** that prod value (only a few keys are preflight-warned).
7. **🟡 `run_folder_ingestion` archives other tenants' pending files** (second P0-2 symptom): tenant A's job moves tenant B's not-yet-ingested upload to `ARCHIVE_DIR`/`QUARANTINE_DIR`, so B's file is silently never ingested. Resolved by the P0-2 namespacing fix.
8. **🟡 Renewal-cron `already_granted` probe ignores subscription/reference** (`tasks.py:382-393`): beyond the per-bot collision, any same-day `plan_grant` (manual credit, etc.) suppresses a legitimate renewal while the period still rolls forward → permanent one-month credit loss with no error.
9. **🟡 P0-1 fix is incomplete without the app layer.** Fixing nginx alone is insufficient — set uvicorn/gunicorn `forwarded-allow-ips` to the trusted proxy, or Starlette's `request.client.host` still resolves to the spoofed `X-Forwarded-For`.

---

## 7. Corrections log (claims from 07-02 that changed)

| Original claim | New verdict | Correction |
|---|---|---|
| Widget duplicate-script bricks `window.OyeChats` (`_registered`/ESM) | **REFUTED (mechanism)** | Loader stub-and-queue guards prevent bricking; real bug is unimplemented `destroy()` (§6-4) |
| Widget docs promise 7 events + `identify()`/`update()` never delivered | **REFUTED** | 10 events + both methods implemented; real gaps are `destroy()` and identify-not-transmitted |
| Zcal booking auto-detection speculative | **REFUTED** | Booking is server-driven, opt-in config |
| Tests send real events to Sentry | **REFUTED** | Init gated on DSN; CI sets none |
| axios ~20 advisories / react-router-dom vulns | **REFUTED/stale** | axios 1.14.0 patched; widget has no react-router-dom |
| Downgrade-to-Free ends with no subscription | **REFUTED at cited location** | `change_plan` keeps row active; real risk is lifecycle downgrade (§3) |
| pytest-timeout referenced but not installed | **REFUTED** | Neither referenced nor installed (non-issue) |
| upload-logo stored XSS via content_type | **PARTIAL** | DoS confirmed; XSS refuted (image re-encoded, `nosniff`) — real XSS is chat-file path (§6-1) |
| offline-message "arbitrary-recipient email" | **PARTIAL** | Team recipients are bot-configured; only confirmation recipient is attacker-controlled |
| `branding_url` javascript: XSS | **PARTIAL** | Unvalidated confirmed; not exploitable — no `href` sink today |
| Renewal cron "two same-day renewals" | **PARTIAL** | Real defect is unscoped probe + wrong-scope reset, not the framing given |
| RAG generation "untested" | **PARTIAL** | Components unit-tested; only end-to-end orchestrators untested |
| Streaming refusal "never persisted" | **PARTIAL** | 2 of 3 refusal branches, not all |
| KnowledgeBase stale-response race | **PARTIAL** | Doc-fetch path *is* guarded; only Leads/Dashboard unguarded |
| Widget "unguarded localStorage" | **PARTIAL** | Most access guarded; only `ChatWindow.jsx` writes unguarded |
| nginx HSTS "commented out" | **PARTIAL** | HSTS entirely absent, not commented |
| Droplet 2GB/1vCPU | **UNVERIFIABLE from repo** | Co-location + 1 worker confirmed; sizing not in repo |
| "898 tests, 898/898 green" | **CORRECTED** | 963 test functions; green unverifiable under `pytest -x` + DB-gated skips |
| Affiliate payout untested | **NON-GAP** | v1 has no payout code by design |

Everything not listed here **verified as CONFIRMED** against source.

---

## 8. What's genuinely strong (verified)

- **Multi-tenancy (row-level):** fail-loud `_owner_filter`, `SessionOwnershipError`, per-bot/client query scoping — no IDOR or cross-bot *retrieval* found. (The two tenancy breaks are at the ingestion filesystem layer (P0-2) and the `department_id` reference (P2), not the query layer.)
- **Webhook trust boundary:** HMAC over raw bytes with `compare_digest`, fail-closed on missing secret, atomic `INSERT … ON CONFLICT` idempotency, dead-letter + 5xx-for-retry, the `WebhookOutOfOrder` race fix.
- **Credit ledger:** event-sourced, advisory-locked per (client, bot), FIFO with per-grant attribution, invoice-linked for precise clawback. (The scope bugs are in the *cron/expiry callers*, not the ledger core.)
- **OAuth:** HMAC-signed expiring state + double-submit cookie, `aud`/`email_verified` checks, open-redirect prevention, refusal to auto-link.
- **Crawl/ingest:** atomic per-page billing, content-hash dedup, heartbeat + reaper, cancel-fast semantics, Redis Lua token-bucket tuned under the Gemini 3000 RPM ceiling.
- **Widget XSS posture:** react-markdown with no `rehype-raw`, scheme-allowlisted links, strict color/URL sanitizers, tested streaming sentinel stripper, Shadow DOM isolation, bot key via `Sec-WebSocket-Protocol`. (The residual gap is the chat-file upload content_type, §6-1.)
- **Incident-driven hardening:** `/health/full` LLM import probe, deploy-time `litellm.completion` assertion, worker-heartbeat gate, SSRF IP validation.
- **Test discipline where it counts:** billing webhooks, credit clawback/dispute/reconcile, and crawl/ingest tested against a real throwaway Postgres with behavior-level assertions and dated prod-regression docstrings.

---

## 9. Suggested sequencing

**Before GA (blockers + highest-risk P1s):**
1. **P0-2** upload namespacing (`documents/{client_id}/{bot_id}/`, explicit file lists) — highest trust risk; also fixes §6-7.
2. **P0-3** seat billing (route through the seat add-on sub; wire its webhook handling) — highest money risk.
3. **P0-1** rate-limit trust boundary (Cloudflare-only ingress **+ app-layer `forwarded-allow-ips`**, §6-9).
4. Billing lifecycle P1s (downgrade-lost, upgrade/cutover stranding incl. §6-3, resume no-op, re-checkout double-charge, renewal-cron scope incl. §6-8) — and the latest-row auth gate (§4) that turns them into lockouts.
5. `documents` indexes (HNSW + `bot_id` b-tree) **and** restore `embedding` NOT-NULL (§6-2) — do with any re-embed backfill.
6. Default `domain_check_enabled` on (widget spoofing) + rotate committed superadmin creds + enforce client suspension.
7. Dashboard: remove fabricated SOC 2 / stats.
8. **New:** audit `_INLINE_SAFE_TYPES` and stop storing caller content_type on chat-file uploads (§6-1).

**Fast-follow (P1 remainder + top P2s):** RAG fallback-on-timeout + move DB off the event loop / unpin the stream connection; email/worker liveness alerting; widget `destroy()` implementation + error boundary; throttle the offline-message and `submit_offline_form` paths; re-run `npm audit` and bump as needed; add tests for live chat, the RAG generation orchestrators, and the subscription lifecycle routes.

**Hardening track (P2/P3):** infra (TLS in repo + HSTS, rollback with prior-SHA restore, systemd hardening + `TimeoutStopSec`, Dockerfile + `.dockerignore`, managed Postgres + PITR), docs rewrite, dashboard code-splitting + stale-response guards + drop beta Vite, widget docs/API reconciliation (`identify()` transmission).
