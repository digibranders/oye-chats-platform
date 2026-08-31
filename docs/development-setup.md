# Local Development Setup

> This page is for **local developer machines only**. Production runs Python under systemd on a DigitalOcean droplet — no conda environment is involved on the server.

## Prerequisites

- **Python 3.11+** (Miniconda/Anaconda recommended locally to isolate from system Python; not used in prod)
- **Node.js 20+** and npm
- **PostgreSQL 16** with the `pgvector` extension enabled
- **uv** — Python dependency manager (works inside conda env or stand-alone)
- **Redis** — backs ARQ, the SlowAPI counters and the crawl progress/lock keys. The app degrades to in-process fallbacks without it, but crawls and background jobs get much harder to observe

> **Playwright is not a backend prerequisite.** Crawling is HTTP-only through Jina Reader / Spider.cloud and nothing in `api/` drives Chromium. Playwright *is* a devDependency of `app/` and `widget/` for their browser test suites — installed with `npm run e2e:install`, not with `uv`.

## Initial Setup

### 1. Clone and Branch

```bash
git clone <repo-url> oye-chats
cd oye-chats/platform
git checkout development    # Always work on development — never commit to main
```

### 2. Backend (API)

```bash
# Create and activate the conda environment
conda create -n oye python=3.11 -y
conda activate oye

# Install dependencies
cd api
uv sync

# Set up environment variables
cp .env.example .env
# Edit .env with your local PostgreSQL URL, API keys, etc.

# Run database migrations
uv run alembic upgrade head

# Start the dev server
uv run uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

The API will be available at `http://localhost:8000`. Swagger docs are at `http://localhost:8000/docs`.

> **Prefer the launcher.** `cd api && ./scripts/dev.sh` runs migrations, opens the ngrok webhook tunnel, starts the ARQ worker and then the API, in that order. The plain `uvicorn` line above starts **no worker**, so document ingestion, invoice PDFs, webhook retries and the cron jobs will not run.

### 3. Chat Widget

```bash
cd widget
npm install

# Set up environment
cp .env.example .env
# Edit .env — set VITE_API_URL=http://localhost:8000

# Start dev server (for widget development only)
npm run dev    # → http://localhost:5173
```

**Important:** The Vite dev server cannot be embedded on external sites due to React Fast Refresh preamble requirements. To test embedding, use preview mode:

```bash
npm run build
npx vite preview --port 4173    # → http://localhost:4173
```

Then embed on a test page:
```html
<script src="http://localhost:4173/oyechats-widget.js" data-bot-key="bot-xxx"></script>
```

### 4. Admin Dashboard

```bash
cd app
npm install

# Set up environment
cp .env.example .env

# Start dev server
npm run dev    # → http://localhost:5174
```

### 5. Landing Page (Optional)

```bash
cd ../oyechats-website
npm install
npm run dev    # → http://localhost:3000
```

> This is a **separate repository**, a sibling of `platform/`, not a directory inside it.

## Development Workflow

### Git Rules

- **Always** work on the `development` branch
- **Never** commit to or push to `main`
- Verify your branch before every commit: `git branch --show-current`
- To release: create a PR from `development` → `main` on GitHub

### Pre-Commit Checks

Run only the checks relevant to the files you changed:

**Backend (Python):**
```bash
conda activate oye
cd api
uv run ruff check .       # Lint
uv run ruff format .      # Format
uv run pytest             # Tests
```

**Widget (JavaScript):**
```bash
cd widget
npm run lint              # Lint
npm test                  # Unit tests (node --test)
npm run build             # Build
npm run size              # Gzipped size budgets — the eager vendor chunk sits at ~99.9% of its ceiling
```

**Admin Dashboard (TypeScript):**
```bash
cd app
npm run lint              # Lint
npx tsc --noEmit          # Typecheck — REQUIRED; `npm run build` does NOT typecheck
npx vitest run            # Unit tests
npm run build             # Build
```

`app/` is TypeScript end to end and Vite transpiles without checking, so `npm run build` passes on code that does not typecheck. Treat `tsc --noEmit` as non-optional there.

There is also a Playwright browser suite, which CI runs. It is the only gate that exercises real layout and a real event loop, so it catches what jsdom cannot — elements covered by other elements, overflow, text rendered twice on one screen:

```bash
cd app && npm run build && npx playwright install chromium && npm run e2e
```

It drives `vite preview`, not the dev server, so it needs the build first — what is under test is what ships.

All checks must pass before pushing. Fix any failures before reporting code as complete.

## Running Services Together

For full-stack local development, run all services simultaneously:

| Terminal | Command | URL |
|----------|---------|-----|
| 1 | `conda activate oye && cd api && uv run uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload` | `localhost:8000` |
| 2 | `cd widget && npm run dev` | `localhost:5173` |
| 3 | `cd app && npm run dev` | `localhost:5174` |
| 4 | `cd api && .venv/bin/python -m arq app.worker.settings.WorkerSettings` | ARQ worker (no port) |

Or replace terminals 1 and 4 with `cd api && ./scripts/dev.sh`, which starts both in the right order.

## Database Management

### Migrations

```bash
conda activate oye && cd api

# Create a new migration after model changes
uv run alembic revision --autogenerate -m "description of change"

# Apply all pending migrations
uv run alembic upgrade head

# Rollback one migration
uv run alembic downgrade -1
```

### Resetting the Database

```bash
# Drop and recreate (development only!)
psql -U postgres -c "DROP DATABASE oyechats;"
psql -U postgres -c "CREATE DATABASE oyechats;"
psql -U postgres -d oyechats -c "CREATE EXTENSION vector;"
uv run alembic upgrade head
```

## Adding Dependencies

**Backend:**
```bash
conda activate oye && cd api
uv add <package-name>
```

**Widget / Admin:**
```bash
cd widget   # or cd app
npm install <package-name>
```

> In `widget/`, a new dependency that lands in the **eager** path (loader, app entry, or vendor chunk) is a budget decision. Run `npm run size` before assuming it fits — the vendor chunk has almost no headroom left.

## Troubleshooting

**"@vitejs/plugin-react can't detect preamble"**
This happens when trying to embed the widget dev server cross-origin. Use `npm run build && npx vite preview --port 4173` instead.

**pgvector extension not found**
Run `CREATE EXTENSION vector;` in your PostgreSQL database.

**Conda environment not found**
Run `conda create -n oye python=3.11 -y` then `conda activate oye`.

**Port conflicts**
The default ports are 8000 (API), 5173 (widget dev), 4173 (widget preview), and 5174 (admin). Update `.env` files if you need different ports.

**Documents ingest but the bot answers "I don't know"**
Almost always a missing `GOOGLE_API_KEY`. Embedding has no fallback provider, so without it every chunk fails to embed and retrieval returns nothing. Check the ingestion logs rather than the chat logs.

**A crawl or an upload appears to hang forever**
Ingestion runs in the ARQ worker. If you started the API with a bare `uvicorn` line and no worker, the job is queued and nothing is draining the queue. Start the worker, or use `./scripts/dev.sh`.
