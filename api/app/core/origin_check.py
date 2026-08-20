"""Origin / domain whitelist validation for widget (``X-Bot-Key``) requests.

The widget bundle is publicly cacheable and its bot key is visible to anyone
who inspects the host page's DOM. To prevent a stolen key from being embedded
on an unrelated site, each Bot can declare an ``allowed_domains`` list and flip
``domain_check_enabled``. When enabled, the backend reads the request's
``Origin`` header (with ``Referer`` as a fallback) and rejects anything whose
hostname does not match an entry.

Entries support:
    * Exact hostnames           -- ``acme.com``, which also admits
                                   ``www.acme.com`` (see :func:`is_origin_allowed`)
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

    An exact entry additionally matches its ``www.`` host (``acme.com`` admits
    ``www.acme.com``), because entries are stored ``www.``-stripped and the
    customer's homepage is usually served from ``www.``. See the inline argument
    in the matching loop for why that cannot reach a third party.
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
        # ``acme.com`` also admits ``www.acme.com``.
        #
        # ``normalize_domain_input`` strips a leading ``www.`` before an entry is
        # persisted, and every write path into ``Bot.allowed_domains`` goes
        # through it: ``_normalize_allowed_domains`` (both request schemas),
        # ``_derive_allowed_domains_from_website`` (the create-flow default), and
        # the Razorpay note replay in ``razorpay_service``, which only echoes back
        # values those two already normalized. A customer therefore *cannot*
        # store ``www.acme.com`` as an entry -- listing the apex is the only way
        # to express the site at all -- while the browser sends the real
        # ``https://www.acme.com`` Origin, which ``extract_hostname``
        # deliberately keeps intact. Without this arm the customer's own
        # homepage was 403ing.
        #
        # Why this cannot admit a third party:
        #   * It is an equality test against one constructed host, not a prefix
        #     test, so ``wwwacme.com`` and ``www-acme.com`` still fail.
        #   * The single host added, ``www.<entry>``, lies inside ``<entry>``'s
        #     own DNS zone. Serving content there requires control of (or a
        #     delegation from) the exact name the customer already vouched for,
        #     so no new registrable domain becomes allowed.
        #   * It is one-directional: because ``www.`` is unstripped on the
        #     request side but always stripped on the entry side, this can only
        #     widen apex -> www, never www -> some other apex.
        # The one bounded exception is an entry that is itself a multi-tenant
        # public suffix (``github.io``), where ``www.github.io`` is a different
        # principal from ``foo.github.io``. Such an entry already grants the
        # suffix apex on its own terms, is never produced by the derive path, and
        # would be an over-broad allowlist with or without this arm.
        #
        # ``_LOCAL_HOSTS`` is excluded: ``www.localhost`` / ``www.127.0.0.1`` are
        # not names anything can be served from, so admitting them would be
        # widening with no legitimate case behind it.
        if normalized not in _LOCAL_HOSTS and host == f"www.{normalized}":
            return True
    return False


def origin_check_applies(*, domain_check_enabled: bool | None, allowed: list[str] | None) -> bool:
    """Whether a bot's origin allowlist should actually be enforced.

    The single source of truth for the fail-open contract, shared by the HTTP
    dependency (``auth._enforce_bot_origin``) and the visitor WebSocket
    (``ws_routes.visitor_websocket``) so the two transports cannot drift apart
    again -- they did: the WebSocket used to enforce an empty allowlist, which in
    production rejects *every* host, so a bot created without a website (the
    create flow turns the flag on unconditionally but derives no domains) served
    HTTP chat normally while every live-chat socket closed with 4403.

    Enforcement needs BOTH the customer's opt-in flag and at least one configured
    domain. ``domain_check_enabled`` defaults ON for new bots, so gating on a
    non-empty allowlist is what keeps that default from bricking a bot whose
    owner has not listed any domains yet.

    Both arguments accept ``None``: a Bot rebuilt from an older Redis cache entry
    can be missing the flag, and the JSONB column reads as ``None`` on a row that
    predates its server default. Either way the answer is "do not enforce".
    """
    return bool(domain_check_enabled) and bool(allowed)
