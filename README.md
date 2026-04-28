# OyeChats

A SaaS chatbot platform: customers sign up, create chatbot instances, upload a knowledge base, and embed a RAG-powered chatbot on their website with one `<script>` tag. Includes live-chat handoff to human operators, BANT/MEDDIC lead qualification, and a Razorpay/Stripe billing system.

## Modules

| Module | Stack | Purpose |
|--------|-------|---------|
| [`api/`](./api/) | FastAPI · SQLAlchemy 2.0 · pgvector · LiteLLM · ARQ | REST + SSE + WebSocket; RAG pipeline; auth; ingestion; billing |
| [`widget/`](./widget/) | React 19 · Vite 7 · Tailwind v4 | Embeddable chat widget IIFE (`oyechats-widget.js`) |
| [`app/`](./app/) | React 19 · Vite 8 · React Router 7 · Recharts | Admin dashboard (bot config, KB, leads, billing, operator console) |

The marketing site lives in a separate sibling repo (`oyechats-website/`, Next.js 16) and is not part of this monorepo.

## Prerequisites

- **Python 3.11** (pinned in `api/.python-version`)
- **Node.js 20+** and npm
- **PostgreSQL 16+** with the [pgvector](https://github.com/pgvector/pgvector) extension
- **Redis 7+** (queue · cache · rate-limit; required in production, optional in dev)
- **uv** — Python dependency manager — [install](https://docs.astral.sh/uv/getting-started/installation/)
- **conda** — optional, for local Python isolation only. Production runs Python under systemd directly; there is no conda env on the server.

## Quick start

### Option 1 — Docker (recommended)

Brings up Postgres + pgvector and the FastAPI backend in containers.

```bash
git clone <repo-url> && cd platform
cp api/.env.example api/.env       # edit at minimum: OPENAI_API_KEY, GOOGLE_API_KEY
docker compose up --build
```

| Service | URL |
|---------|-----|
| Backend API | http://localhost:8000 |
| Swagger UI  | http://localhost:8000/docs |
| Postgres    | localhost:5432 (db `oyechats`, user `oyechats`) |

### Option 2 — Native (conda + uv)

> conda is a local-development convenience. Production uses systemd directly.

```bash
# 1. Python env
conda create -n oye python=3.11 -y
conda activate oye
pip install uv          # or: curl -LsSf https://astral.sh/uv/install.sh | sh

# 2. Configure
cp api/.env.example api/.env
# Edit api/.env — see "Environment variables" below

# 3. Install backend deps
cd api
uv sync

# 4. Database
createdb oyechats         # ensure pgvector extension is installed
uv run alembic upgrade head

# 5. Run dev server
uv run uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

### Frontends

```bash
# Chat widget (host-page-embeddable IIFE)
cd widget && npm install && npm run dev      # http://localhost:5173

# Admin dashboard (SPA)
cd app && npm install && npm run dev          # http://localhost:5174
```

> The Vite dev server on port 5173 cannot be embedded on external sites because of the React Fast Refresh preamble. To test embedding, run `npm run build && npx vite preview --port 4173` in `widget/`.

## Environment variables

Create `api/.env` from `api/.env.example`. The full list with defaults lives in [`api/app/config.py`](./api/app/config.py); the most important ones:

### Required

| Variable | Description |
|----------|-------------|
| `DB_URL` | Postgres connection string (`postgresql://oyechats:oyechats@localhost:5432/oyechats`) |
| `APP_ENV` | `development`, `testing`, or `production` |
| `OPENAI_API_KEY` | OpenAI key — used for embeddings (`text-embedding-3-small`) and primary chat completions |
| `GOOGLE_API_KEY` | Google Gemini key — fallback chat model and gate / enrichment LLM |

### Required in production

| Variable | Description |
|----------|-------------|
| `REDIS_URL` | Redis connection string (queue · cache · rate-limit). App fails fast on startup without it in production. |
| `CORS_ORIGINS` | Comma-separated allowlist (no wildcard with credentials) |
| `R2_KEY_ID`, `R2_APPLICATION_KEY`, `R2_BUCKET_NAME`, `R2_ENDPOINT` | Cloudflare R2 (S3-compatible) for file storage. Legacy `B2_*` env names are accepted as fallbacks. |
| `BREVO_API_KEY` | Transactional email |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` | Primary payment provider (INR) |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Fallback payment provider |
| `BILLING_PROVIDER` | `razorpay` (default) or `stripe` |
| `SENTRY_DSN_BACKEND` | Error tracking |

### Tunable feature flags

| Variable | Default | Effect |
|----------|---------|--------|
| `LLM_MODEL` | `openai/gpt-5.4-mini` | Primary chat model (LiteLLM identifier) |
| `FALLBACK_MODEL` | `gemini/gemini-2.5-flash` | Auto-fallback chain |
| `EMBEDDING_MODEL` | `text-embedding-3-small` | OpenAI embedding (1536-dim) |
| `CHUNK_SIZE` / `CHUNK_OVERLAP` | `1000` / `200` | Document chunking |
| `MODERATION_ENABLED` | `true` | OpenAI moderation pre-check |
| `CAG_LITE_THRESHOLD` | `20` | Skip retrieval for bots with ≤ N chunks |
| `RELEVANCE_GATE_ENABLED` | `false` | CRAG-style relevance scoring |
| `RERANK_ENABLED` | `false` | FlashRank cross-encoder rerank |
| `WORKER_ENABLED` | `true` | If `false`, worker tasks fall back to in-process thread pool |
| `LANGFUSE_FORCE_DISABLE` | — | Escape hatch for low-memory hosts |

Full reference: [docs/configuration.md](./docs/configuration.md) and the system-design [environments page](./docs/system-design/docs/07-deployment/environments.md).

## Common commands

### Backend

```bash
# All commands assume conda env `oye` is active and cwd is api/
uv sync                                                 # install / sync deps
uv run uvicorn app.main:app --reload --port 8000        # dev server
uv run pytest                                           # tests
uv run ruff check .                                     # lint
uv run ruff format .                                    # format
uv run alembic upgrade head                             # run migrations
uv run alembic revision --autogenerate -m "<message>"   # new migration
```

### Frontends

```bash
cd widget && npm run lint && npm run build              # widget
cd app && npm run lint && npm run build                 # admin
```

### Docker

```bash
docker compose up --build         # full stack
docker compose up db -d            # database only
docker compose down                 # stop (preserves volume)
docker compose down -v              # stop + delete data volume
```

## API surface

Once the backend is running:

- **Swagger UI** — http://localhost:8000/docs
- **ReDoc** — http://localhost:8000/redoc
- **Health** — `/health` (DB + Redis), `/health/full` (+ worker heartbeat), `/health/live`

Routers (each is mounted at the root, no `/api` prefix):

| Prefix | File | Purpose |
|--------|------|---------|
| `/auth/*` | `api/app/api/auth_routes.py` | Register, login, OTP password reset |
| `/bots/*` | `api/app/api/bot_routes.py` | Bot CRUD, public widget settings |
| `/chat/*` | `api/app/api/chat_routes.py` | SSE chat stream, history, feedback |
| `/ws/*` | `api/app/api/ws_routes.py` | WebSocket live-chat |
| `/documents/*` | `api/app/api/document_routes.py` | Upload, crawl, list, delete |
| `/leads/*` | `api/app/api/lead_routes.py` | Leads, BANT signals, qualification config |
| `/operators/*` | `api/app/api/operator_routes.py` | Operator CRUD, handoff, assignment |
| `/canned-responses/*` | `api/app/api/canned_response_routes.py` | Snippet CRUD |
| `/offline-messages/*` | `api/app/api/offline_message_routes.py` | Offline form submissions |
| `/analytics/*` | `api/app/api/analytics_routes.py` | Dashboard metrics |
| `/subscriptions/*`, `/credits/*` | `api/app/api/subscription_routes.py` | Plans, invoices, top-ups |
| `/webhooks/*` | `api/app/api/webhook_routes.py` | Customer webhook registrations |
| `/webhooks/billing/*` | `api/app/api/webhook_billing_routes.py` | Inbound Razorpay + Stripe webhooks |
| `/superadmin/*` | `api/app/api/superadmin_routes.py` + `superadmin_plan_routes.py` | Super-admin only |
| `/client/*` | `api/app/api/client_routes.py` | Client account settings |

## Tests

```bash
cd api
uv run pytest                       # all
uv run pytest tests/test_chat_security.py
uv run pytest -v                    # verbose
```

## Embedding the widget

```bash
cd widget && npm run build          # → dist/oyechats-widget.js + dist/app/*
```

```html
<script src="https://cdn.oyechats.com/oyechats-widget.js" data-bot-key="bot-xxx"></script>
```

The widget reads `data-bot-key` from its own `<script>` tag, mounts a `<div id="oyechats-widget-root">`, and lazy-loads its React bundle. See [`widget/README.md`](./widget/README.md) for the loader/chunk strategy.

## Project structure

```
platform/
├── api/                              # FastAPI + ARQ + RAG
│   ├── app/
│   │   ├── main.py                   # entry · middleware · router wiring
│   │   ├── config.py                 # env-driven settings
│   │   ├── api/                      # route modules (17 routers)
│   │   │   ├── auth.py               # auth dependencies (get_current_*)
│   │   │   ├── auth_routes.py        # register · login · OTP reset
│   │   │   ├── bot_routes.py         # bot CRUD
│   │   │   ├── chat_routes.py        # SSE chat stream
│   │   │   ├── ws_routes.py          # WebSocket live-chat
│   │   │   ├── document_routes.py    # upload + crawl
│   │   │   ├── lead_routes.py        # leads + BANT
│   │   │   ├── operator_routes.py    # live-chat staff
│   │   │   ├── subscription_routes.py # plans + credits + top-ups
│   │   │   ├── webhook_routes.py     # customer webhook regs
│   │   │   ├── webhook_billing_routes.py # inbound Razorpay/Stripe
│   │   │   └── …
│   │   ├── services/                 # business logic
│   │   │   ├── rag_service.py        # hybrid search + context assembly
│   │   │   ├── llm_service.py        # LiteLLM wrapper (OpenAI → Gemini)
│   │   │   ├── live_chat_service.py  # WebSocket ConnectionManager
│   │   │   ├── billing_service.py    # Stripe
│   │   │   ├── razorpay_service.py   # Razorpay (primary)
│   │   │   ├── credit_service.py     # FIFO credit ledger
│   │   │   ├── qualification_service.py # BANT / MEDDIC
│   │   │   ├── lead_service.py       # tier transitions + decay
│   │   │   ├── webhook_service.py    # outbound HMAC + retry
│   │   │   ├── email_service.py      # Brevo
│   │   │   ├── crawler_service.py    # Playwright + crawl4ai
│   │   │   ├── intent_service.py     # intent routing
│   │   │   ├── relevance_gate.py     # CRAG-style gate
│   │   │   ├── reranker.py           # FlashRank
│   │   │   └── r2_service.py         # Cloudflare R2 (S3-compat)
│   │   ├── ingestion/                # RAG input pipeline
│   │   │   ├── pipeline.py           # orchestrator
│   │   │   ├── extraction.py         # pypdf · python-docx · text
│   │   │   ├── cleaner.py
│   │   │   ├── chunking.py           # recursive splitter
│   │   │   ├── embedder.py           # OpenAI text-embedding-3-small
│   │   │   └── enrichment.py         # optional Gemini chunk-summary
│   │   ├── worker/                   # ARQ tasks
│   │   ├── db/                       # models · session · repository
│   │   ├── core/                     # middleware · security · thread-pool
│   │   └── schemas/                  # Pydantic v2
│   ├── alembic/                      # migrations
│   ├── tests/
│   ├── systemd/                      # production unit files
│   ├── nginx/                        # production nginx config
│   └── scripts/                      # backup.sh, seed scripts
├── widget/                           # embeddable IIFE
├── app/                              # admin dashboard SPA
├── docs/                             # markdown + interactive system-design site
│   └── system-design/                # VitePress site (28+ pages, 44+ diagrams)
├── docker-compose.yml                # local dev stack
├── CLAUDE.md                         # AI-assistant conventions
└── README.md                         # this file
```

## Tech stack

| Layer | Technology |
|-------|-----------|
| LLM (primary) | OpenAI `gpt-5.4-mini` via LiteLLM |
| LLM (fallback) | Google `gemini-2.5-flash` |
| Embeddings | OpenAI `text-embedding-3-small` (1536-dim) |
| Vector DB | PostgreSQL 16 + pgvector (hybrid search with `TSVECTOR` keyword) |
| Backend | FastAPI · SQLAlchemy 2.0 · Alembic · Pydantic v2 |
| Background queue | ARQ on Redis |
| Frontend | React 19 · Vite 7/8 · Tailwind v4 · React Router 7 |
| Web crawl | Playwright (Chromium) + crawl4ai |
| File storage | Cloudflare R2 (S3-compatible) |
| Email | Brevo |
| Payments | Razorpay (primary, INR) + Stripe (fallback) |
| Real-time | WebSocket (`ws_routes.py`) |
| Rate limiting | SlowAPI on Redis |
| Observability | Sentry · Langfuse (currently disabled in prod due to memory) |
| CDN | Cloudflare R2 + CDN — `cdn.oyechats.com/oyechats-widget.js` |
| Deploy | DigitalOcean droplet · systemd · Nginx · GitHub Actions |
| Dependency mgmt | `uv` (Python) + `npm` (JavaScript) |
| Containerisation | Docker + Docker Compose (local dev only) |

## Documentation

- [`CLAUDE.md`](./CLAUDE.md) — engineering conventions and AI-assistant guide
- [`docs/`](./docs/) — markdown reference (architecture, configuration, RAG pipeline, runbooks)
- [`docs/system-design/`](./docs/system-design/) — VitePress site with C4 diagrams, critical-flow sequence diagrams, ER diagrams, and deployment topology. Run locally:
  ```bash
  cd docs/system-design && npm install && npm run dev
  ```

## Contributing

The git repo is `digibranders/oye-chats-platform` on GitHub. All work happens on the `development` branch; production is `main` and updates only via PR merge. See [`CLAUDE.md`](./CLAUDE.md#git-workflow) for the full workflow and pre-commit checks (`ruff`, `pytest`, `npm run lint`, `npm run build`).
