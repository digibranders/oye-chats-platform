# OyeChats — 1,000–2,000 Active-User Capacity Assessment

**Date:** 2026-08-14 · **Base commit:** `12eff5a` (+ uncommitted Phase-3 async-offload) · **Engine:** k6 v2.2.0 · `MOCK_LLM=true`
**Harness host:** single Apple-silicon Mac, 14 cores / 36 GB, running the load generator AND the full stack (API + Postgres + Redis + single-worker mock-LLM) co-located.

> ## ⚠️ Read this first — measurement validity
> **1,000–2,000 active users could NOT be validly load-measured on this setup**, and the numbers at ≥100 mixed VUs reflect **harness contention, not the application.** Proof: at 20 VUs the API tier is **p95 8.95 ms, 36 req/s, 0 errors** (MEASURED), but the same API at 100 mixed VUs showed p95 15.8 s and at 500 VUs hit the 60 s timeout with 67 % errors. The cause is textbook: the **load generator, the single-worker mock LLM, and the single-event-loop API all compete for the same host**. Valid 1K–2K measurement requires the load generator (and a multi-worker/replicated mock) on a **separate machine** from the staging stack. The multi-instance Docker stack for that is delivered (`staging/docker-compose.scale.yml`); it was not run at scale here.
> So the capacity below is: **MEASURED** single-instance ceilings (from the clean low-VU knee tests) + **CONFIG/MODEL-DERIVED** projection to 1K/2K. Nothing here is a fabricated high-VU benchmark.

## Workload model (Phase 2, documented assumption)
Mixed active users, sticky persona per user: **70 % idle/browsing · 20 % normal API · 5 % dashboard · 5 % AI chat**, each with its own think time (idle 15–40 s, api 5–15 s, dash 15 s, AI 10–25 s). Implemented in `scenarios/active-users.js` (each VU gets a unique X-Forwarded-For so per-IP limits model distinct users). **Key consequence: active users ≠ concurrent AI streams.**

## MEASURED single-instance ceilings (clean, prior phases)
| Metric | Value | Source |
|---|---|---|
| Safe concurrent AI chats | **~30** (p95 ≤ 3.9 s, 0 err, pool ≤ 7) | async-offload knee test |
| Saturation onset | **~40–50** concurrent AI chats | async-offload knee test |
| API tier throughput | **36–41 req/s at p95 ~9 ms** (20 VUs) | baseline (this + phase 1) |
| Primary bottleneck | the **single event loop / worker** | measured |

## MODEL-DERIVED 1K/2K projection (labelled — NOT measured)
Concurrent AI streams ≈ (AI-bucket users) × (stream time ÷ cycle time), stream ≈ 2.5 s, cycle ≈ 20 s → duty cycle ≈ 12.5 %.

| Active users | AI-bucket (5 %) | **Est. concurrent AI streams** | Est. mixed API rps | Fits 1 instance? (vs ~30–40 AI, ~40 rps) |
|---|---|---|---|---|
| 1,000 | 50 | **~6–7** | ~25–50 | **Yes** — comfortable headroom |
| 1,500 | 75 | **~9–11** | ~40–75 | Likely yes, less headroom |
| 2,000 | 100 | **~12–15** | ~50–100 | Borderline — event-loop/rps pressure; a 2nd instance is prudent |

The AI-stream counts are the load-bearing number, and even at 2,000 users they sit **inside** the measured single-instance AI ceiling. The rising risk at 2,000 is aggregate API rps + single-event-loop saturation, not AI concurrency.

## Horizontal scaling — infrastructure delivered, correctness BLOCKED
`staging/docker-compose.scale.yml` + `nginx-lb.conf`: an nginx LB round-robining across `--scale api=N` replicas sharing one Postgres/Redis/mock (Docker is available; validated config, not run at scale here). The **stateless HTTP + SSE-chat path scales horizontally today** (only shared DB/Redis). But three prerequisites block *correct* multi-instance production (all confirmed in-code):

| # | Blocker | Effect on multi-instance | Evidence |
|---|---|---|---|
| 1 | Chat gate is **per-process** (`asyncio.Semaphore`) | N replicas ⇒ N×limit, not a global cap (Phase 13) | `app/core/chat_concurrency.py:61,138` |
| 2 | WebSocket `ConnectionManager` is **in-memory** | visitor/operator on different replicas can't communicate (Phase 14) | `gunicorn.conf.py:6-15` |
| 3 | Uploads write **local disk** | files not shared across replicas (Phase 15) | `document_routes.py` |

## DB protection (Phase 12, CONFIG-DERIVED)
Per-instance pool = `DB_POOL_SIZE 5 + DB_MAX_OVERFLOW 10 = 15`. Totals vs Postgres `max_connections`:
| Instances | API conns | + worker (10) | vs default 100 | vs scale-stack 200 |
|---|---|---|---|---|
| 1 | 15 | 25 | ok | ok |
| 2 | 30 | 40 | ok | ok |
| 4 | 60 | 70 | ok (headroom thin) | ok |
The scale compose sets `max_connections=200` for headroom. **Do not exceed ~5–6 replicas at pool 15 on default Postgres.**

## Bottlenecks, ranked
1. **Single event loop / worker** (measured) — the ceiling for one instance (~40–50 AI chats). Beyond it, only more instances help.
2. **The 3 horizontal-scaling blockers** (confirmed) — prevent correct multi-instance for live chat, global backpressure, and uploads.
3. **Test harness** (measured) — co-located load gen + single-worker mock cannot drive a valid 1K–2K test; needs off-box generation.
4. DB pool per-instance × replicas (config) — bounded, plan pool sizing before scaling replicas.

## Final verdict
- **1K: READY WITH CONDITIONS.** The mixed model implies ~6–7 concurrent AI streams + ~25–50 rps — comfortably inside the measured single-instance capacity, on ONE instance. Conditions: validate with an **off-box** k6 run against `docker-compose.scale.yml` (or a real staging box) before relying on it; backpressure/indexes/async-offload are in place.
- **2K: READY WITH CONDITIONS (leaning to a 2nd instance).** Model implies ~12–15 concurrent AI streams — still within single-instance AI capacity, but aggregate rps + single-event-loop headroom make a **2nd API instance** prudent. The stateless path scales to 2 instances on shared DB/Redis today; **full production correctness at 2 instances requires resolving blockers #1–#3** (global Redis gate, WS backplane, shared R2 storage). Until then, 2K on a single instance is unproven and 2K via horizontal scaling is not production-correct.

## What to do next (measured-driven)
1. **Run the delivered scale stack off-box:** load generator on a separate host → `docker-compose.scale.yml --scale api=1|2|4`, mixed workload 100→2000, to produce the real 1-vs-2-vs-4 scaling-efficiency table (Phase 10) this harness couldn't.
2. **Resolve the 3 blockers** (Redis-backed global gate, WS pub/sub backplane, uploads→R2) — the prerequisites for correct multi-instance, and required before the 2K horizontal path is production-ready.
3. Use a **multi-worker or replicated mock-LLM** in the scale stack so the mock isn't the harness bottleneck.
