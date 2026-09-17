"""What kind of page a document is, read from its name.

A crawled knowledge base mixes the company's own pages (services, terms, SLAs)
with pages that describe a topic in general: buyer guides, "top providers"
listicles, comparisons, glossaries, checklists, "what is" and "how to" articles,
blog posts. The production evaluation of 2026-09-17 found the answering model
quoting figures from the second kind as the company's own terms ("a documented
P1 acknowledge target of 10 min", from an "e.g." in a buyer guide), because
every document reached it with the same header.

The check is deterministic and cheap: it reads the words of a crawled page's
URL path. ``credential_facts`` shares the token set for its own-page test, and
``rag_service`` tags general articles in the reference context with
``GENERAL_ARTICLE_TAG``.
"""

from __future__ import annotations

import re
from urllib.parse import urlsplit

#: The header tag a general article carries in the reference context. RULE 5a
#: of the answer prompt quotes it, so the two change together.
GENERAL_ARTICLE_TAG = "general article, not the company's own terms"

_TOKEN_SPLIT_RE = re.compile(r"[^a-z0-9]+")

#: Path words that mark a page describing a topic rather than the company.
#: "knowledge" and "hub" are deliberately absent: CleanStart publishes its own
#: SLA tiers under /knowledge-hub/, so the section says nothing on its own.
GENERAL_ARTICLE_TOKENS = frozenset(
    {
        "blog",
        "blogs",
        "guide",
        "guides",
        "what",
        "how",
        "checklist",
        "checklists",
        "template",
        "templates",
        "article",
        "articles",
        "insights",
        "glossary",
        "learn",
        "tutorial",
        "tutorials",
        "explained",
        "vs",
        "versus",
        "comparison",
        "compared",
        "top",
        "best",
    }
)


def path_tokens(source: str) -> frozenset[str]:
    """The lowercase words of a URL's path, or of any other name as a whole."""
    lowered = source.strip().casefold()
    if lowered.startswith(("http://", "https://")):
        lowered = urlsplit(lowered).path
    return frozenset(_TOKEN_SPLIT_RE.split(lowered)) - {""}


def _names_company(source: str, company_name: str | None) -> bool:
    """Whether the URL path names the company, which makes the page about it.

    The whole name run together ("cleanstart", "eventussecurity") or its first
    word ("eventus") counts; the host never does, since every page has it. A
    first word that is itself a general-article word ("Best Co") does not.
    """
    if not company_name:
        return False
    words = [word for word in _TOKEN_SPLIT_RE.split(company_name.casefold()) if word]
    if not words:
        return False
    path = urlsplit(source.strip().casefold()).path
    compact_name = "".join(words)
    if len(compact_name) >= 4 and compact_name in "".join(_TOKEN_SPLIT_RE.split(path)):
        return True
    first = words[0]
    return len(first) >= 4 and first not in GENERAL_ARTICLE_TOKENS and first in path_tokens(source)


def is_general_article(document_name: str, company_name: str | None) -> bool:
    """Whether a crawled page reads, from its URL path, as a general article.

    Only crawled URLs are judged. An uploaded file speaks for the company
    whatever its name, because the owner chose to add it.
    """
    name = (document_name or "").strip()
    if not name.casefold().startswith(("http://", "https://")):
        return False
    if not path_tokens(name) & GENERAL_ARTICLE_TOKENS:
        return False
    return not _names_company(name, company_name)
