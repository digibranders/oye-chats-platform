"""The one place a visitor's IP address is stripped out of what we emit.

A visitor IP reaches the wire from two stored columns, and this module owns
both. ``ChatSession.location`` embeds it in a display string; and
``ChatSession.visitor_metadata["ip_intel"]["resolved_for_ip"]`` records it
verbatim as bookkeeping (see :func:`redact_visitor_metadata`).

``ChatSession.location`` is stored with the visitor's IP address inside the
string. ``chat_routes`` writes exactly three shapes:

    "<City>, <Country> | <IP>"   resolved by the background geo lookup
    "<Country> | <IP>"           same, when the vendor had no city
    "IP: <IP>"                   the synchronous stamp, before geo resolves

A visitor IP is personal data under GDPR and under India's DPDP Act, and this
product's consent posture is consent-only — there is no legitimate-interest
basis to fall back on. So the IP may be *recorded* (ops needs it, and
``chat_routes._already_resolved`` reads the trailing address to avoid re-billing
a geo lookup on every message), but it must not *leave*: not in an API
response, not in a CSV a customer downloads, not on an operator's screen.

Every serialising caller goes through this module. It exists because the rule
was previously written out by hand at each boundary, and the copies drifted:
``GET /leads/export`` shipped the raw column — every lead, with its IP — while
the dashboard next to it stripped it. One implementation, one place to audit.

WHAT IS NOT REDACTED HERE
    ``db.repository.get_visitor_data`` deliberately returns the raw column. Its
    only caller (``analytics_routes.get_visitor_sessions``) uses the trailing
    IP as the dedup key that collapses many sessions into one visitor, and then
    calls :func:`format_visitor_location` for the value it actually returns.
    That key is a dict key on the server and is never serialised.

WHY OBSERVABILITY DOES NOT CALL THIS MODULE
    ``rag_service`` used to attach ``location`` to the Langfuse trace for every
    chat request, sending visitor IPs to a third-party processor. It does not
    route through :func:`format_visitor_location` now, because on the request
    path the value is always the ``"IP: <addr>"`` stamp — redacting it yields
    the constant ``"Unknown"`` for every trace, a field with no observability
    value. The field is dropped at both Langfuse call sites instead; see the
    PRIVACY notes in ``rag_pipeline`` / ``rag_pipeline_stream``. Redaction is
    for boundaries where a customer is entitled to the geography; a third-party
    processor is not a boundary, it is a transfer.

MIRROR
    The admin dashboard keeps a TypeScript twin at
    ``app/src/features/leads/leadModel.ts`` (``formatLocation`` /
    ``UNKNOWN_LOCATION``) so a lead row rendered from a cached payload is
    redacted client-side too. It is a belt-and-braces copy, not the source of
    truth — this module is. Change one, change the other.
"""

from __future__ import annotations

# What a table cell or an API field shows when a session has no geography we
# can name. A word, because it is read by a human in a UI; a file says the same
# thing with an empty cell, which is why :func:`redact_visitor_ip` hands back
# ``None`` and lets each caller spell its own absence.
UNKNOWN_LOCATION = "Unknown"


def redact_visitor_ip(raw: str | None) -> str | None:
    """Return the human-readable geography in ``raw``, or ``None`` if there is none.

    This is the rule; the absence convention is the caller's business. Callers
    that render into a UI want :func:`format_visitor_location`; the CSV export
    wants ``redact_visitor_ip(x) or ""``, because a spreadsheet says "no value"
    with an empty cell and a CRM importing the literal word "Unknown" creates a
    country by that name.

    Everything from the first ``|`` onward is dropped, and the pre-resolution
    ``"IP: <addr>"`` stamp degrades to ``None`` rather than printing a bare
    address.

    Cutting at *any* pipe — rather than only at a tail that parses as a real IP,
    which is the narrower test ``chat_routes._is_resolver_owned_location`` uses
    — is deliberate. The two functions guard opposite directions: that one
    decides whether to OVERWRITE stored data, where the cautious answer is to
    leave an unrecognised value alone; this one decides what to EMIT, where the
    cautious answer is to drop anything it cannot vouch for. Over-redacting
    costs a customer the tail of an oddly-formatted place name.
    Under-redacting is the bug this module was written to close.
    """
    value = (raw or "").strip()
    if not value:
        return None
    # "IP: 1.2.3.4" is the pre-resolution stamp — no geography in it at all.
    if value[:3].lower() == "ip:":
        return None
    geo = value.split("|", 1)[0].strip()
    return geo or None


def format_visitor_location(raw: str | None) -> str:
    """Render a stored location for a UI or an API response, IP removed.

    The exact twin of ``formatLocation`` in
    ``app/src/features/leads/leadModel.ts``. Idempotent, so a value that has
    already been through it (or through the TypeScript copy) is unchanged —
    which is what lets the dashboard keep its client-side redaction without the
    two fighting over the same string.
    """
    return redact_visitor_ip(raw) or UNKNOWN_LOCATION


# Written by ``chat_routes._resolve_and_update_location`` so a later turn can
# tell "enrichment already ran" from "ran for a DIFFERENT IP" — see
# ``chat_routes._already_resolved``. Purely server-side bookkeeping: no UI reads
# it, and the visitor-facing company/ASN/threat fields beside it do not need it.
_IP_INTEL_BOOKKEEPING_KEYS = frozenset({"resolved_for_ip"})


def redact_visitor_metadata(metadata: dict | None) -> dict | None:
    """Copy ``visitor_metadata`` with the raw IP dropped out of ``ip_intel``.

    The IP-intelligence block is a paid Professional feature and the customer is
    entitled to what it identified — the company, the ASN, the VPN/threat
    signal. It is not entitled to ``resolved_for_ip``, which is our own dedup
    marker and happens to be the visitor's address in full. It reached the
    operator console on every plan, ungated, purely because the whole blob was
    handed over as-is.

    Copies rather than mutates: ``metadata`` is a live SQLAlchemy JSON column
    value, and popping the key out of it would delete the marker from the row on
    the next flush — re-billing an ipapi.is lookup on every later message.
    """
    if not isinstance(metadata, dict):
        return metadata
    intel = metadata.get("ip_intel")
    if not isinstance(intel, dict) or not _IP_INTEL_BOOKKEEPING_KEYS.intersection(intel):
        return metadata
    redacted = dict(metadata)
    redacted["ip_intel"] = {k: v for k, v in intel.items() if k not in _IP_INTEL_BOOKKEEPING_KEYS}
    return redacted
