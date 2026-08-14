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
discount); this module owns currency selection + formatting, plus the one
regulatory bound a *price* has to clear (:func:`emandate_warning`). They are
kept separate because they change for different reasons.

Nothing here touches the database or the network — pure value helpers, safe
to call from anywhere (routes, services, scripts, tests).
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class BillingContext:
    """The resolved billing identity a quote or charge acts on.

    ``source`` records WHICH signal won, so callers can gate on trust level:
    ``request`` (confirmed this call) and ``stored`` (on the account) are
    charge-grade; ``detected`` (IP geo) is display-grade only; ``unresolved``
    means no signal at all.
    """

    country: str | None
    currency: str  # "INR" | "USD"
    source: str  # "request" | "stored" | "detected" | "unresolved"


def resolve_billing_context(
    *,
    stored_country: str | None,
    request_country: str | None = None,
    detected_country: str | None = None,
) -> BillingContext:
    """The ONE resolution order for every billing surface (blueprint §2).

    ``request_country`` (this call's explicit confirmation) → ``stored_country``
    (the account's tax fact) → ``detected_country`` (IP geo, display-grade) →
    unresolved. Currency always maps through :func:`charge_currency`, so an
    unresolved buyer is domestic/INR — matching every legacy account (NULL
    country, INR mandate) — instead of one surface guessing USD while another
    charges rupees.

    Pure and HTTP-free: routes translate trust rules into status codes (e.g.
    a charge path refusing to act on a ``detected`` foreign signal). Quote and
    charge calling THIS one function is what makes divergence impossible.
    """
    for raw, source in (
        (request_country, "request"),
        (stored_country, "stored"),
        (detected_country, "detected"),
    ):
        country = (raw or "").strip().upper() or None
        if country:
            return BillingContext(country=country, currency=charge_currency(country), source=source)
    return BillingContext(country=None, currency=charge_currency(None), source="unresolved")


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


def charge_currency(country: str | None) -> str:
    """Return the currency a billing country is actually CHARGED in.

    Deliberately stricter than :func:`display_price`'s country rule: an unknown
    country (``None``/blank) means "not confirmed", and an unconfirmed customer
    is a domestic one — every account that predates the country-confirmation
    step has a NULL ``billing_country`` and an INR mandate. Defaulting those to
    USD would repoint live customers at the wrong rail, so display may guess
    USD for an unknown visitor while the charge path never does.

    ``"IN"`` (any case/whitespace) → ``"INR"``; any other country → ``"USD"``.
    """
    normalized = (country or "").strip().upper()
    return "USD" if normalized and normalized != "IN" else "INR"


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


# RBI Digital Payments — E-mandate Framework, 2026 (notified 21 Apr 2026):
# a recurring debit above this amount requires Additional Factor of
# Authentication on EVERY charge, so the renewal stops being silent and the
# customer must re-authenticate each cycle. The Rs 1,00,000 ceiling applies
# only to insurance, mutual funds and credit card bills — SaaS does not
# qualify. Expressed in paise to match the price columns.
EMANDATE_AFA_CEILING_MINOR = 1_500_000


def emandate_warning(amount_minor: int | None, currency: str | None) -> str | None:
    """Warn when a per-charge amount would forfeit AFA-exempt auto-debit.

    Deliberately a WARNING, not a hard block: pricing above the ceiling is a
    legitimate business decision (an enterprise tier may accept per-renewal
    re-authentication, or bill by invoice instead of by mandate). The failure
    this prevents is crossing the line *unknowingly* — and the catalogue is
    already well across it: Professional annual is Rs 28,188 (88% ABOVE the
    ceiling) and Enterprise annual Rs 57,588 (3.8x it). Every monthly amount
    still clears it, as do Starter and Standard annual (Rs 5,748 / Rs 11,508).

    Lives in ``core`` rather than on the super-admin route that first needed it
    because a price also reaches the database through ``scripts/seed_plans.py``,
    and a script importing from ``app.api`` would drag the whole FastAPI/auth
    import graph into a CLI. Both callers now import THIS function, so neither
    can drift from the other's idea of the ceiling.

    Non-INR is out of scope: the threshold is a rupee figure and cannot be
    compared against a USD amount. The 2026 framework does cover cross-border,
    so the FX-converted test lands with the USD rail once Razorpay confirms how
    the ceiling applies to foreign-issued cards.
    """
    if (currency or "INR").upper() != "INR":
        return None
    if int(amount_minor or 0) <= EMANDATE_AFA_CEILING_MINOR:
        return None
    return (
        f"₹{int(amount_minor) / 100:,.0f} per charge exceeds the RBI e-mandate AFA-exempt "
        f"ceiling of ₹{EMANDATE_AFA_CEILING_MINOR / 100:,.0f}. Auto-debit will require the "
        f"customer to authenticate every renewal. Consider monthly billing or invoice-based "
        f"collection for this tier."
    )


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
