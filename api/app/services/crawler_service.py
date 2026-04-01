import asyncio
import json
import logging
import os
import sys

logger = logging.getLogger(__name__)

# Maximum wall-clock time for the crawler subprocess (10 minutes)
_SUBPROCESS_TIMEOUT = int(os.getenv("CRAWL_SUBPROCESS_TIMEOUT", "600"))


class CrawlerError(RuntimeError):
    """Raised when the crawler subprocess fails or produces invalid output."""


async def crawl_website(url: str, max_pages: int | None = None) -> dict:
    """Run the crawler subprocess and return parsed results.

    The crawler runs as a separate Python process to isolate Playwright's
    event loop from FastAPI's asyncio loop (required on all platforms, not
    just Windows).  Uses ``asyncio.create_subprocess_exec`` so the event
    loop is never blocked while waiting for the subprocess.

    Args:
        url: The seed URL to crawl.
        max_pages: Optional page limit (capped at 100). When *None*, the
            subprocess falls back to the ``MAX_CRAWL_PAGES`` env default.

    Returns:
        A dict with ``results`` (list of page dicts) and
        ``recommended_colors`` (list of hex strings).

    Raises:
        CrawlerError: On subprocess failure, timeout, or unparseable output.
    """
    logger.info("Starting subprocess crawl for %s (max_pages=%s)", url, max_pages)

    script_path = os.path.join(os.path.dirname(__file__), "crawler_script.py")

    # Pass max_pages via env so the subprocess picks it up
    env = {**os.environ}
    if max_pages is not None:
        env["MAX_CRAWL_PAGES"] = str(min(max(max_pages, 1), 100))

    try:
        process = await asyncio.create_subprocess_exec(
            sys.executable,
            script_path,
            url,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
        )

        try:
            stdout_bytes, stderr_bytes = await asyncio.wait_for(
                process.communicate(),
                timeout=_SUBPROCESS_TIMEOUT,
            )
        except TimeoutError as e:
            process.kill()
            await process.wait()
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
    except Exception as e:
        logger.error("Subprocess exception: %s", e)
        raise CrawlerError(str(e)) from e
