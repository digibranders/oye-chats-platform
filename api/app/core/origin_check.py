"""Origin / domain whitelist validation for widget (``X-Bot-Key``) requests.

The widget bundle is publicly cacheable and its bot key is visible to anyone
who inspects the host page's DOM. To prevent a stolen key from being embedded
on an unrelated site, each Bot can declare an ``allowed_domains`` list and flip
``domain_check_enabled``. When enabled, the backend reads the request's
``Origin`` header (with ``Referer`` as a fallback) and rejects anything whose
hostname does not match an entry.

Entries support:
    * Exact hostnames           -- ``acme.com``
    * Wildcard subdomains       -- ``*.acme.com`` matches ``app.acme.com`` but
                                   NOT ``acme.com`` itself
    * Literal ``localhost`` /   -- accepted only when ``APP_ENV != "production"``
      ``127.0.0.1``                unless explicitly listed by the customer.

The check is browser-origin enforcement -- a script running inside another
browser cannot forge the ``Origin`` header. Non-browser clients (curl, scripts)
can spoof it, which is why rate limiting and per-bot quotas remain the
defense-in-depth layer.
"""

from __future__ import annotations

import os
import re
from urllib.parse import urlparse

# Permissive hostname check; we are not RFC-1035 strict here -- the goal is to
# reject obvious junk (whitespace, schemes, paths) before storing, not to be a
# DNS validator. Allows letters, digits, dashes, dots, plus an optional leading
# ``*.`` wildcard segment. Localhost + 127.0.0.1 are matched separately.
_DOMAIN_PATTERN = re.compile(
    r"^(?:\*\.)?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$"
)
_LOCAL_HOSTS = {"localhost", "127.0.0.1"}


def extract_hostname(origin_or_referer: str | None) -> str | None:
    """Return the lowercase hostname for an ``Origin``/``Referer`` header.

    Strips scheme, port, path, query, and fragment. Returns ``None`` for
    missing or unparseable values so the caller can decide what to do.
    """
    if not origin_or_referer:
        return None
    raw = origin_or_referer.strip()
    if not raw:
        return None
    # ``Origin`` is always scheme://host[:port]; ``Referer`` may include a path.
    if "://" not in raw:
        raw = f"https://{raw}"
    try:
        parsed = urlparse(raw)
    except ValueError:
        return None
    host = (parsed.hostname or "").strip().lower()
    return host or None


def normalize_domain_input(raw: str) -> str:
    """Clean a user-typed domain entry before persisting it.

    Accepts forgiving inputs (``https://www.Acme.com/contact``) and returns
    the canonical lowercased hostname (``acme.com``). ``www.`` is intentionally
    stripped because matching is hostname-equality plus optional ``*.`` wildcard,
    so storing ``www.acme.com`` would silently exclude the apex domain.

    Raises ``ValueError`` if the result is not a syntactically valid hostname.
    """
    if raw is None:
        raise ValueError("domain must be a string")
    cleaned = raw.strip().lower()
    if not cleaned:
        raise ValueError("domain must not be empty")

    # Preserve a deliberate wildcard prefix; only the rest of the value goes
    # through URL parsing.
    wildcard = False
    if cleaned.startswith("*."):
        wildcard = True
        cleaned = cleaned[2:]

    if "://" in cleaned:
        try:
            parsed = urlparse(cleaned)
        except ValueError as exc:
            raise ValueError(f"invalid domain: {raw!r}") from exc
        cleaned = (parsed.hostname or "").strip()

    # Drop any port, path, or trailing slash that survived parsing.
    cleaned = cleaned.split("/", 1)[0]
    cleaned = cleaned.split(":", 1)[0]
    if cleaned.startswith("www."):
        cleaned = cleaned[4:]

    if not cleaned:
        raise ValueError(f"invalid domain: {raw!r}")

    if cleaned in _LOCAL_HOSTS:
        return cleaned

    value = f"*.{cleaned}" if wildcard else cleaned
    if not _DOMAIN_PATTERN.match(value):
        raise ValueError(f"invalid domain: {raw!r}")
    return value


def is_origin_allowed(
    hostname: str | None,
    allowed: list[str],
    *,
    app_env: str | None = None,
) -> bool:
    """Decide whether ``hostname`` is permitted by the bot's ``allowed`` list.

    ``hostname`` should already be a bare host (use :func:`extract_hostname`).
    ``allowed`` entries are expected to be normalized (lowercased, no scheme).
    ``localhost``/``127.0.0.1`` are auto-allowed in non-production environments
    so customers don't have to add them while testing locally; production never
    auto-allows -- they must opt in explicitly.
    """
    if not hostname:
        return False
    host = hostname.strip().lower()
    if not host:
        return False

    env = (app_env if app_env is not None else os.getenv("APP_ENV", "development")).lower()
    if host in _LOCAL_HOSTS and env != "production":
        return True

    for entry in allowed:
        if not entry:
            continue
        normalized = entry.strip().lower()
        if not normalized:
            continue
        if normalized.startswith("*."):
            suffix = normalized[1:]  # ".acme.com"
            # Wildcard matches a strict subdomain only, never the apex.
            if host.endswith(suffix) and host != suffix[1:]:
                return True
            continue
        if host == normalized:
            return True
    return False
