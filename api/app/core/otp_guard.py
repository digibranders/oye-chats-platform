"""Per-account failed-attempt ceiling for the 6-digit OTP flows.

The e-mail OTPs in this codebase are 6 digits — one million values, of which an
attacker only has to find one inside a 15-minute window. Three of the four OTP
flows already close that door by burning the code on the first wrong guess
(``/auth/reset-password``, ``/client/change-email/confirm``). ``/auth/verify-email``
did not: a wrong guess left the code live, so the only thing standing between a
prober and a forged verification was ``@limiter.limit("10/minute")`` — which is
keyed on the CLIENT IP, and therefore buys nothing against an attacker with a
proxy pool. Spread across enough source addresses, a million guesses inside the
window is ordinary commodity abuse, and ``/auth/resend-verification`` mints a
fresh 15-minute window on demand.

Burning the code on the very first mistype is hostile to the honest user who
fat-fingers a digit, so this module gives the middle option the flow actually
wants: count FAILED attempts per account and let the route invalidate the code
once the ceiling is reached.

Counting rides on the same ``limits`` storage the SlowAPI limiter already uses
— Redis in production (``config.py`` makes it mandatory there), in-memory in
local dev — so the ceiling holds across Gunicorn workers instead of being a
per-process guess.

**Fail-closed**: if the storage backend errors, :func:`register_failed_attempt`
reports the budget as exhausted. The consequence is that the code is burned and
the user requests a new one — the same UX the other OTP flows have always had,
which is the right way to fail for a control whose job is to stop guessing.
"""

from __future__ import annotations

import logging

from limits import parse

from app.core.rate_limit import limiter

logger = logging.getLogger(__name__)

# Failed guesses allowed per account before the code is burned, and the window
# they are counted over. Five covers "I mistyped it" and "I pasted the code from
# the previous e-mail" without leaving a brute-force budget worth having: at 5
# guesses per 15 minutes an attacker needs ~5.7 years of windows to cover half
# the 6-digit keyspace, and every exhausted window costs them a fresh OTP
# request (itself limited to 2/minute per IP).
MAX_OTP_ATTEMPTS = 5
_OTP_ATTEMPT_WINDOW = parse(f"{MAX_OTP_ATTEMPTS}/15 minutes")


def register_failed_attempt(scope: str, identity: str) -> bool:
    """Record one failed OTP guess; return ``True`` when the budget is spent.

    ``scope`` names the flow (e.g. ``"verify_email"``) so unrelated OTP flows
    never share a counter, and ``identity`` is the account the guess was made
    against (its e-mail address — the only identifier an unauthenticated caller
    supplies). A ``True`` return means the caller MUST invalidate the stored
    code; the account is out of guesses for this one.
    """
    try:
        return not limiter.limiter.hit(_OTP_ATTEMPT_WINDOW, "otp", scope, identity)
    except Exception:  # noqa: BLE001 — a broken counter must not become a free pass
        logger.warning("otp_attempt_counter_unavailable scope=%s — failing closed", scope, exc_info=True)
        return True


def clear_attempts(scope: str, identity: str) -> None:
    """Forget an account's failed attempts after a SUCCESSFUL verification.

    Deliberately NOT called when a fresh code is issued (``/auth/resend-verification``).
    Clearing on re-issue would hand the budget straight back: at 2 resends per
    minute that is 10 fresh guesses a minute per source address, and the whole
    point of counting per account was to stop a proxy pool from multiplying
    exactly that. The cost is that an account whose budget was spent has to wait
    out the window before its next code can be tried — the same cost
    ``/auth/reset-password`` has always carried, and bounded by the 15-minute
    window, which is also the OTP's own lifetime.

    On success it matters: without it, a user who mistyped four times and then
    got it right would start their NEXT verification with only one guess left.
    Best-effort — the ceiling is still correct if the call no-ops.
    """
    try:
        limiter.limiter.clear(_OTP_ATTEMPT_WINDOW, "otp", scope, identity)
    except Exception:  # noqa: BLE001 — cosmetic cleanup, never worth an error
        logger.debug("otp_attempt_clear_failed scope=%s", scope, exc_info=True)
