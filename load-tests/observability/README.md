# OyeChats Load-Test Observability (OPTIONAL)

A drop-in Prometheus + Grafana stack for watching a **k6 load test** against the
**staging** OyeChats backend (FastAPI + PostgreSQL 16 + Redis + ARQ).

This is optional. k6 already prints a summary at the end of a run; this stack
gives you **live** graphs during the run and correlates client-side latency
(k6) with server-side pressure (Postgres connections, Redis/ARQ queue depth,
host CPU/memory). If Docker isn't available, skip to
[No-Docker fallback](#no-docker-fallback).

> ⚠️ **Staging only.** Every exporter connects OUT to a database / Redis you
> configure. Point them at **staging**, never production. There are no
> credentials committed here — you supply them via a local `.env`.

---

## What's in here

```
observability/
├── docker-compose.yml                 # Prometheus, Grafana, 3 exporters
├── prometheus/
│   └── prometheus.yml                 # scrape configs + k6 remote-write note
├── grafana/
│   ├── provisioning/
│   │   ├── datasources/prometheus.yml # auto-adds the Prometheus datasource
│   │   └── dashboards/dashboards.yml  # dashboard provider
│   └── dashboards/
│       └── oyechats-loadtest.json     # the dashboard
└── README.md
```

Pinned images: Prometheus `v2.53.1`, Grafana `11.1.4`,
postgres-exporter `v0.15.0`, redis_exporter `v1.62.0`, node-exporter `v1.8.2`.

---

## 1. Configure `.env`

Create `load-tests/observability/.env` (same directory as `docker-compose.yml`).
It is read automatically by `docker compose`. **Do not commit it.**

```dotenv
# --- Grafana admin (CHANGE-ME) ---
GF_SECURITY_ADMIN_USER=admin
GF_SECURITY_ADMIN_PASSWORD=please-change-this-before-exposing

# --- STAGING Postgres (read-only role recommended) ---
# Format: postgresql://USER:PASSWORD@HOST:5432/DBNAME?sslmode=disable
DATA_SOURCE_NAME=postgresql://readonly:CHANGE_ME@staging-db-host:5432/oyechats?sslmode=disable

# --- STAGING Redis (ARQ broker + cache) ---
REDIS_ADDR=redis://staging-redis-host:6379
REDIS_PASSWORD=

# Leave REDIS_PASSWORD blank if staging Redis has no auth.
```

Double-check the host in `DATA_SOURCE_NAME` and `REDIS_ADDR` is **staging**.

---

## 2. Bring the stack up (on staging, or a box that can reach staging)

```bash
cd load-tests/observability
docker compose up -d
docker compose ps          # all services should be "running"/"healthy"
docker compose logs -f prometheus grafana   # tail if something looks off
```

Ports:

| Service            | URL / port                    |
|--------------------|-------------------------------|
| Grafana            | http://localhost:3001         |
| Prometheus         | http://localhost:9090         |
| postgres_exporter  | :9187 (scraped by Prometheus) |
| redis_exporter     | :9121                         |
| node_exporter      | :9100                         |

> Grafana is on **3001** on purpose — the app dashboard uses 3000-ish ports, so
> this avoids a clash.

### Grafana login

Open http://localhost:3001 and log in with the `GF_SECURITY_ADMIN_USER` /
`GF_SECURITY_ADMIN_PASSWORD` you set in `.env`.

> 🔐 **CHANGE-ME:** if you left the default password, Grafana will run with weak
> credentials. Change it in `.env` **before** exposing port 3001 to anything but
> localhost. Never put this box on the public internet with default creds.

The **Prometheus** datasource and the **OyeChats Load Test** dashboard are
auto-provisioned — no manual import. Find the dashboard under
Dashboards → "OyeChats Load Test".

### node_exporter placement caveat

Host metrics (CPU / memory / load / swap) describe **whichever box
node_exporter runs on**. For them to describe the *API* box, run this compose
stack **on the staging API host**. If you run it on a separate monitoring box,
the Host panels reflect that box — run a standalone node_exporter on the API
host and add it as another scrape target instead.

---

## 3. Point k6 at Prometheus (remote-write)

Prometheus starts with `--web.enable-remote-write-receiver`, exposing a
receiver at `/api/v1/write`. Stream k6 metrics into it:

```bash
K6_PROMETHEUS_RW_SERVER_URL="http://<prometheus-host>:9090/api/v1/write" \
K6_PROMETHEUS_RW_TREND_STATS="p(50),p(95),p(99),avg,max" \
k6 run --out experimental-prometheus-rw load-tests/<your-script>.js
```

- `<prometheus-host>` = the host running this stack (e.g. the staging box's IP,
  or `localhost` if k6 runs on the same box).
- `K6_PROMETHEUS_RW_TREND_STATS` **must include `p(50),p(95),p(99)`** or the
  latency percentile panels stay empty — the dashboard queries
  `k6_http_req_duration_p50/_p95/_p99`.

k6 exports counters with a `_total` suffix and trend stats with a `_p95` /
`_p99` / `_avg` suffix. The dashboard already uses those names for both the
built-in metrics (`k6_http_reqs_total`, `k6_http_req_duration_*`,
`k6_http_req_failed_rate`, `k6_vus`) and this project's custom metrics
(`chat_time_to_first_byte_*`, `chat_total_stream_ms_*`, `journey_errors_rate`).

---

## 4. Reading the dashboard (capacity decisions)

**API (k6)** — the client's view.
- *Request rate / VUs* — offered load. Rising VUs with flat request rate = the
  server can't keep up.
- *Latency p50/p95/p99* — the SLO panel. p99 blowing up while p50 stays flat =
  tail latency from queuing/contention, not raw slowness.
- *Error rate* — `k6_http_req_failed_rate`. Anything sustained above ~1% during
  a run is a real failure, not noise.

**Custom chat metrics** — this project's RAG journey.
- *Time to first byte* — how long until the SSE stream starts (retrieval + first
  token). Regressions here usually mean the DB pool or LLM upstream is saturated.
- *Total stream duration* — end-to-end answer time.
- *Journey errors* — failed multi-step journeys. Should be zero.

**PostgreSQL** — the usual bottleneck for this app.
- *Total active connections (pool ceiling = 15)* — **the key panel.** The app's
  real ceiling is its SQLAlchemy pool (~15), not Postgres `max_connections`.
  When this line hits the red 15 threshold, new requests queue for a connection
  and API latency spikes — that's your concurrency limit, and the signal to
  raise the pool size *or* scale out, not to raise Postgres `max_connections`.
- *Connections by state* — rising "idle in transaction" = connections held but
  not doing work (a leak or a slow external call inside a transaction).
- *Cache hit ratio* — should hug 1.0; a dip means the working set spilled out of
  cache and you're now disk-bound.
- *Tuples fetched/returned* — a high returned:fetched ratio flags seq-scans /
  missing indexes surfacing under load.
- *Deadlocks* — must stay zero.

**Redis / ARQ** — background pipeline pressure.
- *Connected / blocked clients*, *commands/sec*, *used memory* — Redis health.
- *ARQ queue depth (`arq:queue:oyechats`)* — background BANT/MEDDIC extraction
  and invoice-PDF jobs land here after each chat. A queue that keeps climbing
  during the test means the single ARQ worker can't drain jobs as fast as load
  enqueues them → add worker capacity. Relies on
  `REDIS_EXPORTER_CHECK_KEYS=arq:queue:oyechats` (set in compose). If it reads
  empty, sample manually: `redis-cli -h <staging-redis> LLEN arq:queue:oyechats`.

**Host (node_exporter)** — the 2 vCPU staging box.
- *CPU %* — sustained >80% on 2 vCPU means CPU, not the DB pool, is the wall.
- *Load average* — load1 above 2.0 (red) = more runnable work than cores.
- *Memory used/available* — watch available trend toward zero (OOM risk for
  gunicorn/ARQ).
- *Swap* — any sustained swap-in destroys latency; should be ~0.

**How to attribute a latency spike:** when p99 jumps, check in order —
DB connections at 15? → pool-bound. CPU pegged / load > 2? → CPU-bound. ARQ
queue climbing? → background backlog. All flat but latency high? → look
upstream (LLM provider).

---

## Tear down

```bash
cd load-tests/observability
docker compose down          # keep volumes (metrics history)
docker compose down -v       # also drop Prometheus/Grafana volumes
```

---

## No-Docker fallback

If Docker isn't available on the staging box, you can still capture the
server-side signals that matter with lightweight shell sampling into CSV during
the run, then eyeball or plot them afterward. (The actual sampler script lives
elsewhere in `load-tests/`; this is the approach it implements.)

Sample every few seconds while k6 runs and append a timestamped row per metric:

- **DB connections** (the pool-ceiling signal):
  ```bash
  psql "$STAGING_DSN" -tAc \
    "select count(*), count(*) filter (where state='active') from pg_stat_activity;"
  # → total_conns, active_conns  (compare total against the ~15 pool ceiling)
  ```
- **Host CPU** (2 vCPU box):
  ```bash
  top -b -n1 | awk '/Cpu\(s\)/ {print 100 - $8}'   # %CPU busy (Linux top)
  ```
- **Process RSS** (gunicorn / uvicorn / arq memory):
  ```bash
  ps -o rss= -C gunicorn | awk '{s+=$1} END {print s/1024 " MB"}'
  ```
- **Redis / ARQ**:
  ```bash
  redis-cli -h "$STAGING_REDIS_HOST" info clients | tr -d '\r'   # connected/blocked
  redis-cli -h "$STAGING_REDIS_HOST" info memory  | tr -d '\r'   # used_memory
  redis-cli -h "$STAGING_REDIS_HOST" llen arq:queue:oyechats     # queue depth
  ```

Write one CSV per run with columns like
`timestamp,pg_total,pg_active,cpu_pct,rss_mb,redis_clients,redis_mem_mb,arq_queue`,
sampling on a fixed interval (e.g. every 5s) for the duration of the test. That
gives you the same four dimensions — DB pool saturation, CPU, memory, and ARQ
backlog — as the Grafana dashboard, just without the live charts. Load the CSV
into a spreadsheet or `pandas` afterward to find where the pool hit 15 and
latency turned over.
