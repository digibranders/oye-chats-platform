# OyeChats Load-Test Results — After Scalability Fixes

**Date:** 2026-08-14 · **Engine:** k6 v2.2.0 · **Mode:** `MOCK_LLM=true` (application capacity)
**Target:** isolated local mock stack, prod pool config (`pool 5 + overflow 10 = 15`).
Same box, same method, same warm-session workload as the baseline in
[`RESULTS_2026-08-14.md`](RESULTS_2026-08-14.md) — so before/after are comparable.
Absolute latencies are local-box (faster than the droplet); the **knee movement and
failure-mode change are architectural and transfer to prod.**

## What changed (the three fixes under test)
1. **Hot-path indexes** — `chat_messages(session_id, created_at DESC)`, `chat_sessions(bot_id, created_at DESC)` (migration `e1f2a3b4c5d6`).
2. **Connection lifetime** — the RAG stream now commits (releases the pooled DB connection) *before* LLM generation instead of holding it idle across the whole stream (`rag_service.py`).
3. **Backpressure gate** — a global cap on in-flight chat generations, sized below the pool, with graceful 503 shedding (`app/core/chat_concurrency.py`, `CHAT_MAX_CONCURRENCY=10`).

---

## Before → After (chat concurrency knee) — MEASURED

| Concurrency | Before: completed/40s | After: completed | Before: total p99 | After: total p95 | Before errors | After errors | DB pool (before→after) |
|---|---|---|---|---|---|---|---|
| 10 | 97 | 83 | 2.63s | 2.59s | 0% | 0% | 14 → 13 |
| **15** | 44 (+cliff) | **121** | **31.6s** | **2.94s** | 0%* | 0% | 16 → 14 |
| 20 | collapse (~0) | **148** | timeout | 5.12s | ~100% | 0% | 16 → 16 |
| 30 | collapse | 154 | timeout | 7.69s | ~100% | 0% | 16 → 16 |
| 50 | collapse | 194 | timeout | 10.35s | ~100% | **10.8% (503)** | 16 → 16 |
| 100 | collapse | **399** | timeout | 10.30s | ~100% | **56% (503)** | 16 → 16 |

\*Before conc=15 completed only 44 iterations because half the requests were stuck on the 30s pool_timeout — the 0% "error rate" is misleading; the run was already failing.

### Headline deltas (MEASURED)
- **`QueuePool limit ... connection timed out` errors: 261 → 0** across the entire sweep.
- **The 31.6s cliff at conc=15 is gone:** 31.6s p99 → **2.94s p95**, and completed iterations **44 → 121**.
- **No more collapse at 20–30:** previously ~0 completions; now 148–154 completions at healthy latency, 0 errors.
- **Beyond capacity, it sheds gracefully:** at conc=100 the system still served **399 requests** and rejected the excess as fast **503 + Retry-After** (245 rejections total) instead of hanging for 30s and exhausting the pool. No cascading failure of background jobs.

---

## Ablation — which fix did what (MEASURED)

| Config | conc=15 behaviour | QueuePool errors (full sweep) |
|---|---|---|
| Before (no fixes) | p99 31.6s, cliff | 261 |
| **Connection-lifetime fix only** (gate disabled) | still cliffs (~31.5s) | 156 |
| **+ Backpressure gate (=10)** | 2.94s, 0 errors | **0** |

**Finding:** releasing the connection during generation helps (261 → 156 QueuePool errors, and instantaneous `checked_out` dropped from a pegged 16 to a peak of ~4), but it does **not** move the knee on its own — because phase-1 DB reads still run **synchronously on the single event loop** and hold connections while serialized. The **backpressure gate is what eliminates the collapse**: capping in-flight generations below the pool means the pool is never exhausted, and excess load is shed cleanly. The two fixes are complementary: the gate bounds concurrency safely; the connection-lifetime fix means each in-flight slot consumes far less of the pool.

---

## New capacity model (application, mock LLM, gate=10)

| Zone | Concurrent AI chats | Behaviour |
|---|---|---|
| **Safe** | ≤ 10 | full throughput, p95 ≈ 2.6s, 0 errors, pool ≤ 13 |
| **Graceful load** | 10 – ~30 | all requests still served, latency rises to ~8s, **0 errors, 0 pool exhaustion** |
| **Shedding** | ~30 – 100+ | in-flight capped at 10; excess gets fast 503 + Retry-After; served volume stays high |
| **Breaking** | — | **no catastrophic breaking point observed** — the system degrades gracefully instead of collapsing |

Tune the safe ceiling with `CHAT_MAX_CONCURRENCY` (raise once phase-1 DB is async, see below).

## Database at scale — re-confirmed via the shipped migration (MEASURED, 1.1M rows)
| Query | Before (no index) | After (migration `e1f2a3b4c5d6`) |
|---|---|---|
| history `session_id → LIMIT 5` | 20.6ms seq scan | **0.071ms** index scan |
| bot sessions `bot_id → LIMIT 500` | 5.8ms parallel seq scan | **1.04ms** index scan |

100K and 1M measured; 10M not seeded this run (extrapolation: unindexed history ≈ ~200ms/turn, indexed stays flat ~0.03ms). See `run-db-scale.sh` to extend to 10M.

## Real-LLM validation (STEP 9)
Not run: no dedicated `LOAD_TEST_OPENAI_API_KEY` was provided, and the harness
correctly **refuses to run** rather than fall back to any production key. Ready to
execute at 1/2/5/10 VU via `scenarios/real-llm.js` once a dedicated key exists.

## Remaining bottlenecks
1. **Phase-1 sync DB on the event loop** (audit S1) — the reason the connection-lifetime fix alone didn't raise the ceiling. Making the pre-generation reads async / offloaded would let `CHAT_MAX_CONCURRENCY` rise well above 10.
2. **Single worker** — still one event loop; CPU-bound work serializes.
3. **Horizontal-scaling blockers unchanged** — in-memory WebSocket `ConnectionManager` and local-disk uploads still block a 2nd instance.
4. The gate is **per-process**; multi-instance would need a Redis-backed distributed limiter.
