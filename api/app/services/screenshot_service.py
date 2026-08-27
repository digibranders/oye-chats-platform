"""Full-page website capture for the hosted demo page.

The demo page (``GET /demo/{bot_key}``) shows the customer's OWN site with the
real widget live on top. It gets that picture from here.

Why a capture and not an iframe of the live site: roughly 40% of sites set
``X-Frame-Options`` or a CSP ``frame-ancestors`` that forbids framing (HTTP
Archive, 2024 Web Almanac: XFO on ~37% of sites, CSP on 19% of hosts with ~56%
of those setting frame-ancestors), and professionally built marketing sites,
which is exactly who buys this product, skew higher than that average. A
headless capture is subject to neither header. It is also the technique the
market leader uses: LiveChat's widget configurator renders a server-side
screenshot as an ``<img>`` and boots the real widget over it, with no iframe
anywhere in the flow.

Both providers here are already integrated for crawling, so this adds no new
vendor and no new key:

* **Jina Reader** takes ``X-Respond-With: pageshot`` for a full-page capture
  and answers with a hosted image URL, which we fetch and re-store. This is the
  default, matching ``CRAWL_PROVIDER_PRIMARY``: Reader is what already fetches
  customer pages, so it is the provider with the most history of rendering
  them.
* **Spider.cloud** exposes a dedicated ``POST /screenshot`` taking
  ``full_page``, and returns the image bytes in one hop rather than a URL to
  fetch.

Either way the bytes end up on our own CDN, so the extra hop costs capture time
and nothing at serving time: once a capture exists the demo page has no
third-party dependency at all. Order is configurable, and a capture only fails
once both providers have refused.

Capture is slow by nature (several seconds for a JavaScript-heavy homepage),
which is why every caller here runs on the worker and never on a request path.
"""

import asyncio
import base64
import binascii
import json
import logging
import secrets
from dataclasses import dataclass
from urllib.parse import urlparse

import httpx

from app.config import (
    DEMO_SCREENSHOT_MAX_BYTES,
    DEMO_SCREENSHOT_PROVIDER,
    DEMO_SCREENSHOT_TIMEOUT,
    DEMO_SCREENSHOT_WAIT_SECONDS,
    JINA_API_KEY,
    JINA_READER_URL,
    SPIDER_API_KEY,
    SPIDER_API_URL,
)
from app.core.ssrf import SSRFError, validate_public_url

logger = logging.getLogger(__name__)

# Capture viewport. 1440 is the width the demo page's browser chrome is drawn
# for; the height only seeds the viewport, since a full-page capture extends
# past it to whatever the document actually is.
CAPTURE_WIDTH = 1440
CAPTURE_HEIGHT = 900

# Magic-number prefixes for the only two formats a capture may be. Content-Type
# comes from the provider and is not evidence: a JSON error body served as
# `image/png` would otherwise be stored and then rendered as a broken image on
# the customer's demo page.
_PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
_JPEG_MAGIC = b"\xff\xd8\xff"


class ScreenshotError(RuntimeError):
    """A capture could not be produced. Carries no provider detail for callers
    to branch on: every failure has the same remedy, which is to try again
    later or leave the demo page on its fallback."""


@dataclass(frozen=True)
class Capture:
    """A captured image and the format it is in."""

    data: bytes
    content_type: str

    @property
    def extension(self) -> str:
        return "jpg" if self.content_type == "image/jpeg" else "png"


def build_screenshot_key(bot_id: int) -> str:
    """Object key for a bot's capture, carrying an unguessable token.

    Screenshots are served from the public CDN domain. A key derived only from
    the bot id would let anyone holding one public bot key (they ship in every
    embed snippet) walk the namespace and pull every customer's homepage
    capture. The token also makes each capture a new object, so a refreshed
    screenshot is never masked by a stale CDN edge copy.
    """
    return f"demo-screenshots/{bot_id}/{secrets.token_urlsafe(16)}.png"


def _sniff(data: bytes) -> str | None:
    """Return the image content type implied by the bytes, or None."""
    if data.startswith(_PNG_MAGIC):
        return "image/png"
    if data.startswith(_JPEG_MAGIC):
        return "image/jpeg"
    return None


def _as_capture(data: bytes, *, provider: str, url: str) -> Capture:
    """Validate raw provider bytes and wrap them, or raise.

    Size is checked before the magic number so a runaway render is rejected on
    the cheap test first.
    """
    if not data:
        raise ScreenshotError(f"{provider} returned an empty body for {url}")
    if len(data) > DEMO_SCREENSHOT_MAX_BYTES:
        raise ScreenshotError(f"{provider} capture of {url} is {len(data)} bytes, over the configured ceiling")
    content_type = _sniff(data)
    if content_type is None:
        raise ScreenshotError(f"{provider} returned a non-image body for {url}")
    return Capture(data=data, content_type=content_type)


def _decode_spider_body(body: bytes) -> bytes:
    """Pull image bytes out of a Spider ``/screenshot`` response body.

    Spider answers with the image directly for a single-URL request, but the
    same endpoint also has a JSON shape carrying base64 (``[{"content": ...}]``
    or ``{"content": ...}``). Handling both means a change in Spider's default
    response shape degrades to a failed capture rather than to a stored blob
    that renders as a broken image.
    """
    if _sniff(body) is not None:
        return body
    try:
        parsed = json.loads(body)
    except (ValueError, UnicodeDecodeError):
        return body  # not JSON either; let the caller's magic-number check reject it
    if isinstance(parsed, list):
        parsed = parsed[0] if parsed else {}
    if not isinstance(parsed, dict):
        return b""
    encoded = parsed.get("content") or parsed.get("screenshot") or parsed.get("data")
    if not isinstance(encoded, str):
        return b""
    try:
        return base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError):
        return b""


async def _capture_via_spider(url: str, client: httpx.AsyncClient) -> Capture:
    """Capture with Spider.cloud's dedicated ``POST /screenshot`` endpoint.

    Note that ``/screenshot`` does not accept ``return_format`` or
    ``readability``; it is a separate endpoint rather than a flag on the scrape
    call the crawler uses.
    """
    if not SPIDER_API_KEY:
        raise ScreenshotError("SPIDER_API_KEY is not configured")

    payload = {
        "url": url,
        "full_page": True,
        "request": "chrome",  # a screenshot always needs the rendered page
        "store_data": False,
        # Spider deserializes `viewport` into a fixed struct with NO optional
        # fields: omitting any one of them is a 400 ("missing field
        # `emulating_mobile`", then "missing field `is_landscape`", and so on),
        # not a defaulted value. Verified against the live endpoint. All six
        # have to be sent even though only width and height carry intent here.
        "viewport": {
            "width": CAPTURE_WIDTH,
            "height": CAPTURE_HEIGHT,
            "device_scale_factor": 1,
            "emulating_mobile": False,
            "is_landscape": True,
            "has_touch": False,
        },
    }
    headers = {"Authorization": f"Bearer {SPIDER_API_KEY}", "Content-Type": "application/json"}
    try:
        resp = await client.post(f"{SPIDER_API_URL}/screenshot", json=payload, headers=headers)
    except httpx.HTTPError as exc:
        raise ScreenshotError(f"Spider screenshot request failed for {url}: {exc}") from exc

    # A non-2xx here is about OUR call (key, quota, a malformed payload, Spider
    # down), never about the target page.
    if not (200 <= resp.status_code < 300):
        detail = resp.content[:200].decode("utf-8", "replace")
        raise ScreenshotError(f"Spider returned {resp.status_code} capturing {url}: {detail}")

    # A 2xx can still carry a per-target failure in the body, e.g.
    # ``[{"status": 504, "error": "Error getting website url."}]`` for a site
    # that would not render in time. Surfacing that status is what makes a slow
    # customer site distinguishable from a broken integration in the logs.
    upstream = _spider_upstream_error(resp.content)
    if upstream:
        raise ScreenshotError(f"Spider could not render {url}: {upstream}")
    return _as_capture(_decode_spider_body(resp.content), provider="Spider", url=url)


def _spider_upstream_error(body: bytes) -> str | None:
    """Extract a per-target error from a 2xx Spider body, if it carries one."""
    if _sniff(body) is not None:
        return None
    try:
        parsed = json.loads(body)
    except (ValueError, UnicodeDecodeError):
        return None
    if isinstance(parsed, list):
        parsed = parsed[0] if parsed else {}
    if not isinstance(parsed, dict):
        return None
    error = parsed.get("error")
    if not error:
        return None
    status = parsed.get("status")
    return f"{error} (upstream status {status})" if status else str(error)


async def _capture_via_jina(url: str, client: httpx.AsyncClient) -> Capture:
    """Capture with Jina Reader's ``pageshot`` mode.

    Reader answers with the URL of a hosted image rather than the image, so
    this costs a second round trip to pull the bytes back for storage. Storing
    them is deliberate: it keeps the demo page free of a third-party image host
    that could expire, rate-limit, or go down mid-demo.
    """
    headers = {
        # `pageshot` is the full-page variant; `screenshot` is viewport-only.
        "X-Respond-With": "pageshot",
        # Give the renderer time to finish painting before it shoots, so
        # lazily-loaded below-the-fold media lands in the capture instead of a
        # blank band. It does NOT rescue sections that reveal on scroll; see
        # DEMO_SCREENSHOT_WAIT_SECONDS for why those are a different problem.
        #
        # `x-respond-timing: media-idle` is deliberately NOT sent alongside it.
        # Lazy images mean media goes idle almost immediately, so that signal
        # fires long before the page has actually finished painting, which is
        # the failure this header exists to avoid.
        "x-timeout": str(DEMO_SCREENSHOT_WAIT_SECONDS),
        "Accept": "application/json",
    }
    if JINA_API_KEY:
        headers["Authorization"] = f"Bearer {JINA_API_KEY}"

    try:
        resp = await client.get(f"{JINA_READER_URL}/{url}", headers=headers)
    except httpx.HTTPError as exc:
        raise ScreenshotError(f"Jina pageshot request failed for {url}: {exc}") from exc
    if not (200 <= resp.status_code < 300):
        raise ScreenshotError(f"Jina returned {resp.status_code} capturing {url}")

    try:
        body = resp.json()
    except ValueError as exc:
        raise ScreenshotError(f"Jina returned a non-JSON body capturing {url}") from exc
    data = body.get("data") if isinstance(body, dict) else None
    image_url = (data or {}).get("pageshotUrl") or (data or {}).get("screenshotUrl") if isinstance(data, dict) else None
    if not isinstance(image_url, str) or not image_url:
        raise ScreenshotError(f"Jina response carried no pageshot URL for {url}")

    # Jina hands back a URL we did not choose, so it goes through the same SSRF
    # gate as any other externally-supplied fetch target.
    try:
        validate_public_url(image_url)
    except SSRFError as exc:
        raise ScreenshotError(f"Jina pageshot URL for {url} is not safe to fetch: {exc}") from exc

    try:
        image_resp = await client.get(image_url)
    except httpx.HTTPError as exc:
        raise ScreenshotError(f"Could not download Jina pageshot for {url}: {exc}") from exc
    if not (200 <= image_resp.status_code < 300):
        raise ScreenshotError(f"Jina pageshot download returned {image_resp.status_code} for {url}")
    return _as_capture(image_resp.content, provider="Jina", url=url)


async def capture_full_page(url: str) -> Capture:
    """Capture ``url`` as a full-page image, trying both providers.

    Raises :class:`ScreenshotError` when neither can render the page. The URL
    is SSRF-validated here as well as by the caller: this function is what
    hands an arbitrary address to an HTTP client, so the check belongs at the
    point of use rather than only at the point of entry.
    """
    try:
        validate_public_url(url)
    except SSRFError as exc:
        raise ScreenshotError(f"Refusing to capture {url}: {exc}") from exc

    primary = _capture_via_jina if DEMO_SCREENSHOT_PROVIDER == "jina" else _capture_via_spider
    fallback = _capture_via_spider if primary is _capture_via_jina else _capture_via_jina

    async with httpx.AsyncClient(timeout=DEMO_SCREENSHOT_TIMEOUT, follow_redirects=True) as client:
        try:
            return await primary(url, client)
        except ScreenshotError as first_error:
            logger.info("primary screenshot provider failed for %s (%s); trying fallback", url, first_error)
            try:
                return await fallback(url, client)
            except ScreenshotError as second_error:
                raise ScreenshotError(
                    f"both screenshot providers failed for {url}: {first_error}; {second_error}"
                ) from second_error


def capture_and_store(bot_id: int, url: str) -> str:
    """Capture ``url`` and store it on the CDN. Returns the public image URL.

    Synchronous wrapper for callers that are not already in an event loop.
    Raises :class:`ScreenshotError` on any failure, including an upload
    failure, so a caller never records a capture it cannot actually serve.
    """
    from app.services.r2_service import upload_demo_screenshot

    capture = asyncio.run(capture_full_page(url))
    key = build_screenshot_key(bot_id)
    if capture.extension == "jpg":
        key = key.removesuffix(".png") + ".jpg"
    try:
        return upload_demo_screenshot(capture.data, key, content_type=capture.content_type)
    except Exception as exc:  # noqa: BLE001 - upload layer raises bare Exception
        raise ScreenshotError(f"Could not store capture for bot {bot_id}: {exc}") from exc


def refresh_bot_capture(bot_id: int, force: bool = False) -> bool:
    """Capture a bot's website and record the result. Returns True if stored.

    The whole job, end to end: decide whether a capture is warranted, claim it,
    render it, and publish it. It lives here rather than in the ARQ task
    because it has to be runnable from two places. ``WORKER_ENABLED`` defaults
    to false, and on that path callers run this inline on the background thread
    pool instead of queueing it, exactly as document ingestion and lead-company
    resolution already do. A version that only existed inside the task body
    would leave the feature silently doing nothing wherever the worker is off:
    the customer would click "refresh", the card would say "we are taking a
    picture now", and nothing would ever take one.

    Never raises. Every failure is recorded on the row and reported as False,
    because both callers are fire-and-forget and neither has anywhere useful to
    put an exception.
    """
    from datetime import UTC, datetime, timedelta

    from app.config import DEMO_SCREENSHOT_ENABLED, DEMO_SCREENSHOT_TTL_DAYS
    from app.db.models import Bot
    from app.db.session import get_session

    if not DEMO_SCREENSHOT_ENABLED:
        return False

    # Phase 1: decide and claim, in one short transaction. The capture itself
    # takes seconds and must not hold a session open for its duration.
    try:
        with get_session() as session:
            bot = session.get(Bot, bot_id)
            if bot is None:
                return False
            target = normalize_site_url(bot.website)
            if not target:
                return False
            if not force and bot.demo_screenshot_status == "ready" and bot.demo_screenshot_url:
                unchanged = bot.demo_screenshot_source_url == target
                captured_at = bot.demo_screenshot_captured_at
                if captured_at is not None and captured_at.tzinfo is None:
                    captured_at = captured_at.replace(tzinfo=UTC)
                fresh = captured_at is not None and captured_at > datetime.now(UTC) - timedelta(
                    days=DEMO_SCREENSHOT_TTL_DAYS
                )
                if unchanged and fresh:
                    return False
            bot.demo_screenshot_status = "pending"
            session.commit()
    except Exception:
        logger.warning("could not claim a demo capture for bot %s", bot_id, exc_info=True)
        return False

    logger.info("capturing demo screenshot: bot=%s url=%s force=%s", bot_id, target, force)

    try:
        public_url = capture_and_store(bot_id, target)
    except ScreenshotError as exc:
        logger.warning("demo screenshot capture failed for bot %s: %s", bot_id, exc)
        _record_status(bot_id, "failed")
        return False
    except Exception:
        # An unexpected error still has to clear "pending", or the Deploy card
        # sits on "we are taking a picture now" forever.
        logger.exception("unexpected error capturing demo screenshot for bot %s", bot_id)
        _record_status(bot_id, "failed")
        return False

    # Phase 2: publish. Re-read rather than reusing the earlier instance: the
    # capture window is long enough for the customer to have changed their
    # website, and a capture of a site they no longer have is worse than none.
    try:
        with get_session() as session:
            bot = session.get(Bot, bot_id)
            if bot is None:
                return False
            if normalize_site_url(bot.website) != target:
                logger.info("bot %s changed website mid-capture; discarding the stale capture", bot_id)
                bot.demo_screenshot_status = None
                session.commit()
                return False
            bot.demo_screenshot_url = public_url
            bot.demo_screenshot_source_url = target
            bot.demo_screenshot_captured_at = datetime.now(UTC)
            bot.demo_screenshot_status = "ready"
            session.commit()
    except Exception:
        logger.exception("captured a demo screenshot for bot %s but could not record it", bot_id)
        return False
    return True


def _record_status(bot_id: int, status: str) -> None:
    """Best-effort write of a terminal capture status."""
    from app.db.models import Bot
    from app.db.session import get_session

    try:
        with get_session() as session:
            bot = session.get(Bot, bot_id)
            if bot is not None:
                bot.demo_screenshot_status = status
                session.commit()
    except Exception:
        logger.warning("could not record capture status %r for bot %s", status, bot_id, exc_info=True)


def normalize_site_url(raw: str | None) -> str | None:
    """Normalize a stored ``bots.website`` into a capturable absolute URL.

    Customers type bare hostnames far more often than URLs, and a bare hostname
    is not something an HTTP client can fetch. Returns None when there is
    nothing usable, which the caller reads as "this bot has no site to capture"
    rather than as an error.
    """
    if not raw:
        return None
    candidate = raw.strip()
    if not candidate:
        return None
    if not candidate.lower().startswith(("http://", "https://")):
        candidate = f"https://{candidate}"
    parsed = urlparse(candidate)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        return None
    # A hostname with no dot is either a local name or a typo; neither is a
    # public site worth spending a capture on.
    if "." not in parsed.hostname:
        return None
    return candidate
