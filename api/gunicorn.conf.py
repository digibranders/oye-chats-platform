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
# Give a recycling worker enough headroom to finish any in-flight crawl
# (CRAWL_SUBPROCESS_TIMEOUT defaults to 600s) before gunicorn SIGKILLs it.
# Gunicorn spawns the replacement worker immediately, so new traffic is not
# blocked by the draining worker.
graceful_timeout = int(os.getenv("GUNICORN_GRACEFUL_TIMEOUT", "650"))
keepalive = 5

# ── Worker recycling ────────────────────────────────────────────────────────
# Workers recycle every N requests to defend against any residual memory
# leaks. Raised from the original 1000 because the previous limit consistently
# fired in the middle of long Playwright crawls and silently killed them
# (the response never reached the client → "Network Error" in the UI). The
# crawler subprocess now PR_SET_PDEATHSIG-ties to the worker and is torn down
# cleanly on any exit path, so the leak this guard was working around is no
# longer the dominant one.
max_requests = int(os.getenv("GUNICORN_MAX_REQUESTS", "10000"))
max_requests_jitter = int(os.getenv("GUNICORN_MAX_REQUESTS_JITTER", "1000"))

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
