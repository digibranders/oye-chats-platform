"""Derive a bot's contact page from its own knowledge base.

The platform already knows a customer's contact page: the crawler stored it as a
row in ``documents`` the first time it walked their site. Until now the only way
for the bot to USE that page was for an admin to re-type it as a ``contact``
Smart Link, and in practice nobody does (0 of 18 bots on the development
database had one). The Free pricing pivot, whose whole job is to hand over that
page when it refuses to quote a price, was therefore unreachable, and every Free
bot fell through to answering pricing questions from its unrestricted knowledge
base -- the stale-price outcome the pricing gate exists to prevent.

This module closes that gap by reading what the crawl already found.

Pure by design: no DB, no I/O, and no import from ``rag_service`` (which imports
this one). Callers pass the source URLs they have already loaded.

MATCHING IS DELIBERATELY NARROW. A page qualifies only when its ENTIRE path is
one of the contact slugs below (``/contact``, ``/contact-us``), never when a slug
merely appears somewhere in a longer path. ``/blogs/how-to-contact-support`` is
an article about contacting someone, not the company's contact page, and handing
a visitor a blog post when they wanted a human is worse than handing them
nothing. Widening this later is cheap; a wrong link shipped to visitors is not.
"""

from __future__ import annotations

from collections.abc import Iterable

from app.services.pricing_gate import normalize_url

#: A page qualifies when its whole path equals one of these, case-insensitively.
#: Exact slugs rather than a regex so adding one stays a one-line review.
CONTACT_SLUGS: frozenset[str] = frozenset(
    {
        "contact",
        "contact-us",
        "contact_us",
        "contactus",
        "contact-me",
        "get-in-touch",
        "getintouch",
        "reach-us",
        "talk-to-us",
    }
)


def _path_of(normalized: str) -> str:
    """The path of a normalized URL, without leading/trailing slashes.

    ``normalize_url`` has already dropped the scheme, ``www.``, query and
    fragment, so what remains is ``host/path``. Splitting on the first ``/``
    leaves the path, and an empty string for a bare domain.
    """
    _, _, path = normalized.partition("/")
    return path.strip("/").casefold()


def detect_contact_url(source_urls: Iterable[object] | None) -> str | None:
    """Pick the contact page out of a bot's crawled source URLs.

    ``source_urls`` is typically the distinct ``documents.document_name`` values
    for one bot. Junk entries (``None``, non-strings, uploaded filenames,
    anything ``normalize_url`` rejects) are skipped rather than raised on: this
    runs against real customer crawls and one bad row must not break a chat turn.

    Returns the URL AS STORED (trimmed), not the normalized form: the visitor is
    handed this string as a clickable link, and ``normalize_url`` strips the
    scheme for comparison purposes only. Mirrors
    ``rag_service._contact_url_from_answer_links``.

    When several pages qualify the SHORTEST path wins, ties broken
    lexicographically. Determinism matters more than which one is "best": the
    value is re-derived on every turn, and a non-deterministic pick would swap
    the link a visitor is handed between two turns of one conversation.
    """
    if not source_urls:
        return None
    candidates: list[tuple[int, str, str]] = []
    for raw in source_urls:
        if not isinstance(raw, str):
            continue
        candidate = raw.strip()
        normalized = normalize_url(candidate)
        if normalized is None:
            continue
        if _path_of(normalized) in CONTACT_SLUGS:
            candidates.append((len(_path_of(normalized)), _path_of(normalized), candidate))
    if not candidates:
        return None
    candidates.sort()
    return candidates[0][2]
