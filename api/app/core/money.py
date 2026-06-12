"""Money-math helpers shared across affiliate + billing code.

Centralising the rounding rule here is the cure for the audit finding that
``pct_to_bps`` used Python's banker's rounding while ``billing_service``
clamped via ``int()`` truncation. Both surfaces fed the same database
column, so a customer could in principle see one bps value on a quote
and a different one on the invoice. Routing every caller through a
single helper makes the rule "round half away from zero" (the everyday
arithmetic rounding most people expect) and provable in tests.

Nothing in here touches the database — pure value helpers, safe to call
from anywhere.
"""

from __future__ import annotations

import math

# Basis-point space: 10000 bps = 100%. Anything outside [0, 10000] is
# nonsense in a commission/discount context and gets clamped instead of
# raising, because every caller is already validating the human-percent
# input upstream — clamping here is belt-and-braces.
MAX_BPS = 10_000


def normalize_bps(value: int | float | None, *, max_bps: int = MAX_BPS) -> int:
    """Clamp to ``[0, max_bps]`` and round to the nearest integer bps.

    Uses half-away-from-zero rounding (the everyday arithmetic rule), NOT
    Python's banker's rounding. ``12.345% × 100 = 1234.5`` → ``1235`` here
    so the discount always favours the customer and the affiliate. The
    same rule applies in ``pct_to_bps`` and in the billing-service guard
    so quote and invoice never disagree by one bps.

    ``None`` resolves to ``0`` — used as "no discount on file" everywhere.
    """
    if value is None:
        return 0
    f = float(value)
    if f <= 0:
        return 0
    if f >= max_bps:
        return int(max_bps)
    # ``floor(x + 0.5)`` is the canonical half-up rule for positive values.
    return int(math.floor(f + 0.5))


def pct_to_bps(pct: int | float | None) -> int | None:
    """Convert a human percentage (0–100, decimals allowed) to bps.

    Returns ``None`` if input is ``None`` (caller's signal to skip an
    update). Raises ``ValueError`` on out-of-range input so a route
    handler can surface a clean 400 instead of silently clamping bad
    admin input. Successful conversions pass through ``normalize_bps``
    so the rounding rule is identical to every other bps writer.
    """
    if pct is None:
        return None
    if pct < 0 or pct > 100:
        raise ValueError("Commission percentage must be between 0 and 100.")
    return normalize_bps(float(pct) * 100)


def bps_to_pct(bps: int | None) -> float | None:
    """Inverse of :func:`pct_to_bps` — bps → human percent (two decimals)."""
    if bps is None:
        return None
    return round(bps / 100, 2)
