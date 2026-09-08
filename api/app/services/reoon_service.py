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
import urllib.error
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

#: Counter name for the OTHER "configured to run, cannot possibly run" state:
#: the key is valid, the vendor is up, and the account has no credits left.
CREDITS_METRIC = "reoon_credits_exhausted"

#: Reoon says this in the body of a 403 when the balance is spent. Matched on
#: the phrase rather than the status code alone, because 403 also covers a
#: revoked or mistyped key -- a different incident with a different fix, and
#: one that must not be reported as a billing problem.
_CREDITS_EXHAUSTED_MARKER = "not enough credits"

_credits_exhausted = False
_credits_reported = False


def credits_exhausted() -> bool:
    """True when Reoon last told us the account is out of credits.

    Process-local and best-effort: it exists so ``/health/full`` and the
    superadmin console can SAY the feature is off, not to gate anything. The
    verification path itself keeps failing open regardless.
    """
    return _credits_exhausted


def reset_credit_state() -> None:
    """Test seam. Clears the flag and the once-only report latch."""
    global _credits_exhausted, _credits_reported
    _credits_exhausted = False
    _credits_reported = False


def _note_credits_exhausted() -> None:
    """Record, and report ONCE, that the vendor account has run dry.

    Once, not once per call: a dry account fails on every address, so a
    per-call report would bury the incident in the noise it generates. This is
    one incident with one fix (recharge), and the counter is what makes it
    countable in the meantime.

    Deliberately ERROR, where every other vendor failure here is WARNING. A
    timeout resolves itself; a balance does not, and until somebody tops it up
    a paid anti-fraud feature is switched off for every bot on every plan while
    every visitor sails through. No address is logged: the incident is about
    our account, not about whoever happened to trigger it.
    """
    global _credits_exhausted, _credits_reported
    _credits_exhausted = True
    if _credits_reported:
        return
    _credits_reported = True
    logger.error(
        "reoon.metric name=%s. Reoon reports no credits remaining; email verification is "
        "failing open for every bot on every plan until the account is recharged",
        CREDITS_METRIC,
    )
    increment_metric_counter(CREDITS_METRIC)
    forward_to_sentry_if_alertable(CREDITS_METRIC)


def _looks_like_credits_exhausted(exc: Exception) -> bool:
    """Is this failure the account balance rather than the network?

    Reads the 403's body, which is where Reoon puts the reason. ``HTTPError``
    is itself a readable file object, so this consumes it -- fine, because the
    caller only logs the exception afterwards and never reads its body.
    """
    if not isinstance(exc, urllib.error.HTTPError) or exc.code != 403:
        return False
    try:
        body = exc.read().decode(errors="replace")
    except Exception:  # noqa: BLE001 - a body we cannot read tells us nothing
        return False
    return _CREDITS_EXHAUSTED_MARKER in body.lower()


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
        # Classify before logging: an unpaid bill and a read timeout are the
        # same code path here (both fail open) but not the same incident, and
        # for a long time they were indistinguishable in the logs too.
        if _looks_like_credits_exhausted(exc):
            _note_credits_exhausted()
        logger.warning(f"Reoon verification failed for {email}: {exc}")
        return None

    if "status" not in data:
        logger.warning(f"Reoon returned unexpected payload for {email}: {data}")
        return None

    # A verdict came back, so the account has credits again. Clearing here
    # rather than on a timer means a recharge takes effect on the next real
    # verification, with no restart and nothing to remember to reset.
    if _credits_exhausted:
        reset_credit_state()
        logger.info("reoon.metric name=%s_cleared. Verification is answering again", CREDITS_METRIC)

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


#: Reoon ``status`` values that mean the mailbox CANNOT receive mail.
#:
#: ``status`` is the vendor's own summary, and "invalid" is only one of the
#: ways it says no. ``disabled`` is a mailbox the provider has deactivated or
#: that its SMTP server rejects outright, and it was the hole this set closes:
#: ``adm@digibranders.com`` came back ``disabled`` with ``is_deliverable``
#: False and a score of 4/100, and a gate testing only ``== "invalid"`` let it
#: through to a live operator AND stamped the lead "verified".
#:
#: What is deliberately NOT here:
#:
#: - ``catch_all`` and ``unknown``: Reoon cannot prove deliverability either
#:   way, and plenty of real B2B domains sit behind such gateways. Blocking
#:   them rejects genuine visitors, which this gate exists not to do.
#: - ``role_account``: ``admin@``, ``sales@`` and friends are real, contactable
#:   business addresses. Reoon scores them 93/100.
#: - ``inbox_full``: a real person whose mailbox is temporarily over quota. A
#:   soft bounce is not a fake lead.
_UNDELIVERABLE_STATUSES = frozenset({"invalid", "disabled", "spamtrap"})


def is_obviously_undeliverable(validation: dict) -> bool:
    """True only for addresses Reoon flags as unambiguously bad.

    THE single definition of "this email is junk", shared by every caller:
    the widget's real-time blur check (``/chat/validate-email``) and the
    background enrichment that persists ``LeadInfo.is_valid_email``.

    Blocks on the vendor statuses in :data:`_UNDELIVERABLE_STATUSES`, plus the
    explicit junk flags. Deliberately lenient otherwise, it does NOT use
    Reoon's ``is_safe_to_send``.
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
        or validation.get("status") in _UNDELIVERABLE_STATUSES
        or validation.get("mx_accepts_mail") is False
    )
