"""Which media cards a bot may offer, and when two cards are the same file.

Two findings from the 2026-09-17 evaluation and prompt review:

* The same file reached a visitor twice. CleanStart's catalog holds its IIFL
  case study at ``/case-studies/iifl-case-study.pdf`` and at
  ``/web/case-study/iifl-case-study-29330f6b.pdf``, and the reply read "**iifl
  case study** and **iifl case study** are ready to download below". Every
  attach path compared raw URLs. ``card_identity`` gives a card the keys two
  copies of one file share: its normalised URL, and for a download whose name
  says what it is about, its normalised title.
* A knowledge base links other people's PDFs (NIST, IBM, SEBI guidance), and the
  file check (``cleaner.is_valid_file_url``) reads only the URL's shape, so a bot
  could offer an IBM report as its own download. ``is_owned_file_url`` admits a
  file only on the bot's own registrable domains (its website and the domains
  its widget is allowed on) or on a host that serves files for a company's own
  site (a website builder's asset CDN or a storage bucket). A bot with no known
  domain is not filtered, because nothing says which files are its own. Videos
  are left alone.

Pure module: no DB and no I/O.
"""

from __future__ import annotations

import re
from collections.abc import Iterable
from urllib.parse import unquote, urlsplit

from app.services.domain_normalizer import registrable_domain

#: Hosts that serve files for a company's own website: website builders' asset
#: CDNs and storage buckets. A file on one of them is the company's when its
#: page links it; there is no domain to compare.
_ASSET_HOST_RE = re.compile(
    r"(?:^|\.)(?:website-files\.com|webflow\.com|hubspotusercontent[a-z0-9-]{0,20}\.(?:net|com)|hubspot\.net"
    r"|wixstatic\.com|squarespace-cdn\.com|cdn\.shopify\.com|shopifycdn\.com|framerusercontent\.com"
    r"|ctfassets\.net|amazonaws\.com|cloudfront\.net|storage\.googleapis\.com|blob\.core\.windows\.net"
    r"|r2\.dev|b-cdn\.net|cloudinary\.com|imgix\.net)$",
    re.IGNORECASE,
)
_HTTP_SCHEMES = frozenset({"http", "https"})
#: The longest URL or name read, so a pathological value costs a bounded amount of work.
_MAX_CHARS = 4_096

#: A hash or id in a file name ("29330f6b"), which a second copy of a file often carries.
_HASH_WORD_RE = re.compile(r"[0-9a-f]{8,}")
_WORD_RE = re.compile(r"[a-z0-9]+")
_EXTENSION_RE = re.compile(r"\.[a-z0-9]{2,5}$")
#: Words that say what kind of file it is, never what it is about. A name made
#: only of these ("Brochure.pdf", "Company-Profile.pdf") is shared by unrelated
#: files, so it is no identity.
_GENERIC_TITLE_WORDS = frozenset(
    {
        "brochure", "datasheet", "data", "sheet", "spec", "case", "study", "studies", "whitepaper", "white", "paper",
        "company", "profile", "overview", "catalog", "catalogue", "deck", "ebook", "guide", "report", "one", "pager",
        "download", "file", "document", "doc", "pdf", "final", "new", "latest", "copy", "v1", "v2", "v3",
    }
)  # fmt: skip


def _host(url: object) -> str | None:
    """The lower-case host of an http(s) URL, or None."""
    if not isinstance(url, str) or not url or len(url) > _MAX_CHARS:
        return None
    try:
        parts = urlsplit(url.strip())
    except ValueError:
        return None
    if parts.scheme.lower() not in _HTTP_SCHEMES or not parts.hostname:
        return None
    return parts.hostname.lower()


def _normalized_url(url: str) -> str | None:
    """Scheme, "www." and case of the host, the query, the fragment and escapes do not tell two files apart."""
    host = _host(url)
    if host is None:
        return None
    path = unquote(urlsplit(url.strip()).path).rstrip("/")
    return f"{host.removeprefix('www.')}{path}"


def _normalized_title(name: object) -> str | None:
    """A file name as a reader says it: no extension, no ids, words only. None when it names only a kind."""
    if not isinstance(name, str) or not name.strip():
        return None
    stem = _EXTENSION_RE.sub("", unquote(name[:_MAX_CHARS]).strip().lower())
    words = [word for word in _WORD_RE.findall(stem) if not _HASH_WORD_RE.fullmatch(word)]
    if len(words) < 2 or all(word in _GENERIC_TITLE_WORDS for word in words):
        return None
    return " ".join(words)


def card_identity(card: object) -> frozenset[str]:
    """The keys two copies of the same media card share. Empty for a card with no usable id.

    A video is its id. A download is its normalised URL and, when its name says
    what the file is about, its normalised title. Keys are scoped by card type,
    so a video and a file never match.
    """
    if not isinstance(card, dict):
        return frozenset()
    if card.get("type") == "youtube":
        video_id = card.get("video_id")
        return frozenset({f"youtube:{video_id}"}) if isinstance(video_id, str) and video_id else frozenset()
    url = card.get("url")
    normalized = _normalized_url(url) if isinstance(url, str) else None
    if normalized is None:
        return frozenset()
    keys = {f"download:url:{normalized}"}
    title = _normalized_title(card.get("name"))
    if title is not None:
        keys.add(f"download:title:{title}")
    return frozenset(keys)


def dedupe_cards(cards: Iterable[object]) -> list[dict]:
    """The cards in order, each file once: a card sharing a key with an earlier one is dropped."""
    seen: set[str] = set()
    kept: list[dict] = []
    for card in cards:
        if not isinstance(card, dict):
            continue
        keys = card_identity(card)
        if not keys or keys & seen:
            continue
        seen |= keys
        kept.append(card)
    return kept


def media_owned_domains(website: object, allowed_domains: object) -> frozenset[str]:
    """The registrable domains a bot's own files live on: its website's and its widget's allowed domains'.

    A website only counts when it is set, so allowed domains alone own nothing:
    they are where the widget runs, and without the website there is no anchor
    that says the bot knows its own domain at all.
    """
    website_domain = _registrable(website)
    if website_domain is None:
        return frozenset()
    owned = {website_domain}
    if isinstance(allowed_domains, list):
        for entry in allowed_domains:
            if isinstance(entry, str):
                domain = _registrable(entry.strip().removeprefix("*."))
                if domain is not None:
                    owned.add(domain)
    return frozenset(owned)


def _registrable(value: object) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    host = _host(text if "://" in text else f"https://{text}")
    return registrable_domain(host) if host else None


def is_owned_file_url(url: object, owned: frozenset[str]) -> bool:
    """Whether a file URL may be offered as the bot's own download. ``owned`` empty filters nothing."""
    if not owned:
        return isinstance(url, str) and bool(url)
    host = _host(url)
    if host is None:
        return False
    if _ASSET_HOST_RE.search(host):
        return True
    return registrable_domain(host) in owned


def owned_media_payloads(payloads: object, owned: frozenset[str]) -> list[dict]:
    """``media_urls`` payloads with the files the bot does not own removed. The input is not changed."""
    if not isinstance(payloads, list):
        return []
    if not owned:
        return [payload for payload in payloads if isinstance(payload, dict)]
    kept: list[dict] = []
    for payload in payloads:
        if not isinstance(payload, dict):
            continue
        files = payload.get("files")
        if isinstance(files, list):
            payload = {
                **payload,
                "files": [f for f in files if isinstance(f, dict) and is_owned_file_url(f.get("url"), owned)],
            }
        kept.append(payload)
    return kept
