import asyncio
import contextlib
import json
import logging
import os
from typing import Any

from app.core.cache import PREFIX, get_redis

logger = logging.getLogger(__name__)

# Maximum wall-clock time for a single crawl job (~27 minutes). Used to derive
# the cancel-flag and lock TTL margins below so they comfortably outlive the
# longest crawl. 1600s is under the 30-minute UX cliff where customers assume
# the crawl is broken, and leaves margin below the 3540s ceiling from ``_PROGRESS_TTL``.
_SUBPROCESS_TIMEOUT = int(os.getenv("CRAWL_SUBPROCESS_TIMEOUT", "1600"))

# ── Cross-process crawl progress + lock (Redis) ─────────────────────────────
# These let the API process surface live progress and terminal status for a
# crawl that is actually executing in the ARQ worker process. Falls back to a
# no-op when Redis is unavailable (callers continue to function; the progress
# endpoint just returns "idle").

_PROGRESS_KEY_PREFIX = f"{PREFIX}crawl:progress:"
_LOCK_KEY_PREFIX = f"{PREFIX}crawl:lock:"
_CANCEL_KEY_PREFIX = f"{PREFIX}crawl:cancel:"
_PROGRESS_TTL = 3600  # keep terminal state visible to the UI for an hour
_CANCEL_TTL = _SUBPROCESS_TIMEOUT + 60  # cancel flag self-expires after the crawl can't possibly still be running
_DEFAULT_LOCK_TTL = _SUBPROCESS_TIMEOUT + 120  # crawl + ingestion margin

# In-process fallback for single-worker dev (no Redis). Without these the
# entire progress + lock subsystem is a no-op locally — the UI polls forever
# on "idle" while the BackgroundTask runs and silently completes/fails out
# of view. DO NOT REMOVE: every "tidy-up" of these dicts has immediately
# broken the local crawl flow because Redis is genuinely unavailable on the
# Windows dev box. Production runs Redis + multiple workers and never reads
# these.
_local_progress: dict[int, dict[str, Any]] = {}
_local_locks: set[int] = set()
_local_cancels: set[int] = set()


def _progress_key(client_id: int) -> str:
    return f"{_PROGRESS_KEY_PREFIX}{int(client_id)}"


def _lock_key(client_id: int) -> str:
    return f"{_LOCK_KEY_PREFIX}{int(client_id)}"


def _cancel_key(client_id: int) -> str:
    return f"{_CANCEL_KEY_PREFIX}{int(client_id)}"


# A "running" progress row is considered dead if its heartbeat falls more than
# this many seconds behind wall-clock. Every ``set_crawl_progress`` write stamps
# ``heartbeat_at``, so an orchestrator that emits progress as it crawls keeps the
# row fresh. 240s gives realistic margin for slow managed-crawl batches plus the
# brand-tone / company-context LLM extraction. A SIGKILL'd worker is still reaped
# within 4 minutes of the next ``GET /crawl/progress`` instead of waiting out the
# 1-hour Redis TTL.
_HEARTBEAT_STALE_SECONDS = 240


def set_crawl_progress(
    client_id: int,
    *,
    status: str,
    urls: list[str] | None = None,
    result: dict[str, Any] | None = None,
    error: str | None = None,
    started_at: float | None = None,
    pages_crawled: int | None = None,
    max_pages: int | None = None,
    current_url: str | None = None,
    phase: str | None = None,
    cancellable: bool | None = None,
) -> None:
    """Write the current crawl progress for a client (Redis + in-process fallback).

    Optional fields (``pages_crawled``, ``max_pages``, ``current_url``,
    ``phase``, ``cancellable``) are written when provided so the frontend can
    render a real progress bar, an ETA, and a Cancel button. Older callers that
    only pass ``status`` + ``urls`` continue to work unchanged.

    Every write also stamps a wall-clock ``heartbeat_at`` so the reader can
    distinguish a quietly-running job (recent heartbeat) from a dead one
    (worker process SIGKILL'd, leaving Redis stuck on ``status=running``).
    See :func:`get_crawl_progress` for the read-side staleness rule.
    """
    import time as _time

    payload: dict[str, Any] = {
        "status": status,
        "urls": urls or [],
        "heartbeat_at": _time.time(),
    }
    if result is not None:
        payload["result"] = result
    if error is not None:
        payload["error"] = error
    if started_at is not None:
        payload["started_at"] = started_at
    if pages_crawled is not None:
        payload["pages_crawled"] = int(pages_crawled)
    if max_pages is not None:
        payload["max_pages"] = int(max_pages)
    if current_url is not None:
        payload["current_url"] = current_url
    if phase is not None:
        payload["phase"] = phase
    if cancellable is not None:
        payload["cancellable"] = bool(cancellable)

    client = get_redis()
    if client is None:
        _local_progress[int(client_id)] = payload
        return
    try:
        client.set(_progress_key(client_id), json.dumps(payload, default=str), ex=_PROGRESS_TTL)
    except Exception:
        logger.debug("set_crawl_progress failed for client=%s", client_id, exc_info=True)
        _local_progress[int(client_id)] = payload


# ── Heartbeat (keeps _reap_if_stale from killing a long-but-alive crawl) ─────
# Interval between heartbeat refreshes. Must stay well below
# ``_HEARTBEAT_STALE_SECONDS`` so a healthy crawl re-stamps several times inside
# one staleness window even if a poll or two is delayed.
_HEARTBEAT_REFRESH_INTERVAL = 30


def refresh_crawl_heartbeat(client_id: int) -> None:
    """Re-stamp ``heartbeat_at`` on the client's in-flight ``running`` row.

    Provider-agnostic replacement for the retired subprocess mirror: the
    orchestrator drives this from a live coroutine (see :func:`crawl_heartbeat`)
    throughout BOTH the crawl and the batch-embedding phases, neither of which
    otherwise writes progress. Because the ticks come from the live worker, a
    genuinely dead worker stops emitting and ``_reap_if_stale`` still fires —
    only a slow-but-alive job is spared. Touches nothing but the timestamp, and
    only for ``running`` rows. No-op when no row exists or Redis is unreachable.
    """
    import time as _time

    client = get_redis()
    if client is None:
        local = _local_progress.get(int(client_id))
        if local and local.get("status") == "running":
            local["heartbeat_at"] = _time.time()
        return
    try:
        raw = client.get(_progress_key(client_id))
        if raw is None:
            return
        data = json.loads(raw)
        if data.get("status") != "running":
            return
        data["heartbeat_at"] = _time.time()
        client.set(_progress_key(client_id), json.dumps(data, default=str), ex=_PROGRESS_TTL)
    except Exception:
        logger.debug("refresh_crawl_heartbeat failed for client=%s", client_id, exc_info=True)


@contextlib.asynccontextmanager
async def crawl_heartbeat(client_id: int, *, interval: int = _HEARTBEAT_REFRESH_INTERVAL):
    """Keep the crawl's Redis heartbeat fresh for the duration of the block.

    Spawns a background task that re-stamps ``heartbeat_at`` every ``interval``
    seconds while the wrapped pipeline runs — covering long phases with no
    natural per-item checkpoint (a single blocking Spider ``/crawl`` call, the
    batch-embedding loop). The task is bound to the caller's coroutine, so if the
    worker process dies the ticks stop and ``_reap_if_stale`` still catches it.
    """

    async def _loop() -> None:
        while True:
            await asyncio.sleep(interval)
            refresh_crawl_heartbeat(client_id)

    task = asyncio.create_task(_loop())
    try:
        yield
    finally:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task


# ── Cancellation flag (Redis + in-process fallback) ────────────────────────
# The crawl provider (Spider / Jina) polls ``is_cancellation_requested`` between
# pages and stops cleanly. The flag self-expires (``_CANCEL_TTL``) so a crashed
# orchestrator can't leave a stale flag that would instantly cancel the *next* crawl.


def request_cancellation(client_id: int) -> None:
    """Mark the client's in-flight crawl for cancellation. Best-effort."""
    client = get_redis()
    if client is None:
        _local_cancels.add(int(client_id))
        return
    try:
        client.set(_cancel_key(client_id), "1", ex=_CANCEL_TTL)
    except Exception:
        logger.debug("request_cancellation failed for client=%s", client_id, exc_info=True)
        _local_cancels.add(int(client_id))


def is_cancellation_requested(client_id: int) -> bool:
    """Return True iff a cancel was requested for the client's current crawl."""
    client = get_redis()
    if client is None:
        return int(client_id) in _local_cancels
    try:
        return client.get(_cancel_key(client_id)) is not None
    except Exception:
        return int(client_id) in _local_cancels


def clear_cancellation(client_id: int) -> None:
    """Drop the cancel flag (call at the start of a new crawl). Best-effort."""
    client = get_redis()
    if client is None:
        _local_cancels.discard(int(client_id))
        return
    with contextlib.suppress(Exception):
        client.delete(_cancel_key(client_id))


def clear_crawl_progress(client_id: int) -> None:
    """Drop the progress key (e.g. when starting a new crawl). Best-effort."""
    client = get_redis()
    if client is None:
        _local_progress.pop(int(client_id), None)
        return
    with contextlib.suppress(Exception):
        client.delete(_progress_key(client_id))


def acquire_crawl_lock(client_id: int, ttl: int = _DEFAULT_LOCK_TTL) -> bool:
    """Try to take the per-client crawl lock. Returns True iff acquired.

    Uses Redis ``SET NX EX`` so the lock survives across processes (API and
    worker can both check it) and self-expires if the holder crashes. Falls
    back to an in-process set when Redis is unavailable so single-worker dev
    still gets per-client serialization.
    """
    client = get_redis()
    if client is None:
        cid = int(client_id)
        if cid in _local_locks:
            return False
        _local_locks.add(cid)
        return True
    try:
        return bool(client.set(_lock_key(client_id), "1", nx=True, ex=ttl))
    except Exception:
        logger.debug("acquire_crawl_lock failed for client=%s", client_id, exc_info=True)
        return True


def release_crawl_lock(client_id: int) -> None:
    """Release the per-client crawl lock. Best-effort and idempotent."""
    client = get_redis()
    if client is None:
        _local_locks.discard(int(client_id))
        return
    with contextlib.suppress(Exception):
        client.delete(_lock_key(client_id))


class CrawlerError(RuntimeError):
    """Raised when the crawl provider fails or produces invalid output."""


class CrawlCancelled(RuntimeError):
    """Raised when the crawl was cancelled by the user.

    Distinct from :class:`CrawlerError` so the orchestrator can write a
    ``cancelled`` terminal status (vs ``failed``) and skip the error toast in
    the UI. Carries the partial result so any pages already crawled before the
    cancel landed are still ingested. (We never throw away crawled work.)
    """

    def __init__(self, partial_result: dict | None = None) -> None:
        super().__init__("Crawl cancelled by user")
        self.partial_result = partial_result or {"results": [], "recommended_colors": []}


def _reap_if_stale(client_id: int, data: dict[str, Any]) -> dict[str, Any]:
    """Synthesise a terminal payload when a non-terminal row's heartbeat is stale.

    A worker that gets SIGKILL'd (or times out) mid-crawl never runs the
    orchestrator's ``except`` blocks, so the Redis row stays at
    ``status='running'`` *or* ``status='cancelling'`` until the 1-hour TTL
    fires. We detect this on the read path: any non-terminal row whose
    ``heartbeat_at`` is older than :data:`_HEARTBEAT_STALE_SECONDS` is
    treated as dead. The terminal state is written BACK to Redis so every
    subsequent read is consistent and so the per-client crawl lock — which
    keys off "is anything running?" upstream of this — gets released.

    Reap mapping:
      * ``running``    → ``failed`` ("worker died")
      * ``cancelling`` → ``cancelled`` ("cancel honoured")

    The ``cancelling`` case matters because the cancel endpoint writes
    ``cancelling`` directly to Redis the moment the user clicks Stop. If
    the orchestrator dies before it can transition to ``cancelled``, the
    UI would otherwise show "Stopping..." until the Redis key expires
    (1 hour later). Treating ``cancelling`` as a reapable state collapses
    that window to ``_HEARTBEAT_STALE_SECONDS``.
    """
    import time as _time

    status = data.get("status")
    if status not in ("running", "cancelling"):
        return data
    heartbeat = data.get("heartbeat_at")
    if heartbeat is None:
        # Legacy row written before heartbeats were added — fall back to
        # ``started_at`` if present so existing in-flight crawls still benefit
        # from the reaper without a redeploy gap.
        heartbeat = data.get("started_at")
    # Anchorless non-terminal row — only possible from pre-heartbeat code
    # or from a writer that crashed before stamping anything. Both mean
    # it isn't live; reap immediately rather than wait for the 1-hour TTL.
    age = float(_HEARTBEAT_STALE_SECONDS + 1) if heartbeat is None else _time.time() - float(heartbeat)
    if age < _HEARTBEAT_STALE_SECONDS:
        return data

    if status == "cancelling":
        # The user clicked Stop; the orchestrator never got to confirm it.
        # Honour the user's intent and surface a clean ``cancelled`` state.
        logger.warning(
            "crawl for client %s stuck in cancelling (heartbeat %ss ago); reporting as cancelled",
            client_id,
            int(age),
        )
        set_crawl_progress(
            client_id,
            status="cancelled",
            urls=data.get("urls") or [],
        )
        terminal_status = "cancelled"
        terminal_error: str | None = None
    else:
        logger.warning(
            "crawl progress for client %s is stale (heartbeat %ss ago); reporting as failed",
            client_id,
            int(age),
        )
        terminal_error = "Crawl did not complete — the worker process appears to have died. Please try again."
        set_crawl_progress(
            client_id,
            status="failed",
            urls=data.get("urls") or [],
            error=terminal_error,
        )
        terminal_status = "failed"

    # Drop the per-client lock too — whatever held it is gone. Without this,
    # the next ``POST /crawl`` would 429 against the live lock for an hour
    # while the customer wonders what's broken.
    with contextlib.suppress(Exception):
        release_crawl_lock(client_id)
    # Mirror what we just wrote so the caller sees the same shape without
    # a second Redis round-trip.
    reaped_payload: dict[str, Any] = {
        "status": terminal_status,
        "urls": data.get("urls") or [],
        "reaped": True,
    }
    if terminal_error is not None:
        reaped_payload["error"] = terminal_error
    return reaped_payload


def get_crawl_progress(client_id: int) -> dict[str, Any]:
    """Return the current crawl progress + terminal status for a client.

    Reads the Redis-backed state written by ``crawl_website`` (URL discovery)
    and by the orchestrating task (final ``done``/``failed`` status). Always
    returns a dict; callers can rely on ``status`` and ``urls`` keys at minimum.
    Returns ``{"status": "idle", "urls": []}`` when no crawl has been recorded
    yet (or Redis is unavailable).

    Detects ghost ``running`` rows whose heartbeat is older than
    :data:`_HEARTBEAT_STALE_SECONDS` and rewrites them as ``failed`` —
    necessary because a SIGKILL of the worker process skips the orchestrator's
    own failure handlers, leaving Redis stuck at ``running`` until its
    1-hour TTL. See :func:`_reap_if_stale`.
    """
    client = get_redis()
    if client is None:
        local = _local_progress.get(int(client_id))
        return dict(local) if local else {"status": "idle", "urls": []}
    try:
        raw = client.get(_progress_key(client_id))
    except Exception:
        local = _local_progress.get(int(client_id))
        return dict(local) if local else {"status": "idle", "urls": []}
    if raw is None:
        return {"status": "idle", "urls": []}
    try:
        data = json.loads(raw)
    except Exception:
        return {"status": "idle", "urls": []}
    data.setdefault("status", "idle")
    data.setdefault("urls", [])
    return _reap_if_stale(client_id, data)
