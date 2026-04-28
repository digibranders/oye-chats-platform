# Environments

> **Audience:** New engineers · Ops · **Read time:** 4 min · **Last updated:** 2026-04-28

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
| Langfuse | Optional | Off | Off (currently disabled — memory; toggle via `LANGFUSE_FORCE_DISABLE=true`) |
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
STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY, STRIPE_WEBHOOK_SECRET
BILLING_PROVIDER=razorpay
BILLING_CURRENCY=INR
FRONTEND_URL
EMAIL_FROM_NAME, EMAIL_FROM_ADDRESS
WORKER_ENABLED=true
MODERATION_ENABLED=true
```

### Optional / feature flags

```
RELEVANCE_GATE_ENABLED      (default false)
RELEVANCE_THRESHOLD         (default 0.55)
GATE_MODEL                  (default gemini/gemini-2.5-flash)
RERANK_ENABLED              (default false)
RERANK_TOP_N                (default 5)
CAG_LITE_THRESHOLD          (default 20)
CHUNK_ENRICHMENT_ENABLED    (default false)
ENRICHMENT_MODEL            (default gemini/gemini-2.5-flash)
CHUNK_SIZE                  (default 1000)
CHUNK_OVERLAP               (default 200)
CRAWLER_JS_ALL_PAGES        (default false)
CRAWLER_BROWSER_RECYCLE     (default 10)
LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, LANGFUSE_HOST
LANGFUSE_FORCE_DISABLE      (escape hatch for low-memory)
SENTRY_RELEASE              (set by deploy = github.sha)
WEB_CONCURRENCY             (Gunicorn workers; default 1)
GUNICORN_BIND               (default 127.0.0.1:8000)
```

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
uv sync
uv run alembic upgrade head
uv run uvicorn app.main:app --reload --port 8000
```

Frontends:

```bash
# Widget
cd platform/widget && npm install && npm run dev      # localhost:5173

# Admin
cd platform/app && npm install && npm run dev         # localhost:5174
```

A typical dev box runs Postgres+pgvector via Docker and Redis natively (or skips Redis entirely; the in-memory fallback covers most flows).

## Where to find the prod env

The prod `.env` is generated on every deploy from GitHub Actions secrets — see [`deploy-api.yml`](../../../.github/workflows/deploy-api.yml). It lives at `/opt/oyechats/platform/api/.env` on the droplet, owned by `root`, mode `600`.

Do not edit directly on the box for non-emergency changes — the next deploy will overwrite. For emergency overrides, also push the change to the GitHub secret immediately.

## Why no staging?

A staging environment is on the roadmap, blocked on:
- Need a second droplet (cost) and a second domain
- Need a separate Postgres + Redis
- Need a way to test webhooks from real Razorpay / Stripe sandbox

Today, risky changes are vetted via:
- Local + CI (which uses a real pgvector instance)
- Manual smoke tests against `localhost:5173` widget + `localhost:5174` admin against a local API
- Provider sandboxes (Razorpay test mode, Stripe test mode) on the dev environment

## Why this matters

If a config change works in dev but breaks in prod, the matrix above is the differential. Most "works on my machine" issues trace back to a prod-only env var (e.g., a test that doesn't run because `WORKER_ENABLED=false` in dev) or a CORS list that's wider in dev than prod.
