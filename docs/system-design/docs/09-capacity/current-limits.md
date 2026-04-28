# Current limits

> **Audience:** CTO · Ops · **Read time:** 4 min · **Last updated:** 2026-04-28

## TL;DR

The platform runs on **one Gunicorn worker on one droplet**, with in-memory WebSocket state and Postgres + Redis colocated on the same host. This is sufficient for early customers (low hundreds of concurrent visitors per droplet) but every dimension is on the same box — vertical-only scaling.

## Hard limits today

| Dimension | Limit | Source |
|---|---|---|
| Gunicorn workers | **1** | `gunicorn.conf.py` (capped intentionally — see [scaling plan](/09-capacity/scaling-plan)) |
| Worker class | `uvicorn.workers.UvicornWorker` | gunicorn.conf.py |
| Max requests per worker | 1000 (jitter ±100) | `max_requests`, `max_requests_jitter` |
| Worker timeout | 120s | `timeout` |
| Graceful shutdown | 30s | `graceful_timeout` |
| Keepalive | 5s | `keepalive` |
| Concurrent WebSocket connections | bounded by event loop + per-connection memory; in practice ≤ a few hundred per process | empirical |
| `client_max_body_size` | 60 MB | `nginx/oyechats-api.conf` |
| Nginx rate limit (catch-all) | 10 req/s, burst 20 | nginx config |
| `/chat/stream` rate limit | 30/min per bot key | slowapi |
| Crawler subprocess timeout | 600s (Nginx route timeout 660s margin) | env |

## Resource footprint (single droplet)

Approximate, observed under low-mid load:

| Resource | Steady state | Peaks |
|---|---|---|
| API process RAM | 250–400 MB | 600 MB during embedding bursts |
| Worker process RAM | 200–300 MB | 800 MB during Playwright crawls (Chromium) |
| Postgres RAM | 200–500 MB | bounded by `shared_buffers` |
| Redis RAM | 20–100 MB | `redis_used_memory_mb` in /health |
| Total RAM headroom | ~400 MB free on a 2 GB droplet | tight during crawls |
| Disk | DB + R2 cache + logs | journalctl rotated weekly |

Memory pressure is the reason **Langfuse is disabled in prod** today (streaming + tracing inflated peak RSS over the limit on a 2 GB droplet). Upsizing the droplet is the simplest path to re-enable.

## Why one Gunicorn worker

Two reasons:

1. **In-memory `ConnectionManager`** in `live_chat_service.py`. WebSocket presence is held in a per-process dict. Two workers means two dicts: an operator on worker A wouldn't see a visitor on worker B. This is the rate-limiting concurrency design choice.
2. **Dev-loop simplicity** — single-process logs, simpler debugging. Acceptable until WebSocket fan-out becomes the bottleneck.

The Phase 2 plan replaces the in-memory dict with Redis pub/sub, unlocking N workers. See [scaling plan](/09-capacity/scaling-plan).

## DB pool

Configured in [`api/app/db/session.py`](../../../api/app/db/session.py). Defaults reasonable for one worker:

```
pool_size = 5
max_overflow = 10
pool_timeout = 30s
pool_recycle = 1800s (30 min)
pool_pre_ping = True
```

Health endpoint reports `db_pool_stats.checked_out` — if it climbs near `pool_size` regularly, slow queries are starving the pool.

## Redis sizing

Self-hosted on the droplet. `maxmemory` set conservatively (ops default). Watch `redis_evicted_keys` from `/health`; rising values mean cache pressure.

## ARQ throughput

ARQ runs **one async worker process** consuming Redis-backed jobs. Each task is `async def`, so I/O-bound tasks (HTTP webhook delivery, email send) overlap freely. CPU-bound tasks (Playwright crawls, embedding requests if not network-bound) serialize.

## LLM rate limits (external)

| Provider | Limit class | Effect when hit |
|---|---|---|
| OpenAI | Per-org RPM/TPM (varies by tier) | LiteLLM falls back to Gemini |
| Gemini | Per-project RPM/TPM | If both hit → 502 to widget |

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
| Concurrent `/chat/stream` SSE | ~200 / process before context-switching latency creeps |
| Concurrent WebSocket live chats | ~300 connections before event-loop saturates |
| Crawl pages per minute | ~30 (Chromium recycled every 10 pages) |
| Embedding throughput | bounded by OpenAI batch RPM, not local |

These are estimates; ground-truth them via load tests before quoting to customers.

## Why this matters

Knowing the limits is half of capacity planning. The CTO scan of this page should produce 2–3 specific worries (droplet SPOF, 1-worker WS ceiling, 2 GB RAM tightness). Each maps to an item in [bottlenecks](/09-capacity/bottlenecks) and a phase of the [scaling plan](/09-capacity/scaling-plan).
