import asyncio
import contextlib
import ctypes
import json
import logging
import os
import signal
import sys
import tempfile

logger = logging.getLogger(__name__)

# Maximum wall-clock time for the crawler subprocess (10 minutes)
_SUBPROCESS_TIMEOUT = int(os.getenv("CRAWL_SUBPROCESS_TIMEOUT", "600"))

# Time to wait between SIGTERM and SIGKILL when tearing down a stuck crawler.
_SUBPROCESS_KILL_GRACE = 5

# Linux prctl(2) constants. PR_SET_PDEATHSIG asks the kernel to deliver `sig`
# to this process when its parent dies, so an orphaned crawler subprocess gets
# torn down automatically if the gunicorn worker is killed mid-crawl.
_PR_SET_PDEATHSIG = 1


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


# Maps client_id → path of the temp progress file for an in-progress crawl.
# Written by the subprocess; read by get_crawl_progress() via the progress endpoint.
_progress_files: dict[int, str] = {}


def get_crawl_progress(client_id: int) -> list[str]:
    """Return URLs discovered so far for an in-progress crawl.

    Returns an empty list when no crawl is running or the file hasn't been
    written yet.  Safe to call at any time; never raises.
    """
    path = _progress_files.get(client_id)
    if not path or not os.path.exists(path):
        return []
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        return data.get("urls", [])
    except Exception:
        return []


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
    if use_js:
        env["CRAWLER_JS_ALL_PAGES"] = "true"

    # Create a temp file for real-time progress updates from the subprocess
    progress_fd, progress_path = tempfile.mkstemp(suffix=".json", prefix="oyecrawl_")
    os.close(progress_fd)
    if client_id is not None:
        _progress_files[client_id] = progress_path

    process: asyncio.subprocess.Process | None = None
    try:
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

        stdout = stdout_bytes.decode("utf-8", errors="replace")
        stderr = stderr_bytes.decode("utf-8", errors="replace")

        if stderr:
            logger.debug("Crawler stderr: %s", stderr)

        if process.returncode != 0:
            msg = f"Crawler process failed with code {process.returncode}. Stderr: {stderr}"
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
        # Always clean up: kill the subprocess tree if it's somehow still
        # alive, remove the progress file, and deregister the client.
        if process is not None:
            await _terminate_process_tree(process)
        if client_id is not None:
            _progress_files.pop(client_id, None)
        with contextlib.suppress(OSError):
            os.unlink(progress_path)
