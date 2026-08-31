"""Email validation via Reoon, power mode only.

Power mode was chosen over quick mode after a live accuracy test found
3 of 11 quick-mode results wrong (including a real false positive on a
known-invalid address). See
docs/superpowers/plans/2026-08-08-visitor-intelligence.md §04. Power mode
costs the same 1 credit per call as quick mode, confirmed empirically.
"""

import json
import logging
import os
import urllib.parse
import urllib.request

from app.core.metrics import forward_to_sentry_if_alertable, increment_metric_counter

logger = logging.getLogger(__name__)

REOON_VERIFY_URL = "https://emailverifier.reoon.com/api/v1/verify"

#: Budget for a call NOTHING is waiting on: the background lead enrichment.
#: Reoon's own docs put power mode at seconds to over a minute, and that path
#: runs after lead capture has already succeeded, so a long wait costs only a
#: worker thread.
REOON_BACKGROUND_TIMEOUT_S = 90.0

#: Budget for a call a VISITOR is waiting on (``POST /chat/validate-email``,
#: fired on email-field blur). The route is a plain ``def``, so it occupies an
#: anyio worker thread for the whole socket read, and it is not in
#: ``main._TIMEOUT_EXEMPT_PREFIXES``: at the background budget a slow vendor
#: blew through the 60s global middleware, returned a 504, and the widget
#: (which retries a 504) kept the visitor's form spinning for roughly two
#: minutes. ``asyncio.wait_for`` does not help, it cancels the await and
#: leaves the socket read running. The only real fix is to stop waiting.
#: Every caller of this function already fails OPEN, so an occasional
#: timeout costs an unverified verdict, never a blocked visitor.
REOON_INTERACTIVE_TIMEOUT_S = 5.0

#: Counter name for the "configured to run, cannot possibly run" state.
_MISSING_KEY_METRIC = "reoon_api_key_missing"

_missing_key_reported = False


def check_configuration() -> bool:
    """True when ``REOON_API_KEY`` is present. Reports a missing key ONCE.

    Without this the feature degrades invisibly: an empty or rotated key makes
    :func:`verify_email` return ``None``, every caller treats ``None`` as
    fail-open, and email verification becomes a platform-wide no-op that only
    shows up as a per-call warning buried in request logs. One warning plus one
    safety-net counter (the same shape ``rag_service._safety_net_metric``
    emits) makes the state visible without failing startup, which would take
    the whole API down over an optional vendor.
    """
    if os.getenv("REOON_API_KEY", "").strip():
        return True

    global _missing_key_reported
    if not _missing_key_reported:
        _missing_key_reported = True
        logger.warning(
            "reoon.metric name=%s. REOON_API_KEY is not set; email verification is a no-op "
            "for every bot on every plan until it is configured",
            _MISSING_KEY_METRIC,
        )
        increment_metric_counter(_MISSING_KEY_METRIC)
        forward_to_sentry_if_alertable(_MISSING_KEY_METRIC)
    return False


def verify_email(email: str, *, timeout: float = REOON_BACKGROUND_TIMEOUT_S) -> dict | None:
    """Run a Reoon power-mode check. Returns None on any failure. Callers
    must treat None as 'unknown, do not send', never as 'safe'.

    ``timeout`` is per-call because the two callers have opposite contracts:
    pass :data:`REOON_INTERACTIVE_TIMEOUT_S` from anything a visitor is
    waiting on, and leave the default for background enrichment.
    """
    if not check_configuration():
        return None
    api_key = os.getenv("REOON_API_KEY", "")

    query = urllib.parse.urlencode({"email": email, "key": api_key, "mode": "power"})
    url = f"{REOON_VERIFY_URL}?{query}"

    try:
        req = urllib.request.Request(url, headers={"User-Agent": "OyeChats/1.0"})
        with urllib.request.urlopen(req, timeout=timeout) as response:
            data = json.loads(response.read().decode())
    except Exception as exc:
        logger.warning(f"Reoon verification failed for {email}: {exc}")
        return None

    if "status" not in data:
        logger.warning(f"Reoon returned unexpected payload for {email}: {data}")
        return None

    return {
        "status": data.get("status"),
        "overall_score": data.get("overall_score"),
        "is_safe_to_send": data.get("is_safe_to_send", False),
        "is_disposable": data.get("is_disposable", False),
        "is_deliverable": data.get("is_deliverable", False),
        "is_valid_syntax": data.get("is_valid_syntax", True),
        "is_spamtrap": data.get("is_spamtrap", False),
        "mx_accepts_mail": data.get("mx_accepts_mail", True),
    }


def is_obviously_undeliverable(validation: dict) -> bool:
    """True only for addresses Reoon flags as unambiguously bad.

    THE single definition of "this email is junk", shared by every caller:
    the widget's real-time blur check (``/chat/validate-email``) and the
    background enrichment that persists ``LeadInfo.is_valid_email``.

    Deliberately lenient, it does NOT use Reoon's ``is_safe_to_send``.
    That flag is False for catch-all and ``unknown`` results, which is
    correct for "can Reoon *prove* deliverability?" but wrong as a gate on
    real B2B leads: plenty of legitimate corporate domains run catch-all
    gateways Reoon can never confirm either way. Using the strict flag here
    previously meant the widget accepted a lead the follow-up feature could
    then never email, two different answers to the same question. Keep
    these two behaviours identical by calling this from both paths.

    Returns False when ``validation`` is falsy so an unreachable Reoon
    fails OPEN, matching the "never block a real visitor on our own infra
    hiccup" policy.
    """
    if not validation:
        return False
    return bool(
        not validation.get("is_valid_syntax", True)
        or validation.get("is_disposable") is True
        or validation.get("is_spamtrap") is True
        or validation.get("status") == "invalid"
        or validation.get("mx_accepts_mail") is False
    )
