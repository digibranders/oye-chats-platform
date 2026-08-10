"""Email validation via Reoon, power mode only.

Power mode was chosen over quick mode after a live accuracy test found
3 of 11 quick-mode results wrong (including a real false positive on a
known-invalid address) — see
docs/superpowers/plans/2026-08-08-visitor-intelligence.md §04. Power mode
costs the same 1 credit per call as quick mode, confirmed empirically.
"""

import json
import logging
import os
import urllib.parse
import urllib.request

logger = logging.getLogger(__name__)

REOON_VERIFY_URL = "https://emailverifier.reoon.com/api/v1/verify"


def verify_email(email: str) -> dict | None:
    """Run a Reoon power-mode check. Returns None on any failure — callers
    must treat None as 'unknown, do not send', never as 'safe'."""
    api_key = os.getenv("REOON_API_KEY", "")
    if not api_key:
        return None

    query = urllib.parse.urlencode({"email": email, "key": api_key, "mode": "power"})
    url = f"{REOON_VERIFY_URL}?{query}"

    try:
        req = urllib.request.Request(url, headers={"User-Agent": "OyeChats/1.0"})
        with urllib.request.urlopen(req, timeout=90.0) as response:
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

    Deliberately lenient — it does NOT use Reoon's ``is_safe_to_send``.
    That flag is False for catch-all and ``unknown`` results, which is
    correct for "can Reoon *prove* deliverability?" but wrong as a gate on
    real B2B leads: plenty of legitimate corporate domains run catch-all
    gateways Reoon can never confirm either way. Using the strict flag here
    previously meant the widget accepted a lead the follow-up feature could
    then never email — two different answers to the same question. Keep
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
