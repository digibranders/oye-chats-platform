"""Request geolocation helpers.

We resolve the requesting client's country code (ISO 3166-1 alpha-2, uppercase)
purely from edge-provided headers — no third-party IP-lookup service, no
GeoIP database to ship with the API. This keeps the dependency surface tiny
and the resolution sub-millisecond.

Header precedence (first non-empty wins):

  1. ``CF-IPCountry``           — Cloudflare (set when the request goes
                                 through Cloudflare's edge; the value is
                                 ``XX`` for unknown and ``T1`` for Tor).
  2. ``X-Vercel-IP-Country``    — Vercel edge for the marketing site /
                                 admin app proxying through Vercel.
  3. ``CloudFront-Viewer-Country`` — AWS CloudFront, retained for parity.
  4. ``X-Country-Code``         — explicit override (used by the dev override
                                 query string ``?country=IN`` once the request
                                 is rewritten by ``resolve_country``).

If none are present (local dev, direct origin hit), we return ``None`` and
let the caller decide on a default. We deliberately do NOT default to ``IN``
or ``US`` here — the billing path treats *unknown* as *non-Indian* (USD
display) by design; surfacing the ambiguity at the call site keeps that
explicit.
"""

from __future__ import annotations

from fastapi import Request

# Headers that may carry an ISO 3166-1 alpha-2 country code, in priority order.
_COUNTRY_HEADERS: tuple[str, ...] = (
    "cf-ipcountry",
    "x-vercel-ip-country",
    "cloudfront-viewer-country",
    "x-country-code",
)

# Cloudflare emits these for unresolvable clients — treat as "no signal".
_UNKNOWN_CF_VALUES = frozenset({"XX", "T1"})


def resolve_country(request: Request) -> str | None:
    """Return the ISO alpha-2 country code for the request, or ``None``.

    The query-string override ``?country=XX`` (uppercase 2-letter) takes
    precedence so the admin checkout page can offer a manual currency
    toggle without us touching every header-aware caller. The override
    is intentionally not authenticated — it only changes *display*, never
    *billing*, since the gateway pins currency from the Razorpay plan.
    """
    override = request.query_params.get("country")
    if override:
        code = override.strip().upper()
        if len(code) == 2 and code.isalpha():
            return code

    for header in _COUNTRY_HEADERS:
        raw = request.headers.get(header)
        if not raw:
            continue
        code = raw.strip().upper()
        if not code or code in _UNKNOWN_CF_VALUES:
            continue
        # Some proxies forward a comma-joined list; first value is the client.
        first = code.split(",", 1)[0].strip()
        if len(first) == 2 and first.isalpha():
            return first

    return None


def is_indian(request: Request) -> bool:
    """Convenience wrapper — ``True`` only when the country resolves to ``IN``.

    Anything else (including ``None`` for local dev) is treated as non-Indian.
    Callers that need a tri-state (IN / non-IN / unknown) should call
    ``resolve_country`` directly.
    """
    return resolve_country(request) == "IN"
