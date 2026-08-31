# Current limits

> **Audience:** CTO · Ops · **Read time:** 4 min · **Last updated:** 2026-08-31

## TL;DR

The platform runs on **two Gunicorn workers plus a dedicated single-worker WebSocket process, all on one droplet**, with Postgres and Redis colocated on the same host. This is sufficient for early customers (low hundreds of concurrent visitors per droplet), but every dimension is still on the same box — vertical-only scaling. The droplet is now the *only* remaining single point of failure in this list; the one-worker ceiling that used to head it was removed on 2026-08-20.

## Hard limits today

| Dimension | Limit | Source |
|---|---|---|
| Gunicorn workers (API) | **2** | `WEB_CONCURRENCY=2`, pinned in `api/systemd/oyechats-api.service`. `gunicorn.conf.py`'s own default is 1, but the unit is what production runs |
| WebSocket process | **1 worker** on `127.0.0.1:8001` | `api/systemd/oyechats-ws.service`; nginx routes `/ws/` there |
| DB pool per API worker | `pool_size=3`, `max_overflow=5` (8) | Pinned in the unit. The budget is **divided** across workers, not multiplied: 2 × 8 = 16, matching the two-worker line in `db/session.py`. The one-worker line is 5 + 10 |
| Concurrent chat generations | `CHAT_MAX_CONCURRENCY=6` per worker | **Must stay below the per-worker pool ceiling of 8.** Inverting it drains the pool, requests queue on `pool_timeout`, and gunicorn's reaper kills workers while Postgres sits idle — it reads exactly like a database problem. Measured on the rig with pool 3+2 and the gate at 10: ten to twelve worker kills in fifteen minutes, 34s p95, Postgres 100% idle throughout |
| Worker class | `uvicorn.workers.UvicornWorker` | gunicorn.conf.py |
| Max requests per worker | 10000 | `max_requests`. Raised from 1000, which used to fire mid-crawl and silently kill the job |
| Worker timeout | 120s | `timeout` |
| Graceful shutdown | 1650s | `graceful_timeout`, sized above `CRAWL_SUBPROCESS_TIMEOUT` (1600s) so a recycling worker can finish an in-flight crawl. Gunicorn spawns the replacement immediately, so new traffic is not blocked |
| Keepalive | 5s | `keepalive` |
| Concurrent WebSocket connections | bounded by event loop + per-connection memory; in practice ≤ a few hundred per process | empirical |
| `client_max_body_size` | 60 MB | `nginx/oyechats-api.conf` |
| Nginx rate limit (catch-all) | 10 req/s, burst 20 | nginx config |
| `/chat/stream` rate limit | 30/min per bot key | slowapi |
| Crawl job timeout | 1600s (`CRAWL_SUBPROCESS_TIMEOUT`); nginx allows 660s on the `/crawl` request | env + nginx |
| Knowledge quota (the binding crawl cap) | **Characters**, not pages — Free 2,500, Starter 50,000 | plan `limits.knowledge_characters` |
| Embedding throughput | `EMBED_RPM_LIMIT=2850` content items/min, `EMBED_CONCURRENCY=8` batches of 100 | Client-side throttle beneath the Gemini project quota |
| Query-embed wait ceiling | `EMBED_QUERY_MAX_WAIT_S=2.0` | Past this a chat request abandons the vector arm rather than pinning a thread on a bulk crawl's token debt |

## Resource footprint (single droplet)

Approximate, observed under low-mid load:

| Resource | Steady state | Peaks |
|---|---|---|
| API process RAM | 250–400 MB | 600 MB during embedding bursts |
| Worker process RAM | 200–300 MB | Crawling is off-box now, so the old 800 MB Chromium peak is gone |
| Postgres RAM | 200–500 MB | bounded by `shared_buffers` |
| Redis RAM | 20–100 MB | `redis_used_memory_mb` in /health |
| Total RAM headroom | 4 GB droplet, 2 vCPU | tighter with three long-lived Python processes |
| Disk | DB + R2 cache + logs | journalctl rotated weekly |

Memory pressure was the reason Langfuse was switched off at one point; `LANGFUSE_FORCE_DISABLE` remains the kill switch but is **not currently set** in production. Removing the headless browser and the local embedding model from the dependency set (both now off-box) took out the dominant memory consumer.

## Why two API workers, and not more

It used to be one, for a real reason: the in-memory `ConnectionManager` in `live_chat_service.py` holds WebSocket presence in a per-process dict, and nginx's `ip_hash` pins a client to the upstream **port**, not to a worker behind it — so with two workers a visitor and their operator could land on different processes and stop seeing each other.

That constraint was removed on **2026-08-20**: `/ws/*` moved to `oyechats-ws.service`, a dedicated single-worker process, with Redis pub/sub carrying frames between processes. The API then went to two workers.

It stopped at two rather than four deliberately. A load rig measured four as better, but it ran Postgres on a separate node; here everything is co-resident on 2 vCPU / 4 GB. `db/session.py` documents pool budgets for one and two workers only, and four would be invented math: 4 × 15 = 60 of `max_connections=100` before the ARQ worker's 10 and the WS process's 5. At today's real load (~0.1 req/s) four buys nothing two does not.

**The consequence to remember:** `ConnectionManager`'s dicts are permanently empty on the API process, so any fan-out that iterates them reaches nobody. Cross-process delivery must go through the backplane, and the backplane is flag-gated (`WS_BACKPLANE_ENABLED`).

## DB pool

Budgets are documented in [`api/app/db/session.py`](../../../../api/app/db/session.py) and pinned in the systemd units, against `max_connections=100` shared by every process on the box:

```
API,  1 gunicorn worker  → pool_size=5, max_overflow=10   (max 15)
API,  2 gunicorn workers → pool_size=3, max_overflow=5    (max 16 total)   ← production
ARQ worker (WORKER_MAX_JOBS=5) → pool_size=5, max_overflow=5 (max 10)
WS process               → ~5
pool_timeout = 30s · pool_recycle = 1800s · pool_pre_ping = True
```

The per-worker budget is **divided, not multiplied**. Leaving the single-worker default in a two-worker unit would reserve 30 connections against a co-resident Postgres.

Health endpoint reports `db_pool_stats.checked_out` — if it climbs near `pool_size` regularly, slow queries are starving the pool.

## Redis sizing

Self-hosted on the droplet. `maxmemory` set conservatively (ops default). Watch `redis_evicted_keys` from `/health`; rising values mean cache pressure.

## ARQ throughput

ARQ runs **one async worker process** consuming Redis-backed jobs (`WORKER_MAX_JOBS=5`). Each task is `async def`, so I/O-bound work (webhook delivery, email, crawl fetches, embedding calls) overlaps freely; the pipeline is now almost entirely network-bound, since neither the browser nor the embedding model runs locally any more.

Separately, and easy to miss: **BANT extraction and the groundedness judge do not run here.** They run on `core/thread_pool`'s shared 3-worker `ThreadPoolExecutor` **inside the API process** — 3 threads per worker, so 6 across the two API workers, shared with geolocation lookups, company lookups and webhook dispatch. That work is non-durable across a restart.

## LLM rate limits (external)

| Provider | Limit class | Effect when hit |
|---|---|---|
| OpenAI | Per-org RPM/TPM (varies by tier) | LiteLLM falls back to Gemini |
| Gemini (chat) | Per-project RPM/TPM | If both hit → 502 to widget |
| Gemini (embeddings) | Per-project, counted **per content item** — batching saves round-trips, not quota | Client throttles to `EMBED_RPM_LIMIT`; past `EMBED_QUERY_MAX_WAIT_S` a chat query drops its vector arm and goes keyword-only |

## Storage

| Where | Today | Limit |
|---|---|---|
| Postgres | DO droplet attached storage | bounded by droplet disk |
| pgvector indexes | same | bounded by RAM × index density |
| R2 (uploads) | Pay-per-use | effectively unlimited |
| R2 (backups) | 30 days × ~50 MB each | tiny |

## Observed concurrency ceilings (empirical)

| Scenario | Ceiling before degradation |
|---|---|
| Concurrent `/chat/stream` SSE | Hard-gated at `CHAT_MAX_CONCURRENCY=6` per worker (12 across two), well before any event-loop ceiling |
| Concurrent WebSocket live chats | ~300 connections before the single WS process's event loop saturates |
| Crawl pages per minute | Bounded by `JINA_FETCH_CONCURRENCY` (5) and the provider's own RPM, not by local CPU |
| Embedding throughput | Bounded by `EMBED_RPM_LIMIT` (2850 items/min) |

These are estimates; ground-truth them via load tests before quoting to customers.

## Why this matters

Knowing the limits is half of capacity planning. The CTO scan of this page should produce 2–3 specific worries (droplet SPOF, the single WS process, and the `CHAT_MAX_CONCURRENCY` ≤ pool-ceiling invariant that fails in a very misleading way). Each maps to an item in [bottlenecks](/09-capacity/bottlenecks) and a phase of the [scaling plan](/09-capacity/scaling-plan).
