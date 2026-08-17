"""One place that decides what an error is allowed to tell a client.

Every handler in ``app.core.middleware`` — and the handful of routes that catch
a third-party failure directly — goes through this module instead of formatting
its own response. Centralising it is the point: the leaks this file exists to
close were never a single bad handler, they were the same reasonable-looking
line written independently in a dozen places.

THE TWO AUDIENCES
    A failure has two readers with opposite needs. The **client** needs to know
    what to do next and nothing else. The **operator** needs the exception type,
    the traceback, the offending field, and the row that broke — all of which
    are exactly what an attacker wants. Splitting one exception into two
    renderings is the whole design; helpers here always come in pairs, one
    ``public_*`` and one ``loggable_*``, so a call site cannot accidentally
    reach for the wrong one.

WHAT LEAKED, CONCRETELY
    ``RequestValidationError.errors()`` was being returned to the client
    verbatim. Pydantic v2 puts two things in there that have no business
    crossing the wire:

    ``url``
        ``https://errors.pydantic.dev/2.12/v/string_type`` — the framework's
        exact **minor version**, handed to anyone who can POST a malformed
        body, on a service whose OpenAPI schema is deliberately switched off in
        production (``main._docs_urls``) precisely to deny that class of recon.

    ``input``
        The submitted value, echoed back. On ``POST /login`` a body of
        ``{"email": [], "password": "hunter2"}`` fails on ``email`` — and the
        response, the ERROR-level log line, and the Sentry breadcrumb attached
        to it all carried the password field's neighbourhood back out. Any
        endpoint taking a credential (``/register``, ``/reset-password``,
        ``/verify-email``, the Razorpay signature routes) had the same shape.

    ``ctx``
        Free-form per-error-type context. For ``string_pattern_mismatch`` it is
        the compiled regex; for a custom validator it is whatever the developer
        put in the exception. Unbounded by construction, so it is dropped
        rather than allow-listed.

    ``msg`` and ``loc`` survive: they are the only parts the dashboard actually
    renders (``app/src/services/api.js`` reads ``detail[0].msg``), they are
    developer-authored rather than input-derived, and a field name the caller
    just sent us is not a disclosure.

ERROR IDs
    A generic 500 with no handle is why teams re-enable verbose errors: support
    cannot connect "it broke at 3pm" to a log line, so somebody argues for
    putting the traceback back in the response. :func:`new_error_id` gives the
    client an opaque token that means nothing on its own and everything in
    ``journalctl``. It is random per occurrence — deliberately not derived from
    the request, the account, or the exception, so it cannot be mined.

PRODUCTION VS DEVELOPMENT
    :func:`debug_hint` is the *only* switch between the two, and it fails
    closed: it consults ``APP_ENV`` at call time (not import time, so a test can
    move it) and returns ``None`` for anything that is not explicitly
    non-production. A misconfigured or missing ``APP_ENV`` therefore yields the
    production behaviour, which is the direction a mistake here has to go.
"""

from __future__ import annotations

import os
import secrets
from typing import Any

# Substrings that mark a field as carrying a credential or other secret. Matched
# against the lower-cased field name, so ``razorpay_signature``, ``new_password``
# and ``otp_code`` are all caught by a token in this set.
#
# Over-matching is the intended bias: these govern what gets written to the
# server log, and a redacted field that did not need redacting costs a debugging
# session, while an un-redacted password costs a credential rotation. ``code``
# is here because every OTP and reset field in this codebase is named for it.
_SENSITIVE_FIELD_TOKENS = frozenset(
    {
        "api_key",
        "apikey",
        "auth",
        "card",
        "credential",
        "cvv",
        "hash",
        "key",
        "otp",
        "passwd",
        "password",
        "pwd",
        "secret",
        "signature",
        "token",
    }
)

# Extra names that are secrets but contain none of the tokens above.
_SENSITIVE_FIELD_NAMES = frozenset({"code", "pin"})

_REDACTED = "[redacted]"

# Upper bound on a debug hint. Long enough to identify the failure, short enough
# that a provider error carrying a serialised request body cannot ride out on it.
_DEBUG_HINT_MAX_CHARS = 300


def is_sensitive_field(name: Any) -> bool:
    """Would a value under this field name be a credential?

    Accepts anything Pydantic can put in a ``loc`` tuple — a string key, an int
    list index, ``'__root__'`` — and answers False for the non-strings, which is
    correct: an array index names no field.
    """
    if not isinstance(name, str):
        return False
    lowered = name.lower()
    if lowered in _SENSITIVE_FIELD_NAMES:
        return True
    return any(token in lowered for token in _SENSITIVE_FIELD_TOKENS)


def _loc_is_sensitive(loc: Any) -> bool:
    """True if any segment of a Pydantic ``loc`` path names a secret."""
    if isinstance(loc, (list, tuple)):
        return any(is_sensitive_field(part) for part in loc)
    return is_sensitive_field(loc)


def public_validation_errors(errors: list[dict]) -> list[dict]:
    """Client-safe rendering of ``RequestValidationError.errors()``.

    Keeps ``type``, ``loc`` and ``msg``; drops ``url``, ``input`` and ``ctx``
    for the reasons in the module docstring. The shape stays a list of dicts
    with ``msg`` and ``loc``, which is the contract the dashboard and widget
    already parse — this narrows the payload without changing its type.
    """
    safe: list[dict] = []
    for err in errors:
        if not isinstance(err, dict):
            # Never seen from Pydantic, but this runs on the error path of every
            # request and must not add a second failure on top of the first.
            continue
        entry: dict[str, Any] = {}
        loc = err.get("loc")
        if loc is not None:
            entry["loc"] = list(loc) if isinstance(loc, (list, tuple)) else [loc]
        if err.get("type") is not None:
            entry["type"] = str(err["type"])
        entry["msg"] = str(err.get("msg") or "Invalid value.")
        safe.append(entry)
    return safe


def loggable_validation_errors(errors: list[dict]) -> list[dict]:
    """Full-fidelity rendering for the server log, with secrets removed.

    Unlike :func:`public_validation_errors` this **keeps** ``input`` — knowing
    the value that failed is most of the diagnostic — except where the ``loc``
    path names a credential, in which case the value is replaced with
    ``[redacted]``. Values are stringified and truncated so a 10 MB body that
    failed validation cannot be re-materialised in the log.
    """
    out: list[dict] = []
    for err in errors:
        if not isinstance(err, dict):
            continue
        loc = err.get("loc")
        entry: dict[str, Any] = {
            "loc": list(loc) if isinstance(loc, (list, tuple)) else [loc],
            "type": err.get("type"),
            "msg": err.get("msg"),
        }
        if "input" in err:
            entry["input"] = _REDACTED if _loc_is_sensitive(loc) else _truncate(err["input"])
        out.append(entry)
    return out


def _truncate(value: Any, limit: int = 120) -> str:
    """Stringify and bound a logged value."""
    text = repr(value)
    return text if len(text) <= limit else text[:limit] + "…"


def new_error_id() -> str:
    """An opaque, per-occurrence correlation token.

    12 hex characters: enough that two concurrent 500s will not collide in a
    log search, short enough for a customer to read out over the phone. Carries
    no information on its own — see the module docstring.
    """
    return secrets.token_hex(6)


# Environments permitted to see exception text in a response body. An
# ALLOW-list, not a "!= production" check, and that asymmetry is the whole
# point: the two are equivalent only while ``APP_ENV`` is spelled exactly right.
# Under a blocklist, ``APP_ENV=Production`` — or ``prod``, or ``staging``, or a
# value blanked by a broken deploy script — reads as "not production" and turns
# exception text back on across the fleet, silently, with no other symptom.
# Under this list the same typo costs a debug convenience and nothing else.
#
# Unset is deliberately absent from the check below: it resolves through
# ``os.getenv``'s default to ``development``, matching ``app.config.APP_ENV``,
# so a developer who has never set the variable still gets hints.
_DEBUG_ENVS = frozenset({"development", "dev", "local", "test", "testing"})


def debug_details_allowed() -> bool:
    """May a response body carry exception text in this environment?

    Read at call time rather than captured at import, so a test can flip
    ``APP_ENV`` with ``monkeypatch`` and exercise both behaviours in one run.
    """
    return os.getenv("APP_ENV", "development").strip().lower() in _DEBUG_ENVS


def is_production() -> bool:
    """Whether this process is serving production traffic.

    Distinct from ``not debug_details_allowed()``: an unrecognised ``APP_ENV``
    is not production, but is still denied debug output. Callers deciding
    *policy* want this; callers deciding *disclosure* want the other.
    """
    return os.getenv("APP_ENV", "development") == "production"


def debug_hint(exc: BaseException) -> str | None:
    """``'<ExceptionType>: <message>'`` in a debug environment, ``None`` elsewhere.

    The single intentional difference between production and development error
    responses. Never a traceback and never unbounded — a hint identifies the
    failure, it does not reproduce it — because the same string is what a
    misconfigured environment would end up shipping.
    """
    if not debug_details_allowed():
        return None
    text = f"{type(exc).__name__}: {exc}".strip()
    if len(text) > _DEBUG_HINT_MAX_CHARS:
        text = text[:_DEBUG_HINT_MAX_CHARS] + "…"
    return text


def public_error_body(
    message: str,
    *,
    error_id: str,
    exc: BaseException | None = None,
    code: str | None = None,
) -> dict[str, Any]:
    """Assemble the JSON body for a server-side failure.

    ``detail`` stays a plain string so the existing clients (which branch on
    ``typeof detail === 'string'``) keep working unchanged; ``error_id`` and the
    optional ``code`` ride alongside it at the top level rather than nested
    inside ``detail``, so nothing that reads ``detail`` today has to change.
    """
    body: dict[str, Any] = {"detail": message, "error_id": error_id}
    if code:
        body["code"] = code
    if exc is not None:
        hint = debug_hint(exc)
        if hint:
            body["debug"] = hint
    return body
