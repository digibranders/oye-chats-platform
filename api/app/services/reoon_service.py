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
