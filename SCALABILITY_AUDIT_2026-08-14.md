# OyeChats — Scalability, Performance & Capacity Audit

**Date:** 2026-08-14
**Scope:** `api/` (FastAPI backend), `app/` (React admin dashboard), production infrastructure
**Method:** Static code analysis of the whole repo + **live read-only inspection of the production droplet** (hardware, Postgres, Redis, nginx logs, systemd). No load tests were executed (see §Load-Test Strategy). Every claim is labelled **MEASURED** (observed on prod), **CONFIG-DERIVED** (read from config/code), or **ESTIMATED** (reasoned projection).

---

## Executive Summary

> **Is OyeChats scalable enough for production traffic today? → READY WITH CONDITIONS.**

The platform is **live and healthy at its current load, with enormous headroom** — but that is because current load is tiny. Production is serving **~0.1 requests/second** (peak ~385 req/hour), the box sits at **load average 0.08**, and there have been **zero 5xx errors in 24h and zero service restarts in 48 days** (all MEASURED). The database is **22 MB** (MEASURED) — this is an early-stage/beta deployment.

The engineering is genuinely careful: Redis-backed rate limiting, strong webhook idempotency, bounded conversation history, an HNSW vector index, SSRF-hardened outbound webhooks, and event-loop-offloading of the heavy RAG work are all already in place. **This is not a naive codebase.**

However, the architecture is **single-everything on one shared 2 vCPU / 4 GB droplet** (API, Postgres, Redis, ARQ worker, nginx all co-resident), pinned to **one gunicorn worker by design**, and it has **two classes of ceiling that will bite well before "big" traffic**:

1. **Concurrency ceiling (structural):** a streaming chat pins one synchronous DB connection for the *entire* LLM generation, against an API pool of ~10–15 connections. That caps concurrent AI conversations at **~10–15** regardless of CPU. On top of that, one event loop with some blocking DB work means one slow query stalls everyone.
2. **Data-growth ceiling (latent):** the fastest-growing, hottest-queried tables (`chat_messages`, `chat_sessions`) are **missing indexes on their primary access columns** — confirmed on the live DB via `EXPLAIN` showing sequential scans. Invisible at 63 rows; linearly painful at 1 M+.

Neither is a problem *today*. Both must be addressed before onboarding meaningful traffic or a single high-volume customer, and the horizontal-scaling blockers (in-memory WebSocket state, local-disk uploads) must be removed before a second instance can ever run.

---

## 1. Architecture & Infrastructure Assessment

### Production topology (MEASURED, live droplet `159.223.45.213`)

| Fact | Value | Source |
|---|---|---|
| Host | 1 × DigitalOcean droplet, **2 vCPU / 3.9 GB RAM / 2 GB swap** | `nproc`, `free -m` |
| Co-resident services | API (gunicorn) + Postgres 16 + Redis + ARQ worker + nginx + fail2ban — **all on one box** | `ps`, `systemctl` |
| API workers | **1 gunicorn/uvicorn worker** (`WEB_CONCURRENCY=1`, pinned) | `systemctl show` |
| API worker RSS | **~594 MB** (heavy: litellm, flashrank, weasyprint, langchain) | `ps` |
| ARQ worker RSS | ~355 MB | `ps` |
| RAM in use (idle) | ~1.4 GB / 3.9 GB used; 2.5 GB available | `free -m` |
| Load average | **0.08** (essentially idle) | `uptime` |
| Uptime / restarts | 48 days; **NRestarts=0**; 1 worker-timeout ever | `systemctl`, `journalctl` |

> ⚠️ **Doc drift:** `DEPLOYMENT.md` states "2 GB RAM / 1 vCPU". The live box is **2 vCPU / 4 GB** — it was upsized. Capacity math below uses the live values.
>
> **Resolved 2026-08-27.** `DEPLOYMENT.md` now states 4 GB / 2 vCPU, re-verified against the live box (`free -h`: 3.8 GiB total, 2 GB swapfile; `nproc`: 2). This audit's numbers were right and are unchanged.

### Why one worker (this is deliberate, not an oversight)

`gunicorn.conf.py` and the systemd unit both pin `WEB_CONCURRENCY=1` with a long docstring: the live-chat WebSocket `ConnectionManager` holds visitor/operator sockets in **in-process dicts**, and nginx pins clients to the single upstream port but *cannot* route a visitor and their operator to the same worker. Multi-worker would silently break live chat until a Redis pub/sub backplane ("Phase 3") lands. **The single-worker constraint is the master constraint the whole capacity story flows from.**

---

## 2. Backend Assessment (`api/`)

**Framework:** FastAPI + SQLAlchemy 2.0 (**synchronous** `create_engine`), Alembic, ARQ on Redis, LiteLLM, SlowAPI. 301 routes across 30 route modules; **541 sync `def` handlers vs 35 `async def`**.

The sync/async split matters: FastAPI runs sync `def` handlers in Starlette's **AnyIO threadpool (default ~40 threads)**, so most endpoints don't block the event loop. The danger is the **async handlers that do blocking sync DB work** — chiefly the chat stream and WebSocket routes.

### Key findings

- **[S1 — blocking sync DB in the async chat-stream path]** `chat_stream_endpoint` (`app/api/chat_routes.py:1200`, `async def`) runs blocking sync DB calls *before* streaming — subscription check (`:1219`), credit deduct + commit (`:1249-1261`), session resolve (`:1283`) — none offloaded to a threadpool. Then `rag_pipeline_stream` (`app/services/rag_service.py:6305`) opens **one sync session at `:6378` and holds it through the entire token loop to `session.commit()` at `:7161`**, executing history reads and message writes directly on the event loop. The heavy work (vector/keyword search, embeddings, moderation, LLM classifiers) *is* correctly offloaded via `asyncio.to_thread` — but the session lifecycle and writes are not. On a 1-worker process, any slow query here stalls **every** concurrent request. **This is the single worst structural issue.**

- **[S2 — DB connection pinned for the whole generation]** Because of S1, each active streaming chat holds one pooled connection for multiple seconds. API pool = `pool_size=5 + max_overflow=10` → **max 15** (`app/db/session.py:22-23`; live `.env` may set overflow=5 → 10). So **~10–15 concurrent streaming chats exhaust the pool**; the next request blocks up to `pool_timeout=30s` then errors. **Effective chat concurrency is bounded by the DB pool, not the CPU.**

- **[S3 — no global concurrency limit / backpressure]** The only throttles are per-key/per-IP SlowAPI token buckets (`/chat` and `/chat/stream` = `30/min`, keyed per bot-key+IP). There is **no global in-flight ceiling and no queue-depth limit**. Under a spike from many distinct IPs, each stays under its own bucket while collectively saturating the one worker → **event-loop stall, not graceful degradation**. The threadpool (~40) is also *larger* than the DB pool (~15), so 40 threads can pile onto 15 connections and queue on `pool_timeout`.

- **[S4 — LLM retry/fallback amplification]** No semaphore caps concurrent LLM calls. Each call carries `num_retries=2` (`app/services/llm_service.py:29`) **×** cross-provider fallback (`:147`). During a provider 429 storm this multiplies retries against an already-throttled provider. Timeouts are sane (60s + per-chunk 60s).

- **[S5 — 3-thread global background pool]** Fire-and-forget work (BANT extraction with a 45s LLM call, geolocation, lead enrichment) runs on a module-global `ThreadPoolExecutor(max_workers=3)` (`app/core/thread_pool.py:18`), **not ARQ**. It is non-durable (lost on restart) and contends for 3 slots. The prod journal shows recurring `asyncio: Task was destroyed but it is pending!` warnings consistent with this fire-and-forget pattern (MEASURED).

- **[Positive] Conversation history is bounded** — `get_chat_history(limit=5)` + 500-char truncation. Context does **not** grow unbounded. Embeddings are Redis-rate-limited, batched, and the query path fails fast to keyword-only rather than queueing behind ingestion. Auth key columns are indexed. Webhook idempotency is strong.

---

## 3. Database Assessment (PostgreSQL 16 + pgvector)

### Live state (MEASURED)

| Fact | Value |
|---|---|
| DB size | **22 MB** — early-stage data (documents 527, chat_sessions 63, chat_messages 393, clients 11, bots 6) |
| `max_connections` | 100; **13 in use at idle** (app pool, not Postgres, is the ceiling) |
| Config | **stock defaults** — `shared_buffers=128 MB`, `work_mem=4 MB` on a 4 GB box (untuned) |
| Cache hit ratio | 96.95% (trivial at 22 MB) |
| `pg_stat_statements` | **NOT installed** — no live slow-query telemetry available |
| Vector index | ✅ `documents_embedding_hnsw_idx` (HNSW cosine) present — **no seq scan on vector search** |
| TSVECTOR index | ✅ `ix_documents_search_vector` (GIN) present |

### 🔴 Confirmed missing indexes (MEASURED via `EXPLAIN` on the live DB)

```
EXPLAIN SELECT * FROM chat_messages WHERE session_id='x' ORDER BY created_at DESC LIMIT 5;
  ->  Seq Scan on chat_messages   (Filter: session_id = 'x')      -- runs EVERY chat turn

EXPLAIN SELECT * FROM chat_sessions WHERE bot_id=1 ORDER BY created_at DESC LIMIT 500;
  ->  Seq Scan on chat_sessions   (Filter: bot_id = 1)            -- runs on EVERY dashboard load
```

- **`chat_messages`** has only `PK` + `ix_chat_messages_is_unanswered`. **No index on `session_id`** — yet `session_id` is the join/filter key for history loads (every turn) and all analytics. `chat_messages` is the **fastest-growing table** (≥2 rows/turn).
- **`chat_sessions`** has only `PK` + `ix_chat_sessions_client_id`. **No index on `bot_id`** (the primary tenant filter in `_session_owner_filter`), nor on `created_at` (used for `ORDER BY … OFFSET` pagination in `get_visitor_data`, default limit 500), nor on `status` (live-chat routing filters `waiting`/`live`).
- **`visitor_events`** indexed on `session_id` only; **no `bot_id`** (per-bot behavioral queries scan).
- Stale reference: `models.py:804-806` documents a partial index from "migration d4e5f6a7b8c9" that **does not exist**.

**Impact:** free today (63 rows), linear pain at scale. At 1 M `chat_messages`, every chat turn's history read and every analytics aggregation becomes a full-table scan; these will dominate DB CPU on the shared box.

### Other DB findings

- **N+1** in `get_global_feedback_data` (`repository.py:1218-1234`): 1 + N queries, one per feedback row, each hitting the unindexed `chat_messages.session_id`. Platform-wide, unscoped, no LIMIT. (Sibling `get_feedback_data` was already fixed to a correlated subquery — this variant was missed.)
- **Unbounded queries** (no LIMIT, grow with tenant data): `get_message_activity` (all messages, no time window), `get_bant_signals`, `get_ingested_documents`, `get_all_platform_feedback`, `get_all_documents_for_bot` (loads full `Vector(768)` + content).
- **Write amplification:** each chat turn writes `chat_messages` ×2, `chat_sessions` ×2 UPDATE, `bant_signals`, `credit_ledger`, `bots`, plus up to 4 `visitor_events` — with **multiple commits per turn** (extra WAL/fsync).
- **Append-only tables with no pruning:** `chat_messages`, `bant_signals`, `visitor_events`, `credit_ledger`, `webhook_deliveries`, `llm_call_logs`, `audit_logs`. (`events` and `processed_webhooks` do have prune crons.)

### Scale forecast

| Table | 100 K | 1 M | 10 M | Root cause |
|---|---|---|---|---|
| `chat_messages` | history load already scans | analytics + history painful | dominates DB CPU | **no `session_id` index** |
| `chat_sessions` | visitor list slow | OFFSET + filesort | dashboard unusable | **no `bot_id`/`created_at`/`status` index** |
| `visitor_events` | ok per-session | per-bot scans | heavy | no `bot_id` index |
| `credit_ledger` | fine | fine | fine | well-indexed ✅ |

---

## 4. AI / LLM Assessment

- **Providers:** primary `openai/gpt-5.4-mini` → fallback `gemini/gemini-2.5-flash` via LiteLLM; embeddings hard-wired to Google `gemini-embedding-001` (**no embedding fallback** — a Gemini embed outage stops ingestion and degrades retrieval).
- **Per turn:** 1–4 LLM calls (optional query rewrite, optional handoff detection, optional relevance gate, main generation) + 1 embedding + 1 background BANT LLM. Retrieval (vector+keyword) is parallelized; the LLM chain is largely sequential.
- **Concurrency behaviour under N simultaneous AI users (ESTIMATED):** bounded by the DB pool (S2), *not* by any LLM-level limit. **~10–15 concurrent generations** is the practical ceiling before pool queueing; beyond that, requests queue on `pool_timeout=30s` and then 500. There is no application-level LLM concurrency cap or token-budget circuit breaker, so a burst relies entirely on the upstream providers' own rate limits + the retry/fallback amplification in S4.
- **Cost/DoS exposure:** the rate-limit key comment itself notes a distributed many-IP credit-drain is still possible; there is no per-bot daily spend/credit ceiling.

---

## 5. Frontend Assessment (`app/`)

React 19 + Vite + React Router 7. **No react-query/SWR/response cache anywhere** — every component mount refetches (plain axios). Auth is a static `X-API-Key` in `localStorage` with **no refresh loop** (good — no refresh amplification). The operator live-chat console is **WebSocket-driven, not polled** (well-architected: one socket/tab, duplicate-tab guard, exponential backoff).

**Backend load from the frontend, per open tab (analysis; matches prod nginx logs):**

| Behaviour | Req/min | Evidence |
|---|---|---|
| 🔴 Analytics **Journey** tab: 11-endpoint fan-out every 15 s | **~44/min** | `features/analytics/useJourneyAnalytics.ts:88-107,178` |
| 🔴 Live-chat preview drawer: full history every 4 s | **15/min each** | `features/inbox/LiveChatPanel.tsx:501-524` |
| 🟠 `CrawlContext` idle probe every 30 s — **on every page** | 2/min (30/min during a crawl) | `context/CrawlContext.jsx:41-47,164` |
| 🟠 Billing banners `/payment-recovery` ×2 every 5 min | 0.4/min | `AppShell.tsx:95-96` |
| Idle baseline (any tab) | **~2.4/min + 1 WS** | — |

Prod nginx logs corroborate this: top endpoints today are `/crawl/progress` (371 hits) and `/chat/connect-request` polling. **The Journey tab is the dominant amplifier** — 50 operators on that tab = ~2,200 req/min (~37 rps) of *expensive analytics* (which do the seq scans from §3) against the single worker. Fix: raise the interval, gate on "data changed", or collapse the 11 calls into one endpoint.

*(Two dead pollers exist but are imported nowhere — `LiveChatStatusPill.jsx` 5s poll, `GlobalCrawlIndicator.jsx` — flag before anyone re-enables them.)*

---

## 6. Capacity Estimate

| Metric | Value | Basis |
|---|---|---|
| Current sustained load | **~0.08–0.1 req/s** (peak ~385/hr) | **MEASURED** (nginx logs) |
| Current CPU load avg | **0.08 / 2 cores** | **MEASURED** |
| Concurrent DB-bound requests | **~10–15** (API pool) | **CONFIG-DERIVED** |
| Concurrent AI generations | **~10–15** before pool queueing | **CONFIG-DERIVED** (S2) |
| Postgres connection limit | 100 (app uses ~13–25) | **MEASURED** — not the bottleneck |
| Memory headroom for more workers | ~2–3 API workers fit in RAM (~600 MB each) — but blocked by S3/WS state | **ESTIMATED** |
| Comfortable concurrent active chatters | **~15–25** simultaneously mid-generation | **ESTIMATED** |
| Comfortable open dashboard tabs | **~20–30** (fewer if on the Journey tab) | **ESTIMATED** |
| Light-traffic (health/cached-config) throughput | low **hundreds of req/s** | **ESTIMATED** |
| **First breaking point** | DB-pool exhaustion on concurrent chat **OR** event-loop stall from a spike of a few hundred simultaneous requests **OR** Journey-tab analytics load as `chat_messages`/`chat_sessions` grow past ~10⁵ rows | **ESTIMATED** |

**Headroom framing:** the system runs at well under **1%** of its own structural ceiling today. It will not fall over from organic growth soon — but the ceiling is **~15 concurrent AI conversations**, which a single busy customer's website could reach, and the missing indexes convert data growth (not traffic) into latency.

---

## 7. Scalability Risk Matrix

| # | Area | Finding | Severity | Evidence | Recommendation |
|---|---|---|---|---|---|
| 1 | DB | `chat_messages.session_id` unindexed → seq scan every chat turn & analytics | **P1** (P0 at scale) | `EXPLAIN` on prod (MEASURED) | `CREATE INDEX CONCURRENTLY ix_chat_messages_session_id_created ON chat_messages(session_id, created_at DESC)` |
| 2 | DB | `chat_sessions.bot_id`/`created_at`/`status` unindexed → seq scan + filesort every dashboard load | **P1** (P0 at scale) | `EXPLAIN` on prod (MEASURED) | Composite `(bot_id, created_at DESC)` + partial on `status`; keyset-paginate `get_visitor_data` |
| 3 | Backend | Blocking sync DB in async `/chat/stream`; 1 connection pinned for whole generation | **P1** | `chat_routes.py:1219-1283`, `rag_service.py:6378-7161` | Make chat-path DB async, or offload every sync DB call via `to_thread`; shorten the session's lifetime |
| 4 | Concurrency | No global concurrency cap; threadpool(40) > DB pool(15); spike → event-loop stall not graceful degradation | **P1** | `gunicorn.conf.py:17-20`; pool `session.py:22`; SlowAPI per-key only | Add a global concurrency/queue limit; cap AnyIO threadpool to ≤ pool; enlarge pool |
| 5 | Scaling | In-memory WebSocket `ConnectionManager` + `NotificationBroadcaster` hard-block >1 worker/instance | **P1** | `live_chat_service.py:60-114`; `gunicorn.conf.py:6-24` | Redis pub/sub backplane ("Phase 3") before any horizontal scale |
| 6 | Scaling | Uploads written to **local disk** `documents/{client}/{bot}/` — a 2nd instance can't read them; also a data SPOF | **P1** | `document_routes.py:121-130` | Route uploads through R2/S3 (module already exists) |
| 7 | SPOF | Single Redis is load-bearing for rate-limit + queue + cache + presence + embed pacing | **P2** | `rate_limit.py:24`, `settings.py:259` | Managed Redis w/ persistence + failover; monitor |
| 8 | Worker | Single ARQ worker, one queue: ~27-min crawls (5 slots) can starve webhook/push/email jobs | **P2** | `settings.py:263-281` | Separate high-priority queue for latency-sensitive jobs |
| 9 | AI | No LLM concurrency cap; `num_retries=2` × fallback → retry storm on provider 429 | **P2** | `llm_service.py:29,147` | Concurrency semaphore + circuit breaker + per-bot spend ceiling |
| 10 | Frontend | Journey tab = ~44 expensive analytics req/min/tab; no client caching | **P2** | `useJourneyAnalytics.ts:88-186` | Raise interval / change-gate / collapse to 1 endpoint; add react-query |
| 11 | Backend | Auth = DB lookup per request (indexed, but a query on every call; bot cache-hit still runs a suspension query) | **P2** | `auth.py:467,494,1079` | Short-TTL cache of client/operator resolution |
| 12 | DB | N+1 in `get_global_feedback_data`; several unbounded queries | **P2** | `repository.py:1218-1234` | Correlated subquery + LIMIT/scope |
| 13 | AI | No embedding-provider fallback (Gemini only) | **P3** | `config.py:87-88` | Secondary embedding provider or degrade-to-keyword banner |
| 14 | Ops | `pg_stat_statements` not installed; Postgres at stock defaults on 4 GB; no APM dashboards | **P3** | live `pg_settings` (MEASURED) | Install `pg_stat_statements`; tune `shared_buffers`/`work_mem`; wire Sentry/Langfuse perf dashboards |
| 15 | Bg work | 3-thread global pool for BANT/geo/enrichment; non-durable | **P3** | `thread_pool.py:18` | Move BANT to ARQ (durable) |

---

## 8. Load-Test Strategy (scaffolding delivered; **not executed**)

k6 was chosen (HTTP/SSE-native, low overhead, thresholds-as-code, scriptable in JS). Scaffolding lives in [`load-tests/`](load-tests/README.md), **safety-guarded to refuse production and refuse real LLM spend by default**. Nothing was run — k6 is not installed in the audit environment and the audit rules forbid generating uncontrolled traffic against production.

**Run order (against a seeded staging box, never prod):**
1. `smoke.js` — 1 VU, prove scripts/auth/target.
2. `profiles.js PROFILE=baseline` — reference p50/p90/p95/p99 + error rate.
3. `chat-journey.js CHAT=1 MOCK_LLM=1` — drive concurrent streams to find the **~15-connection pool knee** (the key experiment).
4. `dashboard-polling.js JOURNEY=1 VUS=50` — quantify open-tab load.
5. `profiles.js PROFILE=stress` → `spike` → `soak` — saturation, recovery, leaks.

**Critical:** seed staging to 100 K / 1 M / 10 M rows first — the top bottlenecks (missing indexes) are **invisible at the current 63 rows**. Watch server-side DB pool state (`pg_stat_activity` waiting-on-pool), CPU, Redis, and ARQ backlog during each run (commands in the load-tests README).

### Recommended production thresholds

| Metric | Threshold | Reasoning |
|---|---|---|
| Non-chat API p95 / p99 | < 500 ms / < 1.5 s | Simple DB round-trips; leaves headroom under Cloudflare |
| Chat time-to-first-byte p95 | < 3 s | Beyond this the widget feels broken |
| Chat full-stream p95 | < 12 s | Generation-bound, provider-dependent (soft) |
| Error rate | < 1 % | Standard web error budget |
| DB pool utilisation | < 80 % sustained | Above this, chat requests queue on `pool_timeout` |
| AI concurrency | ≤ pool_size − headroom (~12) | The real chat ceiling until the async-DB fix lands |

---

## 9. Prioritised Fixes

**Before onboarding meaningful traffic or a high-volume customer (P1):**
1. Add the two missing hot-path indexes (`chat_messages(session_id, created_at)`, `chat_sessions(bot_id, created_at)` + `status` partial) — `CREATE INDEX CONCURRENTLY`, cheap now at 22 MB.
2. Fix the chat-stream DB path: make it async or offload every sync call; stop pinning a connection for the whole generation. This raises the AI-concurrency ceiling off the DB pool.
3. Add a global concurrency/backpressure limit and cap the AnyIO threadpool to the DB pool size so a spike degrades gracefully instead of stalling the loop.

**Before running a second instance (P1, horizontal-scale blockers):**
4. Redis pub/sub backplane for the WebSocket `ConnectionManager` + `NotificationBroadcaster`.
5. Move uploads off local disk to R2/S3.

**Hardening (P2):**
6. LLM concurrency semaphore + per-bot spend ceiling + circuit breaker.
7. Separate high-priority ARQ queue; cache auth lookups; fix the Journey-tab polling and the N+1.

**Ops (P3):**
8. Install `pg_stat_statements`, tune Postgres for 4 GB, wire performance dashboards, add an embedding-provider fallback, move BANT extraction to durable ARQ.

---

## 10. Production Readiness

**Verdict: READY WITH CONDITIONS.**

**Evidence for "ready":** live, stable, zero 5xx in 24 h, zero restarts in 48 days, load average 0.08, ~2.5 GB RAM free, correct indexes on the vector/FTS hot path, strong idempotency and rate-limiting, bounded history — running comfortably at current load with >99% headroom.

**The conditions:** it is single-worker / single-instance / single-DB / single-Redis / single-worker-process by design, with **documented horizontal-scaling blockers** (in-memory WS state, local-disk uploads), a **~10–15 concurrent-AI-conversation structural ceiling**, and **two missing hot-path indexes** that turn data growth into latency. It is **ready for continued low/moderate organic growth**, and **not ready for a large traffic surge, a single high-volume customer, or a second instance** until the P1 items land.
