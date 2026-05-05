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

# Maximum wall-clock time for the crawler subprocess (10 minutes)
_SUBPROCESS_TIMEOUT = int(os.getenv("CRAWL_SUBPROCESS_TIMEOUT", "600"))

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
_PROGRESS_TTL = 3600  # keep terminal state visible to the UI for an hour
_DEFAULT_LOCK_TTL = _SUBPROCESS_TIMEOUT + 120  # subprocess + ingestion margin
_PROGRESS_MIRROR_INTERVAL = 1.0  # seconds between temp-file → Redis mirror ticks

# In-process fallback for single-worker dev (no Redis). Without these the
# entire progress + lock subsystem is a no-op locally — the UI polls forever
# on "idle" while the BackgroundTask runs and silently completes/fails out
# of view. DO NOT REMOVE: every "tidy-up" of these dicts has immediately
# broken the local crawl flow because Redis is genuinely unavailable on the
# Windows dev box. Production runs Redis + multiple workers and never reads
# these.
_local_progress: dict[int, dict[str, Any]] = {}
_local_locks: set[int] = set()


def _progress_key(client_id: int) -> str:
    return f"{_PROGRESS_KEY_PREFIX}{int(client_id)}"


def _lock_key(client_id: int) -> str:
    return f"{_LOCK_KEY_PREFIX}{int(client_id)}"


def set_crawl_progress(
    client_id: int,
    *,
    status: str,
    urls: list[str] | None = None,
    result: dict[str, Any] | None = None,
    error: str | None = None,
    started_at: float | None = None,
) -> None:
    """Write the current crawl progress for a client (Redis + in-process fallback)."""
    payload: dict[str, Any] = {"status": status, "urls": urls or []}
    if result is not None:
        payload["result"] = result
    if error is not None:
        payload["error"] = error
    if started_at is not None:
        payload["started_at"] = started_at

    client = get_redis()
    if client is None:
        _local_progress[int(client_id)] = payload
        return
    try:
        client.set(_progress_key(client_id), json.dumps(payload, default=str), ex=_PROGRESS_TTL)
    except Exception:
        logger.debug("set_crawl_progress failed for client=%s", client_id, exc_info=True)
        _local_progress[int(client_id)] = payload


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


async def _mirror_progress_to_redis(client_id: int, progress_path: str, started_at: float) -> None:
    """Poll the subprocess progress file and mirror discovered URLs to Redis.

    Runs as a background task for the duration of one crawl. Cancelled by
    ``crawl_website`` once the subprocess finishes (or is torn down). Writes
    only when the URL list changes to keep Redis traffic minimal.
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
                )
                last_count = len(urls)
    except asyncio.CancelledError:
        # Final flush so the freshest URL list is always visible after the
        # subprocess exits, even if the last mirror tick was skipped.
        urls = _read_urls_from_progress_file(progress_path)
        if urls and len(urls) != last_count:
            set_crawl_progress(client_id, status="running", urls=urls, started_at=started_at)
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


def get_crawl_progress(client_id: int) -> dict[str, Any]:
    """Return the current crawl progress + terminal status for a client.

    Reads the Redis-backed state written by ``crawl_website`` (URL discovery)
    and by the orchestrating task (final ``done``/``failed`` status). Always
    returns a dict; callers can rely on ``status`` and ``urls`` keys at minimum.
    Returns ``{"status": "idle", "urls": []}`` when no crawl has been recorded
    yet (or Redis is unavailable).
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
    return data


async def crawl_website(
    url: str, max_pages: int | None = None, use_js: bool = False, client_id: int | None = None
) -> dict:
    """Run the crawler subprocess and return parsed results.

    The crawler runs as a separate Python process to isolate Playwright's
    event loop from FastAPI's asyncio loop (required on all platforms, not
    just Windows).  Uses ``asyncio.create_subprocess_exec`` so the event
    loop is never blocked while waiting for the subprocess.

    Args:
        url: The seed URL to crawl.
        max_pages: Optional page limit (capped at 100). When *None*, the
            subprocess falls back to the ``MAX_CRAWL_PAGES`` env default.
        use_js: When True, forces JavaScript (browser/Playwright) mode for
            all pages. Required for Next.js, React, and other SPAs where
            content or links are rendered client-side. The crawler also
            auto-detects SPAs from the seed page HTML, so this flag is
            mainly for explicit override.
        client_id: When provided, real-time progress is written to a temp
            file so the ``/crawl/progress`` endpoint can stream discovered
            URLs to the frontend while the crawl is running.

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
        env["MAX_CRAWL_PAGES"] = str(min(max(max_pages, 1), 100))
    elif use_js:
        # JS (Playwright/Chromium) crawls cost ~10x the memory of HTTP crawls
        # (~150–300 MB per Chromium process tree on top of the ~1 GB API
        # baseline). Cap the default tighter than the generic MAX_CRAWL_PAGES
        # to protect a memory-tight host. An explicit ``max_pages`` argument
        # always wins; this only fills in the default.
        env["MAX_CRAWL_PAGES"] = os.getenv("MAX_CRAWL_PAGES_JS", "25")
    if use_js:
        env["CRAWLER_JS_ALL_PAGES"] = "true"

    # Create a temp file for real-time progress updates from the subprocess.
    # The subprocess writes discovered URLs here; we mirror them to Redis below
    # so the API process can see live progress even when the crawl runs in the
    # ARQ worker.
    progress_fd, progress_path = tempfile.mkstemp(suffix=".json", prefix="oyecrawl_")
    os.close(progress_fd)
    started_at = time.time()
    if client_id is not None:
        # Reset any stale terminal state from a previous crawl by this client
        # before announcing the new run; the mirror task will then publish
        # discovered URLs as the subprocess writes them.
        clear_crawl_progress(client_id)
        set_crawl_progress(client_id, status="running", urls=[], started_at=started_at)

    process: asyncio.subprocess.Process | None = None
    mirror_task: asyncio.Task[None] | None = None
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
                mirror_task = asyncio.create_task(_mirror_progress_to_redis(client_id, progress_path, started_at))
            try:
                completed = await asyncio.to_thread(
                    _subprocess.run,
                    [sys.executable, script_path, url, "--progress-file", progress_path],
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
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=env,
                start_new_session=True,
                preexec_fn=_set_pdeathsig,
            )

            # Stream discovered URLs from the subprocess temp file to Redis so any
            # process (API, worker) can render live progress for this client.
            if client_id is not None:
                mirror_task = asyncio.create_task(_mirror_progress_to_redis(client_id, progress_path, started_at))

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

        if returncode != 0:
            msg = f"Crawler process failed with code {returncode}. Stderr: {stderr}"
            logger.error(msg)
            raise CrawlerError(msg)

        # Parse the JSON output (crawl4ai logs also go to stdout, so
        # our JSON is delimited by ---CRAWLER_JSON_OUTPUT---)
        try:
            if "---CRAWLER_JSON_OUTPUT---" in stdout:
                json_str = stdout.split("---CRAWLER_JSON_OUTPUT---")[1].strip()
            else:
                json_str = stdout

            data = json.loads(json_str)

            if "error" in data:
                msg = f"Crawler script reported error: {data['error']}"
                logger.error(msg)
                raise CrawlerError(msg)

            return data
        except (json.JSONDecodeError, IndexError) as e:
            msg = f"Failed to parse crawler output. Raw output length: {len(stdout)}"
            logger.error(msg)
            raise CrawlerError(msg) from e

    except CrawlerError:
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
        # Always clean up: stop mirroring, kill the subprocess tree if it's
        # somehow still alive, and remove the progress file. The Redis status
        # ("done" / "failed") is the caller's responsibility — we leave any
        # in-progress "running" state for them to overwrite, since we don't
        # know whether ingestion still has to run after the crawl returns.
        if mirror_task is not None and not mirror_task.done():
            mirror_task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await mirror_task
        if process is not None:
            await _terminate_process_tree(process)
        with contextlib.suppress(OSError):
            os.unlink(progress_path)
