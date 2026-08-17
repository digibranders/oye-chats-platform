# OyeChats Load-Test Results — Phase 3: Async DB Offload

**Date:** 2026-08-14 · **Engine:** k6 v2.2.0 · **Mode:** `MOCK_LLM=true` (application capacity)
**Target:** isolated local mock stack, prod pool config (`pool 5 + overflow 10 = 15`), same warm-session workload as prior phases. Absolute latencies are local-box; the **knee movement is architectural** and transfers to prod.

## What changed
1. **Endpoint offload** — the three pre-stream sync-DB checks in `chat_stream_endpoint` (subscription status, credit deduct, session resolve) now run via `asyncio.to_thread`, off the event loop. Billing/refund semantics unchanged (extracted `_deduct_ai_chat_credit_sync`).
2. **Retrieval-window connection release** — `rag_pipeline_stream` now materializes `history` to session-free objects and commits **before retrieval** (the ~1s LLM query-rewrite + embedding + search), so the pooled connection is freed during retrieval *and* generation, held only during the short DB bursts. `bot`/`chat_session` reload transparently on the event loop afterward.
3. Backpressure gate retained unchanged (`CHAT_MAX_CONCURRENCY`, default 10).

## New-code knee (gate=200, i.e. gate off, to expose the TRUE ceiling) — MEASURED
| conc | completed/35s | total p95 | errors | max PG conns |
|---|---|---|---|---|
| 10 | 86 | 2.56s | 0% | 6 |
| 15 | 125 | 2.60s | 0% | **6** |
| 20 | 165 | 2.77s | 0% | 6 |
| 30 | **238** | 3.94s | 0% | **7** |
| 50 | (event loop saturates) | — | ~0% | 16 |
| 100 | (event loop saturates) | — | ~0% | 16 |

**QueuePool errors across the entire sweep: 2** (both at conc≥50).

## Three-way ablation (all gate OFF, apples-to-apples true capacity) — MEASURED
| Configuration | 15 VU | 30 VU | 50 VU | 100 VU | QueuePool |
|---|---|---|---|---|---|
| **Original** (no fixes) | p99 31.6s, 44 done | collapse | collapse | collapse | **261** |
| **Phase 2** (conn-lifetime only) | still cliffs ~31.5s | collapse | collapse | collapse | **156** |
| **Phase 3** (async offload + retrieval release) | **2.6s, 125 done** | **3.9s, 238 done, 0 err** | pool pegs (16) | event-loop bound | **2** |

The async offload is what actually **moved the true ceiling** — from collapse-at-15 to healthy-through-30, first pool pressure ~50. Connections stay at **6–7 through conc=30** (was pegged at 16 by conc=15).

## New capacity model (application, mock LLM)
| Zone | Concurrent AI chats | Evidence |
|---|---|---|
| **Safe** | ≤ 30 | p95 ≤ 3.9s, 0 errors, pool ≤ 7/15, throughput scales (238 done @30) |
| **Warning / saturation** | ~40–50 | pool climbs to 16, event loop becomes the bound, first QueuePool errors |
| **Breaking** | ~50+ | event-loop saturation; with the gate on, sheds gracefully instead |
| **Configured safety cap** | `CHAT_MAX_CONCURRENCY=10` (unchanged) | a *configuration* value, well below the measured ~30–40 true capacity |

**Application capacity (measured): ~30–40 concurrent AI chats** before saturation — up from ~15. The gate default of 10 is now conservative; measurements support raising it to ~20–25 **after validating on the actual 2-vCPU droplet** (this box is faster, so prod saturates sooner).

## New bottleneck (MEASURED)
The **event loop / single worker**, and secondarily the **prompt-building DB reads** (`get_bot_media_urls`, `is_bant_enabled_for_bot`, `_resolve_meeting_booking`, card-state reads between retrieval and the pre-generation commit, ~lines 6686–6883) which re-acquire and hold a connection — the reason the pool still reaches 16 at conc=50. The DB pool is no longer the *primary* limiter; the single event loop is.

## Remaining work (next, measured-driven)
1. **Offload/isolate the prompt-building DB reads** (bot media, entitlements, meeting resolve, card state) — the last connection-holding window; would push the pool ceiling past 50.
2. **The single event loop is the hard ceiling** — beyond ~40–50 concurrent, only a second worker/instance helps, which requires the Redis WebSocket backplane (unchanged blocker).
3. Validate these numbers on the actual droplet and set `CHAT_MAX_CONCURRENCY` from that.

## Regressions
None observed. 1203 tests pass across chat/credit/rag/qualification/billing/webhook/refund/subscription/preview/visitor/history. Chat responses stream correctly; billing/refund/card-dedup/name-capture semantics preserved.
