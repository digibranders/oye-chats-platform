"""Pure currency-display helpers — which amount + currency a visitor sees.

Single source of truth for the dual-currency display rule (billing ADR
D2/D3): there is **no live FX in the charge or display path**. Indian
visitors read the INR column as stored; everyone else reads the plan's fixed
USD column. The INR→USD rate fallback exists ONLY for legacy plan rows whose
USD column is still NULL (rows created before the USD columns were added).

Sibling module ``app.core.money`` owns basis-point math (commission /
discount); this module owns currency selection + formatting. They are kept
separate because they change for different reasons.

Nothing here touches the database or the network — pure value helpers, safe
to call from anywhere (routes, services, tests).
"""

from __future__ import annotations


def display_price(
    *,
    inr_paise: int,
    usd_cents: int | None,
    country: str | None,
    rate: float = 94.67,
) -> tuple[int, str]:
    """Return ``(minor_units, currency)`` for the visitor.

    * ``country == "IN"`` → ``(inr_paise, "INR")`` — stored INR, untouched.
    * Otherwise → ``(usd_cents, "USD")`` using the fixed USD column.
    * If ``usd_cents`` is ``None`` (legacy row), fall back to converting
      ``inr_paise`` via ``rate`` (rupees per dollar). A non-positive ``rate``
      yields ``0`` rather than dividing by zero.

    ``country`` of ``None`` (local dev / edge bypass) is treated as
    non-Indian, matching ``app.core.geo`` policy.
    """
    if country == "IN":
        return int(inr_paise or 0), "INR"

    if usd_cents is not None:
        return int(usd_cents), "USD"

    # Non-positive rate would divide by zero — fall back to 0 (legacy rows
    # should always have a USD column set; this is defence-in-depth).
    converted = round((int(inr_paise or 0) / 100) / rate * 100) if rate and rate > 0 else 0
    return converted, "USD"


def format_amount(minor_units: int, currency: str) -> str:
    """Format minor units as a human string.

    Drops the fractional part when the amount is a whole major unit:
    ``1900, "USD" → "$19"``; ``179900, "INR" → "₹1,799"``;
    ``15050, "USD" → "$150.50"``. Unknown currencies are prefixed with the
    ISO code (``1000, "EUR" → "EUR 10"``).
    """
    symbol = "₹" if currency == "INR" else "$" if currency == "USD" else f"{currency} "
    major = (int(minor_units) or 0) / 100
    body = f"{int(major):,}" if major == int(major) else f"{major:,.2f}"
    return f"{symbol}{body}"
