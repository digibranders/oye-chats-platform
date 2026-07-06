"""Shared SSRF guard for every server-side fetch.

Any code path that fetches a URL the *caller* (or crawled content) can influence
— crawler sitemap discovery, iframe-preview HEAD checks, webhook delivery — must
validate the URL through :func:`validate_public_url` before connecting, and must
not follow redirects to an unvalidated location.

Audit references: F07 (sitemap SSRF), F11 (preview redirect SSRF), F24 (DNS
rebinding — mitigated by re-validating every redirect hop), F25 (response-size
DoS — :func:`fetch_text_safely` caps the body).

Note on residual TOCTOU: :func:`validate_public_url` resolves the hostname and
rejects the host if *any* resolved address is non-public, then the HTTP client
performs its own resolution when connecting. Full IP-pinning (connecting to the
exact validated address) lives in ``webhook_service`` for the outbound-webhook
path; extending pinning to the async crawler is tracked as a follow-up (F24).
"""

from __future__ import annotations

import ipaddress
import socket
from urllib.parse import urljoin, urlparse

_ALLOWED_SCHEMES = ("http", "https")

# Default byte cap for discovery fetches (robots.txt / sitemaps / preview bodies).
DEFAULT_MAX_BYTES = 5 * 1024 * 1024  # 5 MiB


class SSRFError(ValueError):
    """Raised when a URL is unsafe to fetch server-side (bad scheme or a host
    that resolves to a non-public address)."""


def ip_is_public(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    """True only for globally-routable public addresses.

    Rejects private, loopback, link-local (incl. 169.254.169.254 cloud
    metadata), reserved, multicast, and unspecified (0.0.0.0/::) ranges.
    """
    return not (
        ip.is_private or ip.is_loopback or ip.is_reserved or ip.is_link_local or ip.is_multicast or ip.is_unspecified
    )


def validate_public_url(url: str) -> str:
    """Validate that ``url`` is http(s) and resolves only to public addresses.

    Returns the URL unchanged when safe; raises :class:`SSRFError` otherwise.
    Fail-closed: if the host resolves to *any* non-public address, or DNS
    resolution fails, the URL is rejected.
    """
    parsed = urlparse(url)
    if parsed.scheme not in _ALLOWED_SCHEMES:
        raise SSRFError(f"URL scheme {parsed.scheme!r} is not allowed (http/https only)")
    hostname = parsed.hostname
    if not hostname:
        raise SSRFError("URL has no host")

    # IP literal → validate directly, no DNS needed.
    try:
        literal = ipaddress.ip_address(hostname)
    except ValueError:
        literal = None
    if literal is not None:
        if not ip_is_public(literal):
            raise SSRFError(f"URL host {hostname} is a non-public address")
        return url

    # Hostname → resolve every address; reject the host if any is non-public.
    try:
        infos = socket.getaddrinfo(hostname, None, socket.AF_UNSPEC, socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise SSRFError(f"Could not resolve host {hostname}") from exc
    if not infos:
        raise SSRFError(f"Host {hostname} did not resolve to any address")
    for info in infos:
        try:
            ip = ipaddress.ip_address(info[4][0])
        except ValueError as exc:
            raise SSRFError(f"Host {hostname} resolved to an unparseable address") from exc
        if not ip_is_public(ip):
            raise SSRFError(f"Host {hostname} resolves to a non-public address {ip}")
    return url


_REDIRECT_STATUSES = frozenset({301, 302, 303, 307, 308})


async def fetch_text_safely(
    session,
    url: str,
    *,
    max_bytes: int = DEFAULT_MAX_BYTES,
    max_redirects: int = 3,
) -> tuple[int, str] | None:
    """Fetch ``url`` as text through an aiohttp ``session`` with SSRF + size guards.

    - Validates the URL (and every redirect hop) via :func:`validate_public_url`.
    - Does not let aiohttp auto-follow redirects; each ``Location`` is resolved
      and re-validated before the next hop (closes the redirect-to-internal
      bypass, F07/F11, and re-checks on rebinding, F24).
    - Caps the response body at ``max_bytes`` (F25).

    Returns ``(status_code, text)`` for a final (non-redirect) response, or
    ``None`` if the URL is unsafe, too many redirects occur, or a transport
    error is raised. Never raises — callers treat ``None`` as "skip".
    """
    current = url
    for _ in range(max_redirects + 1):
        try:
            validate_public_url(current)
        except SSRFError:
            return None
        try:
            async with session.get(current, allow_redirects=False, ssl=False) as resp:
                if resp.status in _REDIRECT_STATUSES:
                    location = resp.headers.get("Location")
                    if not location:
                        return resp.status, ""
                    current = urljoin(current, location)
                    continue
                chunks: list[bytes] = []
                total = 0
                async for chunk in resp.content.iter_chunked(8192):
                    total += len(chunk)
                    if total > max_bytes:
                        break
                    chunks.append(chunk)
                return resp.status, b"".join(chunks).decode("utf-8", errors="replace")
        except Exception:
            return None
    return None  # redirect limit exceeded
