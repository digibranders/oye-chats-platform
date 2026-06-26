import asyncio
import contextlib
import ctypes
import json
import logging
import os
import signal
import sys
import tempfile
import time
from typing import Any

from app.core.cache import PREFIX, get_redis

logger = logging.getLogger(__name__)

# Maximum wall-clock time for the crawler subprocess (~27 minutes).
# Bumped 600s → 900s → 1600s so heavyweight CMS crawls (1000+ HTTP pages or
# 100+ JS pages) actually fit inside one ARQ job. 1600s is comfortably under
# the 30-minute UX cliff where customers assume the crawl is broken, and
# leaves margin below the 3540s hard ceiling imposed by ``_PROGRESS_TTL``.
_SUBPROCESS_TIMEOUT = int(os.getenv("CRAWL_SUBPROCESS_TIMEOUT", "1600"))

# Time to wait between SIGTERM and SIGKILL when tearing down a stuck crawler.
_SUBPROCESS_KILL_GRACE = 5

# Linux prctl(2) constants. PR_SET_PDEATHSIG asks the kernel to deliver `sig`
# to this process when its parent dies, so an orphaned crawler subprocess gets
# torn down automatically if the gunicorn worker is killed mid-crawl.
_PR_SET_PDEATHSIG = 1

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
_DEFAULT_LOCK_TTL = _SUBPROCESS_TIMEOUT + 120  # subprocess + ingestion margin
_PROGRESS_MIRROR_INTERVAL = 1.0  # seconds between temp-file → Redis mirror ticks
_CANCEL_POLL_INTERVAL = 0.5  # seconds between cancel-flag checks while crawl runs (snappier UX; cheap on Redis)
# Tight enough that the user perceives Cancel as snappy (Playwright pages can
# be stuck mid-``goto`` for many seconds without ever reaching our cooperative
# checkpoint — SIGTERM-via-process-group is the only reliable way out). Loose
# enough that a normal page-load can finish writing its result and exit
# cleanly without truncating the URL list.
_COOPERATIVE_CANCEL_GRACE = 0.3

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


# A "running" progress row is considered dead if its heartbeat falls more
# than this many seconds behind wall-clock. The mirror task below stamps an
# UNCONDITIONAL heartbeat every ``_PROGRESS_MIRROR_INTERVAL`` seconds — even
# when the URL list is unchanged — so a healthy crawl that's mid-batch on a
# slow site never trips the reaper. 240s gives realistic margin for: a fully
# JS-mode batch on a heavyweight CMS (3-5 pages × 30s page timeout = up to
# 150s of zero new URLs), plus head-of-line waits in ``asyncio.gather`` on
# the HTTP path, plus the brand-tone / company-context LLM extraction that
# runs synchronously after Phase 2. A SIGKILL'd worker is still reaped within
# 4 minutes of the next ``GET /crawl/progress`` instead of waiting out the
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


def _touch_heartbeat(client_id: int) -> None:
    """Re-stamp ``heartbeat_at`` on the in-flight progress row without changing
    any other field.

    Used by the progress mirror's idle tick so a slow batch (no new URLs for
    60-150s while ``asyncio.gather`` waits for the slowest page) doesn't trip
    the read-side staleness reaper. No-op when no row exists yet, when the
    row isn't ``running``, or when Redis is unreachable.
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
        logger.debug("_touch_heartbeat failed for client=%s", client_id, exc_info=True)


# ── Cancellation flag (Redis + in-process fallback) ────────────────────────
# Two-tier cancellation:
#   1. Cooperative: the crawler subprocess polls a temp ``cancel-file`` between
#      URLs and exits cleanly (fast, no leaked Playwright/Chromium).
#   2. Forceful: ``crawl_website`` polls this Redis flag every second; when set
#      it touches the cancel-file, waits a few seconds for graceful exit, then
#      SIGTERMs the process tree as the hard fallback.
# The flag self-expires (``_CANCEL_TTL``) so a crashed orchestrator can't leave
# a stale flag that would instantly cancel the *next* crawl.


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


def _read_urls_from_progress_file(path: str) -> list[str]:
    """Re-read the subprocess progress temp file. Empty list on any error."""
    if not os.path.exists(path):
        return []
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        urls = data.get("urls", [])
        return urls if isinstance(urls, list) else []
    except Exception:
        return []


async def _mirror_progress_to_redis(
    client_id: int,
    progress_path: str,
    started_at: float,
    *,
    max_pages: int | None = None,
) -> None:
    """Poll the subprocess progress file and mirror discovered URLs to Redis.

    Runs as a background task for the duration of one crawl. Cancelled by
    ``crawl_website`` once the subprocess finishes (or is torn down). Writes
    ``pages_crawled`` / ``max_pages`` / ``current_url`` so the UI can render a
    real progress bar and ETA.

    Heartbeat policy: the URL list write happens only when the count changes
    (keeps Redis traffic minimal), but a *heartbeat-only* refresh happens on
    every tick. This decoupling matters: the subprocess writes its progress
    file once per batch (``asyncio.gather``), not once per page, so a healthy
    crawl can legitimately go 60-150s without new URLs while a fat batch of
    Knowledge Hub pages is in flight. Without the unconditional heartbeat,
    the read-side reaper at ``_HEARTBEAT_STALE_SECONDS`` would fire while
    the subprocess is still doing real work and incorrectly report failure.
    """
    last_count = -1
    try:
        while True:
            await asyncio.sleep(_PROGRESS_MIRROR_INTERVAL)
            urls = _read_urls_from_progress_file(progress_path)
            if len(urls) != last_count:
                set_crawl_progress(
                    client_id,
                    status="running",
                    urls=urls,
                    started_at=started_at,
                    pages_crawled=len(urls),
                    max_pages=max_pages,
                    current_url=urls[-1] if urls else None,
                    cancellable=True,
                )
                last_count = len(urls)
            else:
                # Heartbeat-only refresh: the URL list didn't change but the
                # subprocess is still alive (we're polling its tempfile).
                # Re-stamping ``heartbeat_at`` keeps ``_reap_if_stale`` from
                # tripping during slow batches. Cheap — one Redis SET with the
                # same payload plus a fresh timestamp.
                _touch_heartbeat(client_id)
    except asyncio.CancelledError:
        # Final flush so the freshest URL list is always visible after the
        # subprocess exits, even if the last mirror tick was skipped.
        urls = _read_urls_from_progress_file(progress_path)
        if urls and len(urls) != last_count:
            set_crawl_progress(
                client_id,
                status="running",
                urls=urls,
                started_at=started_at,
                pages_crawled=len(urls),
                max_pages=max_pages,
                current_url=urls[-1] if urls else None,
                cancellable=True,
            )
        raise


async def _watch_for_cancellation(
    client_id: int,
    cancel_file_path: str,
    process: "asyncio.subprocess.Process | None",
) -> bool:
    """Poll the Redis cancel flag and tear down the crawl when set.

    Returns ``True`` once cancellation has been honoured (cooperative file
    touched + subprocess given a grace period + SIGTERM as fallback). Returns
    only when cancelled or cancelled itself by the parent. Runs as a background
    task for the lifetime of one crawl.

    Tier 1 — cooperative: touch the cancel-file so ``crawler_script.py`` sees
    it between URLs and exits cleanly (no leaked Playwright/Chromium).
    Tier 2 — forceful: if the subprocess hasn't exited within
    ``_COOPERATIVE_CANCEL_GRACE`` seconds, send SIGTERM/SIGKILL via
    ``_terminate_process_tree``.
    """
    try:
        while True:
            await asyncio.sleep(_CANCEL_POLL_INTERVAL)
            if not is_cancellation_requested(client_id):
                continue

            logger.info("Cancellation requested for client %s — initiating graceful shutdown", client_id)
            # Tier 1: signal the subprocess cooperatively.
            with contextlib.suppress(OSError), open(cancel_file_path, "w", encoding="utf-8") as f:
                f.write("1")

            # Tier 2: wait briefly, then SIGTERM if still alive.
            if process is not None:
                with contextlib.suppress(TimeoutError):
                    await asyncio.wait_for(process.wait(), timeout=_COOPERATIVE_CANCEL_GRACE)
                if process.returncode is None:
                    logger.info(
                        "Subprocess did not honour cooperative cancel within %ss — sending SIGTERM",
                        _COOPERATIVE_CANCEL_GRACE,
                    )
                    await _terminate_process_tree(process)
            return True
    except asyncio.CancelledError:
        raise


def _set_pdeathsig() -> None:
    """preexec_fn that wires the crawler subprocess to die with its parent.

    Runs in the forked child between fork() and execve(). On Linux, asks the
    kernel for SIGTERM when the parent (gunicorn worker) exits. No-op on any
    other platform; failure to load libc is tolerated so the crawl still runs.
    """
    if sys.platform != "linux":
        return
    try:
        libc = ctypes.CDLL("libc.so.6", use_errno=True)
        libc.prctl(_PR_SET_PDEATHSIG, signal.SIGTERM, 0, 0, 0)
    except OSError:
        pass


async def _terminate_process_tree(process: asyncio.subprocess.Process) -> None:
    """Kill the crawler subprocess and any descendants (Playwright + Chromium).

    Sends SIGTERM to the whole process group, waits up to
    ``_SUBPROCESS_KILL_GRACE`` seconds for clean exit, then SIGKILLs the group.
    Tolerates already-dead processes. Never raises.
    """
    if process.returncode is not None:
        return

    pid = process.pid
    pgid: int | None = None
    with contextlib.suppress(ProcessLookupError, PermissionError, OSError):
        pgid = os.getpgid(pid)

    def _signal_group(sig: int) -> None:
        if pgid is not None:
            with contextlib.suppress(ProcessLookupError, PermissionError, OSError):
                os.killpg(pgid, sig)
        else:
            with contextlib.suppress(ProcessLookupError):
                process.send_signal(sig)

    _signal_group(signal.SIGTERM)
    try:
        await asyncio.wait_for(process.wait(), timeout=_SUBPROCESS_KILL_GRACE)
        return
    except TimeoutError:
        pass

    _signal_group(signal.SIGKILL)
    with contextlib.suppress(Exception):
        await process.wait()


class CrawlerError(RuntimeError):
    """Raised when the crawler subprocess fails or produces invalid output."""


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


async def crawl_website(
    url: str,
    max_pages: int | None = None,
    use_js: bool = False,
    client_id: int | None = None,
    *,
    max_depth: int | None = None,
    concurrency: int | None = None,
) -> dict:
    """Run the crawler subprocess and return parsed results.

    The crawler runs as a separate Python process to isolate Playwright's
    event loop from FastAPI's asyncio loop (required on all platforms, not
    just Windows).  Uses ``asyncio.create_subprocess_exec`` so the event
    loop is never blocked while waiting for the subprocess.

    Args:
        url: The seed URL to crawl.
        max_pages: Plan-aware page ceiling (already clamped by the route
            layer to the client's tier — for JS crawls the route layer takes
            ``min(max_crawl_pages, max_crawl_js_pages)`` before forwarding).
            When *None*, the subprocess falls back to the ``MAX_CRAWL_PAGES``
            env default. The historical hardcoded clamp to 100 was removed
            when plan-tiered limits landed — the route layer now owns clamping.
        use_js: When True, forces JavaScript (browser/Playwright) mode for
            all pages. Required for Next.js, React, and other SPAs where
            content or links are rendered client-side. The crawler also
            auto-detects SPAs from the seed page HTML, so this flag is
            mainly for explicit override.
        client_id: When provided, real-time progress is written to a temp
            file so the ``/crawl/progress`` endpoint can stream discovered
            URLs to the frontend while the crawl is running.
        max_depth: Plan-aware BFS depth ceiling. ``None`` = let the
            subprocess fall back to its ``MAX_CRAWL_DEPTH`` env default.
        concurrency: Plan-aware count of parallel HTTP fetches the
            subprocess will run. ``None`` = subprocess env default.

    Returns:
        A dict with ``results`` (list of page dicts) and
        ``recommended_colors`` (list of hex strings).

    Raises:
        CrawlerError: On subprocess failure, timeout, or unparseable output.
    """
    logger.info("Starting subprocess crawl for %s (max_pages=%s, use_js=%s)", url, max_pages, use_js)

    script_path = os.path.join(os.path.dirname(__file__), "crawler_script.py")

    # Build a minimal env for the subprocess.  The old code copied **all**
    # parent env vars (including DB_URL, OPENAI_API_KEY, STRIPE_SECRET_KEY,
    # etc.).  If a malicious website exploited the Playwright browser, those
    # secrets would be accessible.  We now whitelist only what the crawler
    # script actually reads plus the minimum required for Python/Playwright.
    _SAFE_ENV_KEYS = {
        # System essentials for Python / Playwright / OS
        "PATH",
        "HOME",
        "USER",
        "LANG",
        "LC_ALL",
        "LC_CTYPE",
        "TMPDIR",
        "TEMP",
        "TMP",
        "SHELL",
        "PYTHONPATH",
        "PYTHONHASHSEED",
        "VIRTUAL_ENV",
        "CONDA_PREFIX",
        "CONDA_DEFAULT_ENV",
        "CONDA_EXE",
        # ─────────────────────────────────────────────────────────────────
        # Windows-only essentials. DO NOT REMOVE — without these the
        # subprocess literally cannot ``import asyncio`` on Windows because
        # asyncio.windows_events imports _overlapped which calls Winsock,
        # and Winsock requires SYSTEMROOT/WINDIR to locate Win32 DLLs.
        # ``Path.home()`` (used by crawl4ai on import) needs USERPROFILE.
        # Playwright / Chromium need LOCALAPPDATA + APPDATA for cache and
        # user-data dirs. PATHEXT/COMSPEC are needed by Windows process
        # launching. These keys are absent on Linux (production) so the
        # filter discards them automatically there — purely additive.
        # ─────────────────────────────────────────────────────────────────
        "USERPROFILE",
        "LOCALAPPDATA",
        "APPDATA",
        "SYSTEMROOT",
        "WINDIR",
        "PATHEXT",
        "COMSPEC",
        # Playwright needs these
        "PLAYWRIGHT_BROWSERS_PATH",
        "DISPLAY",
        "XDG_RUNTIME_DIR",
        # Crawler-specific settings
        "MAX_CRAWL_PAGES",
        "CRAWL_CONCURRENCY",
        "CRAWL_PAGE_TIMEOUT",
        "MAX_CRAWL_DEPTH",
        "CRAWLER_JS_ALL_PAGES",
        "CRAWLER_BROWSER_RECYCLE",
    }
    env = {k: v for k, v in os.environ.items() if k in _SAFE_ENV_KEYS}
    if max_pages is not None:
        # No hardcoded ceiling — the route layer clamps ``max_pages`` to the
        # caller's plan tier (including the JS-specific cap when use_js is
        # true) before we ever get here. Anything that reaches this branch
        # is already tier-bounded; clamping again would silently truncate
        # Enterprise crawls.
        env["MAX_CRAWL_PAGES"] = str(max(int(max_pages), 1))
    elif use_js:
        # Direct caller didn't supply max_pages and asked for JS — fall back
        # to the legacy env default. Production callers always go through
        # document_routes which sets max_pages explicitly.
        env["MAX_CRAWL_PAGES"] = os.getenv("MAX_CRAWL_PAGES_JS", "25")
    if use_js:
        env["CRAWLER_JS_ALL_PAGES"] = "true"

    # Plan-aware depth & concurrency — only emit when the caller provided a
    # value, otherwise the subprocess keeps using its env-driven defaults.
    if max_depth is not None:
        env["MAX_CRAWL_DEPTH"] = str(max(int(max_depth), 1))
    if concurrency is not None:
        env["CRAWL_CONCURRENCY"] = str(max(int(concurrency), 1))

    # Create temp files for the subprocess to write to / read from:
    #   progress_path — subprocess writes discovered URLs (we mirror to Redis)
    #   cancel_path   — we ``touch`` this file to ask the subprocess to stop
    #                   cooperatively between URLs (Tier 1 cancel)
    progress_fd, progress_path = tempfile.mkstemp(suffix=".json", prefix="oyecrawl_")
    os.close(progress_fd)
    cancel_fd, cancel_path = tempfile.mkstemp(suffix=".cancel", prefix="oyecrawl_")
    os.close(cancel_fd)
    # The mkstemp creates the cancel file, but the subprocess uses its mere
    # existence + non-empty content as the cancel signal. Remove it now so an
    # uncancelled run won't be falsely interpreted as cancelled.
    with contextlib.suppress(OSError):
        os.unlink(cancel_path)
    started_at = time.time()
    # Resolve effective max_pages for the progress payload (mirrors what the
    # subprocess will use). Keeps the UI's progress bar honest from the first
    # tick instead of waiting for the subprocess to write its first URL.
    # Mirrors the value the subprocess will actually use, so the UI's
    # progress bar denominator matches the runtime cap. The hardcoded clamp
    # to 100 was removed when plan-aware limits landed — see the env block
    # above for the new clamping contract.
    _effective_max_pages: int | None = None
    if max_pages is not None:
        _effective_max_pages = max(int(max_pages), 1)
    else:
        try:
            _effective_max_pages = int(env.get("MAX_CRAWL_PAGES", os.getenv("MAX_CRAWL_PAGES", "50")))
        except (TypeError, ValueError):
            _effective_max_pages = 50

    if client_id is not None:
        # Reset any stale terminal state from a previous crawl by this client,
        # and clear any leftover cancel flag before the new run — without this
        # the very next crawl would be instantly cancelled.
        clear_crawl_progress(client_id)
        clear_cancellation(client_id)
        set_crawl_progress(
            client_id,
            status="running",
            urls=[],
            started_at=started_at,
            pages_crawled=0,
            max_pages=_effective_max_pages,
            phase="starting",
            cancellable=True,
        )

    process: asyncio.subprocess.Process | None = None
    mirror_task: asyncio.Task[None] | None = None
    cancel_watcher_task: asyncio.Task[bool] | None = None
    try:
        # ── Platform branch ─────────────────────────────────────────────────
        # Linux/macOS: native asyncio subprocess + process-group teardown.
        # Windows: ``preexec_fn`` raises ValueError on Windows ("preexec_fn
        # is not supported on Windows platforms") AND uvicorn's default
        # SelectorEventLoop on Windows raises NotImplementedError on
        # asyncio.create_subprocess_exec. Both blockers force a
        # subprocess.run path on Windows. Trade-off: no in-flight
        # process-tree teardown on Windows, which is acceptable because
        # Windows is a dev-only target — production runs Linux.
        # DO NOT REMOVE this branch: every reverter "tidy-up" of it has
        # immediately broken local crawls on Windows.
        if sys.platform == "win32":
            import subprocess as _subprocess

            if client_id is not None:
                mirror_task = asyncio.create_task(
                    _mirror_progress_to_redis(client_id, progress_path, started_at, max_pages=_effective_max_pages)
                )
                cancel_watcher_task = asyncio.create_task(_watch_for_cancellation(client_id, cancel_path, None))
            try:
                completed = await asyncio.to_thread(
                    _subprocess.run,
                    [
                        sys.executable,
                        script_path,
                        url,
                        "--progress-file",
                        progress_path,
                        "--cancel-file",
                        cancel_path,
                    ],
                    capture_output=True,
                    env=env,
                    timeout=_SUBPROCESS_TIMEOUT,
                    check=False,
                )
            except _subprocess.TimeoutExpired as e:
                msg = f"Crawler subprocess timed out after {_SUBPROCESS_TIMEOUT}s for {url}"
                logger.error(msg)
                raise CrawlerError(msg) from e
            stdout_bytes = completed.stdout
            stderr_bytes = completed.stderr
            returncode = completed.returncode
        else:
            # ``start_new_session`` puts the subprocess (and its Playwright /
            # Chromium descendants) in their own process group, so we can take
            # the entire tree down with one os.killpg() call. ``preexec_fn``
            # runs PR_SET_PDEATHSIG so the kernel kills the crawler if the
            # gunicorn worker dies before we get a chance to clean up.
            process = await asyncio.create_subprocess_exec(
                sys.executable,
                script_path,
                url,
                "--progress-file",
                progress_path,
                "--cancel-file",
                cancel_path,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=env,
                start_new_session=True,
                preexec_fn=_set_pdeathsig,
            )

            # Stream discovered URLs from the subprocess temp file to Redis so any
            # process (API, worker) can render live progress for this client.
            if client_id is not None:
                mirror_task = asyncio.create_task(
                    _mirror_progress_to_redis(client_id, progress_path, started_at, max_pages=_effective_max_pages)
                )
                cancel_watcher_task = asyncio.create_task(_watch_for_cancellation(client_id, cancel_path, process))

            try:
                stdout_bytes, stderr_bytes = await asyncio.wait_for(
                    process.communicate(),
                    timeout=_SUBPROCESS_TIMEOUT,
                )
            except TimeoutError as e:
                await _terminate_process_tree(process)
                msg = f"Crawler subprocess timed out after {_SUBPROCESS_TIMEOUT}s for {url}"
                logger.error(msg)
                raise CrawlerError(msg) from e
            returncode = process.returncode

        stdout = stdout_bytes.decode("utf-8", errors="replace")
        stderr = stderr_bytes.decode("utf-8", errors="replace")

        if stderr:
            logger.debug("Crawler stderr: %s", stderr)

        # Detect cancellation: either Redis flag was set (cooperative or forced),
        # or the subprocess itself wrote ``"cancelled": true`` in its JSON output.
        was_cancelled = client_id is not None and is_cancellation_requested(client_id)

        # Try to recover any partial results — cooperatively cancelled scripts
        # still print their JSON envelope. Forcefully killed scripts won't, in
        # which case we fall back to whatever URLs the mirror task captured.
        def _parse_payload(raw: str) -> dict | None:
            try:
                if "---CRAWLER_JSON_OUTPUT---" in raw:
                    return json.loads(raw.split("---CRAWLER_JSON_OUTPUT---")[1].strip())
                return json.loads(raw)
            except (json.JSONDecodeError, IndexError):
                return None

        parsed = _parse_payload(stdout)
        if parsed and parsed.get("cancelled"):
            was_cancelled = True

        if was_cancelled:
            partial = parsed if parsed and isinstance(parsed.get("results"), list) else None
            if partial is None:
                # Fall back to URLs we already mirrored — at minimum the UI gets
                # an accurate "X pages crawled before cancel" count.
                mirrored_urls = _read_urls_from_progress_file(progress_path)
                partial = {
                    "results": [{"url": u, "content": ""} for u in mirrored_urls],
                    "recommended_colors": [],
                }
            raise CrawlCancelled(partial_result=partial)

        if returncode != 0:
            msg = f"Crawler process failed with code {returncode}. Stderr: {stderr}"
            logger.error(msg)
            raise CrawlerError(msg)

        # Parse the JSON output (crawl4ai logs also go to stdout, so
        # our JSON is delimited by ---CRAWLER_JSON_OUTPUT---)
        if parsed is None:
            msg = f"Failed to parse crawler output. Raw output length: {len(stdout)}"
            logger.error(msg)
            raise CrawlerError(msg)
        if "error" in parsed:
            msg = f"Crawler script reported error: {parsed['error']}"
            logger.error(msg)
            raise CrawlerError(msg)
        return parsed

    except (CrawlCancelled, CrawlerError):
        # CrawlCancelled MUST re-raise above the broad ``except Exception``
        # below — otherwise our own user-cancel sentinel gets caught and
        # re-wrapped as a generic CrawlerError, and the orchestrator marks
        # the run "failed" instead of "cancelled".
        raise
    except (asyncio.CancelledError, KeyboardInterrupt):
        # Propagate the cancellation, but only after taking the subprocess
        # tree down so we never leak Playwright/Chromium when the parent
        # request is cancelled or the worker is shutting down.
        if process is not None:
            await _terminate_process_tree(process)
        raise
    except Exception as e:
        logger.error("Subprocess exception: %s", e)
        raise CrawlerError(str(e)) from e
    finally:
        # Always clean up: stop mirroring, stop the cancel watcher, kill the
        # subprocess tree if it's somehow still alive, and remove the temp
        # files. The Redis status (``done`` / ``failed`` / ``cancelled``) is
        # the caller's responsibility — we leave any in-progress ``running``
        # state for them to overwrite, since we don't know whether ingestion
        # still has to run after the crawl returns.
        if mirror_task is not None and not mirror_task.done():
            mirror_task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await mirror_task
        if cancel_watcher_task is not None and not cancel_watcher_task.done():
            cancel_watcher_task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await cancel_watcher_task
        if process is not None:
            await _terminate_process_tree(process)
        with contextlib.suppress(OSError):
            os.unlink(progress_path)
        with contextlib.suppress(OSError):
            os.unlink(cancel_path)
        # Clear the cancel flag so the *next* crawl by this client isn't
        # instantly cancelled by leftover state. Done after the subprocess
        # has fully exited so the watcher couldn't fire again.
        if client_id is not None:
            clear_cancellation(client_id)
