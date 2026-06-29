# Project: OyeChats

OyeChats is a **SaaS chatbot platform** where customers sign up, create chatbot instances, upload their knowledge base, and embed an AI chatbot on their website with a single script tag. The chatbot uses RAG (Retrieval-Augmented Generation) to answer visitor questions from the customer's documents.

## Code Quality Gate
> **Codex Agent reviews every edit.** Write clean, production-ready code on every change — no placeholders, no shortcuts, no "fix later" comments. Each edit is evaluated for correctness, type safety, error handling, and adherence to project conventions. Treat every diff as if it's going straight to a code review.

## Mandatory Pre-Completion Checks
**BEFORE confirming any code changes to the user OR before pushing code, you MUST run all baseline checks for every project that was touched.** Do not skip these. If any check fails, fix the issue BEFORE presenting the final result.

Run only the checks relevant to the files you changed:

### JavaScript / TypeScript Projects
| Project | Directory | Lint | Typecheck | Build |
|---------|-----------|------|-----------|-------|
| Admin Dashboard | `app/` | `npm run lint` | — (JS) | `npm run build` |
| Chat Widget | `widget/` | `npm run lint` | — (JS) | `npm run build` |

### Python Backend
| Check | Command (run inside conda `oye` env) |
|-------|---------------------------------------|
| Lint | `cd api && uv run ruff check .` |
| Format | `cd api && uv run ruff format .` |
| Tests | `cd api && uv run pytest` |

### Rules
1. **Scope checks to what changed** — don't lint the entire monorepo if you only touched the widget.
2. **Fix before reporting/pushing** — if lint, format, or build fails, fix all errors and re-run until clean. Do not push breaking or unformatted code!
3. **Never skip checks** — even for "small" changes. One-line typos can break builds.
4. **Report the results** — include a brief summary of checks passed in your final message (e.g., "lint ✓ · format ✓ · build ✓").

## Git Workflow
> **STRICT RULE — NO EXCEPTIONS.**

- **NEVER use `main` branch locally.** Do not checkout, commit to, or push from `main`. Ever.
- **NEVER push directly to `main`.** The `main` branch is production and is only updated via GitHub PR merges.
- **Always work on the `development` branch.** All commits and pushes go to `development`.
- Before every commit/push, verify current branch: `git branch --show-current` — must output `development`.
- If you are on `main` by mistake: `git checkout development` immediately — do not commit.
- When ready to release, create a PR from `development` → `main` on GitHub. The user will merge it from there.

## How It Works (End-to-End)

1. **Customer signs up** via the Admin Dashboard → gets an account
2. **Creates a bot** → gets a unique `bot_key` (e.g., `bot-6a427d4529b9`)
3. **Uploads documents** (PDF, DOCX, TXT) or **crawls a URL** → documents are chunked, embedded, and stored in pgvector
4. **Copies the embed script** from the admin dashboard
5. **Pastes the script** into their website's `<body>` tag:
   ```html
   <script src="https://cdn.oyechats.com/oyechats-widget.js" data-bot-key="bot-xxx"></script>
   ```
6. **Visitors see a chat widget** (floating button, bottom-right) → click to open → ask questions
7. **Widget sends question** to backend API with `X-Bot-Key` header
8. **RAG pipeline** performs hybrid search (vector + keyword) over that bot's documents
9. **LiteLLM** routes to primary model (OpenAI `gpt-5.4-mini`) → fallback (Google `gemini-2.5-flash`); response streams back to the widget
10. **Background BANT/MEDDIC extraction** runs after the stream closes; tier transitions emit webhooks + emails

## Architecture (3 apps in this repo + 1 sibling)

```
oye-chats/
├── platform/                     # Main platform repo (this CLAUDE.md is here)
│   ├── api/                     # FastAPI REST + WebSocket + ARQ worker
│   ├── widget/                  # Embeddable chat widget IIFE (oyechats-widget.js)
│   ├── app/                     # React admin dashboard SPA
│   ├── docs/                    # Markdown + interactive system-design site
│   └── docker-compose.yml       # Local dev: db + api with hot-reload
└── oyechats-website/            # Next.js marketing site (separate project, NOT in platform repo)
```

| App | Directory | Port | Stack | Purpose |
|-----|-----------|------|-------|---------|
| Backend API | `api/` | 8000 | FastAPI · SQLAlchemy 2.0 · pgvector · LiteLLM · ARQ | REST + SSE + WebSocket; RAG; auth; ingestion; billing |
| Chat Widget | `widget/` | 5173 (dev) / 4173 (preview) | React 19 · Vite 7 · Tailwind v4 | Embeddable chat widget for customer websites (IIFE bundle) |
| Admin Dashboard | `app/` | 5174 | React 19 · Vite 8 · React Router 7 · Recharts | Bot mgmt, knowledge base, leads, billing, live chat operator console |
| Landing Page | `../oyechats-website/` | 3000 | Next.js 16 · React 19 · Tailwind v4 | Marketing site at oyechats.com (separate repo) |

## Widget Embedding — How It Works

The widget (`oyechats-widget.js`) is a **self-contained IIFE bundle** (~416KB) that:

1. Finds its own `<script>` tag and reads `data-bot-key`
2. Sets `window.OYECHATS_BOT_KEY` globally
3. Auto-injects its sibling CSS file (`oyechats-widget.css`) in production
4. Creates a `<div id="oyechats-widget-root">` in the DOM
5. Renders a React app (its own bundled React, isolated from the host page)
6. Communicates with the backend via `X-Bot-Key` header

**Works on any platform**: Next.js, React, WordPress, Webflow, Shopify, plain HTML — anything with a `<body>` tag. Same pattern as Intercom, Crisp, Drift.

### Production Embed
```html
<script src="https://cdn.oyechats.com/oyechats-widget.js" data-bot-key="bot-xxx"></script>
```

### Development Embed (IMPORTANT)
The Vite **dev server** (`localhost:5173/src/main.jsx`) **cannot** be embedded on external sites. Vite's `@vitejs/plugin-react` injects a React Fast Refresh preamble only in its own `index.html`. Loading it cross-origin throws: `"@vitejs/plugin-react can't detect preamble"`.

**To test the widget on another local site:**
```bash
cd platform/widget
npm run build                    # Build the widget
npx vite preview --port 4173     # Serve built files
```
Then embed:
```html
<script src="http://localhost:4173/oyechats-widget.js" data-bot-key="bot-xxx"></script>
```

## RAG Pipeline

```
Document Upload/Crawl
  → Extraction      (PDF via pypdf · DOCX via python-docx · TXT — extraction.py)
  → Cleaning        (cleaner.py)
  → Chunking        (recursive splitting, default 1000 chars, 200 overlap — chunking.py, env-configurable)
  → Embedding       (OpenAI text-embedding-3-small, 1536-dim — embedder.py)
  → Storage         (PostgreSQL pgvector + TSVECTOR — repository.py)

User Question
  → Hybrid Search   (vector similarity + full-text TSVECTOR — rag_service.py)
  → CAG-lite        (skip retrieval if ≤ CAG_LITE_THRESHOLD chunks — default 20)
  → Relevance Gate  (optional, RELEVANCE_GATE_ENABLED — Gemini scores chunks)
  → Rerank          (optional, RERANK_ENABLED — FlashRank cross-encoder)
  → Context Build   (top chunks + chat history + system prompt)
  → LLM Generation  (LiteLLM → OpenAI gpt-5.4-mini → Gemini 2.5 Flash fallback, streaming — llm_service.py)
  → SSE → Widget
  → BANT/MEDDIC extraction runs in ARQ background after stream closes (qualification_service.py)
```

## Database Schema (25 tables)

**Core**
- **Client** — Account (email, hashed_password, api_key, max_bots, is_superadmin, is_bot_manager)
- **Bot** — Chatbot instance (bot_key, system_prompt, colors, logos, business_hours, live_chat_enabled, qualification_framework)
- **Document** — Ingested content chunks (text + `Vector(1536)` + TSVECTOR)
- **ChatSession** — Conversation (status: bot|waiting|live|closed, BANT scores/tier, visitor_rating, assigned_operator_id)
- **ChatMessage** — Individual messages (role: user|bot|operator|system, trace_id)
- **LeadInfo** — Captured contact (1:1 with session)
- **MeetingBooking** — Calendly/Zcal booking confirmations

**Live chat**
- **Operator** — Team member (separate operator_api_key, role owner|admin|operator, max_concurrent_chats)
- **Department** — Operator grouping
- **ChatAuditLog** — Immutable transition log
- **CannedResponse** — `/shortcut` snippets
- **OfflineMessage** — Form submissions while offline

**Qualification**
- **BANTSignal** — Append-only audit (dimension, score_before/after, source: llm|cta_click)
- **VisitorEvent** — Behavioral signals (page_view, return_visit, UTM)
- **BotGrowthEvent** — Per-bot business events

**Billing (Razorpay primary INR + Stripe fallback)**
- **Plan** — Tier definition (price, credits_per_month, included seats, feature_flags, provider IDs)
- **Subscription** — status: trialing|active|past_due|canceled|paused|expired
- **UsageRecord** — Per-period counters
- **Invoice** — Synced from providers
- **PaymentMethod** — Card / UPI / bank refs
- **CreditLedger** — Append-only event-sourced credit balance; FIFO topup expiry via self-FK `grant_id`
- **PricingConfig** — Super-admin tunable key/value (credit costs, kill switch)
- **ProcessedWebhook** — Idempotency for inbound provider webhooks

**Outbound webhooks**
- **Webhook** — Customer registration (URL, secret, event_filter)
- **WebhookDelivery** — Per-attempt log (5 retries: 30s/2m/10m/1h/4h)

Relationships: `Client → Bot → Document`, `Bot → ChatSession → ChatMessage`, `Client → Operator → Department`, `Subscription → Invoice`, every credit grant/deduction in `CreditLedger`.

## API Headers & Auth

| Persona | Header | Source |
|---|---|---|
| Customer / Admin / Super-admin | `X-API-Key` | Generated at register/login, stored in `localStorage` |
| Widget (visitor) | `X-Bot-Key` | `data-bot-key` attribute on embed script (public) |
| Operator | `X-Operator-Key` | `operators.operator_api_key` |
| Operator (legacy alias) | `X-Agent-Key` | Backward-compat during agent → operator rename |

Resolved via FastAPI dependencies in `api/app/api/auth.py`: `get_current_bot`, `get_current_client`, `get_current_client_strict`, `get_current_operator`, `get_current_client_or_operator`. Super-admin gating uses `get_current_client_strict` plus an `is_superadmin` check inside the route.

## Key Naming Conventions

| Item | Name |
|------|------|
| Widget bundle | `oyechats-widget.js` / `oyechats-widget.css` |
| DOM container | `oyechats-widget-root` |
| Window globals | `window.OYECHATS_BOT_KEY`, `window.OYECHATS_API_KEY` |
| Console prefix | `[OyeChats]` |
| Production CDN | `cdn.oyechats.com/oyechats-widget.js` |
| Contact email | `developer@oyechats.com` |

## Environment Setup (local development only)

> **Conda is a local-dev convenience, not a runtime requirement.** The production droplet runs Python 3.11 + `uv`-managed deps under systemd directly — there is no conda env on the server. The `oye` conda env below is only for keeping local Python isolated from system Python.

- **Conda environment**: `oye` (Python 3.11) — local only
- **Dependency manager**: `uv` (works the same with or without conda)

## Production Access

- **API server**: `root@159.223.45.213` (hostname `oyechats-api`, DigitalOcean KVM)
- **SSH key**: `~/.ssh/oyechats_deploy` (the default `id_ed25519` is **not** authorized on this host)
- **Connect**:
  ```bash
  ssh -i ~/.ssh/oyechats_deploy -o IdentitiesOnly=yes root@159.223.45.213
  ```
- **Services on box**: `oyechats-api.service` (Gunicorn, 127.0.0.1:8000), `oyechats-worker.service` (ARQ), `postgresql@16-main`, `nginx` (80/443).
- **Health endpoints**: `GET /health`, `GET /health/live`, `GET /health/full` on `127.0.0.1:8000`.
- **Read-only ops only** unless the user explicitly authorizes restarts or writes — production reads via remote shell still require explicit user approval per session.

## Development Commands

### API (Backend)
All backend commands MUST run within the conda `oye` environment **on a developer machine**. (Production uses `oyechats-api.service` / `oyechats-worker.service` on the droplet — no conda there; do not try to `conda activate` over SSH.)

```bash
conda activate oye && cd api

uv sync                          # Install/sync dependencies
uv run uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload  # Dev server
uv run pytest                    # Tests
uv run ruff check .              # Linter
uv add <package-name>            # Add dependency
uv run alembic upgrade head      # DB migrations
```

Or prefix with `conda run -n oye --no-capture-output`:
```bash
conda run -n oye --no-capture-output bash -c "cd api && uv run uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload"
```

### Widget
```bash
cd widget
npm install && npm run dev       # Dev server (localhost:5173) — for widget development only
npm run build                    # Build oyechats-widget.js
npx vite preview --port 4173     # Serve built widget for embedding tests
```

### Admin Dashboard
```bash
cd app
npm install && npm run dev       # Dev server (localhost:5174)
npm run build                    # Production build (consumed by Vercel)
```

### Local dev — Docker Compose alternative
```bash
cd platform
docker compose up                # brings up pgvector/postgres + api with hot-reload
```

### Landing Page
```bash
cd ../oyechats-website
npm install && npm run dev       # Dev server (localhost:3000)
```

## Key Files

| Purpose | File |
|---------|------|
| Backend entry · middleware · router wiring | `api/app/main.py` |
| Config (env vars, LLM models, RAG flags) | `api/app/config.py` |
| Auth dependencies | `api/app/api/auth.py` |
| RAG pipeline | `api/app/services/rag_service.py` |
| LLM service (LiteLLM router) | `api/app/services/llm_service.py` |
| Live chat ConnectionManager | `api/app/services/live_chat_service.py` |
| Billing (Stripe) | `api/app/services/billing_service.py` |
| Razorpay (primary) | `api/app/services/razorpay_service.py` |
| Credit ledger | `api/app/services/credit_service.py` |
| Qualification (BANT/MEDDIC) | `api/app/services/qualification_service.py` |
| Outbound webhooks (HMAC + retry) | `api/app/services/webhook_service.py` |
| Email (Brevo) | `api/app/services/email_service.py` |
| DB models — single source of truth for ER | `api/app/db/models.py` |
| Repository (queries / CRUD) | `api/app/db/repository.py` |
| Document ingestion | `api/app/ingestion/pipeline.py` |
| Embedding generation | `api/app/ingestion/embedder.py` |
| Crawler (Playwright + crawl4ai) | `api/app/ingestion/crawler.py` |
| ARQ worker tasks | `api/app/worker/tasks.py` |
| WebSocket live chat | `api/app/api/ws_routes.py` |
| Chat routes (SSE) | `api/app/api/chat_routes.py` |
| Subscription / billing routes | `api/app/api/subscription_routes.py` |
| Inbound Stripe + Razorpay webhooks | `api/app/api/webhook_billing_routes.py` |
| Gunicorn config | `api/gunicorn.conf.py` |
| systemd units | `api/systemd/oyechats-api.service` · `oyechats-worker.service` |
| Nginx config | `api/nginx/oyechats-api.conf` · `oyechats-locations.conf` |
| DB backup script | `api/scripts/backup.sh` |
| Standard plan seed | `api/scripts/seed_standard_plus_10k.py` |
| Widget entry point (IIFE) | `widget/src/main.jsx` |
| Widget API client | `widget/src/services/api.js` |
| Widget chat UI | `widget/src/components/ChatWindow.jsx` |
| Widget live-chat UI | `widget/src/components/LiveChatMode.jsx` |
| Vite build config | `widget/vite.config.js` |
| Admin app router | `app/src/App.jsx` |
| Admin embed UI | `app/src/pages/Chatbot.jsx` (was `Interface.jsx`, now a tab) |
| Admin bot settings tabs | `app/src/pages/Settings.jsx` (+ BrandingTab/MessagesTab/AdvancedSettingsTab) |
| Admin live-chat operator console | `app/src/pages/LiveChat.jsx` (rendered inside `Support.jsx`) |
| Admin leads | `app/src/pages/Leads.jsx` |
| Admin billing | `app/src/pages/Billing.jsx` |
| Admin qualification config | `app/src/pages/Qualification.jsx` |

## Tech Stack

| Layer | Technology | Notes |
|-------|-----------|-------|
| LLM (primary) | OpenAI `gpt-5.4-mini` | Routed via LiteLLM |
| LLM (fallback) | Google `gemini-2.5-flash` | Auto-fallback in LiteLLM |
| Gate / enrichment LLM | `gemini-2.5-flash` | CRAG relevance gate + chunk enrichment (off by default) |
| Embeddings | OpenAI `text-embedding-3-small` | 1536-dim, batched |
| Vector DB | PostgreSQL 16 + pgvector | Hybrid search: `Vector(1536)` + `TSVECTOR` |
| Backend | FastAPI · SQLAlchemy 2.0 · Alembic | Python 3.11; `uv` for deps |
| Background queue | ARQ on Redis | `oyechats-worker.service` |
| Frontend | React 19 · Vite 7/8 · Tailwind v4 | Widget = IIFE; Admin = SPA |
| Web Scraping | Playwright (Chromium) + crawl4ai | URL ingestion |
| File Storage | Cloudflare R2 (S3-compatible) | Env vars use `R2_` prefix; internal code module name is still `b2_service.py` for legacy reasons but the bucket is on Cloudflare R2 in production |
| Email | Brevo (Sendinblue) | Transactional |
| Payments | Razorpay (primary, INR) + Stripe (fallback) | Webhook idempotency via `processed_webhooks` |
| Real-time | WebSocket (`ws_routes.py`) | Live chat bidirectional messaging |
| Rate limiting | SlowAPI on Redis | Per-route + IP/key |
| Observability | Langfuse + Sentry | **Two separate Langfuse projects**: "OyeChats Prod" (keys in GitHub Secrets) and "OyeChats Dev" (keys in local `.env`). Traces go to the matching project — no mixing. Toggle via `LANGFUSE_FORCE_DISABLE=true` if needed. |
| CDN | Cloudflare R2 | `cdn.oyechats.com/oyechats-widget.js` |
| CI/CD | GitHub Actions | `ci.yml`, `deploy-api.yml`, `deploy-widget.yml` |
| Dependency Mgmt | uv (Python) + npm (JavaScript) | |

## Skill routing

When the user's request matches an available skill, ALWAYS invoke it using the Skill
tool as your FIRST action. Do NOT answer directly, do NOT use other tools first.
The skill has specialized workflows that produce better results than ad-hoc answers.

Key routing rules:
- Product ideas, "is this worth building", brainstorming → invoke office-hours
- Bugs, errors, "why is this broken", 500 errors → invoke investigate
- Ship, deploy, push, create PR → invoke ship
- QA, test the site, find bugs → invoke qa
- Code review, check my diff → invoke review
- Update docs after shipping → invoke document-release
- Weekly retro → invoke retro
- Design system, brand → invoke design-consultation
- Visual audit, design polish → invoke design-review
- Architecture review → invoke plan-eng-review
- Save progress, checkpoint, resume → invoke checkpoint
- Code quality, health check → invoke health
