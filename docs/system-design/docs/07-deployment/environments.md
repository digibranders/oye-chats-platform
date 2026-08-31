# Environments

> **Audience:** New engineers · Ops · **Read time:** 4 min · **Last updated:** 2026-08-31

## TL;DR

Three environments — `development`, `testing`, `production` — selected by `APP_ENV`. The toggle changes CORS handling, Sentry behavior, Redis enforcement, and timeout behavior. There is **no separate staging** today (a known gap on the roadmap).

## Environment matrix

| Concern | `development` | `testing` (CI) | `production` |
|---|---|---|---|
| `APP_ENV` | `development` | `testing` | `production` |
| Selected by | dev defaults | `ci.yml` env | systemd `EnvironmentFile` |
| CORS | `localhost:*` allowed automatically | localhost only | `CORS_ORIGINS` env var (comma-sep), no wildcard |
| `allow_credentials` | False (wildcard origin) | False | False (wildcard incompatible with credentials) |
| Redis required | Optional (in-memory shim if missing) | Required | **Required** (fails on startup if missing) |
| Sentry | Off unless DSN set | Off | On (`SENTRY_DSN_BACKEND` set) |
| Langfuse | Optional | Off | **On.** `LANGFUSE_FORCE_DISABLE` is an available kill switch for OTEL memory pressure but is not currently set (confirmed 2026-07-08). Prod and Dev are separate Langfuse projects — keys must not be mixed |
| Worker | Optional (`WORKER_ENABLED=false` falls back to thread pool) | Off | On (`WORKER_ENABLED=true`) |
| LLM | Real OpenAI/Gemini if keys set | `GOOGLE_API_KEY=test-key` (mocked layer) | Real OpenAI primary, Gemini fallback |
| DB | Local Postgres | Service container (`pgvector/pgvector:pg16`) | Self-hosted Postgres on droplet |
| Logging | INFO to stdout | INFO to stdout | INFO via Gunicorn → journalctl |

## Required environment variables

### Always required

```
DB_URL
APP_ENV
```

### Required in production

```
REDIS_URL
CORS_ORIGINS
OPENAI_API_KEY
GOOGLE_API_KEY
LLM_MODEL=openai/gpt-5.4-mini
FALLBACK_MODEL=gemini/gemini-2.5-flash
R2_KEY_ID, R2_APPLICATION_KEY, R2_BUCKET_NAME, R2_ENDPOINT  (Cloudflare R2)
BREVO_API_KEY
SENTRY_DSN_BACKEND
RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET
RAZORPAY_SEAT_PLAN_ID, RAZORPAY_SEAT_PLAN_ID_USD          (extra operator seats)
RAZORPAY_BRANDING_PLAN_ID, RAZORPAY_BRANDING_PLAN_ID_USD  (branding removal)
FRONTEND_URL
API_BASE_URL          (defaults to the PRODUCTION host — it used to default to
                       localhost and shipped dead unsubscribe links)
UNSUBSCRIBE_SECRET, OAUTH_STATE_SECRET
EMAIL_FROM_NAME, EMAIL_FROM_ADDRESS
WORKER_ENABLED=true
MODERATION_ENABLED=true
```

### Optional / feature flags

```
RELEVANCE_GATE_ENABLED      (default TRUE — and an EMPTY value is treated as unset)
RELEVANCE_THRESHOLD         (default 0.55; per-bot override in bots.relevance_threshold)
GATE_MODEL                  (fallback only — runtime_config.get_gate_model() wins)
GROUNDEDNESS_CHECK_ENABLED  (default true; observability only, never blocks)
GROUNDEDNESS_THRESHOLD      (default 0.5)
RERANK_ENABLED              (default false)
RERANK_TOP_N                (default 5)
CAG_LITE_THRESHOLD          (default 20)
CHUNK_ENRICHMENT_ENABLED    (default false)
ENRICHMENT_MODEL            (default gemini/gemini-2.5-flash)
CHUNK_SIZE                  (default 1000)
CHUNK_OVERLAP               (default 200)
EMBED_PROVIDER              (default google — the only supported value)
GEMINI_EMBED_MODEL          (default gemini-embedding-001)
EMBED_DIMENSIONS            (default 768 — must match the Vector(768) column)
EMBED_CONCURRENCY           (default 8)
EMBED_RPM_LIMIT             (default 2850)
EMBED_QUERY_MAX_WAIT_S      (default 2.0)
CRAWL_PROVIDER_PRIMARY      (default "jina" — NOT spider)
JINA_API_KEY, JINA_FALLBACK_ENABLED, SPIDER_API_KEY, SPIDER_REQUEST_MODE
DEMO_SCREENSHOT_ENABLED, DEMO_SCREENSHOT_PROVIDER (default jina), DEMO_SCREENSHOT_TTL_DAYS
WS_BACKPLANE_ENABLED        (default FALSE in config.py; oyechats-ws.service pins it
                             true for its own process, and the deploy writes
                             ${WS_BACKPLANE_ENABLED:-false} into the API's .env)
EMAIL_PROVIDER              (default "brevo"; "ses" switches to the AWS SES HTTPS API)
REOON_API_KEY               (email verification — absent makes it a silent no-op)
IPAPI_IS_KEY                (visitor company lookup)
VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, EXPO_PUSH_ENABLED
LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, LANGFUSE_HOST
LANGFUSE_FORCE_DISABLE      (escape hatch for OTEL memory pressure)
SENTRY_RELEASE              (set by deploy = github.sha)
WEB_CONCURRENCY             (gunicorn workers; config default 1, but the systemd
                             unit pins 2 — the unit is what production runs)
DB_POOL_SIZE, DB_MAX_OVERFLOW, CHAT_MAX_CONCURRENCY
                            (pinned 3 / 5 / 6 in the unit; the budget is DIVIDED
                             across workers, never multiplied)
GUNICORN_BIND               (default 127.0.0.1:8000)
```

> **The empty-string trap.** `config._env()` treats `""` as unset for exactly this reason: a deploy that emits a bare `${VAR}` for an unset repo variable writes an **empty-but-present** key into `api/.env`, and systemd's `EnvironmentFile=` then sets it to `""`. A plain `os.getenv(k, default)` returns `""`, not the default. That is how `RELEVANCE_GATE_ENABLED` ran **disabled** in production while the code's default said `true` — the scope-enforcement control behind the "answers only from your knowledge base" guarantee. The deploy now emits `${VAR:-default}` and the module treats empty as unset; a CI assertion forbids re-introducing a bare `${VAR}`.

### Frontend (Vite — `platform/widget/.env` and `platform/app/.env`)

```
VITE_API_URL                # http://localhost:8000 (dev) → https://api.oyechats.com (prod)
VITE_SENTRY_DSN             # optional, frontend Sentry
VITE_WIDGET_BASE            # widget only — https://cdn.oyechats.com in prod
```

## Local development

Two paths — pick one:

### Option A: Docker Compose (single command, brings up DB + API)

A `platform/docker-compose.yml` is committed at the repo root with two services: `db` (`pgvector/pgvector:pg16`, port 5432) and `api` (built from `./api/Dockerfile`, port 8000, hot-reload via mounted volume). It pulls env from `./api/.env`.

```bash
cd platform
docker compose up        # brings up db + api with hot-reload
```

### Option B: Native (conda + uv) — local only

> **Conda is a local-development convenience, not a production runtime.** Production runs gunicorn directly under systemd on the droplet (see [topology](/07-deployment/topology)) — no conda involved.

```bash
conda activate oye        # local: keep Python 3.11 + uv isolated from system Python
cd platform/api
cp .env.example .env       # then edit DB_URL, OPENAI_API_KEY, GOOGLE_API_KEY at minimum
                           # GOOGLE_API_KEY is not optional: it powers embeddings,
                           # both RAG gates and the fallback LLM
uv sync
uv run alembic upgrade head
uv run uvicorn app.main:app --reload --port 8000
```

Or, preferred, `cd api && ./scripts/dev.sh` — migrations → ngrok webhook tunnel → ARQ worker → API in one command.

Frontends:

```bash
# Widget
cd platform/widget && npm install && npm run dev      # localhost:5173

# Admin
cd platform/app && npm install && npm run dev         # localhost:5174
```

A typical dev box runs Postgres+pgvector via Docker and Redis natively (or skips Redis entirely; the in-memory fallback covers most flows).

## Where to find the prod env

The prod `.env` is generated on every deploy from GitHub Actions secrets — see [`deploy-api.yml`](../../../../.github/workflows/deploy-api.yml). It lives at `/opt/oyechats/platform/api/.env` on the droplet. The services run as the non-root `oyechats` user, so the file is group-readable by that group rather than root-only `600`.

Do not edit directly on the box for non-emergency changes — the next deploy will overwrite. For emergency overrides, also push the change to the GitHub secret immediately.

## Why no staging?

A staging environment is on the roadmap, blocked on:
- Need a second droplet (cost) and a second domain
- Need a separate Postgres + Redis
- Need a way to test webhooks from the Razorpay sandbox

Today, risky changes are vetted via:
- Local + CI (which uses a real pgvector instance)
- Manual smoke tests against `localhost:5173` widget + `localhost:5174` admin against a local API
- Razorpay test mode on the dev environment, with an ngrok tunnel for inbound webhooks (`api/scripts/dev.sh` wires this up)

## Why this matters

If a config change works in dev but breaks in prod, the matrix above is the differential. Most "works on my machine" issues trace back to a prod-only env var (e.g., a test that doesn't run because `WORKER_ENABLED=false` in dev) or a CORS list that's wider in dev than prod.
