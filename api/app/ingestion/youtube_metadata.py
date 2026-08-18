"""YouTube metadata fetching for the media-card pipeline.

Extracts duration (in seconds) AND title of a YouTube video by scraping
the public watch page. We use scrape rather than the YouTube Data API v3
so customers don't need to set up a Google Cloud API key. This data is
a card-polish detail, not core functionality, and degrading gracefully
to "no title / no duration" is acceptable when a scrape fails.

Both fields are extracted from the same HTTP response so a video costs
one round-trip at ingest, not two. The scrape targets the ``lengthSeconds``
field in the ``ytInitialPlayerResponse`` JSON blob and the ``og:title``
meta tag in the HTML head, both are server-rendered on every watch page
and have been stable across YouTube redesigns.

Called at ingest time from :mod:`app.ingestion.pipeline` so the network
cost sits on the crawl worker rather than on the visitor-facing request
path. Results are cached in-process for the lifetime of the worker.

Why title matters as much as duration:
    Without titles, the LLM's "Available media" context lists only
    ``video_id + url``. Indistinguishable strings from the model's
    perspective. When a retrieved chunk carries several video URLs
    (common on multi-episode pages where pypdf packs them together),
    the LLM has no signal to pick "the busybox video" over "the
    shell-less container video". Injecting the title lets the LLM
    match a topic-specific question to the topic-specific video.
"""

from __future__ import annotations

import html
import logging
import re
from urllib.error import URLError
from urllib.request import Request, urlopen

logger = logging.getLogger(__name__)

# In-process cache keyed by video_id. Metadata (title + duration) doesn't
# change once a video is uploaded, so caching across the worker's lifetime
# is safe. Bounded because a large crawl could theoretically ingest
# thousands of unique videos and we don't want unbounded memory growth in
# a long-lived worker.
_METADATA_CACHE: dict[str, dict[str, int | str] | None] = {}
_MAX_CACHE_SIZE = 4096

# ``"lengthSeconds":"NNN"`` lives inside the ``ytInitialPlayerResponse``
# JSON blob served on every watch page. Anchoring on the JSON key rather
# than a broader ``\d+`` reduces the chance of matching an unrelated
# numeric field elsewhere on the page.
_LENGTH_SECONDS_RE = re.compile(r'"lengthSeconds":"(\d+)"')

# Video title lives in an OpenGraph meta tag in the HTML head, populated
# server-side so it's present in the initial payload. Alternative would
# be the JSON ``"title":"..."`` inside videoDetails, but the meta tag is
# HTML-escaped rather than JSON-escaped which is easier to unescape
# safely (``html.unescape`` handles the whole entity set).
_OG_TITLE_RE = re.compile(r'<meta\s+property="og:title"\s+content="([^"]*)"', re.IGNORECASE)

# YouTube serves a stripped-down HTML to requests with unusual user
# agents (or blocks them entirely). Presenting as a real desktop Chrome
# request is the cheapest reliable way to get the full initial payload
# without cookies or session tokens.
_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)
_ACCEPT_LANGUAGE = "en-US,en;q=0.9"

# Kept short so a slow / hanging fetch during a crawl doesn't stall
# ingestion. Metadata is optional polish. Better to skip it than to
# block a whole batch on one unresponsive request.
_TIMEOUT_SECONDS = 5.0

# YouTube video IDs are always 11 chars from the URL-safe base64 alphabet.
# Anchor validation here so a hallucinated id from a broken caller can't
# turn into an HTTP request to an arbitrary URL.
_VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")

# Cap title length so a wildly-long value from a malformed page can't
# balloon the LLM prompt or the JSONB row.
_MAX_TITLE_CHARS = 200

# In-process cache for channel → video-ID list. Same reasoning as the
# per-video metadata cache above: channel contents don't change often;
# caching per worker lifetime keeps a large crawl from re-fetching the
# same channel dozens of times when the URL appears in many pages.
_CHANNEL_CACHE: dict[str, list[dict[str, str]]] = {}

# Every YouTube channel/watch/videos page embeds its video list inside
# the initial ``ytInitialData`` JSON blob. Each video appears as
# ``"videoId":"XXXXXXXXXXX"``. 11-char URL-safe alphabet. Anchor on
# that JSON key rather than a broader ``\d+`` so we don't false-positive
# on incidental numeric IDs elsewhere on the page.
_VIDEO_ID_IN_CHANNEL_PAGE = re.compile(r'"videoId":"([A-Za-z0-9_-]{11})"')

# Hard cap on how many videos we pull from a single channel to protect
# the LLM prompt + Redis payload from a channel with hundreds of videos.
# The bot-wide catalog also caps at 25 elsewhere, so more than this here
# is wasted work anyway.
_MAX_VIDEOS_PER_CHANNEL = 50


def fetch_youtube_metadata(video_id: str) -> dict[str, int | str] | None:
    """Return ``{"duration_seconds": int, "title": str}`` or ``None`` on failure.

    Either individual field may be missing from the returned dict when
    that specific field failed to parse. Callers should ``.get()`` with
    a default rather than assume both keys are present. When BOTH fields
    fail the function returns ``None`` so the caller can distinguish
    "video exists but metadata partial" from "video is unreachable".

    Called synchronously from the ingestion pipeline (which is itself
    sync). Result is cached in-process so repeat calls for the same
    ``video_id`` cost nothing after the first successful fetch.
    """
    if not video_id or not _VIDEO_ID_RE.match(video_id):
        return None
    if video_id in _METADATA_CACHE:
        return _METADATA_CACHE[video_id]

    # Bound the cache before adding a new entry. Simple "evict-oldest-half"
    # avoids the cost of a dedicated LRU dependency; metadata lookups are
    # non-critical so at worst a popular video gets re-fetched.
    if len(_METADATA_CACHE) >= _MAX_CACHE_SIZE:
        for k in list(_METADATA_CACHE.keys())[: _MAX_CACHE_SIZE // 2]:
            _METADATA_CACHE.pop(k, None)

    url = f"https://www.youtube.com/watch?v={video_id}"
    try:
        req = Request(
            url,
            headers={
                "User-Agent": _USER_AGENT,
                "Accept-Language": _ACCEPT_LANGUAGE,
            },
        )
        with urlopen(req, timeout=_TIMEOUT_SECONDS) as response:  # noqa: S310 -- fixed https scheme
            # 4 MB safety cap: watch pages are typically ~1 MB; anything
            # larger is either a redirect chain gone wrong or a hostile
            # response, and we don't want to buffer megabytes into memory
            # for a metadata lookup.
            body = response.read(4 * 1024 * 1024).decode("utf-8", errors="replace")
    except (URLError, TimeoutError, ValueError, OSError) as exc:
        logger.debug("YouTube metadata fetch failed for %s: %s", video_id, exc)
        _METADATA_CACHE[video_id] = None
        return None

    result: dict[str, int | str] = {}

    duration_match = _LENGTH_SECONDS_RE.search(body)
    if duration_match is not None:
        try:
            seconds = int(duration_match.group(1))
            # Negative or absurdly large duration is a parse error, not a
            # real video. Cap at 24h, no legitimate podcast episode or
            # product demo is longer.
            if 0 < seconds <= 24 * 60 * 60:
                result["duration_seconds"] = seconds
        except (TypeError, ValueError):
            pass

    title_match = _OG_TITLE_RE.search(body)
    if title_match is not None:
        raw = title_match.group(1)
        # og:title contains HTML entities (e.g. ``&amp;``, ``&#39;``).
        # Unescape so the LLM and the widget see human-readable text.
        title = html.unescape(raw).strip()
        if title:
            result["title"] = title[:_MAX_TITLE_CHARS]

    if not result:
        _METADATA_CACHE[video_id] = None
        return None
    _METADATA_CACHE[video_id] = result
    return result


def fetch_youtube_duration(video_id: str) -> int | None:
    """Return the video's duration in whole seconds, or ``None`` on failure.

    Thin wrapper around :func:`fetch_youtube_metadata` for callers that
    only need duration (kept for API stability. Earlier code paths
    imported this by name).
    """
    meta = fetch_youtube_metadata(video_id)
    if meta is None:
        return None
    duration = meta.get("duration_seconds")
    return duration if isinstance(duration, int) else None


def enrich_media_urls_with_metadata(media_urls: dict) -> None:
    """Mutate a ``media_urls`` dict in place, adding YouTube metadata.

    Shape matches :func:`app.ingestion.cleaner.extract_media_urls`::

        {"youtube": [{"video_id": "...", "url": "..."}, ...], "files": [...]}

    On successful fetch each YouTube entry gains ``duration_seconds``
    (int, if parseable) AND ``title`` (str, if parseable). On failure the
    keys are simply absent. Callers do not need to distinguish "not
    fetched yet" from "fetch failed", the widget/LLM path degrades
    gracefully in either case.
    """
    if not isinstance(media_urls, dict):
        return
    youtube = media_urls.get("youtube")
    if not isinstance(youtube, list):
        return
    for entry in youtube:
        if not isinstance(entry, dict):
            continue
        video_id = entry.get("video_id")
        if not isinstance(video_id, str):
            continue
        meta = fetch_youtube_metadata(video_id)
        if meta is None:
            continue
        duration = meta.get("duration_seconds")
        if isinstance(duration, int):
            entry["duration_seconds"] = duration
        title = meta.get("title")
        if isinstance(title, str) and title:
            entry["title"] = title


# Backwards-compatible alias, the existing pipeline import continues
# to work while a follow-up rename can migrate callers at leisure.
enrich_media_urls_with_durations = enrich_media_urls_with_metadata


# ─── Layer 1.5: auto-discover channel videos ──────────────────────────────
# When a customer's crawled page contains their YouTube channel URL
# (footer, "Follow us on YouTube", social icons, About page), the
# ingestion pipeline calls into here to expand that channel URL into the
# full list of videos on it. Result: customer gets their entire video
# library surfaced in the bot's media catalog without ever configuring
# anything manually.


def fetch_channel_videos(channel_url: str) -> list[dict[str, str]]:
    """Return every ``{"video_id", "url"}`` on a YouTube channel.

    Fetches the channel's ``/videos`` page (which is what YouTube serves
    at a bare channel URL anyway) and greps the ``ytInitialData`` blob
    for every ``"videoId":"..."`` occurrence, same technique the
    hand-run injection script used earlier in the codebase's evolution.

    Failure modes silently return ``[]``: dead channels, geo-blocked
    pages, network errors, YouTube-HTML shape drift. A silent zero here
    is fine, the bot just misses this customer's videos, which is the
    same state as before Layer 1.5 shipped, so it never regresses
    existing behaviour.
    """
    if not channel_url or not isinstance(channel_url, str):
        return []

    # Normalise to the ``/videos`` endpoint so YouTube serves the full
    # video listing instead of the channel's "About" default. Idempotent
    # if the URL already ends in ``/videos``.
    normalised = channel_url.rstrip("/")
    if not normalised.lower().endswith("/videos"):
        normalised = normalised + "/videos"

    cache_key = normalised.lower()
    if cache_key in _CHANNEL_CACHE:
        return _CHANNEL_CACHE[cache_key]

    if len(_CHANNEL_CACHE) >= _MAX_CACHE_SIZE:
        for k in list(_CHANNEL_CACHE.keys())[: _MAX_CACHE_SIZE // 2]:
            _CHANNEL_CACHE.pop(k, None)

    try:
        req = Request(
            normalised,
            headers={
                "User-Agent": _USER_AGENT,
                "Accept-Language": _ACCEPT_LANGUAGE,
            },
        )
        with urlopen(req, timeout=_TIMEOUT_SECONDS) as response:  # noqa: S310 -- fixed https scheme
            # 8 MB cap. Channel pages carry richer JSON than watch pages,
            # so give a bit more headroom than fetch_youtube_metadata's 4MB.
            body = response.read(8 * 1024 * 1024).decode("utf-8", errors="replace")
    except (URLError, TimeoutError, ValueError, OSError) as exc:
        logger.debug("YouTube channel fetch failed for %s: %s", channel_url, exc)
        _CHANNEL_CACHE[cache_key] = []
        return []

    # Preserve YouTube's own ordering (typically newest-first) so the
    # bot's catalog surfaces recent content first. Dedupe.
    seen: set[str] = set()
    videos: list[dict[str, str]] = []
    for match in _VIDEO_ID_IN_CHANNEL_PAGE.finditer(body):
        vid = match.group(1)
        if vid in seen:
            continue
        seen.add(vid)
        videos.append({"video_id": vid, "url": f"https://www.youtube.com/watch?v={vid}"})
        if len(videos) >= _MAX_VIDEOS_PER_CHANNEL:
            break

    _CHANNEL_CACHE[cache_key] = videos
    return videos


def enrich_media_urls_with_channel_videos(media_urls: dict) -> None:
    """Expand ``youtube_channels`` into their full video lists in place.

    When ``extract_media_urls`` detected one or more YouTube channel
    URLs on a page, this helper fetches every video on each channel
    (deduped across channels) and merges them into the same
    ``media_urls["youtube"]`` list where per-video entries already live.
    Subsequent :func:`enrich_media_urls_with_metadata` then scrapes
    title + duration for the newly-added entries, so they land in the
    catalog with the same shape as videos the crawler found directly.

    Idempotent: re-running this on an already-expanded dict is a no-op
    thanks to the in-process ``_CHANNEL_CACHE`` and the per-video ID
    dedup below.
    """
    if not isinstance(media_urls, dict):
        return
    channels = media_urls.get("youtube_channels")
    if not isinstance(channels, list) or not channels:
        return

    existing = list(media_urls.get("youtube") or [])
    seen_ids: set[str] = set()
    for entry in existing:
        if isinstance(entry, dict):
            vid = entry.get("video_id")
            if isinstance(vid, str):
                seen_ids.add(vid)

    for channel_url in channels:
        if not isinstance(channel_url, str):
            continue
        for video in fetch_channel_videos(channel_url):
            vid = video.get("video_id")
            if not isinstance(vid, str) or vid in seen_ids:
                continue
            seen_ids.add(vid)
            existing.append(video)

    if existing:
        media_urls["youtube"] = existing
