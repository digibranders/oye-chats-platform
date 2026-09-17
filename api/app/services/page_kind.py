"""What kind of page a document is, read from its name.

A crawled knowledge base mixes the company's own pages (services, terms, SLAs)
with pages that describe a topic in general: buyer guides, "top providers"
listicles, comparisons, glossaries, checklists, "what is" and "how to" articles,
blog posts. The production evaluation of 2026-09-17 found the answering model
quoting figures from the second kind as the company's own terms ("a documented
P1 acknowledge target of 10 min", from an "e.g." in a buyer guide), because
every document reached it with the same header.

The check is deterministic and cheap: it reads a crawled page's URL path.
``rag_service`` tags general articles in the reference context with
``GENERAL_ARTICLE_TAG``, and ``credential_facts`` shares the broader word set
for its own-page test.
"""

from __future__ import annotations

import re
from urllib.parse import urlsplit

#: The header tag a general article carries in the reference context. RULE 5a
#: of the answer prompt quotes it, so the two change together.
GENERAL_ARTICLE_TAG = "general article, not the company's own terms"

_TOKEN_SPLIT_RE = re.compile(r"[^a-z0-9]+")

#: Path words that can mark a page describing a topic rather than the company.
#: Too broad to tag a page on their own ("/how-we-work/", "/what-we-do/" and
#: "/learn-more/" are the company's own pages), so ``is_general_article`` reads
#: the stronger shapes below; ``credential_facts`` uses this set, where leaning
#: towards "not the company's own page" is the safe side for a credential.
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


#: A whole path segment that is a publishing section: "/blog/...", "/insights/...".
_ARTICLE_SECTION_RE = re.compile(
    r"(?:blogs?|guides?|glossary|glossaries|articles?|insights|resources|news|webinars?|tutorials?)"
)

#: A slug that reads as an article, matched against one whole path segment. The
#: review of 2026-09-17 found "how", "what", "best", "top" and "learn" alone
#: tagging the company's own pages ("/how-we-work/", "/best-in-class-support/"),
#: so each shape needs a second word that only an article has: "what is",
#: "how to", a count after "top", a providers or tools list, a year, or a
#: comparison, checklist or explainer word. A segment is read only when it is
#: a plain slug of at most 200 characters (``_SLUG_RE``), so every open repeat
#: runs to the end of the segment and matching stays linear.
_ARTICLE_SLUG_RE = re.compile(
    r"(?:what-is|what-are|how-to)-[a-z0-9-]*"
    r"|top-\d{1,3}-[a-z0-9-]*"
    r"|(?:best|top)-[a-z0-9-]*-(?:providers|vendors|tools|platforms|companies|software)"
    r"(?:-(?:19|20)\d\d)?"
    r"|best-[a-z0-9-]*-(?:19|20)\d\d"
    r"|[a-z0-9-]*-(?:vs|versus)-[a-z0-9-]*"
    r"|[a-z0-9-]*-(?:comparison|compared|checklist|explained|tutorial)(?:-[a-z0-9-]*)?"
)
_SLUG_RE = re.compile(r"[a-z0-9-]{1,200}")


def _path_segments(url: str) -> list[str]:
    return [segment for segment in urlsplit(url.strip().casefold()).path.split("/") if segment]


def _reads_as_article(url: str) -> bool:
    """Whether a URL's path has a publishing section or an article-shaped slug."""
    return any(
        _ARTICLE_SECTION_RE.fullmatch(segment)
        or (_SLUG_RE.fullmatch(segment) is not None and _ARTICLE_SLUG_RE.fullmatch(segment) is not None)
        for segment in _path_segments(url)
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
    if not _reads_as_article(name):
        return False
    return not _names_company(name, company_name)
