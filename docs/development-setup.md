# Local Development Setup

> This page is for **local developer machines only**. Production runs Python under systemd on a DigitalOcean droplet — no conda environment is involved on the server.

## Prerequisites

- **Python 3.11+** (Miniconda/Anaconda recommended locally to isolate from system Python; not used in prod)
- **Node.js 20+** and npm
- **PostgreSQL 16** with the `pgvector` extension enabled
- **uv** — Python dependency manager (works inside conda env or stand-alone)
- **Playwright** — for web crawling (Chromium browser auto-installed)

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

# Install Playwright browser (for web crawling)
uv run playwright install chromium

# Start the dev server
uv run uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

The API will be available at `http://localhost:8000`. Swagger docs are at `http://localhost:8000/docs`.

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
cd admin
npm install

# Set up environment
cp .env.example .env

# Start dev server
npm run dev    # → http://localhost:5174
```

### 5. Landing Page (Optional)

```bash
cd ../landing
npm install
npm run dev    # → http://localhost:3000
```

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
npm run build             # Build
```

**Admin Dashboard (JavaScript):**
```bash
cd admin
npm run lint              # Lint
npm run build             # Build
```

All checks must pass before pushing. Fix any failures before reporting code as complete.

## Running Services Together

For full-stack local development, run all services simultaneously:

| Terminal | Command | URL |
|----------|---------|-----|
| 1 | `conda activate oye && cd api && uv run uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload` | `localhost:8000` |
| 2 | `cd widget && npm run dev` | `localhost:5173` |
| 3 | `cd admin && npm run dev` | `localhost:5174` |

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
cd widget   # or cd admin
npm install <package-name>
```

## Troubleshooting

**"@vitejs/plugin-react can't detect preamble"**
This happens when trying to embed the widget dev server cross-origin. Use `npm run build && npx vite preview --port 4173` instead.

**pgvector extension not found**
Run `CREATE EXTENSION vector;` in your PostgreSQL database.

**Conda environment not found**
Run `conda create -n oye python=3.11 -y` then `conda activate oye`.

**Port conflicts**
The default ports are 8000 (API), 5173 (widget dev), 4173 (widget preview), and 5174 (admin). Update `.env` files if you need different ports.
