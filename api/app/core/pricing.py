"""Pure currency-display helpers — which amount + currency a visitor sees.

Single source of truth for the dual-currency display rule (billing ADR
D2/D3): there is **no live FX in the charge path** (charges are taken in INR
via Razorpay). FX appears only as a **static, display-only** fallback (M3):
Indian visitors read the INR column as stored; everyone else reads the plan's
fixed USD column. The INR→USD rate fallback is used ONLY for legacy plan rows
whose USD column is still NULL (rows created before the USD columns were
added) and never reaches a captured amount. A paid plan persisted with a NULL
USD column is a config error to fix at the source, not here.

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


def seat_price(
    *,
    inr_cents: int,
    usd_cents: int,
    country: str | None = None,
    currency: str | None = None,
) -> tuple[int, str]:
    """Return ``(minor_units, currency)`` for ONE extra operator seat.

    The seat price is global — one INR amount actually charged by the single
    seat add-on plan, and one USD equivalent for the international rail — so
    unlike :func:`display_price` there is no per-plan USD fallback: callers pass
    the canonical ``config.RAZORPAY_SEAT_PLAN_PRICE_CENTS`` /
    ``config.EXTRA_SEAT_PRICE_USD_CENTS`` so every surface shows exactly what the
    seat add-on bills.

    Currency selection: an explicit ``currency`` wins (``"usd"`` → USD, anything
    else → INR); otherwise a non-Indian ``country`` (``!= "IN"``, matching
    :func:`display_price`) selects USD. ``country`` of ``None`` with no currency
    defaults to INR — the live single rail.
    """
    # Explicit currency wins; otherwise a non-Indian country selects USD.
    is_usd = currency.lower() == "usd" if currency is not None else (country is not None and country != "IN")
    if is_usd:
        return int(usd_cents or 0), "USD"
    return int(inr_cents or 0), "INR"


def _group_indian(major: int) -> str:
    """Group an integer with the Indian numbering system (lakh/crore).

    ``1234567 → "12,34,567"`` — the last three digits, then pairs. Western
    grouping (``f"{n:,}"``) renders INR wrong (M2).
    """
    s = str(major)
    if len(s) <= 3:
        return s
    last3 = s[-3:]
    head = s[:-3]
    pairs = []
    while len(head) > 2:
        pairs.insert(0, head[-2:])
        head = head[:-2]
    if head:
        pairs.insert(0, head)
    return ",".join(pairs) + "," + last3


def format_amount(minor_units: int, currency: str) -> str:
    """Format integer minor units as a human string.

    Computed purely from integers via ``divmod`` (no float equality, which is
    imprecise for large paise totals — M2). Drops the fractional part when the
    amount is a whole major unit, and uses Indian (lakh) grouping for INR:
    ``1900, "USD" → "$19"``; ``179900, "INR" → "₹1,799"``;
    ``1234567, "INR" → "₹12,345.67"``; ``15050, "USD" → "$150.50"``. Unknown
    currencies are prefixed with the ISO code (``1000, "EUR" → "EUR 10"``).
    """
    symbol = "₹" if currency == "INR" else "$" if currency == "USD" else f"{currency} "
    minor_units = int(minor_units or 0)
    sign = "-" if minor_units < 0 else ""
    major, minor = divmod(abs(minor_units), 100)
    major_str = _group_indian(major) if currency == "INR" else f"{major:,}"
    body = major_str if minor == 0 else f"{major_str}.{minor:02d}"
    return f"{sign}{symbol}{body}"
