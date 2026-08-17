# OyeChats Scalability — Measured Findings & Recommended Path

**Date:** 2026-08-17
**Measured on:** `oye-load` VM (Ubuntu 24.04 **arm64**, 2 vCPU / 4 GB — prod droplet envelope)
**Code:** `development` @ `99dc17c` (merge of `origin/development` + concurrency WIP `f0c0ef8`)
**LLM:** mock (`mock-llm/server.py`, 1200 ms) — *application* capacity, deliberately never mixed with provider-limited capacity
**Supersedes:** the backplane-first plan in this file's first revision (see §6 for why)
**Builds on:** `SCALABILITY_AUDIT_2026-08-14.md` (prod-measured baseline) — not a replacement

---

## 0. Answers to the three questions asked

| Question | Answer |
|---|---|
| **Will Docker improve scalability?** | **No.** Containerising one single-process app changes nothing measurable. Docker earns its place only when you genuinely need a *second host* — and then use **Kamal**, not an orchestrator. It is a deployment tool, not a performance one. |
| **Is it a code issue?** | **Partly — and the biggest piece is already fixed.** The WIP (`f0c0ef8`) **doubled** the single-worker ceiling. Measured, not theorised. |
| **What actually limits us?** | **One gunicorn worker**, pinned by in-process WebSocket state. On 1 worker CPU plateaus at ~75 % — a whole core idle. Adding workers is worth **1.6–2.4×** throughput and up to **9×** better latency. |

---

## 1. The measured evidence

### 1a. The DB pool is no longer the bottleneck

At the default gate, pg connections stayed **≤14 even at 500 concurrent chats**; `/health/full` showed `overflow=0`. The Aug-14 finding ("knee at 15 = pool exhaustion") **no longer reproduces**, thanks to `chat_gate` + the connection-release work.

### 1b. The WIP is worth shipping — it doubles single-worker capacity

Identical config (`CHAT_MAX_CONCURRENCY=50`, restart per level); only the two files differ:

| concurrency | with WIP (`f0c0ef8`) | pre-WIP (`origin/development`) |
|---:|---|---|
| 10 | ✅ 87 reqs, p95 586 ms, **pg 6** | ⚠️ 84 reqs, p95 228 ms, **pg 15 — pool already maxed** |
| 15 | ✅ 99 reqs, p95 1.3 s, pg 7 | 💥 **2 reqs**, 31.6 s, pg 16 |
| 20 | ✅ 106 reqs, p95 2.4 s, pg 12 | 💥 **0 reqs** — dead |
| 25 | ✅ 108 reqs, p95 3.7 s, pg 14 | 💥 **0 reqs** — dead |
| 30 | 💥 2 reqs, pg 16 | 💥 100 % failures |

**Collapse moves ~15 → ~30; usable capacity ~10 → ~25.** Mechanism visible in the `pg` column: pre-WIP holds 15 connections at 10 concurrent; with the WIP, 25 concurrent fit in 14.

### 1c. Raising the gate is NOT a scaling lever

At `CHAT_MAX_CONCURRENCY=50` on one worker, **both** versions deadlocked — the API stopped answering `/health/live` entirely. At the default 10 the same box degrades *gracefully*: 0 % errors to 30 arrivals, clean 503 shedding to 500 concurrent.

> **The gate is doing real protective work. Do not raise it without adding workers.**

### 1d. Worker sweep — more workers help, beyond core count

`CHAT_MAX_CONCURRENCY=10` per worker, all workers pre-warmed:

| workers | conc | throughput | ttfb p95 | fail % | pg conns | CPU % |
|---:|---:|---:|---:|---:|---:|---:|
| 1 | 30 | 3.13 rps | 8 511 ms | 3.2 | 7 | 74 |
| 1 | 50 | 4.90 rps | 10 686 ms | **38.1** | 7 | 79 |
| 2 | 30 | 5.23 rps | 2 763 ms | 0 | 16 | 95 |
| 2 | 50 | 5.70 rps | 7 510 ms | **0** | 13 | 95 |
| 3 | 30 | 6.37 rps | 1 155 ms | 0 | 18 | 45 |
| 3 | 50 | **7.87 rps** | 4 344 ms | 0 | 18 | 100 |
| 4 | 30 | 6.80 rps | **320 ms** | 0 | 21 | 29 |

Two conclusions:

1. **Workers > cores is correct here.** The workload is **I/O-bound** (waiting on the LLM), not CPU-bound, so 3–4 workers beat 2 on a 2-vCPU box. An earlier "workers = vCPU count" assumption was **wrong** — measurement overturned it.
2. **A second worker converts hard failure into graceful slowdown.** At 50 concurrent, 1 worker sheds **38 %** of requests; 2+ workers serve **all** of them.

**Cost:** pg connections climb 7 → 23 as workers go 1 → 4. Per-worker pools multiply — this is why the DB split and pooling matter before scaling workers hard.

---

## 2. Why we're stuck on one worker (and the cheap way out)

`gunicorn.conf.py` pins `WEB_CONCURRENCY=1` because `live_chat_service.py` holds a module-level `manager = ConnectionManager()` with ~15 in-process dicts. With 2 workers a visitor and their operator can land in different processes and stop seeing each other.

**But the framing that matters:**

> You don't have a WebSocket scale problem. You have a **"WebSockets are holding the entire HTTP API hostage"** problem.

Verified facts that make this cheap to fix:

- The widget opens a WebSocket in **exactly one place** (`widget/src/components/LiveChatMode.jsx:94`). Bot chat is **SSE + polling**. So concurrent WS = escalated live chats + operators only — tens to low hundreds, for years.
- **Only 21 socket-write sites** (`send_json`/`send_text`) across 4 files.
- `operator_presence_service.py` is **already Redis-backed** (60 s TTL heartbeats, documented degradation), and `live_chat_queue_service.py` already uses Postgres as source of truth. **The two hardest pieces are done.**

### The recommendation: split the WS process, don't rewrite the manager

Run `/ws/*` on a dedicated **single-worker** uvicorn; everything else on **multi-worker** gunicorn; route with the nginx you already have. `ConnectionManager` is untouched — still one process, still correct.

Add a **one-way** Redis pub/sub channel (HTTP/ARQ publish → WS process fans out locally), ~100 lines. `notification_broadcaster.py` already degrades gracefully when it can't reach the loop.

This buys the measured multi-worker win **now**, and defers the full distributed backplane until WS load actually justifies it.

**Non-negotiable:** re-tune `pool_size`/`max_overflow` **as part of** the worker change. We watched connections go 7 → 23. Not a follow-up.

---

## 2b. 🔴 P0 — REPRODUCED **and FIXED** (migration `c2e8b41f07d9`)

> **Status: fixed.** `c2e8b41f07d9` drops the global HNSW index and adds
> `ix_documents_bot_id_is_active`. Acceptance test on the reproduction corpus
> (45 370 rows / 203 tenants) — all tenant sizes now return rows:
> 20 chunks → 5 rows in 0.15 ms · 300 → 5 rows in 1.0 ms · 5 000 → 5 rows in 7.8 ms.
> Full API suite: 4 856 passed, 2 skipped. ruff check + format clean.
>
> **Correction to the original framing below:** this breaks **small** tenants, not
> large ones. A 300-chunk tenant in a 45 k corpus is 0.66 % of the graph, so almost
> none of the ~40 HNSW candidates belong to it; a 5 000-chunk tenant (11 %) survived.
> The trigger is therefore **the total corpus growing as customers are added**, not a
> single tenant growing — which is exactly what a multi-tenant SaaS does. Measured:
>
> | tenant size | baseline | + composite index only | + composite, HNSW dropped |
> |---|---|---|---|
> | 300 chunks | **0 rows** ❌ | **0 rows** ❌ | **5 rows** ✅ |
> | 5 000 chunks | 5 rows | 5 rows | 5 rows ✅ |
>
> Note the middle column: **adding the composite index alone does NOT fix it** — the
> planner still prefers HNSW for `ORDER BY … LIMIT`. Dropping the global index is
> required.

### Original finding (retained for the record)

**This is a live correctness bug, reproduced on this VM against the real schema and the real query shape.**

Setup: 200 tenants sharing the one global HNSW index, 40 000 noise chunks, plus a target
tenant with **300 chunks**. Query = the exact production shape
(`repository.py:790` — `WHERE bot_id AND client_id AND is_active ORDER BY embedding <=> $1 LIMIT k`).

| Condition | Rows returned (300 exist) | Plan |
|---|---|---|
| **Planner's own free choice** | **0** ❌ | `Index Scan using documents_embedding_hnsw_idx` |
| `hnsw.ef_search = 200` | **0** ❌ | HNSW |
| `hnsw.ef_search = 1000` (max) | **0** ❌ | HNSW |
| **HNSW avoided** | **5** ✅ **in 0.47 ms** | `Bitmap Index Scan on ix_documents_bot_id` |

### Why it happens
With an approximate index, pgvector applies the filter **after** the graph walk. The walk
collects its candidates from a graph dominated by *other tenants'* vectors; the
`bot_id`/`client_id` filter then discards every one of them. The result is an **empty set
with no error** — the bot answers "I don't know" while hundreds of relevant chunks sit in
the table. Nothing is logged.

### What makes this urgent rather than theoretical
- The planner chose HNSW **on its own** — no forcing, at only 40 k rows.
- **`ef_search` tuning does not fix it**, at any value up to the maximum. The obvious first
  remedy is a dead end.
- `hnsw.iterative_scan` (the documented fix) requires **pgvector ≥ 0.8.0**. This VM has
  **0.6.0**, and production's version is **unrecorded** (`docs/architecture.md` claims
  "0.3", which predates HNSW entirely — the docs are wrong).
- **The version is not the deciding factor.** `hnsw.iterative_scan` defaults to **`off`**
  even on 0.8+, and `hnsw.max_scan_tuples` is capped at 20 000 (silent truncation). Since
  this codebase **never sets `iterative_scan` or `ef_search` anywhere**, production is
  exposed *regardless of version*. The version only determines **which fix is available**,
  not **whether you are affected**.
- At OyeChats' tenant sizes the exact path is **both correct and fast** (0.47 ms), so the
  HNSW index is currently pure downside: write amplification, RAM, vacuum cost — and a
  silent-wrong-answer hazard.

### Fix, in order
1. **Add composite `(bot_id, is_active)` on `documents`** — gives the planner a clean,
   cheap alternative.
2. **Drop `documents_embedding_hnsw_idx`**, *or* keep it and force the exact path for
   tenant-scoped retrieval. On 0.6.0 there is no `iterative_scan` escape hatch.
3. **Only reintroduce ANN per-tenant** (partitioned HNSW by `bot_id`, on pgvector ≥ 0.8.0
   with `iterative_scan='relaxed_order'`) once a single tenant exceeds ~5 k chunks.
4. **Check production's pgvector version** — it determines whether option 2 is your only
   choice.

### How to verify on production safely (read-only)
```sql
SELECT extversion FROM pg_extension WHERE extname='vector';
-- then, for your largest bot, compare:
EXPLAIN (ANALYZE) SELECT id FROM documents
 WHERE bot_id=<big_bot> AND client_id=<c> AND is_active
 ORDER BY embedding <=> '<a real vector from that bot>'::vector LIMIT 5;
-- if the plan says "Index Scan using documents_embedding_hnsw_idx" and rows=0, you are hit.
```

---

## 3. LLM-layer findings (verified against the code)

### ⭐ The cheapest real win: move `{personalization_section}` to the end of the system prompt

`rag_service.py:4584` — the block interpolates the **visitor's name** and sits mid-template, with the template running to **4630**. ~46 lines of highly stable content (RULES 1–11, custom prompt, tone, company, services, smart links) sit *after* it. OpenAI matches **exact token prefixes**, so the cacheable prefix truncates there — and it has three variants that mutate **mid-session** when a visitor gives their name.

Moving it to the end roughly **triples the cached prefix**. One-line change, zero behaviour change. Cached input bills at **0.1×**.

**Caveat:** cache TTL is 5–10 min of inactivity. At current prod traffic (~0.1 req/s) most bots won't see repeat traffic inside the window — **this win scales with traffic, it is near-zero today.** Do it anyway; it's one line.

### Also worth doing
- **Set `prompt_cache_key = bot_key`** — verified unused today.
- **Instrument cache hit rate.** Hits are only `logger.info`'d (`5595`, `6549`); `increment_metric_counter` already exists (`core/metrics.py:55`). You cannot tune what you can't see.
- **CAG-lite bots (≤20 chunks):** the whole KB is injected into the *varying* user message, but `get_all_documents_for_bot` orders deterministically — so it's byte-stable and belongs in the cacheable prefix.

### 🐞 Correctness bug in the existing cache
The key is `sha256(normalized_question)` **per bot, with no conversation history**. A visitor asking *"how much?"* after discussing product A caches that answer for the whole bot; the next visitor asking *"how much?"* about product B gets A's answer. Existing guards (`_skip_cache_for_turn`) cover CTAs/media but not this. **Fix before considering semantic caching, which amplifies it.**

### Semantic caching: do it last, if at all
- **RAG-with-retrieval is a 5–25 % hit-rate use case** — the 40–70 % figures are pure-FAQ. Your exact-match layer already harvests 15–30 %.
- At 0.93–0.95 thresholds, **3–7 % of hits return a wrong answer with a 200 OK**. Negation and entity swaps defeat cosine similarity: *"does Pro include SSO"* vs *"does Pro **not** include SSO"*, or *"₹999"* vs *"₹9,999"*, sail through any threshold.
- **GPTCache is dormant** (last release Aug 2024) despite being the top search result — don't adopt it.
- **Better first step:** widen exact-match normalisation (lowercase, strip punctuation/filler openers, collapse whitespace). Most of the realistic win, **zero** false-positive risk.
- If you do build it: reuse the **query embedding you already compute** for hybrid search (placing the cache *before* the pipeline adds a network round-trip to 100 % of traffic to save on ~20 % — a net latency regression), threshold **≥0.95**, hard per-bot namespace, shadow mode first, and a `gemini-2.5-flash` judge on hits.
- Replace SCAN-based invalidation with a **generation counter in the key**; include **embedding-model version** and **system-prompt hash** or you get silent corruption.

### Gateway: stay on LiteLLM
Verified: **`litellm==1.89.4`** pinned, **SDK in-process, no proxy**. Migration would cost 1–2 weeks to buy overhead improvements ~5 orders of magnitude away from your bottleneck. Competing "Nx faster" benchmarks are all vendor-run.

### Embeddings: premise was wrong — do not re-embed
`gemini_embedding.py:42,79` **already batches** (`batchEmbedContents`, `_MAX_BATCH=100`, `EMBED_CONCURRENCY=8`, Redis token bucket at 2850 RPM, RetryInfo-aware 429 backoff). **`CLAUDE.md` is factually wrong** where it says "1 text/request (no batch API)" — worth fixing, it caused a bad recommendation.

Real headroom instead: Google allows **250 texts / 20,000 tokens** per request; batching is by fixed count, so 100 × ~250 tokens ≈ **25,000 tokens may exceed the ceiling** (non-429 4xx aborts the call). Make batching **token-aware**. For bulk ingestion, the Gemini **Batch API** now supports embeddings at 50 % off with far higher TPM.

*(FastEmbed was already evaluated and removed — commit `bbb9727`, Jul 2026.)*

---

## 4. The ladder, in dependency order

| # | Step | Type | Effect | Cost |
|---|---|---|---|---|
| 0 | Connection-release WIP | Code — **done** (`f0c0ef8`) | **2× single-worker ceiling** (measured) | $0 |
| 1 | Deploy the hot-path index migration (`e1f2a3b4c5d6`) to prod | Deploy | removes the Aug-14 seq-scan cliff | $0 |
| 2 | Prompt reorder + `prompt_cache_key` + cache instrumentation + history-aware cache key | Code, small | latency + correctness | $0 |
| 3 | **Split `/ws/*` to its own single-worker process; raise `WEB_CONCURRENCY` to 3–4; re-tune pools** | **Code — the unlock** | **1.6–2.4× throughput, 3–9× lower p95, eliminates 38 % shed** | $0 |
| 4 | Split Postgres off the app box (managed) + resize droplet | Infra | durability + resource isolation | ~+$40–55/mo |
| 5 | PgBouncer / managed pooling | Infra | required once N workers × pools approach `max_connections` | included w/ managed |
| 6 | Second host behind a LB, containerised with **Kamal** | Infra | real HA / horizontal scale | ~+$36/mo |
| 7 | Full Redis pub/sub backplane | Code | multi-node WS | only when WS load demands |

### Ceilings on the current 2 vCPU / 4 GB droplet

| Ceiling | Value | Max workers |
|---|---|---|
| CPU | 2 vCPU (I/O-bound, so not strictly binding) | 3–4 optimal |
| RAM | 2 705 MB avail ÷ ~380 MB/worker | ~7 |
| Postgres | 97 usable conns ÷ 15 per worker pool | ~6 |

---

## 5. Explicitly do NOT adopt

| Technology | Why not |
|---|---|
| **Kubernetes** | Massive operational burden for a 1–2 person team; your WS sticky-session and ARQ-singleton needs make it *harder*, not easier |
| **Docker Swarm** | Maintenance mode, no roadmap |
| **Soketi** | Abandoned (last release Mar 2025) |
| **GPTCache** | Dormant since Aug 2024, still pinned to `openai==0.28`-era APIs |
| **Dedicated vector DB** (Qdrant/Pinecone/Milvus) | pgvector+HNSW handles single-digit millions; you are far below that. Premature. |
| **Redis Streams for the backplane** | Pays consumer-group complexity for durability Postgres already provides |
| **Gateway migration** (Bifrost/Portkey) | ~5 orders of magnitude from your bottleneck |
| **Re-embedding the corpus** | Based on a false premise — you already batch |
| **Autoscaling** | At ~0.1 req/s it adds only cost and failure modes |
| **IndexedDB** | A *browser* API, not a server DB. Widget-side only; not your bottleneck. |

---

## 6. Corrections to earlier statements in this engagement

Recorded so the reasoning trail is honest:

1. **"Build the full Redis backplane first"** → superseded. The WS-process split gets the same win far cheaper (§2).
2. **"Workers = vCPU count"** → **wrong**; measurement showed 3–4 workers beat 2 on 2 vCPU because the load is I/O-bound (§1d).
3. **"Semantic caching is the highest-leverage upgrade"** → **overstated**; RAG hit rates are 5–25 % and false positives are dangerous for pricing/policy answers (§3).
4. **"Embeddings are 1 text/request — a throughput wall"** → **false**, propagated from an error in `CLAUDE.md` (§3).
5. **LiteLLM CVE numbers / "backdoored 1.82.7–1.82.8"** → **fabricated by a research agent and repeated in error. Retracted entirely.** Verified facts: version is 1.89.4, SDK-only. Vulnerability status is **unverified** — run `uv run --with pip-audit pip-audit` for a real answer.
6. **"Add missing indexes on `chat_messages`/`chat_sessions`"** → stale; they exist in `e1f2a3b4c5d6`. The real action is **deploying** them (§4 step 1).
7. **"BANT extraction may be inline"** → **false**; it uses `submit_background` (`core/thread_pool.py:21`). Off the critical path. (`CLAUDE.md` says ARQ; it's an in-process thread pool.)

---

## 6b. Provenance — what is measured vs. what is second-hand

This engagement used background research agents, and **several produced fabricated claims**
(one admitted inventing CVE identifiers). Treat the table below as the trust boundary.

**Directly measured or verified in this session — rely on these:**
- The HNSW zero-rows reproduction and every number in §2b (run on `oye-load`, real schema)
- The full worker sweep in §1d, and the WIP A/B in §1b
- All code facts: `ef_search`/`iterative_scan` never set; embeddings already batch;
  `personalization_section` placement; `prompt_cache_key` unused; history-blind cache key;
  BANT runs via `submit_background`; `litellm==1.89.4`, SDK-only

**Second-hand, plausible, NOT verified here — test before acting:**
- `halfvec(768)` halving the footprint and eliminating TOAST fetches (agent measurement)
- The "21.9 ms → 1.9 ms" composite-index speedup — **my own run did not reproduce this**;
  the planner used `ix_documents_bot_id`, not the composite. The *correctness* fix is what
  was verified, not that speedup.
- Managed-provider pricing and DO's shipped pgvector version

**Disputed or retracted — do not act on:**
- All PgBouncer / pgcat version and CVE claims (two agents contradict each other)
- All LiteLLM CVE claims (fabricated; retracted)

Where a decision depends on a ⚠️ or ❌ item, verify it first. None of the recommendations in
§4 depend on them.

---

## 7. Two honest caveats on all numbers here

1. **arm64 / Apple M4 cores, no noisy-neighbour throttling.** Absolute figures are an **optimistic upper bound** versus the x86 DigitalOcean droplet. **The ratios transfer; the absolute capacity does not.** For true absolute numbers, point this harness at a same-size staging droplet (`TEST_ENV=staging`).
2. **Mock LLM, no WebSocket traffic.** These are *application* capacity numbers. Provider latency and rate limits are a separate ceiling. And the multi-worker runs prove multi-worker is **fast**, not that it is **safe** — safety requires §2.
