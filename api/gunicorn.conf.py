"""Gunicorn configuration for OyeChats API.

Usage:
    uv run gunicorn app.main:app -c gunicorn.conf.py

Worker count:
    WEB_CONCURRENCY, defaulting to (2 * CPU cores) + 1 — the standard
    Gunicorn sizing heuristic — instead of a hardcoded 1. A default of 1
    meant a single worker handled every request, including the async SSE
    chat endpoints that still do blocking sync DB work: one slow request
    stalled the event loop for the whole process with no other worker to
    absorb traffic. The systemd unit pins an explicit value for prod (see
    oyechats-api.service) so the deployed worker count is defined in-repo
    rather than left to whatever CPU count this default resolves to.

    CAVEAT — WebSocket live chat: `ConnectionManager`
    (app/services/live_chat_service.py) tracks visitor/operator sockets in
    plain in-memory dicts, and nginx's `ip_hash` (nginx/oyechats-api.conf)
    only pins a client to the single upstream `127.0.0.1:8000` — it cannot
    route a visitor and their assigned operator to the *same* gunicorn
    worker process behind that port. With >1 worker, a live-chat pair
    split across workers will not see each other's messages. This does not
    affect the async SSE bot-chat path (the thing this default fixes), but
    it means multi-worker must not go to production until the WebSocket
    manager moves to Redis pub/sub (Phase 3), unless WEB_CONCURRENCY is
    deliberately pinned back to 1 in the meantime.
"""

import multiprocessing
import os

# ── Worker configuration ────────────────────────────────────────────────────
# (2 * cores) + 1 is Gunicorn's own recommended default (see the "Worker
# Processes" section of the Gunicorn docs) — enough workers to keep the CPU
# busy while one is blocked on I/O. WEB_CONCURRENCY still overrides it so
# prod can pin an explicit, reviewed value (see systemd unit + module
# docstring above for why an unqualified bump is not automatically safe).
_default_workers = (multiprocessing.cpu_count() * 2) + 1
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
