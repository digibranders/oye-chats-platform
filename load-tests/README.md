# OyeChats Load & Scalability Testing

Production-grade k6 load-testing system for the OyeChats API. Built to answer
capacity questions with **measured** evidence while making it **hard to hit
production or spend real LLM money**.

Latest measured run: [`results/RESULTS_2026-08-14.md`](results/RESULTS_2026-08-14.md)
(headline: the chat concurrency **knee is at 15 = the DB pool size**; two missing
indexes cost **up to 588×** on the hottest query at 1.1M rows).

## Layout

```
load-tests/
├── config/
│   ├── environments.js   # target resolution + HARD prod/LLM safety guards
│   └── thresholds.js     # pass/fail SLOs (api / analytics / chat / smoke)
├── helpers/
│   ├── auth.js  http.js  checks.js  data.js  metrics.js
├── scenarios/
│   ├── smoke.js             # 1 VU sanity — run first
│   ├── baseline.js          # steady web-tier reference percentiles
│   ├── api-load.js          # realistic weighted API mix, 10→500 VUs
│   ├── chat-concurrency.js  # THE knee test (1,5,10,15,20,30,50,100)
│   ├── chat-stream.js       # low-conc per-stream timing detail
│   ├── dashboard.js         # open-tab polling load
│   ├── journey-analytics.js # the 11-call/15s analytics fan-out
│   ├── spike.js  soak.js    # slam+recovery / sustained leak-hunt
│   └── real-llm.js          # OPT-IN real provider validation (gated, low VU)
├── mock-llm/server.py       # OpenAI+Gemini-compatible mock (Phase 8/8A)
├── datasets/                # deterministic seed + DB-scale seed
├── runner/                  # stack bring-up, server sampler, knee & db-scale runners
├── observability/           # optional Prometheus+Grafana stack (staging)
└── results/                 # per-run outputs (never overwritten)
```

## Prerequisites
```bash
brew install k6
```
Python tooling (mock server, seeds) uses the API's own venv at `../api/.venv`.

## Safety model (enforced in `config/environments.js`)
- **Refuses production.** Throws if `BASE_URL` matches `api.oyechats.com`, the prod
  IP, or `oyechats-api`, or if `TEST_ENV=production`. There is no override flag.
- **Mock LLM by default.** `MOCK_LLM=true` unless you explicitly opt into real
  providers (below). Chat scenarios refuse to run unless the target is verified
  routed to the mock (`MOCK_LLM_VERIFIED=1`, set by the bring-up script).
- **Never seeds dev/prod data.** Seed scripts refuse any DB whose name doesn't
  contain `loadtest` (unless `FORCE_SEED=1`).

---

## Quick start — full local knee test (mock LLM, zero external spend)

```bash
# 1. Bring up the isolated mock stack: creates oyechats_loadtest DB, migrates,
#    seeds plans+fixtures+warm sessions, starts the mock LLM (:9099) and a 2nd
#    API instance (:8001) routed entirely at the mock. Verifies a real stream.
bash runner/start-mock-stack.sh
source .run/env.sh          # exports BASE_URL, BOT_KEY, API_KEY, MOCK_LLM_VERIFIED

# 2. Smoke, then baseline
k6 run scenarios/smoke.js
VUS=20 HOLD=45s k6 run scenarios/baseline.js

# 3. The knee sweep (per-level server sampling + summary table)
LEVELS="1 5 10 15 20 30 50 100" DURATION=40s bash runner/run-knee-test.sh

# 4. DB scale — EXPLAIN ANALYZE before/after the missing indexes
LEVELS="100000 1000000" bash runner/run-db-scale.sh

# 5. Other profiles (mock stack must be up + env sourced for chat ones)
TABS=50 k6 run scenarios/journey-analytics.js
MAXVUS=250 k6 run scenarios/api-load.js
PEAK=300 k6 run scenarios/spike.js
DURATION=1h VUS=15 CHAT=1 k6 run scenarios/soak.js

# 6. Tear down (keeps the test DB; add --drop-db to remove it)
bash runner/stop-mock-stack.sh
```

### Why the test API runs with `--proxy-headers`
`/chat/stream` is rate-limited `30/min` per `{bot_key}:{client_ip}`. All k6 VUs
share one IP, so `chat-concurrency.js` sends a **unique `X-Forwarded-For` per VU**
(simulating distinct visitor IPs — the real widget traffic pattern) and the bring-up
script starts uvicorn with `--proxy-headers --forwarded-allow-ips="*"` so those IPs
are honored. This is realistic load shaping, **not** a limit bypass.

### Why "warm" sessions
On a visitor's first message the bot asks for their name and defers generation.
`seed_fixtures.py --warm N` pre-creates N sessions with a stored lead name so every
turn runs the **full RAG + streaming LLM path**. Each knee VU drives its own warm
session (`--warm` must be ≥ your max concurrency).

---

## LLM isolation — Mock vs Real (Phase 8A)

Testing is split into two capacity numbers that must **never be merged**:
- **Application capacity** — `MOCK_LLM=true`. What OyeChats' own infrastructure can
  sustain, independent of the provider. This is what the knee test measures.
- **Provider-limited capacity** — `MOCK_LLM=false`. What OpenAI/Gemini allow.

### 1. Mock scalability tests (default)
Everything above runs against `mock-llm/server.py`, an OpenAI+Gemini-compatible
server with configurable, deterministic latency:
```bash
MOCK_LLM_LATENCY_MS=2000 MOCK_LLM_TTFT_MS=400 bash runner/start-mock-stack.sh
# or per-request without restart: chat-concurrency.js honors -e MOCK_LATENCY_MS=5000
```
Profiles to sweep: `500 / 1000 / 2000 / 5000 / 10000` ms. This isolates
**application vs DB vs provider** bottlenecks without cost. Recommended mock VU
progression: `1 5 10 15 20 30 50 100 250 500 1000`.

### 2. Dedicated real-LLM test key
Real-provider runs require **all** of these (missing any → hard failure):
```bash
export MOCK_LLM=false
export ALLOW_REAL_LLM_TEST=true
export TEST_PROVIDER=openai
export LOAD_TEST_OPENAI_API_KEY=sk-...   # a dedicated OYECHATS_LOADTEST project key
unset  OPENAI_API_KEY                     # must NOT inherit the production key
```
- The harness **never** falls back to `OPENAI_API_KEY`. If `LOAD_TEST_OPENAI_API_KEY`
  is absent, it refuses to run.
- The **target API instance** must be started with the dedicated key as its
  `OPENAI_API_KEY` and its real base URL (not the mock). Use a separate OpenAI
  project so test spend is billed and capped separately from production.

### 3. Hard spending / concurrency safeguards
Defaults (in `config/environments.js`), overridable only *with* the confirm flag:
```
MAX_REAL_LLM_VUS=10   MAX_REAL_LLM_REQUESTS=100   MAX_REAL_LLM_DURATION=5m
```
Exceeding a ceiling additionally requires `CONFIRM_REAL_LLM_LOAD_TEST=true`.
Recommended real progression is **only** `1 → 2 → 5 → 10` VUs — never hundreds.
```bash
VUS=2 ITERATIONS=20 k6 run scenarios/real-llm.js
```

### 4. Verify production credentials are NOT in use
```bash
env | grep -iE 'OPENAI|GOOGLE|API_KEY'      # expect ONLY LOAD_TEST_OPENAI_API_KEY
echo "$BASE_URL"                            # must be local/staging, never api.oyechats.com
git diff --stat; git status                 # no secrets staged (see below)
```
The harness also refuses if `OPENAI_API_KEY` is present in the shell during a
real-LLM run, and if the target URL looks like production.

### 5. Record real-LLM cost
k6 can't see token usage (the widget stream doesn't echo it). After a real run,
pull the authoritative counts from the **server side** and record them in the run's
results file:
- **Tokens / retries / fallbacks / 429s:** the API's `llm_call_logs` table and/or
  Langfuse traces for the run window.
- **Cost:** OpenAI usage dashboard for the dedicated test project, or
  `tokens × model rate`. Label it **ESTIMATED** if derived from token counts.
Record: provider, model, requests, input/output/total tokens, est. cost, duration,
concurrency, retries, 429s, fallbacks.

---

## Thresholds (`config/thresholds.js`)
| Metric | Target | Notes |
|---|---|---|
| API p95 / p99 | <500ms / <1.5s | simple DB round-trips |
| Analytics p95 / p99 | <2s / <5s | heavier aggregation |
| Chat TTFB p95 | <3s | with mock = app latency; with real = includes provider |
| Chat full-stream p95 | <12s | generation-bound (soft) |
| Error rate | <1% | standard budget |

A run exits non-zero on breach — the stress/spike profiles are *meant* to breach,
and the level at which they do is the capacity answer. Re-tune against your
environment's measured baseline; these are starting points, not universal truths.

## Observability
- **No-Docker (used here):** `runner/sample-server.sh` samples `pg_stat_activity`,
  process RSS/CPU and Redis into CSV once/sec during a run — enough to see the pool
  knee. The knee runner does this automatically.
- **Full stack (staging):** `observability/` has a Prometheus + Grafana +
  postgres/redis/node exporter compose with a ready dashboard (DB-pool-ceiling
  panel annotated at 15). See `observability/README.md`. Point k6 at it with
  `--out experimental-prometheus-rw`.

## Results format
Each runner writes a timestamped dir/file under `results/` (never overwritten):
per-level k6 `--summary-export` JSON, server-metric CSVs, and a summary table.
Keep a dated `RESULTS_*.md` per campaign (see the 2026-08-14 example) recording
environment, git commit, config, and the measured curve.

## Secret hygiene (Phase 8A)
No API keys are committed, printed, or written into scripts or result files. Only
non-secret mock/deterministic test credentials (`sk-mock-loadtest`,
`lt_admin_key_deterministic_*`) appear in-repo. Before committing:
```bash
git diff; git status        # confirm no real keys/tokens
```
