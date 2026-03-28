# OyeChat

A production-ready RAG-powered chatbot platform with multi-bot support, BANT sales qualification, admin analytics dashboard, and an embeddable widget for any website.

## Architecture

| Module | Stack | Purpose |
|--------|-------|---------|
| `api/` | FastAPI, SQLAlchemy, pgvector, Google Gemini | RAG pipeline, REST API, auth, document ingestion |
| `widget/` | React 19, Vite, Tailwind CSS | Embeddable chat widget (`oyechats-widget.js`) |
| `admin/` | React 19, Vite, React Router, Recharts | Admin dashboard with analytics |
| `aiorb-preview/` | React 19, Three.js | 3D animated chatbot orb preview |

## Prerequisites

- **Python 3.11** (pinned via `.python-version`)
- **Node.js 18+**
- **PostgreSQL 16+** with [pgvector](https://github.com/pgvector/pgvector) extension
- **uv** (Python dependency manager) — [install guide](https://docs.astral.sh/uv/getting-started/installation/)
- **conda** (optional, for local env management)

## Quick Start

### Option 1: Docker (Recommended)

Spins up PostgreSQL + pgvector and the FastAPI backend in containers.

```bash
# 1. Clone and configure
git clone <repo-url> && cd platform
cp api/.env.example api/.env
# Edit api/.env — at minimum set GOOGLE_API_KEY

# 2. Start all services
docker compose up --build
```

| Service | URL |
|---------|-----|
| Backend API | http://localhost:8000 |
| Swagger Docs | http://localhost:8000/docs |
| PostgreSQL | localhost:5432 |

### Option 2: Local Development (with conda + uv)

#### 1. Set up the conda environment

```bash
# Create conda env (one-time)
conda create -n oye python=3.11 -y
conda activate oye
```

#### 2. Install uv

```bash
# Option A: via pip inside conda
pip install uv

# Option B: standalone installer
curl -LsSf https://astral.sh/uv/install.sh | sh
```

#### 3. Configure environment variables

```bash
cp api/.env.example api/.env
# Edit api/.env with your API keys (see Environment Variables section below)
```

#### 4. Install backend dependencies

```bash
cd api
uv sync          # Installs all deps from uv.lock into .venv
```

#### 5. Set up the database

If running PostgreSQL locally (not via Docker):

```bash
# Ensure pgvector extension is installed, then:
createdb ragpro

# Run migrations
uv run alembic upgrade head
```

Or use Docker for just the database:

```bash
docker compose up db -d
uv run alembic upgrade head
```

#### 6. Start the backend

```bash
cd api
uv run uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

#### 7. Start the frontend apps

Each frontend runs independently. Open separate terminals:

**Chat Widget:**

```bash
cd widget
npm install
npm run dev        # → http://localhost:5173
```

**Admin Dashboard:**

```bash
cd admin
npm install
npm run dev        # → http://localhost:5174 (or next available port)
```

**3D Orb Preview (optional):**

```bash
cd aiorb-preview
npm install
npm run dev        # → http://localhost:5175 (or next available port)
```

## Environment Variables

Create `api/.env` from the example file. Variables marked required must be set for the backend to function.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DB_URL` | Yes | — | PostgreSQL connection string (`postgresql://user:pass@host:5432/ragpro`) |
| `GOOGLE_API_KEY` | Yes | — | Google Gemini API key |
| `GOOGLE_API_KEY` | No | — | Fallback Gemini API key (used if `GOOGLE_API_KEY` is unset) |
| `APP_ENV` | No | `development` | `development` or `production` |
| `CORS_ORIGINS` | No | `*` (dev) | Comma-separated allowed origins (production only) |
| `B2_KEY_ID` | No | — | Backblaze B2 storage key ID |
| `B2_APPLICATION_KEY` | No | — | Backblaze B2 application key |
| `B2_BUCKET_NAME` | No | — | B2 bucket name |
| `B2_ENDPOINT` | No | — | B2 S3-compatible endpoint URL |
| `SENTRY_DSN` | No | — | Sentry error tracking DSN (leave blank to disable) |
| `LANGFUSE_SECRET_KEY` | No | — | Langfuse LLM observability secret key |
| `LANGFUSE_PUBLIC_KEY` | No | — | Langfuse public key |
| `LANGFUSE_HOST` | No | `https://cloud.langfuse.com` | Langfuse host URL |

## Common Commands

All backend commands assume you're in the `api/` directory with the conda `oye` environment active.

### Backend

```bash
# Activate environment
conda activate oye

# Install / sync dependencies
uv sync

# Add a new dependency
uv add <package-name>

# Start dev server
uv run uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload

# Run database migrations
uv run alembic upgrade head

# Create a new migration
uv run alembic revision --autogenerate -m "description"

# Run tests
uv run pytest

# Run linter
uv run ruff check .

# Auto-fix lint issues
uv run ruff check . --fix
```

### Frontend / Admin

```bash
# Install dependencies
npm install

# Start dev server
npm run dev

# Production build
npm run build
```

### Docker

```bash
# Start everything
docker compose up --build

# Start only the database
docker compose up db -d

# Rebuild backend after dependency changes
docker compose build backend

# View logs
docker compose logs -f backend

# Tear down (preserves data volume)
docker compose down

# Tear down and delete database volume
docker compose down -v
```

## API Documentation

Once the backend is running, interactive API docs are available at:

- **Swagger UI**: http://localhost:8000/docs
- **ReDoc**: http://localhost:8000/redoc

### Key API Routes

| Route Prefix | Description |
|--------------|-------------|
| `/api/auth/` | Registration, login, API key management |
| `/api/superadmin/` | Super admin operations |
| `/api/bots/` | Bot CRUD, customization |
| `/api/chat/` | Chat sessions, messages, SDR/BANT, feedback |
| `/api/documents/` | Document upload, ingestion, web crawling |
| `/api/analytics/` | Dashboard statistics |
| `/api/client/` | Client-facing settings |

## Testing

```bash
cd api
uv run pytest                    # Run all tests
uv run pytest tests/test_sentry.py  # Run a specific test file
uv run pytest -v                 # Verbose output
```

## Embedding the Widget

Build the widget and host the output file:

```bash
cd widget
npm run build
# Output: dist/oyechats-widget.js
```

Add to any webpage:

```html
<script src="https://your-cdn.com/oyechats-widget.js" data-bot-key="bot-YOUR_KEY_HERE"></script>
```

## Project Structure

```
platform/
├── api/
│   ├── app/
│   │   ├── main.py              # FastAPI app entry point
│   │   ├── config.py            # Environment configuration
│   │   ├── api/                 # Route handlers
│   │   │   ├── auth_routes.py   # Login / register
│   │   │   ├── bot_routes.py    # Bot CRUD
│   │   │   ├── chat_routes.py   # Chat + SDR + feedback
│   │   │   ├── document_routes.py  # Ingestion + crawling
│   │   │   ├── analytics_routes.py # Dashboard stats
│   │   │   ├── client_routes.py    # Client settings
│   │   │   └── superadmin_routes.py
│   │   ├── db/                  # Database layer
│   │   │   ├── models.py        # SQLAlchemy ORM models
│   │   │   ├── session.py       # Connection management
│   │   │   └── repository.py    # Data access queries
│   │   ├── services/            # Business logic
│   │   │   ├── rag_service.py   # Hybrid RAG (vector + keyword)
│   │   │   ├── llm_service.py   # Google Gemini integration
│   │   │   ├── sdr_service.py   # BANT sales qualification
│   │   │   ├── intent_service.py # Intent classification
│   │   │   ├── crawler_service.py # Web crawling (Playwright)
│   │   │   └── b2_service.py    # Backblaze B2 storage
│   │   ├── ingestion/           # Document processing pipeline
│   │   │   ├── pipeline.py      # Orchestrator
│   │   │   ├── extraction.py    # PDF / DOCX / TXT extraction
│   │   │   ├── chunking.py      # Recursive text splitting
│   │   │   ├── embedder.py      # FastEmbed vector generation
│   │   │   └── cleaner.py       # Text preprocessing
│   │   ├── core/                # Cross-cutting concerns
│   │   │   ├── security.py      # Password hashing (bcrypt)
│   │   │   ├── middleware.py     # Error handling, CORS
│   │   │   └── langfuse_client.py # LLM observability
│   │   └── schemas/             # Pydantic request/response models
│   ├── alembic/                 # Database migrations
│   ├── tests/                   # Test suite
│   ├── pyproject.toml           # Dependencies & tool config
│   ├── uv.lock                  # Locked dependency versions
│   ├── Dockerfile               # Container build (uv-based)
│   └── .python-version          # Python 3.11
├── widget/                      # Embeddable chat widget
├── admin/                       # Admin dashboard
├── aiorb-preview/               # 3D orb preview
├── docker-compose.yml           # PostgreSQL + api
└── CLAUDE.md                    # AI assistant conventions
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| LLM | Google Gemini 2.5 Flash |
| Embeddings | FastEmbed (BAAI/bge-small-en-v1.5) |
| Vector DB | PostgreSQL 16 + pgvector |
| Backend | FastAPI + SQLAlchemy + Alembic |
| Frontend | React 19 + Vite + Tailwind CSS |
| Web Scraping | Playwright (Chromium) |
| Cloud Storage | Backblaze B2 (S3-compatible) |
| Observability | Langfuse (LLM traces) + Sentry (errors) |
| Dependency Mgmt | uv (Python) + npm (JavaScript) |
| Containerization | Docker + Docker Compose |
