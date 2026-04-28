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
| Admin Dashboard | `admin/` | `npm run lint` | — (JS) | `npm run build` |
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
9. **Google Gemini** generates a response using retrieved context
10. **Response streams back** to the widget

## Architecture (4 Applications)

```
oye-chats/
├── platform/                     # Main platform (this repo)
│   ├── api/                     # FastAPI REST API + RAG pipeline
│   ├── widget/                  # Embeddable chat widget (builds to oyechats-widget.js)
│   ├── admin/                   # React admin dashboard (bot management, analytics)
│   └── aiorb-preview/           # 3D animated orb preview (optional)
├── landing/                     # Next.js marketing landing page
└── CLAUDE.md                    # Root orientation (see platform/CLAUDE.md for details)
```

| App | Directory | Port | Stack | Purpose |
|-----|-----------|------|-------|---------|
| Backend API | `api/` | 8000 | FastAPI, SQLAlchemy, pgvector | REST API, RAG pipeline, auth, document ingestion |
| Chat Widget | `widget/` | 5173 (dev) / 4173 (preview) | React 19, Vite, Tailwind | Embeddable chat widget for customer websites |
| Admin Dashboard | `admin/` | 5174 | React 19, Vite, React Router | Bot management, knowledge base, analytics, settings |
| Landing Page | `../landing/` | 3000 | Next.js 16, React 19, Tailwind v4 | Marketing site at oyechats.com |

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
  → Extraction (PDF/DOCX/TXT via extraction.py)
  → Cleaning (cleaner.py)
  → Chunking (recursive splitting, 2000 chars, 300 overlap — chunking.py, env-configurable)
  → Embedding (OpenAI text-embedding-3-small, 1536-dim vectors — embedder.py)
  → Storage (PostgreSQL pgvector — repository.py)

User Question
  → Hybrid Search (vector similarity + full-text TSVECTOR — rag_service.py)
  → Context Building (top chunks + chat history)
  → LLM Generation (Google Gemini 2.5 Flash, streaming — llm_service.py)
  → BANT Tracking (optional sales qualification — rag_service.py)
  → Response → Widget
```

## Database Schema (Key Models)

- **Client** — User account (email, hashed password, API key, max bots)
- **Bot** — Chatbot instance (bot_key, name, system_prompt, settings, colors, logos)
- **Document** — Ingested content (text chunks + Vector(384) embeddings + TSVECTOR)
- **ChatSession** — Conversation session (visitor tracking, BANT state, geolocation)
- **ChatMessage** — Individual messages (role, content, feedback, Langfuse trace ID)

Relationships: `Client → Bot → Document`, `Bot → ChatSession → ChatMessage`

## API Headers & Auth

- **Admin auth**: API key in `X-API-Key` header (set during login)
- **Widget auth**: Bot key in `X-Bot-Key` header (from embed script's `data-bot-key`)
- Backend resolves the bot from `X-Bot-Key` via `get_current_bot()` middleware

## Key Naming Conventions

| Item | Name |
|------|------|
| Widget bundle | `oyechats-widget.js` / `oyechats-widget.css` |
| DOM container | `oyechats-widget-root` |
| Window globals | `window.OYECHATS_BOT_KEY`, `window.OYECHATS_API_KEY` |
| Console prefix | `[OyeChats]` |
| Production CDN | `cdn.oyechats.com/oyechats-widget.js` |
| Contact email | `developer@oyechats.com` |

## Environment Setup

- **Conda environment**: `oye` (Python 3.11)
- **Dependency manager**: `uv` (inside conda env)

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
All backend commands MUST run within the conda `oye` environment.

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
cd admin
npm install && npm run dev       # Dev server (localhost:5174)
```

### Landing Page
```bash
cd ../landing
npm install && npm run dev       # Dev server (localhost:3000)
```

## Key Files

| Purpose | File |
|---------|------|
| Backend entry | `api/app/main.py` |
| RAG pipeline | `api/app/services/rag_service.py` |
| LLM service | `api/app/services/llm_service.py` |
| DB models | `api/app/db/models.py` |
| Bot routes | `api/app/api/bot_routes.py` |
| Chat routes | `api/app/api/chat_routes.py` |
| Document ingestion | `api/app/ingestion/pipeline.py` |
| Embedding generation | `api/app/ingestion/embedder.py` |
| Widget entry point | `widget/src/main.jsx` |
| Widget API client | `widget/src/services/api.js` |
| Widget chat UI | `widget/src/components/ChatWindow.jsx` |
| Vite build config | `widget/vite.config.js` |
| Admin embed scripts | `admin/src/pages/Chatbot.jsx` |
| Admin bot settings UI | `admin/src/pages/Interface.jsx` |
| Landing page layout | `../landing/src/app/layout.tsx` |

## Tech Stack

| Layer | Technology |
|-------|-----------|
| LLM | Google Gemini 2.5 Flash |
| Embeddings | OpenAI text-embedding-3-small (1536-dim, API-based) |
| Vector DB | PostgreSQL 16 + pgvector |
| Backend | FastAPI + SQLAlchemy + Alembic |
| Frontend | React 19 + Vite + Tailwind CSS |
| Web Scraping | Playwright (Chromium) |
| Cloud Storage | Backblaze B2 (S3-compatible) |
| Observability | Langfuse (LLM traces) + Sentry (errors) |
| Dependency Mgmt | uv (Python) + npm (JavaScript) |

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
