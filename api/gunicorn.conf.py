"""Gunicorn configuration for OyeChats API.

Usage:
    uv run gunicorn app.main:app -c gunicorn.conf.py

Worker count:
    Phase 1 (scalability plan): workers=1 — process management benefits
    (auto-restart, memory recycling) without breaking the in-memory
    WebSocket ConnectionManager.

    After Phase 3 (Redis pub/sub WebSocket refactor), increase via
    WEB_CONCURRENCY env var.
"""

import os

# ── Worker configuration ────────────────────────────────────────────────────
# Start with 1 worker until the WebSocket manager is refactored to Redis
# pub/sub (Phase 3). After that, set WEB_CONCURRENCY=2-4.
workers = int(os.getenv("WEB_CONCURRENCY", "1"))
worker_class = "uvicorn.workers.UvicornWorker"

# ── Binding ─────────────────────────────────────────────────────────────────
# Behind Nginx, bind to loopback only. Without Nginx, use 0.0.0.0.
bind = os.getenv("GUNICORN_BIND", "127.0.0.1:8000")

# ── Timeouts ────────────────────────────────────────────────────────────────
# Workers stuck beyond 120s are killed (covers the 60s app timeout in
# middleware.py plus margin for streaming/WebSocket handshake).
timeout = 120
graceful_timeout = 30
keepalive = 5

# ── Worker recycling ────────────────────────────────────────────────────────
# Recycle workers after ~1000 requests to prevent memory leaks (Playwright
# browser instances, large document ingestion buffers).
max_requests = 1000
max_requests_jitter = 100

# ── Preloading ──────────────────────────────────────────────────────────────
# Cannot preload: the in-memory ConnectionManager and ThreadPoolExecutor
# must be per-worker, not shared across fork().
preload_app = False

# ── Logging ─────────────────────────────────────────────────────────────────
accesslog = "-"
errorlog = "-"
loglevel = os.getenv("GUNICORN_LOG_LEVEL", "info")

# ── Process naming ──────────────────────────────────────────────────────────
proc_name = "oyechats-api"
