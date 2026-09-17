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

import re
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
    ``rag_service.contact_url_from_answer_links``.

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


# ── Company-facts pages ───────────────────────────────────────────────────────
#
# Where a company says where it is, how to reach it and who runs it. Reported
# from production on 2026-09-17: a managed SOC's bot refused "where are the soc
# centers ?" although its contact page lists every SOC city, because on a
# knowledge base of about 7,900 chunks the SOC blog posts outranked that one
# chunk for every phrasing tried. The retriever pins these pages for a question
# about the company's own facts (``rag_service._asks_company_facts``).
#
# Same narrow matching as the contact slugs above: every segment of the path
# (after an optional locale prefix such as ``en`` or ``en-us``) must be one of
# these slugs, and there are at most two of them. ``/about-us/leadership`` is a
# leadership page; ``/blog/our-team-at-rsa`` is an article.

#: The facts a page carries, by kind.
COMPANY_FACT_KINDS: tuple[str, ...] = ("contact", "locations", "team", "about")

_COMPANY_FACT_SLUGS: dict[str, str] = {
    **dict.fromkeys(CONTACT_SLUGS, "contact"),
    **dict.fromkeys(
        (
            "locations",
            "location",
            "our-locations",
            "offices",
            "our-offices",
            "office-locations",
            "global-presence",
            "our-presence",
            "presence",
            "where-we-are",
            "find-us",
            "branches",
            "our-branches",
        ),
        "locations",
    ),
    **dict.fromkeys(
        (
            "team",
            "our-team",
            "meet-the-team",
            "leadership",
            "leadership-team",
            "our-leadership",
            "management",
            "management-team",
            "board",
            "board-of-directors",
            "founders",
            "people",
            "our-people",
        ),
        "team",
    ),
    **dict.fromkeys(
        (
            "about",
            "about-us",
            "aboutus",
            "about_us",
            "who-we-are",
            "company",
            "our-company",
            "our-story",
            "company-profile",
        ),
        "about",
    ),
}

_LOCALE_SEGMENT_RE = re.compile(r"[a-z]{2}(?:[-_][a-z]{2})?")
_MAX_FACT_PATH_SEGMENTS = 2


def company_fact_page_kind(url: object) -> str | None:
    """The kind of company-facts page ``url`` is (one of ``COMPANY_FACT_KINDS``),
    or ``None`` for any other page.

    The last segment decides the kind, so ``/about-us/contact`` is a contact
    page and ``/company/leadership`` a team page. Junk input reads as ``None``.
    """
    normalized = normalize_url(url)
    if normalized is None:
        return None
    segments = [s for s in _path_of(normalized).split("/") if s]
    if segments and _LOCALE_SEGMENT_RE.fullmatch(segments[0]) and len(segments) > 1:
        segments = segments[1:]
    if not segments or len(segments) > _MAX_FACT_PATH_SEGMENTS:
        return None
    if any(segment not in _COMPANY_FACT_SLUGS for segment in segments):
        return None
    return _COMPANY_FACT_SLUGS[segments[-1]]


#: Which pages answer which question, best first. An about page is the fallback
#: for all three: it is where a small site puts its address and its founders.
_PAGE_KINDS_FOR_QUESTION: dict[str, tuple[str, ...]] = {
    "locations": ("contact", "locations", "about"),
    "contact": ("contact", "about"),
    "team": ("team", "about"),
}


def company_fact_page_priority(question_kinds: Iterable[str], page_kind: str | None) -> int | None:
    """How well a page of ``page_kind`` answers a question asking
    ``question_kinds``: 0 is best, ``None`` means it does not.

    A question asking several kinds gives a page the best rank any of them
    gives it.
    """
    if page_kind is None:
        return None
    best: int | None = None
    for kind in question_kinds:
        order = _PAGE_KINDS_FOR_QUESTION.get(kind, ())
        if page_kind in order:
            rank = order.index(page_kind)
            best = rank if best is None else min(best, rank)
    return best


def company_fact_pages(source_urls: Iterable[object] | None, question_kinds: Iterable[str]) -> dict[str, int]:
    """The crawled pages that answer a company-facts question, mapped to their
    priority (see :func:`company_fact_page_priority`).

    Keys are the URLs as stored, so they can be matched back against
    ``documents.document_name``.
    """
    kinds = tuple(question_kinds)
    if not source_urls or not kinds:
        return {}
    pages: dict[str, int] = {}
    for raw in source_urls:
        if not isinstance(raw, str):
            continue
        priority = company_fact_page_priority(kinds, company_fact_page_kind(raw))
        if priority is not None:
            pages[raw] = priority
    return pages
