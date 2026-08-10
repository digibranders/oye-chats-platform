"""Reduce a hostname to its registrable domain.

The registrable domain is the label immediately below the public suffix —
``acme.co.uk`` from ``mail.acme.co.uk``. It is the cache key for a company
profile: every employee's address, on whatever subdomain, must resolve to one
entry.

## Why a curated suffix set, and why it fails CLOSED

We carry a curated set rather than depend on ``tldextract``, which downloads
the Public Suffix List over the network at first use — not a property this
codebase should acquire for a best-effort enrichment path.

The consequence has to be handled carefully, because ``company_profile.domain``
is a **cross-tenant** primary key. If an unknown multi-part suffix caused us to
return the suffix itself, one customer's lead would create a cache entry that
every other customer's lead under that suffix then reads. Concretely:
``acme.myshopify.com`` collapsing to ``myshopify.com`` would attribute every
Shopify-hosted lead on the platform to "Shopify".

So the set covers BOTH sections of the PSL that matter here — the ccTLD
second-levels AND the private section (hosting platforms) — and, as a backstop
for whatever is still missing, :data:`_NEVER_A_COMPANY` rejects a computed
result that is itself a known public suffix. An unknown suffix therefore
degrades to ``None`` (a cheap miss the caller falls back from) rather than to a
poisoned shared key.

## Scope

This module answers "what is the registrable domain of this host?" and nothing
else. It deliberately knows nothing about free email providers — for the
"which company does this address belong to?" question, call
``email_domain_service.extract_company_domain``, which applies that policy on
top of this normalisation. Keeping one public entry point per question stops
the two from drifting apart.
"""

from __future__ import annotations

import ipaddress
import re

# ── ICANN section: ccTLD second-levels ─────────────────────────────────────
_ICANN_MULTI_PART: frozenset[str] = frozenset(
    {
        "co.uk", "org.uk", "gov.uk", "ac.uk", "me.uk", "net.uk", "sch.uk", "ltd.uk", "plc.uk",
        "co.in", "net.in", "org.in", "gen.in", "firm.in", "ind.in", "gov.in", "ac.in", "edu.in",
        "com.au", "net.au", "org.au", "edu.au", "gov.au", "asn.au", "id.au",
        "co.nz", "net.nz", "org.nz", "govt.nz", "ac.nz",
        "co.za", "org.za", "net.za", "gov.za", "web.za",
        "co.jp", "or.jp", "ne.jp", "ac.jp", "go.jp", "gr.jp",
        "co.kr", "or.kr", "ne.kr", "re.kr", "pe.kr", "go.kr", "ac.kr",
        "com.br", "net.br", "org.br", "gov.br",
        "com.sg", "com.my", "com.hk", "com.cn", "net.cn", "org.cn", "gov.cn", "edu.cn",
        "com.mx", "com.ar", "com.tr", "com.pk", "com.bd", "com.ph", "com.vn", "com.tw",
        "com.co", "com.pe", "com.ec", "com.uy", "com.ve", "com.bo", "com.py", "com.do",
        "com.pl", "com.ua", "com.ru", "com.es", "com.pt", "com.gr", "com.cy", "com.mt",
        "com.sa", "com.eg", "com.qa", "com.kw", "com.lb", "com.bh", "com.om", "com.jo",
        "com.ng", "com.gh", "com.tz", "com.et",
        "co.id", "co.il", "co.th", "co.ke", "co.cr", "co.at", "co.ma", "co.ug", "co.zm",
        "org.mx", "org.ar", "net.mx", "gob.mx",
        "uk.com", "eu.com", "us.com", "za.com", "br.com", "cn.com", "de.com",
    }
)  # fmt: skip

# ── PSL private section: hosting platforms ─────────────────────────────────
# Without these, every site hosted on a platform collapses onto the PLATFORM,
# which is the worst outcome for a cross-tenant cache.
_PLATFORM_SUFFIXES: frozenset[str] = frozenset(
    {
        "myshopify.com", "shopifypreview.com",
        "github.io", "gitlab.io", "pages.github.com",
        "vercel.app", "netlify.app", "netlify.com", "pages.dev", "workers.dev",
        "web.app", "firebaseapp.com", "appspot.com",
        "herokuapp.com", "azurewebsites.net", "cloudapp.net",
        "amazonaws.com", "elasticbeanstalk.com",
        "wixsite.com", "editorx.io", "squarespace.com", "weebly.com",
        "blogspot.com", "wordpress.com", "tumblr.com", "ghost.io",
        "notion.site", "webflow.io", "framer.website", "carrd.co",
        "bubbleapps.io", "glitch.me", "replit.app", "onrender.com", "fly.dev",
        "substack.com", "medium.com",
        "sharepoint.com", "zohosites.com", "hubspotpagebuilder.com",
    }
)  # fmt: skip

_MULTI_PART_SUFFIXES: frozenset[str] = _ICANN_MULTI_PART | _PLATFORM_SUFFIXES

# Backstop. If the computed registrable domain is ITSELF a known public
# suffix, the input carried a suffix we do not recognise and we must fail
# closed rather than hand back a key shared by every tenant under it.
_NEVER_A_COMPANY: frozenset[str] = _MULTI_PART_SUFFIXES

# Hosts under these TLDs are never public companies.
_RESERVED_TLDS: frozenset[str] = frozenset(
    {"local", "internal", "localdomain", "localhost", "test", "invalid", "example", "onion", "arpa"}
)

# A generic second-level that is almost certainly a public suffix we do not
# know, e.g. "acme.co.zz" → "acme.co.zz" would be right, but "co.zz" alone is
# not a company. Used to reject a two-label result made only of these.
_SUFFIX_LIKE_LABELS: frozenset[str] = frozenset(
    {"co", "com", "net", "org", "gov", "edu", "ac", "or", "ne", "go", "web", "info", "biz"}
)

_LABEL_RE = re.compile(r"[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?")
_MAX_HOST_LEN = 253


def registrable_domain(host: str | None) -> str | None:
    """Return the registrable domain for ``host``, or None if there isn't one.

    None means "not a company domain" and is a normal, expected outcome — an
    empty value, a bare label, a public suffix on its own, an IP literal, a
    reserved TLD, or a suffix this module does not recognise. Callers treat it
    as "no company", never as an error. This function does not raise.
    """
    if not host or not isinstance(host, str):
        return None

    value = host.strip().lower().rstrip(".")
    if not value or "." not in value or len(value) > _MAX_HOST_LEN:
        return None

    # An IP literal is never a company domain.
    try:
        ipaddress.ip_address(value)
        return None
    except ValueError:
        pass

    labels = value.split(".")
    # fullmatch, not match: `$` also matches before a trailing newline, and this
    # value becomes a database primary key and part of a crawl URL.
    if not all(_LABEL_RE.fullmatch(label) for label in labels):
        return None

    if labels[-1] in _RESERVED_TLDS:
        return None

    # A real TLD always contains a letter. Without this, a malformed IP-like
    # value that `ipaddress` rejects — "999.999.999.999", "123.456" — is read
    # as a domain and becomes a junk cache row.
    if not any(ch.isalpha() for ch in labels[-1]):
        return None

    # Longest known multi-part suffix wins, so acme.co.uk beats a .uk reading.
    last_two = ".".join(labels[-2:])
    if last_two in _MULTI_PART_SUFFIXES:
        if len(labels) < 3:
            return None  # the suffix alone — no registrable name below it
        candidate = ".".join(labels[-3:])
    elif len(labels) >= 2:
        candidate = last_two
    else:
        return None

    # Fail closed on a suffix we evidently do not know about.
    if candidate in _NEVER_A_COMPANY:
        return None
    parts = candidate.split(".")
    if len(parts) == 2 and parts[0] in _SUFFIX_LIKE_LABELS:
        # "co.zz" / "com.zz" — a generic second-level under an unknown TLD.
        return None

    return candidate
