"""The last thing that touches a Sentry payload before it leaves the process.

``send_default_pii=False`` is set at both ``sentry_sdk.init`` call sites, and it
does most of the work: it suppresses ``user.ip_address`` and the ``REMOTE_ADDR``
env block, and it turns on the SDK's header scrubber. But that scrubber works
off a fixed list — ``sentry_sdk.integrations._wsgi_common.SENSITIVE_ENV_KEYS`` —
which knows about ``x-forwarded-for``, ``x-real-ip``, ``cookie``, ``set-cookie``,
``authorization`` and ``x-api-key``, and nothing else. Two gaps follow from that:

VISITOR IP
    Nginx rewrites ``X-Forwarded-For`` to the Cloudflare edge address, so the
    header the SDK scrubs is the one with no visitor in it.
    ``chat_routes._parse_request_context`` reads ``CF-Connecting-IP`` *first*
    for exactly that reason — and ``CF-Connecting-IP`` is not on the SDK's list.
    ``SentryAsgiMiddleware`` attaches the full header dict to every event, so
    the real address rode out on ordinary traffic: ``core.metrics
    .forward_to_sentry_if_alertable`` fires ``capture_message`` from inside the
    chat request on every ``injection_attempt`` / ``moderation_block`` /
    ``system_prompt_leak``, and ``traces_sample_rate=0.1`` ships a transaction
    for a tenth of all requests besides. A visitor IP is personal data under
    GDPR and under India's DPDP Act, where this product's basis is consent-only
    with no legitimate-interest fallback.

CREDENTIALS
    ``X-Operator-Key`` and its ``X-Agent-Key`` alias (see ``api/auth.py``) are
    long-lived bearer credentials for an operator's whole workspace. The SDK has
    no way to know that, so it forwarded them verbatim on every event raised
    from an operator-authenticated request. ``X-Bot-Key`` is deliberately NOT
    stripped: it ships in the public embed snippet on the customer's own website
    and is the fastest way to tell which agent an error came from.

Headers are dropped, not replaced with a marker — the same call the Langfuse fix
made in d041a7a. A field whose only value is a constant is not a diagnostic, and
the SDK's own substitute (``AnnotatedValue.removed_because_over_size_limit``) is
both a constant and a lie about why it went. Everything else in the request
context — method, URL, path, ``user-agent``, ``x-bot-key``, ``referer`` — stays,
because stripping an address is the goal and gutting the context so nobody can
debug a 500 is not.

WHY A HOOK AND NOT THE CALL SITES
    The header dict is assembled by the SDK's own ASGI middleware, not by any
    line of code in this repository, so there is no call site to patch. A
    ``before_send`` hook is also the only spelling that covers event types that
    do not exist yet: it runs on errors, on ``capture_message``, and — wired
    separately as ``before_send_transaction``, because Sentry does not route
    transactions through ``before_send`` — on performance events, which carry
    the identical ``request`` block because the ASGI middleware registers its
    event processor on the isolation scope, where it sees every event kind.

WHAT THIS HOOK DOES NOT COVER
    Breadcrumbs and log-record messages. A regex that hunts IP-shaped tokens
    through free text over-redacts (a version string reads as an IPv4 address)
    and under-redacts (any format nobody anticipated), which buys assurance
    rather than privacy. Those leaks are closed where the string is built —
    see the PRIVACY notes in ``chat_routes._resolve_and_update_location``,
    ``ip_intel_service.fetch_ip_intel``, ``lead_routes.send_followup_email``
    and ``email_service._email_failure_tags`` — and kept from crossing between
    unrelated requests by the per-task scope fork in ``core.thread_pool``.
"""

from __future__ import annotations

from typing import Any

# Request headers that carry the visitor's real IP address and that the Sentry
# SDK does not scrub for us. All lowercase; the ASGI spec lowercases header
# names, and :func:`scrub_event` lowercases again before matching so a
# non-conforming server cannot slip one through on casing alone.
#
# ``cf-connecting-ip`` is the one that actually fires here — it is what
# Cloudflare sets and what ``chat_routes`` trusts. The rest are the other
# vendors' spellings of the same thing, listed so that swapping CDN or adding
# a load balancer does not silently reopen this.
VISITOR_IP_HEADERS = frozenset(
    {
        "cf-connecting-ip",
        "cf-connecting-ipv6",
        "cf-pseudo-ipv4",
        "true-client-ip",
        "fastly-client-ip",
        "x-client-ip",
        "x-cluster-client-ip",
        "x-original-forwarded-for",
        # RFC 7239's ``Forwarded: for=<addr>`` — the standardised form of
        # X-Forwarded-For, and the one the SDK's list predates.
        "forwarded",
    }
)

# ``cf-ipcountry`` is deliberately absent: a two-letter country code is not a
# visitor, and it is the only geography left on an event once the address is
# gone.

# Bearer credentials this application defines. The SDK strips ``x-api-key`` and
# ``authorization`` on its own; these two it has never heard of.
CREDENTIAL_HEADERS = frozenset({"x-operator-key", "x-agent-key"})

_STRIPPED_HEADERS = VISITOR_IP_HEADERS | CREDENTIAL_HEADERS


def _strip_request_headers(event: dict[str, Any]) -> None:
    """Remove every :data:`_STRIPPED_HEADERS` entry from ``event["request"]``.

    Mutates in place. The event dict is the SDK's own, handed to the hook
    immediately before serialisation, so there is nothing downstream to copy
    for.
    """
    request = event.get("request")
    if not isinstance(request, dict):
        return
    headers = request.get("headers")
    # Not always a dict: the SDK substitutes an ``AnnotatedValue`` when a
    # payload is trimmed for size. Nothing to strip in that case — the value is
    # already gone.
    if not isinstance(headers, dict):
        return
    for key in [k for k in headers if isinstance(k, str) and k.lower() in _STRIPPED_HEADERS]:
        del headers[key]


def scrub_event(event: dict[str, Any] | None, hint: dict[str, Any] | None = None) -> dict[str, Any] | None:
    """``before_send`` / ``before_send_transaction`` hook. Returns ``event``.

    Never raises and never returns ``None`` for an event it was given: a hook
    that throws makes the SDK discard the event outright, so a bug in here would
    take error reporting down with it. If the scrub itself fails, the whole
    ``request`` block is dropped rather than sent unscrubbed — fail closed on
    the part that holds the address, and keep the stack trace, tags and
    breadcrumbs that make the event worth having.

    ``hint`` is unused. It is in the signature because Sentry passes it
    positionally.
    """
    if not isinstance(event, dict):
        return event
    try:
        _strip_request_headers(event)
    except Exception:  # noqa: BLE001 - see the fail-closed note above
        event.pop("request", None)
    return event
