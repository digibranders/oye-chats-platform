"""Read a company's identity out of its own HTML. No LLM, no network.

Order is deliberate, most-authoritative first:

1. schema.org ``Organization`` (and its subtypes) — the entity the publisher
   declares, preferring one whose ``url`` matches the domain we fetched.
2. ``og:site_name`` — the brand the publisher declares.
3. ``<title>`` — last resort, and frequently SEO copy, a nav label, or a
   hosting interstitial rather than a name, so it is heavily guarded.

Anything returned here is a *declaration*, which is why it outranks the LLM
fallback: a model can only infer a name from page copy, and inference is where
wrong answers come from. Measured against real lead domains, 3 of 4 carried
``og:site_name`` and 2 of 4 carried a schema.org Organization block.

## Failing closed

A false negative is cheap — the caller falls back to the LLM, and a domain
that resolves to nothing is cached as a failure. A false POSITIVE is
expensive: the name is written to a cross-tenant cache and shown to a
salesperson as fact. Every guard below is therefore biased toward returning
None. In particular a parked, suspended, or bot-walled page must NOT yield a
name — doing so would short-circuit the resolver's failure-caching path and
attribute every Cloudflare-challenged lead domain to "Cloudflare".
"""

from __future__ import annotations

import html as html_lib
import json
import logging
from urllib.parse import urlparse

from bs4 import BeautifulSoup

logger = logging.getLogger(__name__)

_MAX_NAME_LEN = 80
_MAX_DESCRIPTION_LEN = 500
_MAX_JSON_LD_DEPTH = 40

# Split only on characters that genuinely separate a brand from a tagline.
# A plain hyphen is excluded on purpose — it appears inside real company names.
_TITLE_SEPARATOR_CHARS = "|•·—–"
_TITLE_SEPARATOR_RUN = " :: "
_MAX_TITLE_WORDS = 5

# schema.org types that denote the site's owning organisation.
_ORG_TYPES = {
    "organization", "corporation", "localbusiness", "onlinestore", "onlinebusiness",
    "ngo", "governmentorganization", "educationalorganization", "nonprofit",
    "professionalservice", "store", "restaurant", "medicalorganization",
}  # fmt: skip

_GENERIC_TITLES = {
    "home", "welcome", "index", "untitled", "home page", "homepage",
    "404", "not found", "page not found", "main", "default", "new page",
}  # fmt: skip

# Substrings that mark a page as an interstitial, error, parked, or
# for-sale placeholder rather than a company site.
_INTERSTITIAL_MARKERS = (
    "cloudflare",
    "just a moment",
    "attention required",
    "access denied",
    "forbidden",
    "unauthorized",
    "not found",
    "bad gateway",
    "gateway timeout",
    "service unavailable",
    "temporarily unavailable",
    "coming soon",
    "under construction",
    "site maintenance",
    "maintenance mode",
    "account suspended",
    "suspended",
    "default page",
    "default web page",
    "nginx",
    "apache",
    "iis windows",
    "parked",
    "buy domain",
    "domain for sale",
    "this domain",
    "sedo",
    "godaddy",
    "namecheap",
    "hostgator",
    "bluehost",
    "are you a robot",
    "captcha",
    "security check",
    "redirecting",
    "enable javascript",
    "page not available",
    "error",
)

# Page/nav labels. Common as the SHORT side of a "Label | Brand" title, which
# is exactly what the shortest-segment heuristic would otherwise pick.
_NAV_LABELS = {
    "contact", "contact us", "about", "about us", "login", "log in", "sign in",
    "sign up", "register", "blog", "news", "shop", "store", "products",
    "product", "services", "service", "pricing", "plans", "careers", "jobs",
    "support", "help", "faq", "faqs", "privacy policy", "privacy", "terms",
    "terms of service", "terms and conditions", "cart", "checkout", "search",
    "portfolio", "gallery", "team", "our team", "testimonials", "case studies",
}  # fmt: skip


def _clean(value: object) -> str | None:
    """Normalise whitespace and decode entities. Non-strings yield None.

    JSON-LD legitimately allows ``"name": {"@value": ...}`` and
    ``"name": [...]``; feeding those to ``str`` methods used to raise
    AttributeError straight into the caller.
    """
    if not isinstance(value, str):
        return None
    cleaned = " ".join(html_lib.unescape(value).split())
    return cleaned or None


def _looks_like_interstitial(value: str) -> bool:
    lowered = value.lower()
    return any(marker in lowered for marker in _INTERSTITIAL_MARKERS)


def _plausible_name(value: str | None) -> bool:
    """Could this string be a company name?

    Rejects generic page labels, nav labels, interstitial/parked-page text,
    anything carrying raw markup (html.parser turns an unclosed ``<title>``
    into RCDATA that swallows the rest of the head), and anything too long.
    """
    if not value:
        return False
    if len(value) > _MAX_NAME_LEN:
        return False
    if "<" in value or ">" in value:
        return False
    if not any(ch.isalpha() for ch in value):
        return False
    lowered = value.strip().lower()
    if lowered in _GENERIC_TITLES or lowered in _NAV_LABELS:
        return False
    return not _looks_like_interstitial(value)


def _type_matches_org(node: dict) -> bool:
    node_type = node.get("@type")
    types = node_type if isinstance(node_type, list) else [node_type]
    for t in types:
        if not isinstance(t, str):
            continue
        # Types may be full IRIs: "https://schema.org/Organization".
        if t.rsplit("/", 1)[-1].strip().lower() in _ORG_TYPES:
            return True
    return False


def _host_of(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    try:
        return (urlparse(value).hostname or "").lower().removeprefix("www.") or None
    except ValueError:
        return None


def _collect_organizations(node: object, out: list[tuple[str, str | None]], depth: int = 0) -> None:
    """Gather ``(name, url_host)`` for every Organization-ish node.

    ``author`` and ``mainEntity`` are deliberately NOT descended into: an
    article's author Organization is the publisher of the CONTENT, not the
    owner of the site, and descending there let "Reuters" outrank the site's
    own og:site_name.
    """
    if depth > _MAX_JSON_LD_DEPTH:
        return
    if isinstance(node, list):
        for item in node:
            _collect_organizations(item, out, depth + 1)
        return
    if not isinstance(node, dict):
        return

    if _type_matches_org(node):
        name = _clean(node.get("name"))
        if _plausible_name(name):
            out.append((name, _host_of(node.get("url")) or _host_of(node.get("@id"))))

    for key in ("@graph", "publisher"):
        if key in node:
            _collect_organizations(node[key], out, depth + 1)


def _schema_org_name(soup: BeautifulSoup, domain: str) -> str | None:
    found: list[tuple[str, str | None]] = []
    for tag in soup.find_all("script"):
        script_type = (tag.get("type") or "").strip().lower()
        if script_type != "application/ld+json":
            continue
        raw = (tag.string or tag.get_text() or "").strip()
        # Some CMSs wrap JSON-LD in a CDATA comment.
        raw = raw.removeprefix("//<![CDATA[").removesuffix("//]]>").strip()
        raw = raw.removeprefix("<![CDATA[").removesuffix("]]>").strip()
        try:
            data = json.loads(raw)
        except Exception:
            # Malformed JSON-LD is common in the wild. RecursionError from a
            # pathologically nested payload is not a ValueError, so catch broadly.
            continue
        try:
            _collect_organizations(data, found)
        except Exception:
            logger.debug("json-ld walk failed for %s", domain, exc_info=True)
            continue

    if not found:
        return None
    # Prefer an Organization whose own url matches the site we fetched.
    target = domain.lower().removeprefix("www.")
    for name, host in found:
        if host and (host == target or host.endswith("." + target)):
            return name
    return found[0][0]


def _meta(soup: BeautifulSoup, prop: str) -> str | None:
    wanted = prop.lower()

    def _match(tag) -> bool:
        if tag.name != "meta":
            return False
        key = (tag.get("property") or tag.get("name") or "").strip().lower()
        return key == wanted

    tag = soup.find(_match)
    return _clean(tag.get("content")) if tag else None


def _split_title(title: str) -> list[str]:
    normalised = title.replace(_TITLE_SEPARATOR_RUN, "|")
    for char in _TITLE_SEPARATOR_CHARS:
        normalised = normalised.replace(char, "|")
    return [s for s in (_clean(part) for part in normalised.split("|")) if s]


def _name_from_title(soup: BeautifulSoup, domain: str) -> str | None:
    """Pick the brand segment out of a title, or give up.

    The shortest-segment rule only holds for TWO segments ("Brand | Tagline"
    either way round). With three or more — "Brand | Category | City", the
    standard shape for this platform's market — the shortest segment is the
    city, so we require a segment that matches the domain instead and return
    None when none does.
    """
    head = soup.head or soup
    title_tag = head.find("title", recursive=True)
    if title_tag is not None and title_tag.find_parent("svg") is not None:
        title_tag = None
    title = _clean(title_tag.get_text()) if title_tag else None
    if not title:
        return None

    # A whole title that reads as an interstitial disqualifies every segment.
    if _looks_like_interstitial(title):
        return None

    segments = _split_title(title)
    if not segments:
        return None

    if len(segments) == 1:
        candidate = segments[0]
        if len(candidate.split()) > _MAX_TITLE_WORDS:
            return None  # a sentence, not a name
        return candidate if _plausible_name(candidate) else None

    if len(segments) == 2:
        candidate = min(segments, key=len)
        return candidate if _plausible_name(candidate) else None

    # 3+ segments: only trust one that echoes the domain's own label.
    root_label = domain.lower().removeprefix("www.").split(".")[0]
    for segment in segments:
        squashed = segment.lower().replace(" ", "")
        if root_label and (root_label in squashed or squashed in root_label) and _plausible_name(segment):
            return segment
    return None


def _absolutise(url: str | None, domain: str) -> str | None:
    if not url:
        return None
    if url.startswith("//"):
        url = f"https:{url}"
    elif url.startswith("/"):
        url = f"https://{domain}{url}"
    try:
        parsed = urlparse(url)
    except ValueError:
        return None
    return url if parsed.scheme in ("http", "https") and parsed.netloc else None


def extract_from_markup(html: str | None, domain: str) -> dict | None:
    """Return ``{"name", "description", "logo_url"}`` or None.

    None means "this page did not declare a usable identity" — the caller
    should fall back to the LLM. Never raises: malformed markup is the norm,
    not an exceptional case, so the whole body is guarded.
    """
    if not html or not isinstance(html, str):
        return None

    try:
        soup = BeautifulSoup(html, "html.parser")

        name = _schema_org_name(soup, domain)
        if not _plausible_name(name):
            name = _meta(soup, "og:site_name")
        if not _plausible_name(name):
            name = _name_from_title(soup, domain)
        if not _plausible_name(name):
            return None

        description = _meta(soup, "og:description") or _meta(soup, "description")
        if description and len(description) > _MAX_DESCRIPTION_LEN:
            description = None

        return {
            "name": name,
            "description": description,
            "logo_url": _absolutise(_meta(soup, "og:image"), domain),
        }
    except Exception:
        logger.debug("markup extraction failed for %s", domain, exc_info=True)
        return None
