"""Read a company's identity out of its own HTML. No LLM, no network.

Two sources only, most-authoritative first:

1. schema.org ``Organization`` (and its subtypes), the entity the publisher
   declares, preferring one whose ``url`` matches the domain we fetched.
2. ``og:site_name``, the brand the publisher declares.

Both are *declarations*, which is why they outrank the LLM fallback: a model
can only infer a name from page copy, and inference is where wrong answers
come from. Measured against real lead domains, 3 of 4 carried ``og:site_name``
and 2 of 4 carried a schema.org Organization block.

## Why ``<title>`` is deliberately NOT a source

An earlier version mined the ``<title>`` as a third tier. Adversarial review
reproduced three separate classes of wrong answer from it, all in the
expensive direction:

* ``"Kumar Textiles | Surat"`` → ``"Surat"``. The brand is usually the shorter
  segment, except when it isn't, and "Brand | City" is a standard shape in
  this platform's market.
* ``"Shah Industries | Steel | Mumbai"`` on ``mumbaisteel.com`` → ``"Mumbai"``,
  because a city that appears in the domain satisfies any domain-echo check.
* ``"Sitio en construcción"``, ``"Just another WordPress site"`` → returned
  verbatim. A blocklist of interstitial phrases can only ever cover the
  languages and CMS defaults someone thought to enumerate.

Each fix produced another variant of the same bug, which is the signal that
the heuristic itself is unsound rather than under-tuned. A title is written
for search engines and humans, not for machines, so nothing in it is a
declaration. Dropping it costs coverage on sites that declare nothing. Those
now fall through to the LLM, which is exactly the cheap direction.

## Failing closed

A false negative is cheap: the caller falls back to the LLM, and a domain that
resolves to nothing is cached as a failure. A false POSITIVE is expensive,
the name is written to a cross-tenant cache and shown to a salesperson as
fact. Every guard below is therefore biased toward returning None.
"""

from __future__ import annotations

import html as html_lib
import json
import logging
import re
from urllib.parse import urlparse

from bs4 import BeautifulSoup

logger = logging.getLogger(__name__)

_MAX_NAME_LEN = 80
_MAX_DESCRIPTION_LEN = 500
_MAX_URL_LEN = 500
_MAX_JSON_LD_DEPTH = 40

# schema.org types that denote the site's owning organisation.
_ORG_TYPES = {
    "organization", "corporation", "localbusiness", "onlinestore", "onlinebusiness",
    "ngo", "governmentorganization", "educationalorganization", "nonprofit",
    "professionalservice", "store", "restaurant", "medicalorganization",
}  # fmt: skip

_GENERIC_TITLES = {
    "home", "welcome", "index", "untitled", "home page", "homepage",
    "404", "not found", "page not found", "main", "default", "new page",
    "forbidden", "unauthorized", "403 forbidden", "401 unauthorized",
    "access denied", "error", "server error", "500 internal server error",
}  # fmt: skip

# Interstitial detection is split in two so matching can be anchored.
#
# WORDS are matched on token boundaries. A raw substring test rejected real
# companies. "Sparked" contains "parked", "Sedona" contains "sedo".
_INTERSTITIAL_WORDS = frozenset(
    {
        "cloudflare", "captcha", "recaptcha",
        "parked", "suspended", "webmaster", "plesk", "cpanel", "htdocs",
        "baustelle", "wartung", "mantenimiento", "manutencao", "manutenzione",
    }
)  # fmt: skip
# NOTE "forbidden" and "unauthorized" are NOT here. As standalone words they
# belong to real companies (Forbidden Planet is a UK retail chain) so they
# are matched exactly via _GENERIC_TITLES instead, alongside the "403
# forbidden" phrase below. A bare status word is a status page; the same word
# inside a longer name is a name.

# PHRASES are matched as substrings; each is long enough to be unambiguous.
# Includes the common non-English and default-CMS titles, because a parked
# page in Spanish is exactly as wrong as one in English.
_INTERSTITIAL_PHRASES = (
    "just a moment",
    "attention required",
    "access denied",
    "bad gateway",
    "gateway timeout",
    "service unavailable",
    "temporarily unavailable",
    "403 forbidden",
    "401 unauthorized",
    "internal server error",
    "coming soon",
    "under construction",
    "site maintenance",
    "maintenance mode",
    "default page",
    "default web page",
    "welcome to nginx",
    "apache2 ",
    "iis windows",
    "buy this domain",
    "buy domain",
    "domain for sale",
    "this domain is",
    "domain is parked",
    "are you a robot",
    "security check",
    "please enable javascript",
    "page not available",
    "page not found",
    "not found",
    "index of /",
    "site title",
    "just another wordpress",
    "wordpress site",
    "wix.com site",
    "untitled document",
    "test page",
    "hello world",
    "en construccion",
    "en construcción",
    "en maintenance",
    "im aufbau",
    "in costruzione",
    "em construcao",
    "em construção",
    "diese domain",
    "esta web",
    "site en cours",
    "该域名",
    "域名停放",
    "припаркован",
    "заглушка",
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
    """Does this read as a parked / error / bot-wall page rather than a company?

    Matched on WORD boundaries, not raw substrings. Unanchored matching
    rejected real companies whose names merely contain a marker. "Sparked"
    and "Sedona Systems" tripped "parked"/"sedo", "Trial and Error Films"
    tripped "error", and "Apache Corporation" (a Fortune 500 oil company) was
    dropped by the web-server blocklist.
    """
    words = set(re.findall(r"[a-z0-9]+", value.lower()))
    lowered = value.lower()
    if _INTERSTITIAL_WORDS & words:
        return True
    return any(phrase in lowered for phrase in _INTERSTITIAL_PHRASES)


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


def _absolutise(url: str | None, domain: str) -> str | None:
    """Resolve a logo URL, or None.

    Bounded like every other stored field: this value is written to the
    cache and rendered as an ``<img>`` in the admin UI, so an unbounded
    string is both a column-size problem and an easy tracking pixel.
    """
    if not url or len(url) > _MAX_URL_LEN:
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


def extract_logo(html: str | None, domain: str) -> str | None:
    """The site's logo, independent of whether it declared a name.

    A page can carry an ``og:image`` while declaring no identity, so the logo
    should not be lost merely because the name needed an LLM. Shares the
    parsing and absolutising rules with :func:`extract_from_markup`, a
    separate regex here previously mishandled attribute order, ``name=``
    instead of ``property=``, and HTML entities, the last of which wrote a
    broken URL into a cache every tenant renders.
    """
    if not html:
        return None
    try:
        soup = BeautifulSoup(html, "html.parser")
        return _absolutise(_meta(soup, "og:image"), domain)
    except Exception:
        logger.debug("logo extraction failed for %s", domain, exc_info=True)
        return None


def extract_from_markup(html: str | None, domain: str) -> dict | None:
    """Return ``{"name", "description", "logo_url"}`` or None.

    None means "this page did not declare a usable identity", the caller
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
