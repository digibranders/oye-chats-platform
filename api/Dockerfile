FROM python:3.11-slim

WORKDIR /app

# System deps: psycopg2 build chain + WeasyPrint's cairo/pango stack (invoice
# PDF rendering — without these the worker logs "PDF renderer unavailable" and
# invoice PDFs silently never render). Crawling is off-box (Spider.cloud/Jina),
# so no Playwright/Chromium here.
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libpq-dev \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libcairo2 \
    libgdk-pixbuf-2.0-0 \
    libffi8 \
    shared-mime-info \
    fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

# Install uv
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/

# Install dependencies (cached layer)
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

# Copy application code
COPY . .

EXPOSE 8000

# Copy gunicorn config
COPY gunicorn.conf.py .

# Use gunicorn with uvicorn workers for process management (auto-restart,
# memory recycling). Worker count controlled via WEB_CONCURRENCY env var.
# For bare-metal (no Nginx), override GUNICORN_BIND=0.0.0.0:8000.
CMD ["uv", "run", "gunicorn", "app.main:app", "-c", "gunicorn.conf.py"]
