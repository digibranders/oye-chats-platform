"""Structured event extraction from crawled/uploaded knowledge base content.

Powers the Tier 2 fix for the "upcoming events" bug: instead of leaving the
chat LLM to parse fuzzy date strings out of retrieved text at answer time,
we detect event-shaped pages during ingestion, extract each event into a
typed row (``models.Event`` with a real ``starts_at`` timestamptz), and let
the chat pipeline answer date questions with a plain SQL query.

Two-stage design so we never pay for an LLM call we don't need:

1. ``is_events_page`` — a cheap keyword filter over URL, title, and body
   text. Skips pricing pages, blog posts, and other content that happens
   to contain a date but is not an event listing.
2. ``extract_events`` — calls Gemini with a strict JSON schema. Any event
   the model can't attach a real day+month+year to is silently dropped by
   the schema, so a wrong verdict is preferred over a made-up date.

Idempotency lives in ``repository.upsert_events``: the natural key is
``(bot_id, source_url, title)`` so a re-crawl refreshes ``last_seen_at``
instead of stacking duplicates. The pruning job then uses that timestamp
to delete events the customer removed from their page.
"""

from __future__ import annotations

import logging
import re
from datetime import UTC, date, datetime, timedelta

import litellm
from pydantic import BaseModel, Field

from app import config
from app.services import runtime_config
from app.services.llm_service import _apply_model_family_kwargs

logger = logging.getLogger(__name__)


# ── Keyword filter ──────────────────────────────────────────────────────────
# Kept intentionally narrow and case-insensitive. False negatives (an events
# page whose URL says /happenings) are covered by the Tier-2-plus safety
# nets we'll layer on top (admin override, content-based classifier); false
# positives here waste an LLM call and can pollute the events table, so we
# err on the side of being strict.
_URL_KEYWORDS = ("event", "webinar", "calendar", "schedule", "session", "meetup", "workshop")
_TITLE_KEYWORDS = ("event", "webinar", "calendar", "schedule", "upcoming", "meetup", "workshop")
# Body-level signals that push a borderline page (URL missed, but the page
# clearly IS an event listing) into the extractor. Requires >= 2 hits AND a
# heading-shaped line so a blog post that happens to mention "register" and
# "speaker" once doesn't get pulled in.
_BODY_SIGNAL_TERMS = (
    "register now",
    "rsvp",
    "book your seat",
    "reserve your spot",
    "join us",
    "speaker",
    "agenda",
    "session starts",
)
_HEADING_PATTERN = re.compile(
    r"^\s*#{1,3}\s+.*(event|webinar|schedule|upcoming|calendar)", re.IGNORECASE | re.MULTILINE
)

# Hard caps so a pathological page never runs away.
_MAX_TEXT_CHARS = 20_000
_MAX_EVENTS_PER_PAGE = 40
_EXTRACT_TIMEOUT_S = 15
# Events more than this far in the past aren't useful to store; the LLM
# occasionally still returns them ("Last year's summit was on …") and we'd
# rather not carry them just to filter them out on every query.
_PAST_HORIZON = timedelta(days=180)


def is_events_page(url: str | None, title: str | None, text: str | None) -> bool:
    """Return True when the page is likely an events / webinars listing.

    The three signals stack: URL and title are strong on their own; body
    heuristics require both a heading match AND multiple body-signal terms
    so an ordinary blog post doesn't trigger extraction.
    """
    if url:
        url_lower = url.lower()
        if any(kw in url_lower for kw in _URL_KEYWORDS):
            return True
    if title:
        title_lower = title.lower()
        if any(kw in title_lower for kw in _TITLE_KEYWORDS):
            return True
    if text:
        if not _HEADING_PATTERN.search(text):
            return False
        text_lower = text.lower()
        hits = sum(1 for term in _BODY_SIGNAL_TERMS if term in text_lower)
        if hits >= 2:
            return True
    return False


# ── JSON schema for the LLM call ────────────────────────────────────────────


class _ExtractedEvent(BaseModel):
    """One event as returned by the LLM.

    Every optional field is truly optional — pages routinely list an event
    with only a title + date and no URL, and we still want that row.
    ``starts_at`` uses a permissive ISO 8601 string so the model doesn't
    have to guess about timezone offsets it can't infer; we normalize on
    our side.
    """

    title: str = Field(..., description="Event or webinar name as it appears on the page.")
    starts_at: str = Field(
        ...,
        description=(
            "Event start as ISO 8601 date or datetime, e.g. '2026-08-18' or "
            "'2026-08-18T15:00:00+05:30'. If only a date is given, use the date form. "
            "Return an empty string if no specific day+month+year is stated."
        ),
    )
    ends_at: str = Field("", description="Optional ISO 8601 end date/datetime. Empty string if unknown.")
    url: str = Field("", description="Registration or event detail URL. Empty string if none on the page.")
    location: str = Field("", description="City, venue, or 'Online'. Empty string if unknown.")


class _ExtractedEvents(BaseModel):
    events: list[_ExtractedEvent] = Field(default_factory=list)


_EXTRACTION_PROMPT_TEMPLATE = (
    "You are extracting a list of scheduled events from a webpage's cleaned text. "
    "Return every event that has an unambiguous calendar date (day + month + year). "
    "\n\nRULES:\n"
    "- Skip any event that only names a year (e.g. 'DevOps Summit 2026') without a specific day+month.\n"
    "- Skip events described only by relative phrases ('next Friday') if the reference date isn't clear.\n"
    "- Skip past-year annual retrospectives, testimonials, and 'thanks for attending' recaps.\n"
    "- If the same event is listed multiple times on the page, return it once.\n"
    "- Prefer the event's own registration URL over a generic homepage link.\n"
    "- TODAY IS {today}. Do not invent future dates; if the page is ambiguous, omit the event.\n"
    "\nPAGE URL: {source_url}\n\nPAGE CONTENT:\n{text}"
)


def _extraction_model() -> str:
    """Prefer the CRAG gate model (Gemini Flash) — cheap, fast, JSON-strict.

    Falls back to the primary LLM if the gate model isn't configured so a
    misconfigured environment degrades gracefully instead of silently
    dropping all extraction.
    """
    try:
        return runtime_config.get_gate_model()
    except Exception:
        return runtime_config.get_primary_model()


def _parse_iso_datetime(raw: str) -> datetime | None:
    """Parse an ISO 8601 date or datetime into a timezone-aware UTC datetime.

    Bare dates ('2026-08-18') are anchored at 00:00 UTC — good enough for
    PAST/UPCOMING comparisons at day granularity, which is all the chat
    pipeline needs. Anything the parser can't handle is returned as None
    so the caller can drop the row (never guess).
    """
    if not raw or not isinstance(raw, str):
        return None
    raw = raw.strip()
    if not raw:
        return None
    try:
        # ``fromisoformat`` on 3.11+ handles both 'YYYY-MM-DD' and full
        # datetimes with offset; a date-only string comes back as
        # ``datetime`` with tzinfo=None which we then anchor to UTC.
        parsed = datetime.fromisoformat(raw)
    except ValueError:
        try:
            parsed = datetime.combine(date.fromisoformat(raw), datetime.min.time())
        except ValueError:
            return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def extract_events(
    text: str,
    *,
    source_url: str,
    today: date | None = None,
) -> list[dict]:
    """Call the LLM to extract structured events from a cleaned page.

    Returns a list of ``{title, starts_at, ends_at, url, location}`` dicts
    ready for ``repository.upsert_events``. Never raises: on any LLM error,
    JSON error, or timeout, returns ``[]`` so ingestion is never blocked by
    extraction failures — the page still gets chunked and embedded as
    normal, we just miss the structured rows for that crawl.
    """
    if not text or not text.strip():
        return []

    today = today or datetime.now(UTC).date()
    truncated = text[:_MAX_TEXT_CHARS]
    prompt = _EXTRACTION_PROMPT_TEMPLATE.format(
        today=today.isoformat(),
        source_url=source_url or "(unknown)",
        text=truncated,
    )
    model = _extraction_model()

    kwargs: dict = {
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "response_format": {
            "type": "json_schema",
            "json_schema": {
                "name": "ExtractedEvents",
                "strict": True,
                "schema": _ExtractedEvents.model_json_schema(),
            },
        },
        "timeout": _EXTRACT_TIMEOUT_S,
        "metadata": {"generation_name": "event-extractor"},
    }
    _apply_model_family_kwargs(kwargs, model)

    try:
        response = litellm.completion(**kwargs)
        raw = (response.choices[0].message.content or "").strip()
        parsed = _ExtractedEvents.model_validate_json(raw)
    except Exception as exc:  # noqa: BLE001 — never block ingestion on LLM error
        logger.info("event_extractor: LLM call failed for %s (%s)", source_url, exc)
        return []

    horizon = today - _PAST_HORIZON
    out: list[dict] = []
    seen: set[tuple[str, str]] = set()
    for ev in parsed.events[:_MAX_EVENTS_PER_PAGE]:
        title = (ev.title or "").strip()
        starts = _parse_iso_datetime(ev.starts_at)
        if not title or starts is None:
            continue
        if starts.date() < horizon:
            continue
        key = (title.lower(), starts.date().isoformat())
        if key in seen:
            continue
        seen.add(key)
        ends = _parse_iso_datetime(ev.ends_at) if ev.ends_at else None
        out.append(
            {
                "title": title,
                "starts_at": starts,
                "ends_at": ends,
                "url": (ev.url or "").strip() or None,
                "location": (ev.location or "").strip() or None,
            }
        )
    return out


# ── Public API surface used by the ingestion pipeline ────────────────────────


def maybe_extract_events(
    *,
    url: str | None,
    title: str | None,
    text: str,
    today: date | None = None,
) -> list[dict]:
    """Convenience wrapper: gate on ``is_events_page`` then extract.

    The ingestion pipeline calls this once per crawled page; when the page
    isn't event-shaped we skip the LLM call entirely.
    """
    if not config.EVENT_EXTRACTION_ENABLED:
        return []
    if not is_events_page(url, title, text):
        return []
    return extract_events(text, source_url=url or "", today=today)
