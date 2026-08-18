"""Shared SSRF guard for every server-side fetch.

Any code path that fetches a URL the *caller* (or crawled content) can influence
(crawler sitemap discovery, iframe-preview HEAD checks, webhook delivery) must
validate the URL through :func:`validate_public_url` before connecting, and must
not follow redirects to an unvalidated location.

Audit references: F07 (sitemap SSRF), F11 (preview redirect SSRF), F24 (DNS
rebinding (mitigated by re-validating every redirect hop), F25 (response-size
DoS) :func:`fetch_text_safely` caps the body).

AR-42: :func:`fetch_text_safely` used to only validate via
:func:`validate_public_url`, then let aiohttp perform its own separate DNS
resolution when actually connecting, a classic DNS-rebinding TOCTOU window
(attacker DNS returns a public IP at validation time, then a private-range/
169.254.169.254 address at connect time). Fixed by resolving once via
:func:`_resolve_pinned_public_ip` and connecting to exactly that IP via a
custom aiohttp resolver (:class:`_PinnedResolver`), mirroring the pattern
``webhook_service`` already used for the outbound-webhook path.
"""

from __future__ import annotations

import ipaddress
import logging
import socket
import ssl as _ssl
from urllib.parse import urljoin, urlparse

from app.config import SSRF_TLS_VERIFY_ENABLED

logger = logging.getLogger(__name__)

_ALLOWED_SCHEMES = ("http", "https")

# Default byte cap for discovery fetches (robots.txt / sitemaps / preview bodies).
DEFAULT_MAX_BYTES = 5 * 1024 * 1024  # 5 MiB

# Built once: `create_default_context` loads the system trust store, which is
# not something to repeat per hop per candidate URL.
_VERIFYING_SSL_CONTEXT = _ssl.create_default_context()


def _tls() -> _ssl.SSLContext | bool:
    """The ``ssl=`` argument for every pinned connector and request here.

    Every fetch in this module used to pass ``ssl=False``, which disables
    certificate verification outright. Pinning the IP does not require that:
    :class:`_PinnedResolver` reports the real hostname alongside the pinned
    address, so aiohttp still sends the correct SNI and still verifies the
    certificate against the name in the URL. The two mechanisms are
    independent. Pinning decides WHERE we connect, TLS decides WHETHER the
    thing that answered is who the URL said it would be.

    Without it, an on-path attacker can substitute anything these helpers
    fetch: the sitemap that decides which pages get ingested, the footer and
    colours read off the homepage, the favicon that becomes the agent's
    avatar. All of it is served back to the customer as their own content.

    ``SSRF_TLS_VERIFY_ENABLED`` exists because turning this on can only ever
    *reduce* what we successfully fetch, a site with an expired or
    mismatched certificate now fails where it used to succeed. That failure
    is silent and per-customer (page discovery quietly falls back to a
    recursive crawl; the brand extras just yield nothing), so the flag is
    there to restore service from a variable while the certificate is chased,
    without a code push. It defaults to verifying.
    """
    return _VERIFYING_SSL_CONTEXT if SSRF_TLS_VERIFY_ENABLED else False


def _log_if_tls_failure(url: str, exc: BaseException) -> None:
    """Give a rejected certificate its own log line.

    Every fetch here collapses failure into ``None``/``True``, so a site that
    stopped working *because* verification was turned on is indistinguishable
    from a timeout or a 500, which is exactly the diagnosis someone will be
    doing when they reach for ``SSRF_TLS_VERIFY_ENABLED``. aiohttp wraps the
    error (``ClientConnectorCertificateError``), so the cause is checked too.
    """
    cause = getattr(exc, "__cause__", None)
    if isinstance(exc, _ssl.SSLError) or isinstance(cause, _ssl.SSLError):
        logger.warning("TLS verification failed for %s: %s", url, exc)


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


def _resolve_pinned_public_ip(hostname: str) -> str | None:
    """Resolve ``hostname`` once and return a single public IP to pin the
    actual connection to.

    AR-42: without this, ``validate_public_url``'s resolution and the HTTP
    client's later, separate resolution at connect time could return
    different addresses for the same hostname, an attacker-controlled DNS
    server returns a public IP the millisecond this check runs, then a
    private-range/169.254.169.254 address for the actual connection
    microseconds later. Resolving once here and pinning the connection to
    exactly this address closes that window. Fail-closed: any non-public
    resolved address (or a resolution failure) rejects the host. Mirrors
    ``webhook_service._resolve_pinned_public_ip`` for this async path.
    """
    try:
        infos = socket.getaddrinfo(hostname, None, socket.AF_UNSPEC, socket.SOCK_STREAM)
    except socket.gaierror:
        return None
    pinned: str | None = None
    for info in infos:
        try:
            ip = ipaddress.ip_address(info[4][0])
        except ValueError:
            return None
        if not ip_is_public(ip):
            return None
        if pinned is None:
            pinned = str(ip)
    return pinned


class _PinnedResolver:
    """aiohttp resolver that always returns one pre-validated, pinned IP for
    a given hostname instead of performing a fresh DNS lookup at connect
    time, the mechanism that actually closes the AR-42 TOCTOU window.
    """

    def __init__(self, pins: dict[str, str]) -> None:
        self._pins = pins

    async def resolve(self, host: str, port: int = 0, family: int = socket.AF_INET) -> list[dict]:
        pinned_ip = self._pins.get(host)
        if pinned_ip is None:
            # Should never happen. Every hostname this resolver is asked
            # to resolve was pinned before the request was issued. Fail
            # closed rather than falling through to a real DNS lookup.
            raise OSError(f"No pinned IP for host {host!r}")
        resolved_family = socket.AF_INET6 if ":" in pinned_ip else socket.AF_INET
        return [
            {
                "hostname": host,
                "host": pinned_ip,
                "port": port,
                "family": resolved_family,
                "proto": 0,
                "flags": 0,
            }
        ]

    async def close(self) -> None:
        return None


async def probe_url_alive(session, url: str) -> bool:
    """Liveness probe (HEAD, GET fallback) for ``url``, connecting only to a
    single pinned, pre-validated IP so the host that gets validated is the
    host that actually gets connected to.

    AR-42: this is the pinned-DNS counterpart of :func:`fetch_text_safely`
    for the ``check_urls_alive`` liveness-check path. Previously the lone
    holdout in this codebase that opened a *raw* ``aiohttp.ClientSession``
    and issued ``session.head()``/``session.get()`` directly. That let
    ``validate_public_url`` resolve DNS once, then aiohttp perform its own,
    separate resolution when actually connecting, a DNS-rebinding TOCTOU
    window (attacker DNS answers public at validation time, then
    private-range/169.254.169.254 at connect time). Fixed the same way
    :func:`fetch_text_safely` was: resolve once via
    :func:`_resolve_pinned_public_ip` and connect to exactly that IP through
    a custom aiohttp resolver (:class:`_PinnedResolver`).

    ``session`` is used only to inherit the caller's headers/timeout
    configuration; the actual HEAD/GET connections go through a short-lived
    session bound to the pinned resolver. Mirrors ``fetch_text_safely``.

    Liveness policy (unchanged from the pre-fix behavior of
    ``check_urls_alive``, preserved here so callers see no behavior change):
        - The URL fails :func:`validate_public_url`, or its host does not
          resolve to a single pinned public IP -> ``False``.
        - HEAD (or the GET fallback) responds 404/410 (confirmed gone) ->
          ``False``.
        - HEAD responds < 400 -> ``True``.
        - HEAD responds >= 400 (other than 404/410), or raises -> retried as
          GET; the GET result (status not in 404/410) is the final answer.
          A GET transport error is conservative -> ``True`` ("not confirmed
          dead", so a transient blip or bot-blocking firewall never deletes
          a customer's knowledge base entry).

    Never raises.
    """
    import aiohttp

    try:
        validate_public_url(url)
    except SSRFError:
        return False

    hostname = urlparse(url).hostname
    if hostname is None:
        return False
    try:
        pinned_ip = str(ipaddress.ip_address(hostname))
    except ValueError:
        pinned_ip = _resolve_pinned_public_ip(hostname)
    if pinned_ip is None:
        return False

    connector = aiohttp.TCPConnector(resolver=_PinnedResolver({hostname: pinned_ip}), ssl=_tls())
    async with aiohttp.ClientSession(headers=session.headers, timeout=session.timeout, connector=connector) as pinned:
        try:
            async with pinned.head(url, allow_redirects=False, ssl=_tls()) as resp:
                if resp.status in (404, 410):
                    return False
                if resp.status < 400:
                    return True
        except Exception as exc:
            _log_if_tls_failure(url, exc)
        try:
            async with pinned.get(url, allow_redirects=False, ssl=_tls()) as resp:
                return resp.status not in (404, 410)
        except Exception as exc:
            _log_if_tls_failure(url, exc)
            return True


async def fetch_text_safely(
    session,
    url: str,
    *,
    max_bytes: int = DEFAULT_MAX_BYTES,
    max_redirects: int = 3,
) -> tuple[int, str] | None:
    """Fetch ``url`` as text with SSRF + size guards.

    - Validates the URL (and every redirect hop) via :func:`validate_public_url`.
    - Does not let aiohttp auto-follow redirects; each ``Location`` is resolved
      and re-validated before the next hop (closes the redirect-to-internal
      bypass, F07/F11).
    - AR-42: connects to a pinned, pre-validated IP for each hop (via
      :class:`_PinnedResolver`) instead of letting aiohttp re-resolve the
      hostname at connect time. Closes the DNS-rebinding TOCTOU window
      (F24). ``session`` is used only to inherit the caller's headers/
      timeout configuration; the actual connection for each hop goes
      through a short-lived session bound to that hop's pinned resolver.
    - Caps the response body at ``max_bytes`` (F25).

    Returns ``(status_code, text)`` for a final (non-redirect) response, or
    ``None`` if the URL is unsafe, too many redirects occur, or a transport
    error is raised. Never raises. Callers treat ``None`` as "skip".
    """
    import aiohttp

    current = url
    for _ in range(max_redirects + 1):
        try:
            validate_public_url(current)
        except SSRFError:
            return None

        hostname = urlparse(current).hostname
        try:
            pinned_ip = ipaddress.ip_address(hostname)
            pinned_ip = str(pinned_ip)  # IP-literal host. Already validated above
        except ValueError:
            pinned_ip = _resolve_pinned_public_ip(hostname)
        if pinned_ip is None:
            return None

        connector = aiohttp.TCPConnector(resolver=_PinnedResolver({hostname: pinned_ip}), ssl=_tls())
        try:
            async with (
                aiohttp.ClientSession(headers=session.headers, timeout=session.timeout, connector=connector) as pinned,
                pinned.get(current, allow_redirects=False, ssl=_tls()) as resp,
            ):
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
        except Exception as exc:
            _log_if_tls_failure(current, exc)
            return None
    return None  # redirect limit exceeded


async def fetch_bytes_safely(
    session,
    url: str,
    *,
    max_bytes: int,
    max_redirects: int = 3,
) -> tuple[int, bytes] | None:
    """:func:`fetch_text_safely` for binary bodies, with one behavioural change.

    An oversized body is REJECTED, not truncated. Text can survive being cut
    short; an image cannot, a truncated PNG is either undecodable or, worse,
    decodes to something the caller then stores. Returning ``None`` means the
    caller skips it, which is the honest outcome.

    Exists because the favicon fetcher rolled its own client and got all three
    guards wrong: `follow_redirects=True` meant a customer site could 302 the
    crawl worker into the VPC, `validate_public_url` ran once on the
    pre-redirect URL only, and the size cap was applied to ``resp.content``
    AFTER the whole body had been buffered, so a slow multi-gigabyte body was
    unbounded in both memory and time.
    """
    import aiohttp

    current = url
    for _ in range(max_redirects + 1):
        try:
            validate_public_url(current)
        except SSRFError:
            return None

        hostname = urlparse(current).hostname
        try:
            pinned_ip = str(ipaddress.ip_address(hostname))
        except ValueError:
            pinned_ip = _resolve_pinned_public_ip(hostname)
        if pinned_ip is None:
            return None

        connector = aiohttp.TCPConnector(resolver=_PinnedResolver({hostname: pinned_ip}), ssl=_tls())
        try:
            async with (
                aiohttp.ClientSession(headers=session.headers, timeout=session.timeout, connector=connector) as pinned,
                pinned.get(current, allow_redirects=False, ssl=_tls()) as resp,
            ):
                if resp.status in _REDIRECT_STATUSES:
                    location = resp.headers.get("Location")
                    if not location:
                        return resp.status, b""
                    current = urljoin(current, location)
                    continue

                # Reject early on a declared length, then enforce it again
                # while streaming. Content-Length is a claim, not a promise.
                declared = resp.headers.get("Content-Length")
                if declared and declared.isdigit() and int(declared) > max_bytes:
                    return None

                chunks: list[bytes] = []
                total = 0
                async for chunk in resp.content.iter_chunked(8192):
                    total += len(chunk)
                    if total > max_bytes:
                        return None  # reject, do not truncate
                    chunks.append(chunk)
                return resp.status, b"".join(chunks)
        except Exception as exc:
            _log_if_tls_failure(current, exc)
            return None
    return None  # redirect limit exceeded
