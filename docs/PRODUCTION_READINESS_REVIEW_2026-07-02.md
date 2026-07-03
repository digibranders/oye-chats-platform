# OyeChats Platform — Production-Readiness Review

**Date:** 2026-07-02
**Scope:** Full platform repo — API backend (~46k LOC Python), customer dashboard SPA (~37k LOC JS/JSX), embeddable widget (~2k LOC), infra/deploy config, test suite (~13.7k LOC, 898 tests).
**Method:** Eight parallel deep-read audits (security/auth, billing, RAG/chat pipeline, data layer, infra/deploy, dashboard, widget, test suite), every in-scope file read in full. All P0 findings independently verified against source by the lead reviewer.

---

## 1. Executive verdict

**Not production-ready as-is. The engineering quality is genuinely high — well above typical startup standard — but there are 3 verified P0 blockers and ~20 P1 issues that must be closed before onboarding paying, multi-tenant traffic.**

The codebase shows strong, incident-driven discipline: multi-tenant data scoping is enforced at the query layer with fail-loud guards (no IDOR or cross-bot retrieval found), the OAuth flow and inbound-webhook trust boundary are textbook, credit accounting is event-sourced with advisory locks and FIFO attribution, the crawl/ingest pipeline is impressively hardened, and past outages (the July 1 litellm corruption) left visible scar tissue in the form of health probes and deploy assertions. The money paths that already shipped are tested against a real Postgres to a production-grade standard.

But the platform is let down by a few foundational gaps clustered at the edges: an ingestion path that can leak one tenant's documents into another's bot, a billing seat-change flow that overcharges by ~10x the intended amount, an auth rate-limiter that any attacker can trivially bypass, and a serving tier pinned to a single worker that blocks its own event loop. Around those sit real correctness bugs in the subscription lifecycle (downgrade/upgrade/resume), a widget that can permanently brick its own public API under common embedding conditions, and large untested surfaces (live chat, RAG generation, subscription routes, both frontends).

**Recommendation:** Fix the 3 P0s and the P1 cluster (billing lifecycle, missing indexes, origin-enforcement default, rate-limit trust boundary, worker/connection model) before GA. Most are small, well-scoped fixes — not rewrites.

### Severity scorecard

| Area | P0 | P1 | P2 | P3 | Overall |
|------|----|----|----|----|---------|
| Security / auth | 1* | 1 | 3 | 3 | Solid core, one bypass |
| Billing / payments | 1 | 5 | 4 | 5 | Core good, lifecycle edges broken |
| RAG / chat pipeline | 0 | 2 | 8 | 8 | Good, capacity + fallback gaps |
| Data layer / CRUD | 1 | 6 | 8 | 7 | Strong, two foundational gaps |
| Infra / deploy | 1* | 4 | 7 | 5 | Thoughtful, single-box fragile |
| Dashboard (SPA) | 0 | 2 | 5 | 8 | Good, no blockers |
| Widget | 0 | 2 | 6 | 10 | Strong, brick + spoofing risks |
| Test suite | 0 | 3 | 6 | 3 | Great money paths, big gaps |

\* The `CF-Connecting-IP` rate-limit bypass was flagged independently by both the security and infra audits; counted once as a P0.

---

## 2. P0 — Launch blockers (verified)

### P0-1 · Rate limiting is bypassable via spoofed `CF-Connecting-IP` header
**Files:** `api/nginx/oyechats-locations.conf:26-27,42-43`, `api/app/core/rate_limit.py:36-49`, `api/gunicorn.conf.py`
Nginx copies the **client-supplied** `CF-Connecting-IP` header into `X-Real-IP`/`X-Forwarded-For` with no `set_real_ip_from` Cloudflare-range validation, and the firewall permits direct origin access (a plain `:80` server block exists). SlowAPI keys every auth limit on `get_remote_address`, which now resolves to an attacker-chosen value.
**Impact:** An attacker rotates the header per request → every request lands in a fresh rate-limit bucket → login (5–10/min), register, password-reset (3/min), and OTP (2/min) limits are all nullified → unlimited credential stuffing and OTP/verification brute-force. Also poisons IP-based audit/geo data.
**Fix:** Restrict origin ingress to Cloudflare IP ranges (ufw + nginx `set_real_ip_from` with `real_ip_header CF-Connecting-IP`), or use an authenticated origin pull / Tunnel. Only honor `CF-Connecting-IP` from Cloudflare ranges.

### P0-2 · Cross-tenant knowledge-base contamination via shared upload directory
**Files:** `api/app/api/document_routes.py:330-338`, `api/app/ingestion/pipeline.py:216-236`, `api/app/config.py:386` (`DOCUMENTS_DIR = "documents"`) — **verified in source**
Uploads are written to one global folder keyed only by original filename (`base_dir / filename`), and `run_folder_ingestion(client_id, folder_path, bot_id)` sweeps the **entire folder** (`os.listdir(folder_path)`) under whichever tenant's job runs first.
**Impact:** Client A uploads `pricing.pdf`; before A's ARQ job runs, Client B uploads files. The first job to run ingests **both** tenants' files into its own bot and archives them — B's confidential document is now served verbatim by A's public chatbot, and B's job finds nothing. Same-name uploads silently overwrite; `DELETE /documents/{name}` can unlink another tenant's pending file.
**Fix:** Namespace storage to `documents/{client_id}/{bot_id}/`; pass explicit per-request file lists (not a folder sweep) to ingestion; scope the delete-time unlink identically.

### P0-3 · Seat change bills `plan_price × quantity` instead of `plan + seat_price`
**Files:** `api/app/api/subscription_routes.py:1052`, `api/app/services/razorpay_service.py:681-718` — **verified in source**
`POST /subscriptions/seats` calls `update_subscription_quantity` → `rzp.subscription.edit(quantity=N)` on the **main plan** subscription. The code's own comment (`razorpay_service.py:370-373`) documents that Razorpay quantity multiplies the whole plan amount (₹4,599×2 = ₹9,198, *not* ₹4,599+₹499). The correct mechanism, `create_seat_addon_subscription` (`RAZORPAY_SEAT_PLAN_ID`), has **zero callers** (grep-verified).
**Impact:** A ₹4,599/mo customer adding one extra seat (advertised ~₹499) is charged **₹9,198 every cycle** — a recurring ~₹4,100 overcharge. Adding an *included* seat also doubles the bill.
**Fix:** Route seat deltas through a separate seat add-on subscription; never edit the main sub's quantity. Wire up activation/charged webhook handling for the add-on (its notes carry `purpose=seat_addon` and would currently dead-letter).

---

## 3. P1 — Fix before launch

### Billing lifecycle (the remediation didn't reach these edges)
- **Scheduled downgrade silently lost** (`razorpay_service.py:1428-1438`, `worker/tasks.py:444-456`): downgrades are promoted only off `subscription.completed`, but `cancel(at_period_end)` fires `subscription.cancelled`; the cron then excludes the row because the webhook already flipped it to `canceled`. Customer's scheduled downgrade never happens → drops to no-subscription, widget goes offline.
- **Upgrade strands the customer** (`transition_service.py:132-152`): the old mandate is hard-cancelled *before* new payment. If the customer abandons the Razorpay modal, they've lost service mid-cycle with no refund and rollover credits stuck in `upgrade_credit_pending_cents` forever.
- **`/subscriptions/resume` is a gateway no-op** (`subscription_routes.py:968-994`): clears local flags only, makes no Razorpay call, but returns "resumed successfully." At period end Razorpay still cancels → involuntary churn despite the customer choosing to stay.
- **Re-checkout while subscribed → double-charge** (`subscription_routes.py:600-665`, `razorpay_service.py:1236-1252`): no "already subscribed" guard; sibling subs cancelled locally only, so the old UPI mandate keeps debiting at the gateway.
- **Renewal cron is scope-blind under per-bot billing** (`worker/tasks.py:380-405`): `already_granted` probe and `reset_monthly_plan_credits` omit `bot_id` → a client with two same-day renewals loses a month of credits on one, and per-bot grants wipe the client pool / stack grants.

### Data layer
- **No vector index, no `bot_id`/`client_id` index on `documents`** (`alembic/…3424f908d31a…:32-34`, never recreated): every chat turn full-scans the entire multi-tenant `documents` table computing cosine distance. One large customer's crawl degrades *everyone's* latency. Add HNSW (`vector_cosine_ops`) + b-tree on `bot_id`.
- **Committed default superadmin credentials** (`alembic/…b2c3d4e5f6a7…:19-21`): `admin@oyechats.com` / `Admin@123` bcrypt hash is in public repo history. Rotate in prod now; make the migration require an env-supplied hash.
- **Client suspension never enforced** (`superadmin_routes_v2.py:185` sets `suspended_at`; auth never checks it): suspending an abusive customer is purely cosmetic — their API key, bots, crawls, and emails keep working.
- **`/client/upload-logo`: no size or content-type limit** (`client_routes.py:256-274`): `await file.read()` is unbounded (memory-exhaustion DoS); attacker-controlled `content_type` stored on the R2 object → stored XSS via `/files/` on the API origin.
- **Public offline-message endpoint: no rate limit, arbitrary-recipient email** (`offline_message_routes.py:57-135`): only a public `bot_key` required; each call emails every team recipient + any attacker-supplied address → Brevo quota exhaustion, email-bombing, row spam.
- **Email delivery failures invisible; worker-down = silent queue** (`email_service.py:251-314`): the exact class of the past OTP-never-sends incident remains structurally possible — no queue-depth/worker-liveness alerting.

### Security
- **Email-verification OTP not invalidated on wrong guess** (`auth_routes.py:560-561` vs the correct `reset_password` pattern at 846-869): the 6-digit OTP stays valid for its full 15-min window across unlimited guesses; `login` also never checks `is_verified`, making verification cosmetic.

### RAG / serving
- **Primary-stream timeout never falls back to Gemini** (`llm_service.py:337-343`): `TimeoutError` returns immediately even with zero chunks yielded, so the fallback model is never tried for a stalled primary — every bot answers "[Response timed out]" during an upstream stall.
- **Event-loop blocking + per-stream DB-connection pinning on one worker** (`rag_service.py:2984-3015,3523-3615`, `chat_routes.py:272-313`, `gunicorn.conf.py` `workers=1`, `db/session.py` pool 5+10): sync DB writes on the event loop and a DB session held open across the whole 10–30s LLM stream → ~15 concurrent streams exhaust the pool; any slow query freezes every live-chat WebSocket. A hard capacity cliff.

### Infra
- **Repo nginx serves plain HTTP** — 443 block + HTTP→HTTPS redirect + HSTS all commented out (`oyechats-api.conf:20-43`); repo is not the source of truth it claims. Commit the real TLS config and sync on deploy.
- **No rollback path** (`.github/workflows/deploy-api.yml:120-268`): a failed health gate leaves the broken build, deps, and migrations live; only remedy is a manual revert commit through CI. Record the prior SHA and auto-restore on gate failure.
- **Whole platform on one 2GB/1vCPU droplet, 1 gunicorn worker** — Postgres, Redis, API, worker, nginx co-tenant; droplet loss = total outage with up to 24h RPO (nightly dump, no WAL/PITR). Stage: managed Postgres first, then Redis-pub/sub WS refactor to raise `WEB_CONCURRENCY`.
- **systemd default 90s `TimeoutStopSec` voids gunicorn's 1650s / ARQ's 1600s graceful drain**: every deploy SIGKILLs in-flight 20-min crawls at 90s; ARQ re-runs them, doubling crawl spend. Set `TimeoutStopSec` deliberately.

### Dashboard
- **Fabricated "SOC 2 compliant" + invented usage/uptime stats** on Login/Register (`Login.jsx:15,225-229`, `Register.jsx:15`): legal/compliance exposure. The marketing site was remediated for exactly this on July 1; the dashboard was missed.
- **Permanent API key in `localStorage`/`sessionStorage`** (`authStorage.js:50-63`, `api.js:53-67`): non-expiring, XSS-exfiltratable credential gating the whole workspace (incl. superadmin). Move to short-lived tokens / httpOnly cookies.

### Widget
- **Duplicate script tag or wrapper remount permanently bricks `window.OyeChats`** (`app-entry.jsx:109-163`, `loader.js:194-196`, `packages/react/src/index.js:57-63`): module-state `_registered` guard + cached ESM module means a second loader (GTM + hardcoded tag, or React StrictMode) leaves `OyeChats.open()/on()/identify()` silently dead. Make `register()` idempotent / detect an existing impl.
- **Bot-key spoofing / cross-site embedding** (`widget/src/services/api.js:8-21`; server enforcement `api/app/api/auth.py:368-391`): origin enforcement exists and is correctly wired to chat/stream/WS via `get_current_bot`, **but `_enforce_bot_origin` is a no-op unless `domain_check_enabled` is true, which defaults to false** (verified). Out of the box, any site can embed any customer's public bot key, drain their LLM credits, and exfiltrate their RAG knowledge base. Default `domain_check_enabled` to true, or force allowed-domains configuration at bot creation.

### Test suite
- **Live-chat handoff journey has zero tests** (`live_chat_service.py` 15%, `ws_routes.py` 10%, queue/routing/transition 0%): a headline feature with no regression safety.
- **Core RAG generation pipeline untested** (`rag_service.py` 32%; `test_chat_routes.py` mocks `rag_pipeline` entirely): retrieval→prompt→stream is unguarded.
- **Subscription lifecycle routes untested** (`subscription_routes.py` 24%): checkout callback, upgrade, cancel — exactly where the billing P0/P1s live.

---

## 4. P2 — Fix soon (selected; full lists in per-area detail)

**Billing:** per-bot top-up expiry writes to wrong ledger scope (`credit_service.py:615-625`); subscription gates read "latest row" not "active row" → paying customer locked out (`auth.py:541-547`); downgrade-to-Free ends with no subscription → widget offline (`subscription_routes.py:716-765`); `ReferralConversion` written per checkout *attempt* → payout landmine (`subscription_routes.py:652-664`).

**Data layer:** cross-tenant `department_id` accepted (IDOR-by-reference, `operator_routes.py:385-393`); unbounded list endpoints with Python-side pagination (`lead_routes.py:68-134`); N+1 patterns (feedback, operators, queue); CSV formula-injection in lead export (`lead_routes.py:299-318`); `delete_bot` ORM cascade without `passive_deletes` (row-by-row delete of 100k+ rows); profile email change with no validation/re-verification; `update_bot` accepts unvalidated `branding_url` → `javascript:` XSS in the widget's "Powered by" link (`bot_routes.py:181-203`).

**RAG:** streaming refusal paths violate the SSE contract and are never persisted → anti-repeat/escalation can never fire (`rag_service.py:3264-3303`); credits deducted before service with no retry idempotency + public-bot-key rate-limit key → visitor-driven credit drain (`chat_routes.py:285-313`); injection-guard bypass via unfenced conversation history (`rag_service.py:2400-2409`); client disconnect mid-stream drops the reply while still charging (`rag_service.py:3351-3364`); QA cache can replay one visitor's personalized answer to another (`rag_service.py:2488-2489`); unthrottled `submit_offline_form` WS message → email bomb (`ws_routes.py:317-343`); 3-thread background pool serializes geo+BANT under load.

**Infra:** schema mutated from 3 places besides alembic (`main.py:157-190`); Swagger `/docs` exposed in prod (`main.py:116,503`); no alerting consumer of `/health/full` (the LLM-probe exists but nothing pages on it); widget Sentry DSN never passed at build → dead in prod; `api/Dockerfile` broken (installs removed playwright) and bakes `.env` into the image (no `.dockerignore`); services run as root with zero systemd hardening; backup cron out-of-band and never restore-tested.

**Dashboard:** stale-response races when switching bots (Dashboard/Leads/KnowledgeBase have no cancellation guard); Leads hard-capped at 200 with no pagination; session-only operator logins miss `operator_id`; 1.8 MB single bundle, no code splitting, beta Vite pinned in prod; live-chat operator actions (transfer/accept/toggle) fail with zero user feedback.

**Widget:** no React error boundary + unguarded `localStorage` → blanks for cookie-blocking users; double error bubble leaking "check if the backend is running" to visitors; live-chat retry queue is dead code (offline sends silently lost); manifest fetched with default caching → stale-manifest bricks boot after deploys; public docs/types promise 7 events + `identify()`/`update()` that the code never delivers; Zcal booking auto-detection is speculative and over-broad (phantom "meeting confirmed").

**Tests:** dashboard has zero tests; widget e2e never runs in CI; coverage gate decorative (15% vs 45% actual); tests send real events to Sentry; affiliate payout untested; outbound webhook delivery/retry untested.

---

## 5. Dependency & hygiene (cross-cutting)

- **Secrets:** clean. No hardcoded production secrets in source; `.env` files gitignored (only `.env.example` tracked). Dev-only fixtures aside.
- **Frontend npm vulns:** dashboard has 6 (5 high) — notably a badly outdated `axios` (~20 advisories: SSRF, prototype-pollution, credential-leak) and `react-router-dom` (DoS/CSRF). Widget has 3 (2 high: `form-data` CRLF, `follow-redirects` header leak). All fixable via `npm audit fix` / minor bumps.
- **Python deps:** sane. `litellm` pinned (`==1.89.4`, post-outage), Sentry wired, `python-jose>=3.5.0`. Add `pytest-timeout` (referenced but not installed).
- **Docs drift:** DEPLOYMENT.md and README materially diverge from reality (Redis/worker not documented, wrong embedding model, removed playwright still instructed) — a from-scratch rebuild following the docs produces a non-booting prod.

---

## 6. What's genuinely strong

- **Multi-tenancy:** fail-loud `_owner_filter`, `SessionOwnershipError`, per-bot/client query scoping throughout — no IDOR or cross-bot retrieval found in any audit.
- **Webhook trust boundary:** HMAC over raw bytes with `compare_digest`, fail-closed on missing secret, atomic `INSERT … ON CONFLICT` idempotency, dead-letter + 5xx-for-retry, the `WebhookOutOfOrder` race fix.
- **Credit ledger:** event-sourced, advisory-locked per (client, bot), FIFO with per-grant attribution, invoice-linked for precise clawback.
- **OAuth:** HMAC-signed expiring state + double-submit cookie, `aud`/`email_verified` checks, open-redirect prevention, refusal to auto-link.
- **Crawl/ingest:** atomic per-page billing, content-hash dedup, heartbeat + reaper, cancel-fast semantics, Redis Lua token-bucket tuned under the Gemini 3000 RPM ceiling.
- **Widget XSS posture:** react-markdown with no `rehype-raw`, scheme-allowlisted links, strict color/URL sanitizers, a well-tested streaming sentinel stripper; Shadow DOM CSS isolation; bot key via `Sec-WebSocket-Protocol` not query string.
- **Incident-driven hardening:** `/health/full` LLM import probe, deploy-time `litellm.completion` assertion, worker-heartbeat gate, SSRF IP validation — visible learning from real outages.
- **Test discipline where it counts:** billing webhooks, credit clawback/dispute/reconcile, and crawl/ingest tested against a real throwaway Postgres with behavior-level assertions and dated prod-regression docstrings. 898/898 green in ~18s, running in CI on real pgvector.

---

## 7. Suggested sequencing

**Before GA (blockers + highest-risk P1s):**
1. P0-2 upload namespacing (tenant data leak) — highest trust risk.
2. P0-3 seat billing (active overcharge) — highest money risk.
3. P0-1 rate-limit trust boundary (Cloudflare-only ingress).
4. Billing lifecycle P1s (downgrade/upgrade/resume/re-checkout/renewal-cron).
5. `documents` indexes (HNSW + bot_id) — do with any re-embed backfill.
6. Default `domain_check_enabled` on (widget spoofing) + rotate committed superadmin creds + enforce client suspension.
7. Dashboard: remove fabricated SOC 2 / stats.

**Fast-follow (P1 remainder + top P2s):** RAG fallback-on-timeout + move DB off the event loop / unpin stream connection; email/worker liveness alerting; widget double-register brick + error boundary; `npm audit fix` on both frontends; add tests for live chat, RAG generation, and subscription lifecycle.

**Hardening track (P2/P3):** infra (TLS in repo, rollback, systemd hardening + timeouts, Dockerfile + `.dockerignore`, managed Postgres), docs rewrite, dashboard code-splitting + stale-response guards, widget docs/API reconciliation.
