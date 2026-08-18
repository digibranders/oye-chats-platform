# Capacity Plan — Hundreds of Bots

**Date:** 2026-08-18
**Target:** hundreds of customer bots, steady traffic, some concurrent live chat
**Evidence:** [`load-tests/results/SCALABILITY_SCOPE_2026-08-17.md`](../load-tests/results/SCALABILITY_SCOPE_2026-08-17.md)
and this campaign's measured matrix; production figures read live on 2026-08-18.

---

## 1. The thing that would have blocked this — already resolved

**The dormant vector-search defect would have armed itself on the way to this
target, and it failed silently. It is now fixed in production.**

Verified live on 2026-08-18: alembic is at `c2e8b41f07d9`,
`documents_embedding_hnsw_idx` is **gone**, and `ix_documents_bot_id_is_active`
is in place. The section below is retained because it is the reasoning that made
this urgent, and because the same trap returns the moment anyone reintroduces a
global approximate index.

Production today: **6 bots, 697 active chunks, 116 chunks/bot**. At that size
Postgres never chooses the HNSW index, so tenant-scoped retrieval is correct —
the index has been scanned **zero times since the database was created**. That is
why the read-only production check found the bug present but not firing.

Growth changes the planner's mind. Reproduced on a rig: a **300-chunk tenant in a
45,350-row corpus — a 0.66 % share — returned ZERO rows**, no error, no log. The
bot answers "I don't know" while its knowledge base sits intact in the table.

Project today's 116 chunks/bot forward:

| bots | total chunks | a typical tenant is | verdict |
|---:|---:|---:|---|
| 6 (today) | 697 | 16.7 % of the corpus | safe — planner ignores the index |
| 100 | 11,600 | 1.0 % | approaching |
| **200** | **23,200** | **0.5 %** | **below the share that returned zero rows** |
| **300** | **34,800** | **0.33 %** | **every typical tenant in the danger zone** |
| 500 | 58,000 | 0.20 % | — |

Removal was the only available lever, not a preference: production runs
**pgvector 0.6.0**, and `hnsw.iterative_scan` — the documented mitigation for
filtered ANN — needs 0.8.0.

> **Status: shipped.** Migration `c2e8b41f07d9` dropped the global HNSW index and
> added the `(bot_id, is_active)` composite. Retrieval now runs as an exact
> bitmap scan per tenant: 100 % recall, and *faster* at these sizes — 0.15 ms for
> a 20-chunk tenant, 7.8 ms for a 5,000-chunk one against a 45 k-row table.
>
> **The standing rule this leaves behind:** never reintroduce a single approximate
> index spanning all tenants. If a bot ever outgrows an exact scan (~5,000 chunks),
> partition `documents` by `bot_id` and build one HNSW index per partition, on
> pgvector ≥ 0.8.0 with `hnsw.iterative_scan` enabled — and prove a *small* tenant
> still returns rows before shipping it.

With that deployed, **nothing in this plan is time-critical.**

---

## 2. What hundreds of bots actually costs

Measured ceilings, 2 vCPU / 4 GB with the worker and crons running:

| surface | comfortable | breaks |
|---|---|---|
| open widgets (10 % mid-chat) | **2,000** | 5,000 |
| concurrent AI streams | **~50** at 4 workers | ~10 at 1 worker |
| live-chat sockets | 2,000 held | 4,000 under mixed load |
| sign-ins | **~11/sec** | CPU-bound, unaffected by workers |
| admin dashboard tabs | **300+** | effectively free |

The conversion from *bots* to *load* is the one genuinely unknown input, because
it depends on your customers' traffic, not on this system:

| concurrent visitors per bot | 300 bots | fits |
|---:|---:|---|
| 2 | 600 | one 2 vCPU box, comfortably |
| 5 | 1,500 | one 2 vCPU box |
| 8 | 2,400 | 4 vCPU, or the cluster |
| 15 | 4,500 | cluster (2 API + separate DB) |

Today's production peak is ~385 requests/hour across 6 bots. Even a hundredfold
increase lands inside the first row.

**The mix matters more than the count.** At constant total volume, moving from
10 % to 20 % of visitors mid-chat took chat p95 from 1.0 s to 8.7 s and started
producing errors. Admin seats, by contrast, are nearly free — 300 dashboard tabs
behaved no worse than 10. If you forecast one number, forecast **chat adoption**,
not visitors.

---

## 3. What is *not* a constraint

Worth stating, so effort does not go here:

- **Corpus RAM.** 300 bots at today's density is a ~320 MB working set; 1,000
  bots is ~1 GB. The 4 GB box does not begin to strain until roughly 250,000
  chunks — about 2,000 bots at current density.
- **pgvector.** It handles single-digit millions of vectors. Moving to a
  dedicated vector database would be premature by three orders of magnitude.
- **Postgres connections.** Measured 27 in normal operation. The ceiling is
  reachable only by multiplying per-worker pools — divide the budget instead
  (measured: smaller pools were *faster* and used 57 % fewer connections).
- **The background worker.** Its per-bot sweep is already capped per tick, so
  customer count does not turn a cron into a thundering herd.

---

## 4. Sizing, in the order it should be bought

| # | Step | Buys | Cost |
|---|---|---|---|
| 1 | ~~Deploy the vector-index migration~~ | correctness at scale | **done — live 2026-08-18** |
| 2 | **Live-chat process split, `WEB_CONCURRENCY=4`** | 2× throughput, up to 12× latency, 38 % → 0 % shed | £0 — phases 0–5 merged, awaiting the soak |
| 3 | Widen exact-match cache normalisation | latency, no false-positive risk | £0 |
| 4 | Resize to 4 vCPU / 8 GB | ~1.5× headroom, 8 workers | ~+£24/mo |
| 5 | Split Postgres onto its own host | ~2× and real durability | ~+£40/mo |
| 6 | Second API node behind a load balancer | HA, horizontal headroom | ~+£36/mo |

Steps 1 and 2 are free and already built. Nothing beyond step 2 is needed for
hundreds of bots at the traffic densities in §2 — buy 4 and 5 when the measured
signals in §5 say so, not on a schedule.

---

## 5. What to watch, with thresholds

| signal | act when | because |
|---|---|---|
| total active chunks | **> 15,000** | was the vector-index trigger (now fixed); still the point where a *reintroduced* global ANN index would bite |
| % of visitors mid-chat | **> 15 %** | the single most expensive dial measured |
| chat TTFB p95 | **> 3 s** sustained | the project's own SLO, and the first surface to degrade |
| `chat_gate.rejected_total` | rising | shedding; add workers before adding boxes |
| `pg_stat_activity` | **> 70** | per-worker pools multiplying |
| API RSS vs free memory | free < 800 MB | ~350 MB per worker; the 4 GB box ends at 4 workers |
| `WORKER TIMEOUT` count | **any** | requests exceeding the 120 s reaper |

---

## 6. Honest caveats

Every capacity figure here was measured on **arm64 Apple silicon with no
noisy-neighbour throttling**, against a **mock LLM at a fixed 1,200 ms**, with
**nginx bypassed**. The *ratios* transfer; the absolute ceilings are an
optimistic upper bound on the x86 droplet. Provider latency and rate limits are
a separate ceiling that must never be merged with these numbers.

For absolutes you would trust for a customer commitment, point the same harness
at a same-size staging droplet — the harness already supports `TEST_ENV=staging`.
