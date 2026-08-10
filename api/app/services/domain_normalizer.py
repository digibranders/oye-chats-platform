"""Reduce a hostname or email address to its registrable domain.

The registrable domain is the label immediately below the public suffix —
``acme.co.uk`` from ``mail.acme.co.uk``. It is the correct cache key for a
company profile: every employee's address, whatever subdomain they sit on,
must resolve to one entry.

We carry a curated suffix set rather than depend on ``tldextract``. That
package is excellent but downloads the Public Suffix List at first use, and a
network fetch during import is not something this codebase should acquire for
a best-effort enrichment path. The set below covers the multi-part suffixes a
B2B lead realistically arrives on; extend it when a real miss is reported —
an unknown multi-part suffix degrades to "one label below the last dot",
which is wrong but harmless (a slightly over-broad cache key), never a crash.
"""

from __future__ import annotations

import ipaddress
import re

# Multi-part public suffixes. Order does not matter; the longest match wins.
_MULTI_PART_SUFFIXES: frozenset[str] = frozenset(
    {
        "co.uk", "org.uk", "gov.uk", "ac.uk", "me.uk", "net.uk", "sch.uk",
        "co.in", "net.in", "org.in", "gen.in", "firm.in", "ind.in", "gov.in", "ac.in", "edu.in",
        "com.au", "net.au", "org.au", "edu.au", "gov.au",
        "co.nz", "net.nz", "org.nz", "govt.nz",
        "co.za", "org.za", "net.za", "gov.za",
        "co.jp", "or.jp", "ne.jp", "ac.jp", "go.jp",
        "com.br", "net.br", "org.br", "gov.br",
        "com.sg", "com.my", "com.hk", "com.cn", "net.cn", "org.cn", "gov.cn",
        "com.mx", "com.ar", "com.tr", "com.pk", "com.bd", "com.ph", "com.vn",
        "co.id", "co.kr", "co.il", "co.th", "com.tw", "com.sa", "com.eg",
        "co.ke", "com.ng", "com.gh",
    }
)  # fmt: skip

_LABEL_RE = re.compile(r"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$")


def registrable_domain(host: str | None) -> str | None:
    """Return the registrable domain for ``host``, or None if there isn't one.

    None means "this is not a company domain" — an empty value, a bare label,
    a public suffix on its own, an IP address, or anything with a malformed
    label. Callers treat None as "no company", never as an error.
    """
    if not host:
        return None

    value = host.strip().lower().rstrip(".")
    if not value or "." not in value:
        return None

    # An IP literal is never a company domain.
    try:
        ipaddress.ip_address(value)
        return None
    except ValueError:
        pass

    labels = value.split(".")
    if not all(_LABEL_RE.match(label) for label in labels):
        return None

    # Longest known multi-part suffix wins, so acme.co.uk beats a .uk reading.
    last_two = ".".join(labels[-2:])
    if last_two in _MULTI_PART_SUFFIXES:
        if len(labels) < 3:
            return None  # the suffix alone — no registrable name below it
        return ".".join(labels[-3:])

    if len(labels) < 2:
        return None
    return last_two


def domain_from_email(email: str | None) -> str | None:
    """Registrable domain of an email address, or None."""
    if not email or "@" not in email:
        return None
    return registrable_domain(email.rsplit("@", 1)[-1])
