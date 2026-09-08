# Project: OyeChats

OyeChats is a **SaaS chatbot platform** where customers sign up, create chatbot instances, upload their knowledge base, and embed an AI chatbot on their website with a single script tag. The chatbot uses RAG (Retrieval-Augmented Generation) to answer visitor questions from the customer's documents.

---

> ## ACTIVE MANDATE — the console rebuild → see [`app/CLAUDE.md`](app/CLAUDE.md)
> All work inside `app/` (the admin dashboard) is governed by a complete rebuild
> mandate, and by the design language in [`app/DESIGN.md`](app/DESIGN.md). This
> file stays the **technical** reference — backend, APIs, DB models, auth, dev
> commands — and every word of it still applies. What it says about the *UI* does
> not: the existing pages, navigation, onboarding and layouts are pointers to
> reusable logic, never to UX worth keeping.

---

## Code Quality Gate
> **Codex Agent reviews every edit.** Write clean, production-ready code on every change — no placeholders, no shortcuts, no "fix later" comments. Each edit is evaluated for correctness, type safety, error handling, and adherence to project conventions. Treat every diff as if it's going straight to a code review.

## Mandatory Pre-Completion Checks
**BEFORE confirming any code changes to the user OR before pushing code, you MUST run all baseline checks for every project that was touched.** Do not skip these. If any check fails, fix the issue BEFORE presenting the final result.

Run only the checks relevant to the files you changed:

### JavaScript / TypeScript Projects
| Project | Directory | Lint | Typecheck | Tests | Build |
|---------|-----------|------|-----------|-------|-------|
| Admin Dashboard | `app/` | `npm run lint` | `npx tsc --noEmit` | `npx vitest run` | `npm run build` |
| Chat Widget | `widget/` | `npm run lint` | — (JS) | `npm test` | `npm run build` |

`app/` is TypeScript end to end, so `tsc --noEmit` is not optional there: Vite
transpiles and strips types without checking them, and `npm run build` passes
on code that does not typecheck.

**The admin dashboard also has a browser suite, and CI runs it.** It is the
only gate that exercises real layout and a real event loop, so it catches what
jsdom cannot: elements covered by other elements, overflow, and text rendered
twice on one screen.

```bash
cd app && npm run build && npx playwright install chromium && npm run e2e
```

Run it whenever you change the inbox, the shell, or anything under
`features/agents/experience`. It needs the build first: it drives `vite
preview`, not the dev server, so what is under test is what ships.

### Python Backend
| Check | Command (run inside conda `oye` env) |
|-------|---------------------------------------|
| Lint | `cd api && uv run ruff check .` |
| Format | `cd api && uv run ruff format .` |
| Tests | `cd api && uv run pytest` |

**Answer quality is a separate gate, and pytest is not it.** The suite mocks
every LLM call, so a prompt edit that makes the bot hedge on prices, or a gate
change that starts refusing pricing questions, passes it. That class of
regression is caught by the golden-set harness in `api/eval/`, which drives the
real `POST /chat` of a deployed bot and scores the answers with an LLM judge:

```bash
cd api && uv run python -m eval.run_eval --dry-run   # validate the set, no network, no keys
cd api && GOOGLE_API_KEY=... uv run python -m eval.run_eval \
  --api-url https://api.oyechats.com --bot-key bot-xxx
```

Run it after changing the system prompt, the relevance gate, retrieval, or the
qualification prompts. It also runs nightly (`.github/workflows/eval-nightly.yml`,
informational, blocks nothing). See [`docs/eval/README.md`](docs/eval/README.md).

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

| App | Directory | Port | Stack | Purpose |
|-----|-----------|------|-------|---------|
| Backend API | `api/` | 8000 | FastAPI · SQLAlchemy 2.0 · pgvector · LiteLLM · ARQ | REST + SSE + WebSocket; RAG; auth; ingestion; billing |
| Chat Widget | `widget/` | 5173 (dev) / 4173 (preview) | React 19 · Vite 7 · Tailwind v4 | Embeddable chat widget for customer websites (loader IIFE + lazy ESM app) |
| Admin Dashboard | `app/` | 5174 | React 19 · Vite 8 · React Router 7 · Recharts | Bot mgmt, knowledge base, leads, billing, live chat operator console |
| Landing Page | `../oyechats-website/` | 3000 | Next.js 16 · React 19 · Tailwind v4 | Marketing site at oyechats.com (separate repo) |

## Widget Embedding

The two-stage embed (loader IIFE + lazy ESM app), the production and
development snippets, and the hosted demo page are documented in
[`widget/CLAUDE.md`](widget/CLAUDE.md), which loads automatically when you
work under `widget/`.

## RAG Pipeline

```
Document Upload/Crawl
  → Extraction      (PDF via pypdf · DOCX via python-docx · TXT — extraction.py)
  → Cleaning        (cleaner.py)
  → Chunking        (recursive splitting, default 1000 chars, 200 overlap — chunking.py, env-configurable)
  → Embedding       (Google gemini-embedding-001, 768-dim — embedder.py; task type from the bot's
                     embedding profile: RETRIEVAL_DOCUMENT on the current profile, none on legacy)
  → Storage         (PostgreSQL pgvector + TSVECTOR — repository.py)

User Question
  → Hybrid Search   (vector similarity + full-text TSVECTOR — rag_service.py)
  → CAG-lite        (skip retrieval if ≤ CAG_LITE_THRESHOLD chunks — default 20)
  → Relevance Gate  (RELEVANCE_GATE_ENABLED, default **true** — Gemini scores chunks)
  → Rerank          (optional, RERANK_ENABLED — FlashRank cross-encoder)
  → Context Build   (top chunks + chat history + system prompt)
  → LLM Generation  (LiteLLM → OpenAI gpt-5.4-mini → Gemini 2.5 Flash fallback, streaming — llm_service.py)
  → SSE → Widget
  → BANT/MEDDIC extraction after stream closes (qualification_service.py) — NOT ARQ:
                      it runs on the shared 3-thread pool via `core/thread_pool.submit_background`
                      (rag_service.py:7274, :8761). Non-durable: lost on restart.
```

## Database Schema (51 tables; the 25 that matter most are below)

> `models.py` declares 51 `__tablename__`s. The groups below are the ones you will
> actually touch; for the full list read `api/app/db/models.py`, which is the
> single source of truth.

**Core**
- **Client** — Account (email, hashed_password, api_key, max_bots, is_superadmin, is_bot_manager)
- **Bot** — Chatbot instance (bot_key, system_prompt, colors, logos, business_hours, live_chat_enabled, bant_config, demo_screenshot_*). There is **no** `qualification_framework` column here — the bot's framework lives inside the `bant_config` JSON (`qualification_service._framework_name`, models.py:274).
- **Document** — Ingested content chunks (text + `Vector(768)` + TSVECTOR)
- **ChatSession** — Conversation (status: bot|waiting|live|closed, BANT scores/tier, `qualification_framework` stamp, `dimension_scores`, `last_probed_dimension`, visitor_rating, assigned_operator_id)
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

**Billing (Razorpay, INR — single rail)**
- **Plan** — Tier definition (base price exclusive of GST, credits_per_month, included seats, feature_flags, provider IDs)
- **Subscription** — status: trialing|active|past_due|canceled|paused|expired
- **UsageRecord** — Per-period counters
- **Invoice** — Issued by OyeChats (Razorpay-triggered)
- **PaymentMethod** — Card / UPI / bank refs
- **CreditLedger** — Append-only event-sourced credit balance; FIFO topup expiry via self-FK `grant_id`
- **PricingConfig** — Super-admin tunable key/value (credit costs, kill switch)
- **ProcessedWebhook** — Idempotency for inbound provider webhooks

> **Pricing is GST-exclusive.** Every price the product publishes is a base price. For an Indian
> customer the GST is added at charge time by `api/app/core/tax.py::gross_charge_minor`, so ₹1,199
> listed is ₹1,414.82 debited. For an international customer the sale is an export of services, no
> Indian GST applies, and the listed USD price is the full charge. Because the charge is `base + tax`,
> the invoicing engine was not changed: the captured amount is tax-inclusive of the base, so the
> existing carve-out recovers the advertised base exactly, and `SellerProfile.price_inclusive` stays
> pinned `true`. Razorpay Subscriptions have no tax layer, so every INR plan is minted at base + GST.
> See `docs/billing/razorpay-plan-ids.md`.

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
| Widget loader (customer script tag) | `oyechats-widget.js` |
| Widget app chunks | `app/oyechats-*.[hash].js` / `app/oyechats-app.[hash].css` |
| Chunk manifest | `app/manifest.json` |
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
- **Services on box**: `oyechats-api.service` (Gunicorn, 127.0.0.1:8000), `oyechats-worker.service` (ARQ), `postgresql@16-main`, `nginx` (80/443), plus `oyechats-backup.timer` (nightly dump).
- **WebSocket topology**: `api/systemd/oyechats-ws.service` serves `/ws/*` from a dedicated **single-worker** process on 127.0.0.1:8001 so `oyechats-api.service` can run `WEB_CONCURRENCY=2`; nginx routes `/ws/` to it (`api/nginx/oyechats-locations.conf:41`). Cross-process frames travel over the Redis backplane (`services/ws_backplane.py`, `WS_BACKPLANE_ENABLED`, which defaults **true** and is additionally inert without `REDIS_URL`). The deploy restarts this unit only if it is already installed, so whether a given host runs the split is a per-host fact — check `systemctl cat oyechats-ws` before assuming.
- **Health endpoints**: `GET /health`, `GET /health/live`, `GET /health/full` on `127.0.0.1:8000`.
- **Read-only ops only** unless the user explicitly authorizes restarts or writes — production reads via remote shell still require explicit user approval per session.

## Development Commands

### Local backend stack — preferred launcher
```bash
cd api && ./scripts/dev.sh   # migrations → ngrok webhook tunnel → ARQ worker → API
```

### ARQ worker rules (local, macOS) — REQUIRED for invoice PDFs
1. **Start the worker with the pango path directly on the python binary:**
   ```bash
   cd api && DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib .venv/bin/python -m arq app.worker.settings.WorkerSettings
   ```
   Without it, WeasyPrint can't find homebrew pango and the worker logs
   "PDF renderer unavailable" — invoice PDFs silently never render (`pdf_url`
   stays null, no Download button, no invoice email).
2. **Never put a system binary between the env var and python.** macOS SIP
   strips `DYLD_*` vars across `nohup`/`env`/other protected binaries:
   `DYLD_… nohup python …` silently loses the var. This exact trap broke PDF
   rendering on 2026-07-03.
3. **Run exactly ONE worker.** Duplicates share the Redis queue and race for
   render jobs — a pango-less duplicate grabs and skips them, making PDFs
   appear only when the 5-min cron lands on a healthy worker (flaky, hard to
   debug).
4. **Run `alembic upgrade head` on the dev DB (`oyechats`) after pulling
   billing changes** — a schema-behind DB makes invoice ORM writes fail and
   silently rolls back credit grants. `dev.sh` does this automatically.

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
npm run build                    # Build loader + app chunks into dist/ (app config, then loader config)
npm run size                     # Enforce per-chunk gzipped size budgets
npx vite preview --port 4173     # Serve built widget for embedding tests
```

### Admin Dashboard
```bash
cd app
npm install && npm run dev       # Dev server (localhost:5174)
npm run build                    # Production build (Vercel builds this too)
npx tsc --noEmit                 # Typecheck — `npm run build` does NOT typecheck
npx vitest run                   # Unit tests
npm run e2e                      # Playwright browser suite (needs a build first)
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
| Razorpay (sole payment rail) | `api/app/services/razorpay_service.py` |
| Credit ledger | `api/app/services/credit_service.py` |
| Qualification (BANT/MEDDIC) | `api/app/services/qualification_service.py` |
| Outbound webhooks (HMAC + retry) | `api/app/services/webhook_service.py` |
| Email (Brevo) | `api/app/services/email_service.py` |
| DB models — single source of truth for ER | `api/app/db/models.py` |
| Repository (queries / CRUD) | `api/app/db/repository.py` |
| Document ingestion | `api/app/ingestion/pipeline.py` |
| Embedding generation | `api/app/ingestion/embedder.py` |
| Crawler (Spider.cloud + Jina Reader) | `api/app/services/spider_service.py`, `api/app/services/jina_service.py`, `api/app/services/crawl_orchestrator.py` |
| Demo-page website capture | `api/app/services/screenshot_service.py` |
| Hosted demo page (`GET /demo/{bot_key}`) | `api/app/api/bot_routes.py` |
| ARQ worker tasks | `api/app/worker/tasks.py` |
| WebSocket live chat | `api/app/api/ws_routes.py` |
| Chat routes (SSE) | `api/app/api/chat_routes.py` |
| Subscription / billing routes | `api/app/api/subscription_routes.py` |
| Inbound Razorpay webhooks | `api/app/api/webhook_billing_routes.py` |
| Gunicorn config | `api/gunicorn.conf.py` |
| systemd units | `api/systemd/oyechats-api.service` · `oyechats-worker.service` |
| Nginx config | `api/nginx/oyechats-api.conf` · `oyechats-locations.conf` |
| DB backup script | `api/scripts/backup.sh` |
| Standard plan seed | `api/scripts/seed_standard_plus_10k.py` |
| Widget loader (customer entry) | `widget/src/loader.js` |
| Widget app entry (shadow root + React mount) | `widget/src/app-entry.jsx` |
| Widget dev-server entry | `widget/src/main.jsx` |
| Widget prod build configs | `widget/vite.loader.config.js` · `widget/vite.app.config.js` |
| Widget API client | `widget/src/services/api.js` |
| Widget chat UI | `widget/src/components/ChatWindow.jsx` |
| Widget live-chat UI | `widget/src/components/LiveChatMode.jsx` |
| Vite dev-server config | `widget/vite.config.js` (prod uses the two configs above) |
| Admin app router | `app/src/app/routes.tsx` (+ `App.tsx`, `ProtectedLayout.tsx`) |
| Admin shell (rail · topbar · switcher) | `app/src/shell/` |
| Admin API client | `app/src/services/api.ts` |
| Admin embed / deploy UI | `app/src/features/agents/channels/DeployPage.tsx` (+ `PlatformGuide.tsx` for the per-stack steps, `InstallHandoff.tsx` for the key and the developer hand-off); the snippet itself in `app/src/features/agents/channels/deployModel.ts` |
| Admin widget appearance & messages | `app/src/features/agents/experience/ExperiencePage.tsx` |
| Admin knowledge base / crawl | `app/src/features/agents/knowledge/` |
| Admin live-chat operator console | `app/src/features/inbox/InboxPage.tsx` |
| Admin leads | `app/src/features/leads/LeadsPage.tsx` |
| Admin billing | `app/src/features/workspace/billing/` |
| Admin qualification config | `app/src/features/agents/advanced/QualificationPage.tsx` |
| Admin analytics | `app/src/features/analytics/` |
| Admin onboarding / first run | `app/src/onboarding/` |

> The dashboard lives under `app/src/features/**` (one directory per product area),
> `app/src/shell/**` (chrome) and `app/src/app/**` (routing). There is no
> `app/src/App.jsx`, and `app/src/pages/` now holds only the unauthenticated auth
> screens (Login, Register, VerifyEmail, ForgotPassword, OAuthCallback).
>
> ⚠️ **Every `app/src/*` entry above is a TECHNICAL reference only** — use it to find which APIs, hooks and business logic to reuse, never as a UX, layout or navigation reference. The pages, flows, IA and navigation are being rebuilt from first principles; see [`app/CLAUDE.md`](app/CLAUDE.md) and [`app/DESIGN.md`](app/DESIGN.md).

## Tech Stack

| Layer | Technology | Notes |
|-------|-----------|-------|
| LLM (primary) | OpenAI `gpt-5.4-mini` | Routed via LiteLLM |
| LLM (fallback) | Google `gemini-2.5-flash` | Auto-fallback in LiteLLM |
| Gate / enrichment LLM | `gemini-2.5-flash` | CRAG relevance gate (`RELEVANCE_GATE_ENABLED`, **on** by default — it is the control behind the "answers only from your knowledge base" guarantee) + chunk enrichment (`CHUNK_ENRICHMENT_ENABLED`, off by default). Effective gate model is resolved at call time by `runtime_config.get_gate_model()`, not by the `GATE_MODEL` env constant. |
| Embeddings | Google `gemini-embedding-001` | 768-dim, Matryoshka-truncated, client-side L2-normalized; batched **100 texts/call** via `batchEmbedContents`, 8-way concurrent (`EMBED_CONCURRENCY`). Quota is counted **per content item, not per HTTP call**, so batching saves round-trips, not quota — sustained throughput is capped by `EMBED_RPM_LIMIT` (default 2850). **Embedding profiles** (`api/app/core/embedding_profiles.py`): every chunk (`documents.embedding_profile`) and every bot (`bots.embedding_profile`) records how its vectors were made, vector search only compares a query against chunks on the bot's profile, and a bot moves to a newer profile via `task_migrate_embedding_profile` (`api/scripts/migrate_embedding_profile.py`), which re-embeds its chunks then flips the bot under a row lock. Rows that predate profiles are on `…/768/v1` (no task type); the current `…/768/v2` embeds chunks as `RETRIEVAL_DOCUMENT` and questions as `RETRIEVAL_QUERY`. Model is now marked **Legacy** by Google; `gemini-embedding-2` is current (8192 input tokens vs 2048, auto-normalizes truncated dims) but its embedding space is **incompatible** — adopting it is a new profile plus a full migration run. |
| Vector DB | PostgreSQL 16 + pgvector | Hybrid search: `Vector(768)` + `TSVECTOR` |
| Backend | FastAPI · SQLAlchemy 2.0 · Alembic | Python 3.11; `uv` for deps |
| Background queue | ARQ on Redis | `oyechats-worker.service` |
| Frontend | React 19 · Vite 7/8 · Tailwind v4 | Widget = loader IIFE + lazy ESM chunks in a shadow root; Admin = SPA |
| Web Scraping | Jina Reader (primary) + Spider.cloud (fallback) | URL ingestion, HTTP-only (no local browser). `CRAWL_PROVIDER_PRIMARY` defaults to `"jina"` (config.py:674); the other provider becomes the fallback. Super-admin can flip it at runtime via `pricing_config` `crawl.provider_primary`. |
| File Storage | Cloudflare R2 (S3-compatible) | Env vars use the `R2_` prefix (legacy `B2_*` names still accepted as fallbacks); the module is `api/app/services/r2_service.py` |
| Email | Brevo (Sendinblue) | Transactional |
| Payments | Razorpay (INR) — single provider | Webhook idempotency via `processed_webhooks` |
| Real-time | WebSocket (`ws_routes.py`) | Live chat bidirectional messaging |
| Rate limiting | SlowAPI on Redis | Per-route + IP/key |
| Observability | Langfuse + Sentry | **Two separate Langfuse projects**: "OyeChats Prod" (keys in GitHub Secrets) and "OyeChats Dev" (keys in local `.env`). Traces go to the matching project — no mixing. Toggle via `LANGFUSE_FORCE_DISABLE=true` if needed. |
| CDN | Cloudflare R2 | `cdn.oyechats.com/oyechats-widget.js` |
| CI/CD | GitHub Actions | `ci.yml`, `deploy-api.yml`, `deploy-widget.yml`, `deploy-app.yml` |
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
