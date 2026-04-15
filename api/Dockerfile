FROM python:3.11-slim

WORKDIR /app

# Install system dependencies for psycopg2 and playwright
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libpq-dev \
    && rm -rf /var/lib/apt/lists/*

# Install uv
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/

# Install dependencies (cached layer)
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

# Copy application code
COPY . .

# Install playwright browsers
RUN uv run playwright install --with-deps chromium

EXPOSE 8000

# Copy gunicorn config
COPY gunicorn.conf.py .

# Use gunicorn with uvicorn workers for process management (auto-restart,
# memory recycling). Worker count controlled via WEB_CONCURRENCY env var.
# For bare-metal (no Nginx), override GUNICORN_BIND=0.0.0.0:8000.
CMD ["uv", "run", "gunicorn", "app.main:app", "-c", "gunicorn.conf.py"]
