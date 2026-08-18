"""Reduce a hostname to its registrable domain.

The registrable domain is the label immediately below the public suffix.
``acme.co.uk`` from ``mail.acme.co.uk``. It is the cache key for a company
profile: every employee's address, on whatever subdomain, must resolve to one
entry.

## Why a curated suffix set, and why it fails CLOSED

We carry a curated set rather than depend on ``tldextract``, which downloads
the Public Suffix List over the network at first use, not a property this
codebase should acquire for a best-effort enrichment path.

The consequence has to be handled carefully, because ``company_profile.domain``
is a **cross-tenant** primary key. If an unknown multi-part suffix caused us to
return the suffix itself, one customer's lead would create a cache entry that
every other customer's lead under that suffix then reads. Concretely:
``acme.myshopify.com`` collapsing to ``myshopify.com`` would attribute every
Shopify-hosted lead on the platform to "Shopify".

So the set covers BOTH sections of the PSL that matter here, the ccTLD
second-levels AND the private section (hosting platforms).

For whatever is still missing, there is a backstop: a two-label result whose
first label is generic (:data:`_SUFFIX_LIKE_LABELS`. ``co``, ``asso``,
``nom``, ``gob``, ``nhs``…) under a TLD that does not register flat
(:data:`_FLAT_GTLDS`) is almost certainly a public suffix we do not carry, and
returns ``None``. So ``acme.asso.fr`` yields nothing rather than handing back
``asso.fr`` as a key shared by every French association on the platform.

An unrecognised suffix therefore degrades to a cheap miss the caller falls
back from, never to a poisoned shared key. An earlier version claimed this
protection via a constant that was provably inert (emptying it failed no
tests) so the guarantee is now expressed as a rule with tests that fail when
it is weakened.

## Scope

This module answers "what is the registrable domain of this host?" and nothing
else. It deliberately knows nothing about free email providers, for the
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
#
# NOTE these are suffixes, not exclusions: the apex itself is usually a real
# company (someone does work at squarespace.com), so `squarespace.com` returns
# ITSELF while `acme.squarespace.com` returns `acme.squarespace.com`. Only the
# ICANN entries above are never-a-company at the apex. Nobody is reachable
# at `co.uk`.
_PLATFORM_SUFFIXES: frozenset[str] = frozenset(
    {
        "myshopify.com", "shopifypreview.com",
        "github.io", "gitlab.io",
        "vercel.app", "netlify.app", "netlify.com", "pages.dev", "workers.dev",
        "web.app", "firebaseapp.com", "appspot.com",
        "herokuapp.com", "azurewebsites.net", "cloudapp.net",
        "amazonaws.com", "cloudfront.net", "elasticbeanstalk.com", "pythonanywhere.com",
        "wixsite.com", "editorx.io", "squarespace.com", "weebly.com",
        "blogspot.com", "wordpress.com", "tumblr.com", "ghost.io",
        "notion.site", "webflow.io", "framer.website", "carrd.co",
        "bubbleapps.io", "glitch.me", "replit.app", "onrender.com", "fly.dev",
        "substack.com", "medium.com",
        "sharepoint.com", "zohosites.com", "hubspotpagebuilder.com",
    }
)  # fmt: skip

_MULTI_PART_SUFFIXES: frozenset[str] = _ICANN_MULTI_PART | _PLATFORM_SUFFIXES

# Hosts under these TLDs are never public companies.
_RESERVED_TLDS: frozenset[str] = frozenset(
    {"local", "internal", "localdomain", "localhost", "test", "invalid", "example", "onion", "arpa"}
)

# gTLDs that register FLAT. Every second level is a real registrable domain,
# so the unknown-suffix backstop below must not swallow web.com, go.com
# (Disney), or info.com.
#
# ccTLDs are deliberately absent. Many of them (.fr, .br, .in, .jp, .uk, .at)
# carry second-level structures. Asso.fr, nom.br, res.in, ed.jp, nhs.uk,
# gv.at. That we cannot enumerate exhaustively without the full PSL. Under a
# ccTLD a generic second label therefore fails closed. That loses the odd real
# domain such as web.de, which is a cheap false negative; returning `asso.fr`
# as a company would be an expensive shared-key collision.
_FLAT_GTLDS: frozenset[str] = frozenset(
    {
        "com", "net", "org", "io", "app", "dev", "ai", "me", "xyz", "tech",
        "digital", "agency", "studio", "cloud", "shop", "store", "online", "site",
        "biz", "info", "inc", "llc", "ltd", "group", "team", "works", "solutions",
        "email", "world", "life", "live", "news", "blog", "design", "software",
    }
)  # fmt: skip

# Generic second-level labels. A two-label result made of one of these under an
# UNKNOWN TLD ("co.zz", "gob.pe" before it was listed) is almost certainly a
# public suffix we do not carry, and must not become a shared cache key.
_SUFFIX_LIKE_LABELS: frozenset[str] = frozenset(
    {
        "co", "com", "net", "org", "gov", "edu", "ac", "or", "ne", "go", "web",
        "info", "biz", "gob", "gouv", "asso", "nom", "res", "ind", "firm", "gen",
        "in", "ed", "gv", "nhs", "sch", "plc", "ltd", "govt", "mil", "int",
    }
)  # fmt: skip

_LABEL_RE = re.compile(r"[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?")
_MAX_HOST_LEN = 253


def registrable_domain(host: str | None) -> str | None:
    """Return the registrable domain for ``host``, or None if there isn't one.

    None means "not a company domain" and is a normal, expected outcome, an
    empty value, a bare label, a public suffix on its own, an IP literal, a
    reserved TLD, or a suffix this module does not recognise. Callers treat it
    as "no company", never as an error. This function does not raise.
    """
    if not host or not isinstance(host, str):
        return None

    value = host.strip().lower().rstrip(".")
    # Strip www BEFORE any suffix logic. Otherwise www.medium.com becomes its
    # own key alongside medium.com, and the platform branch never fires.
    value = value.removeprefix("www.")
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
    # value that `ipaddress` rejects. "999.999.999.999", "123.456". Is read
    # as a domain and becomes a junk cache row.
    if not any(ch.isalpha() for ch in labels[-1]):
        return None

    # Longest known multi-part suffix wins, so acme.co.uk beats a .uk reading.
    last_two = ".".join(labels[-2:])
    if last_two in _MULTI_PART_SUFFIXES:
        if len(labels) >= 3:
            return ".".join(labels[-3:])
        # The input IS the suffix. For an ICANN suffix that is never a company
        # (nobody is reachable at co.uk); for a platform apex it is the
        # platform's own company (someone does work at squarespace.com).
        return last_two if last_two in _PLATFORM_SUFFIXES else None

    if len(labels) < 2:
        return None

    # Backstop for a multi-part suffix we do not carry. Returning `in.th` or
    # `asso.fr` here would hand back a key shared by every tenant under it, so
    # a generic second-level under an unfamiliar TLD fails closed instead.
    if labels[-2] in _SUFFIX_LIKE_LABELS and labels[-1] not in _FLAT_GTLDS:
        return None

    return last_two
