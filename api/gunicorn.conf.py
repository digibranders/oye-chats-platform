"""Gunicorn configuration for OyeChats API.

Usage:
    uv run gunicorn app.main:app -c gunicorn.conf.py

Worker count:
    Defaults to 1 (via WEB_CONCURRENCY). This is a DELIBERATE constraint, not
    an oversight: the live-chat WebSocket `ConnectionManager`
    (app/services/live_chat_service.py) tracks visitor/operator sockets in
    plain in-memory dicts, and nginx's `ip_hash` (nginx/oyechats-api.conf)
    only pins a client to the single upstream `127.0.0.1:8000` — it cannot
    route a visitor and their assigned operator to the *same* gunicorn worker
    process. With >1 worker, a live-chat pair split across workers stops
    seeing each other's messages. So multi-worker must NOT ship until the
    WebSocket manager moves to a shared backplane (Redis pub/sub, "Phase 3").

    Known limitation of staying at 1: the async SSE chat endpoints still do
    some blocking sync DB work, so one slow request can stall the event loop
    for the whole process. The correct fix is to make that DB work async (or
    land the Redis-pub/sub backplane and then raise WEB_CONCURRENCY) — NOT to
    bump workers while the WebSocket manager is still in-process. The systemd
    unit pins WEB_CONCURRENCY=1 explicitly so this constraint is visible
    in-repo rather than being an accidental default.
"""

import os

# ── Worker configuration ────────────────────────────────────────────────────
# Default 1 — see the module docstring: multi-worker breaks in-process
# WebSocket live chat until the ConnectionManager moves to Redis pub/sub.
# WEB_CONCURRENCY (pinned to 1 in the systemd unit) may raise this ONLY after
# that backplane work lands.
_default_workers = 1
workers = int(os.getenv("WEB_CONCURRENCY", str(_default_workers)))
worker_class = "uvicorn.workers.UvicornWorker"
# Only trust proxy headers (X-Forwarded-For / -Proto) from nginx on loopback.
# Without this, uvicorn would honor a spoofed X-Forwarded-For from any source
# that reached the port directly (P0-1 / NB-9).
#
# This is also the load-bearing invariant behind the per-IP rate-limit key
# (roadmap §0.3): keying on the client IP is only non-spoofable because uvicorn
# trusts X-Forwarded-For *only* from nginx on loopback. If this is opened to
# ``*`` / ``0.0.0.0`` a visitor could forge X-Forwarded-For and mint unlimited
# rate-limit buckets, defeating the anti-drain protection — so refuse it in
# production rather than fail open silently.
forwarded_allow_ips = os.getenv("FORWARDED_ALLOW_IPS", "127.0.0.1")
if os.getenv("APP_ENV", "development") == "production":
    _open_forwarded = {"*", "0.0.0.0", "0.0.0.0/0"}
    _configured = {ip.strip() for ip in forwarded_allow_ips.split(",")}
    if _configured & _open_forwarded:
        raise RuntimeError(
            "FORWARDED_ALLOW_IPS must not be open (* / 0.0.0.0) in production: it lets clients "
            "spoof X-Forwarded-For and defeat the per-IP rate limit. Set it to the trusted proxy "
            "IP(s) (default 127.0.0.1 for nginx-on-loopback)."
        )

# ── Binding ─────────────────────────────────────────────────────────────────
# Behind Nginx, bind to loopback only. Without Nginx, use 0.0.0.0.
bind = os.getenv("GUNICORN_BIND", "127.0.0.1:8000")

# ── Timeouts ────────────────────────────────────────────────────────────────
# Workers stuck beyond 120s are killed (covers the 60s app timeout in
# middleware.py plus margin for streaming/WebSocket handshake).
timeout = 120
# Give a recycling worker enough headroom to finish any in-flight crawl
# (CRAWL_SUBPROCESS_TIMEOUT defaults to 1600s) before gunicorn SIGKILLs it.
# Gunicorn spawns the replacement worker immediately, so new traffic is not
# blocked by the draining worker.
graceful_timeout = int(os.getenv("GUNICORN_GRACEFUL_TIMEOUT", "1650"))
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
