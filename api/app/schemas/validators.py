"""Reusable server-side input-validation primitives.

Every route module grew its own copy of "is this an email", "is this URL
safe", "cap this string", and the copies disagreed. Worse, most request
models declared bare ``str`` / ``dict`` fields, which Pydantic happily fills
with a 40 MB string or a 12-level-deep object graph. The database columns
behind them are unbounded Postgres ``VARCHAR`` / ``JSONB``, so whatever the
client sends is what gets stored.

This module is the single place those rules live. It exports **Annotated
types**, not helper functions, so a field's constraints travel with its
declaration and show up in the OpenAPI schema:

    class Foo(BaseModel):
        email: EmailAddress
        session_id: SessionId
        note: ShortText | None = None

Design rules this module follows, and callers should too:

* **Reject, never coerce.** A value outside the contract raises, it is not
  quietly truncated or stripped down to something acceptable. The one
  normalisation allowed is whitespace stripping and case-folding of
  identifiers (emails, country codes), because those are canonicalisations
  of the *same* value, not a different one.
* **Bound everything that reaches storage.** Length for strings, item count
  for arrays, serialized size and nesting depth for free-form objects.
* **Allow-list, don't deny-list.** Enumerations use ``Literal`` or an
  explicit frozenset; identifiers use a positive character-class pattern.
* **Finite numbers only.** JSON permits ``NaN`` / ``Infinity`` and Python's
  ``json.loads`` accepts them, so any float that reaches a numeric column or
  arithmetic has to say it wants a real number.
"""

from __future__ import annotations

import ipaddress
import json
import re
from typing import Annotated, Any
from urllib.parse import urlparse

from pydantic import AfterValidator, BeforeValidator, Field, StringConstraints

# ── Length ceilings ─────────────────────────────────────────────────────────
# Named rather than inlined so the same intent gets the same number
# everywhere, and so widening one is a single reviewable edit.

MAX_NAME = 200
MAX_SHORT_TEXT = 500
MAX_MEDIUM_TEXT = 2_000
MAX_LONG_TEXT = 5_000
MAX_URL = 2_048
MAX_EMAIL = 254  # RFC 5321 §4.5.3.1.3 forward-path limit
MAX_PHONE = 40
MAX_IDENTIFIER = 128
MAX_TOKEN = 512
MAX_PASSWORD = 128  # bcrypt only reads 72 bytes; the rest is pure payload
MAX_SEARCH = 200

# ── Regexes ─────────────────────────────────────────────────────────────────

# Deliberately the same expression the route modules were each carrying a
# copy of, so this consolidation changes no accept/reject decision.
EMAIL_RE = re.compile(r"^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$")

# Opaque identifiers minted by us or by the widget: UUIDs, ``session_<uuid>``,
# ``sess-<b36>-<b36>``, ``bot-<hex>``, ``req_<hex>``. A positive class keeps
# control characters, whitespace, path separators and non-ASCII out of values
# that become primary keys, cache keys and log lines.
IDENTIFIER_RE = re.compile(r"^[A-Za-z0-9_.:\-]+$")

# Hex colour, with or without the short form. The widget writes these straight
# into inline styles on the customer's page.
HEX_COLOR_RE = re.compile(r"^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$")

# ISO 3166-1 alpha-2 / ISO 3166-2 subdivision suffix.
COUNTRY_CODE_RE = re.compile(r"^[A-Za-z]{2}$")

# ``YYYY-MM`` calendar month, used by every analytics/report period param.
YEAR_MONTH_RE = re.compile(r"^\d{4}-(?:0[1-9]|1[0-2])$")


# ── Primitive string types ──────────────────────────────────────────────────

#: Trimmed, length-capped strings. ``Trimmed*`` variants normalise surrounding
#: whitespace (a canonicalisation, not a rewrite); the plain variants do not.
Name = Annotated[str, StringConstraints(strip_whitespace=True, max_length=MAX_NAME)]
RequiredName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=MAX_NAME)]
ShortText = Annotated[str, StringConstraints(max_length=MAX_SHORT_TEXT)]
MediumText = Annotated[str, StringConstraints(max_length=MAX_MEDIUM_TEXT)]
LongText = Annotated[str, StringConstraints(max_length=MAX_LONG_TEXT)]
RequiredLongText = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=MAX_LONG_TEXT)]
SearchTerm = Annotated[str, StringConstraints(strip_whitespace=True, max_length=MAX_SEARCH)]
Password = Annotated[str, StringConstraints(min_length=1, max_length=MAX_PASSWORD)]
#: A bearer-style secret submitted for verification. Length-bounded but NOT
#: ``min_length``-constrained: an endpoint whose job is to validate a token
#: must answer 401 for every bad token, including an empty one. A 422 there
#: would tell an attacker which rejections came from the shape check and
#: which from the lookup, and would break clients that expect one status for
#: "not authenticated".
Token = Annotated[str, StringConstraints(strip_whitespace=True, max_length=MAX_TOKEN)]
Phone = Annotated[str, StringConstraints(strip_whitespace=True, max_length=MAX_PHONE)]

#: Opaque identifier: session ids, request ids, bot keys, client-message ids.
Identifier = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True,
        min_length=1,
        max_length=MAX_IDENTIFIER,
        pattern=IDENTIFIER_RE.pattern,
    ),
]

#: Chat session id. Same shape as :data:`Identifier`. Named separately
#: because it is by far the most common one and reads better at call sites.
SessionId = Identifier

#: ``YYYY-MM``, as every analytics ``period`` query param expects.
YearMonth = Annotated[str, StringConstraints(strip_whitespace=True, pattern=YEAR_MONTH_RE.pattern)]

#: A ``/slash`` shortcut an operator types in the live-chat composer. Slug
#: form so it is typeable and cannot collide with composer syntax.
Shortcut = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=40, pattern=r"^[A-Za-z0-9_\-]+$"),
]

#: The public widget embed key (``bot-<hex>``). Arrives in the ``X-Bot-Key``
#: header, in an unauthenticated URL path, and in the offline-message body.
BotKey = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=4, max_length=64, pattern=r"^[A-Za-z0-9_\-]+$"),
]

#: A payment-gateway object handle (``pay_…``, ``sub_…``, ``order_…``).
GatewayRef = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_\-]+$"),
]

#: The signature a gateway returns with a Checkout callback.
#:
#: Bounded and free of whitespace/control characters, but NOT pinned to hex.
#: Razorpay emits a hex HMAC today; the encoding is the vendor's to change,
#: and a schema that hard-codes it would reject a valid callback after a
#: provider-side change. Turning a paid customer's activation into a 422.
#: Whether the signature is *correct* is settled by the constant-time compare
#: in ``razorpay_service``, which is the only check that can answer that.
GatewaySignature = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=512, pattern=r"^[!-~]+$"),
]


def _normalise_email(value: str) -> str:
    """Trim, case-fold and syntax-check an address.

    Length is checked before the regex: the pattern's ``+`` quantifiers on a
    multi-megabyte string are pointless work, and the caller gets the more
    useful error either way.
    """
    value = value.strip().lower()
    if not value:
        raise ValueError("Email address must not be empty.")
    if len(value) > MAX_EMAIL:
        raise ValueError(f"Email address must be {MAX_EMAIL} characters or fewer.")
    if not EMAIL_RE.match(value):
        raise ValueError("Please enter a valid email address.")
    return value


#: A syntactically valid, normalised email address.
EmailAddress = Annotated[str, AfterValidator(_normalise_email)]


def _normalise_country(value: str) -> str:
    value = value.strip().upper()
    if not COUNTRY_CODE_RE.match(value):
        raise ValueError("Country must be a 2-letter ISO 3166-1 alpha-2 code.")
    return value


#: ISO 3166-1 alpha-2, upper-cased.
CountryCode = Annotated[str, AfterValidator(_normalise_country)]


def _validate_hex_color(value: str) -> str:
    value = value.strip()
    if not HEX_COLOR_RE.match(value):
        raise ValueError("Colour must be a hex value such as '#2563EB'.")
    return value


#: ``#RGB`` / ``#RRGGBB`` / ``#RRGGBBAA``. These land in inline styles on the
#: customer's own page, so anything that is not a colour is refused outright
#: rather than escaped downstream.
HexColor = Annotated[str, AfterValidator(_validate_hex_color)]


# ── URLs ────────────────────────────────────────────────────────────────────


def _validate_http_url(value: str) -> str:
    """Accept only a well-formed, length-bounded ``http(s)`` URL.

    Scheme allow-listing is the point: a stored ``javascript:`` or ``data:``
    URL is rendered as an anchor href in the admin UI and in emails, so a
    non-http scheme is not "unusual input", it is a stored-XSS payload.
    """
    value = value.strip()
    if not value:
        raise ValueError("URL must not be empty.")
    if len(value) > MAX_URL:
        raise ValueError(f"URL must be {MAX_URL} characters or fewer.")
    parsed = urlparse(value)
    if parsed.scheme not in ("http", "https"):
        raise ValueError("URL must start with http:// or https://")
    if not parsed.hostname:
        raise ValueError("URL must contain a valid hostname.")
    return value


#: Any syntactically valid ``http(s)`` URL, length-bounded.
HttpUrlStr = Annotated[str, AfterValidator(_validate_http_url)]

#: Imperative form of the same check, for validators that need it inside a
#: loop over a heterogeneous list rather than as a field annotation.
validate_http_url = _validate_http_url


def is_private_host(hostname: str) -> bool:
    """True when *hostname* is a literal address in a non-public range.

    Only answers the literal-IP case. Name resolution lives in
    ``app.schemas.client._is_public_hostname``, which performs DNS and is
    therefore not something to put in a hot request path by default.
    """
    try:
        ip = ipaddress.ip_address(hostname)
    except ValueError:
        return False
    return bool(ip.is_private or ip.is_loopback or ip.is_reserved or ip.is_link_local or ip.is_multicast)


def _validate_public_http_url(value: str) -> str:
    """``HttpUrlStr`` that additionally refuses literal private/internal IPs."""
    value = _validate_http_url(value)
    hostname = urlparse(value).hostname or ""
    if is_private_host(hostname):
        raise ValueError("URLs targeting internal or private network addresses are not allowed.")
    return value


#: An ``http(s)`` URL that is not a literal private/loopback/link-local address.
#: Use for any URL the *server* may later fetch or redirect to.
PublicHttpUrl = Annotated[str, AfterValidator(_validate_public_http_url)]


# ── Numbers ─────────────────────────────────────────────────────────────────


def _require_finite(value: float) -> float:
    """Reject ``NaN`` / ``±Infinity``.

    ``json.loads`` (which is what Starlette parses request bodies with)
    accepts all three as literals. A NaN that reaches a ``double precision``
    column stores fine and then breaks every consumer that serialises the row
    back to JSON, so it has to be refused at the boundary.
    """
    if value != value or value in (float("inf"), float("-inf")):
        raise ValueError("Value must be a finite number.")
    return value


#: A float guaranteed to be a real number.
FiniteFloat = Annotated[float, AfterValidator(_require_finite)]

#: Non-negative, finite, and bounded to a day. Enough for any "seconds spent"
#: telemetry and small enough that no consumer has to think about overflow.
DurationSeconds = Annotated[float, AfterValidator(_require_finite), Field(ge=0, le=86_400)]

#: A positive database row id supplied by a client.
RowId = Annotated[int, Field(ge=1)]

#: A zero-or-greater counter supplied by a client.
CountValue = Annotated[int, Field(ge=0, le=1_000_000)]


# ── Free-form JSON objects ──────────────────────────────────────────────────
#
# Several columns are genuinely open-ended maps whose keys are defined by
# product config, not by this schema (``bot.feature_flags``,
# ``bot.widget_messages``, ``chat_session.utm_params`` …). "Open-ended" is not
# "unbounded": a client can still be held to a size, a depth and a key count,
# which is what stops a JSONB column from becoming a free object store.

MAX_JSON_BYTES = 64 * 1024
MAX_JSON_DEPTH = 6
MAX_JSON_KEYS = 200
MAX_JSON_KEY_LENGTH = 128


def _measure_depth(value: Any, depth: int = 1) -> int:
    """Deepest nesting level in *value*, counting the outermost container as 1."""
    if isinstance(value, dict):
        children = value.values()
    elif isinstance(value, list):
        children = value
    else:
        return depth - 1
    deepest = depth
    for child in children:
        deepest = max(deepest, _measure_depth(child, depth + 1))
    return deepest


def check_json_object(
    value: Any,
    *,
    field: str = "value",
    max_bytes: int = MAX_JSON_BYTES,
    max_depth: int = MAX_JSON_DEPTH,
    max_keys: int = MAX_JSON_KEYS,
) -> dict:
    """Validate a free-form JSON object's shape, size, depth and key count.

    Returns the object unchanged on success and raises ``ValueError`` on any
    breach. This is a gate, not a sanitiser. Rejecting rather than pruning
    matters here: silently dropping the 201st key would persist a config the
    caller never asked for and can't see, which is a worse outcome than a 422.
    """
    if not isinstance(value, dict):
        raise ValueError(f"{field} must be a JSON object.")
    if len(value) > max_keys:
        raise ValueError(f"{field} must have {max_keys} keys or fewer.")
    for key in value:
        if not isinstance(key, str):
            raise ValueError(f"{field} keys must be strings.")
        if len(key) > MAX_JSON_KEY_LENGTH:
            raise ValueError(f"{field} keys must be {MAX_JSON_KEY_LENGTH} characters or fewer.")
    depth = _measure_depth(value)
    if depth > max_depth:
        raise ValueError(f"{field} must not nest more than {max_depth} levels deep.")
    try:
        encoded = json.dumps(value, allow_nan=False)
    except ValueError as exc:  # NaN / Infinity somewhere inside
        raise ValueError(f"{field} must contain only finite numbers.") from exc
    if len(encoded.encode("utf-8")) > max_bytes:
        raise ValueError(f"{field} must be {max_bytes // 1024} KB or smaller when serialized.")
    return value


def bounded_json_object(
    *,
    max_bytes: int = MAX_JSON_BYTES,
    max_depth: int = MAX_JSON_DEPTH,
    max_keys: int = MAX_JSON_KEYS,
):
    """Build an ``AfterValidator`` applying :func:`check_json_object`.

    Use when a field needs limits other than the defaults::

        bant_config: Annotated[dict, bounded_json_object(max_bytes=128 * 1024)] | None = None
    """

    def _validate(value: dict | None) -> dict | None:
        if value is None:
            return None
        return check_json_object(value, max_bytes=max_bytes, max_depth=max_depth, max_keys=max_keys)

    return AfterValidator(_validate)


#: A free-form JSON object held to the default size/depth/key budget.
BoundedJsonObject = Annotated[dict, bounded_json_object()]

#: Small telemetry/metadata blobs, one page of JSON, shallow.
SmallJsonObject = Annotated[dict, bounded_json_object(max_bytes=4 * 1024, max_depth=4, max_keys=50)]

#: ``{"utm_source": "...", ...}``-style maps: flat, string-valued, few keys.
UtmParams = Annotated[dict, bounded_json_object(max_bytes=2 * 1024, max_depth=2, max_keys=25)]


# ── Arrays ──────────────────────────────────────────────────────────────────


def bounded_list(max_items: int):
    """Constrain an array's item count.

    Item *types* come from the element annotation; this only stops the
    "10,000-element array where the UI offers five rows" case, which is how an
    endpoint that looks cheap turns into a per-item loop over an attacker's
    array.
    """
    return Field(max_length=max_items)


def _strip_or_none(value: str | None) -> str | None:
    """Trim, and treat an all-whitespace string as absent.

    Only for genuinely optional free-text fields where "" and None mean the
    same thing to the column behind them. Never use it to make a *required*
    field tolerate blanks.
    """
    if value is None:
        return None
    value = value.strip()
    return value or None


#: Optional trimmed text where blank collapses to ``None``.
#:
#: The length constraint sits on the ``str`` member, not on the union: a
#: ``max_length`` applied to ``str | None`` is handed ``None`` and raises
#: ``TypeError`` inside Pydantic rather than producing a validation error.
OptionalName = Annotated[Name | None, BeforeValidator(_strip_or_none)]
OptionalShortText = Annotated[ShortText | None, BeforeValidator(_strip_or_none)]


__all__ = [
    "BotKey",
    "BoundedJsonObject",
    "GatewayRef",
    "GatewaySignature",
    "CountValue",
    "CountryCode",
    "DurationSeconds",
    "EMAIL_RE",
    "EmailAddress",
    "FiniteFloat",
    "HexColor",
    "HttpUrlStr",
    "Identifier",
    "LongText",
    "MAX_EMAIL",
    "MAX_IDENTIFIER",
    "MAX_JSON_BYTES",
    "MAX_LONG_TEXT",
    "MAX_MEDIUM_TEXT",
    "MAX_NAME",
    "MAX_PASSWORD",
    "MAX_PHONE",
    "MAX_SEARCH",
    "MAX_SHORT_TEXT",
    "MAX_TOKEN",
    "MAX_URL",
    "MediumText",
    "Name",
    "OptionalName",
    "OptionalShortText",
    "Password",
    "Phone",
    "PublicHttpUrl",
    "RequiredLongText",
    "RequiredName",
    "RowId",
    "SearchTerm",
    "SessionId",
    "Shortcut",
    "ShortText",
    "SmallJsonObject",
    "Token",
    "UtmParams",
    "YearMonth",
    "bounded_json_object",
    "bounded_list",
    "check_json_object",
    "validate_http_url",
    "is_private_host",
]
