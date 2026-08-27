"""Pure currency-display helpers, which amount + currency a visitor sees.

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

Nothing here touches the database or the network. Pure value helpers, safe
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
    unresolved buyer is domestic/INR (matching every legacy account (NULL
    country, INR mandate)) instead of one surface guessing USD while another
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

    * ``country == "IN"`` → ``(inr_paise, "INR")``. Stored INR, untouched.
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

    # Non-positive rate would divide by zero. Fall back to 0 (legacy rows
    # should always have a USD column set; this is defence-in-depth).
    converted = round((int(inr_paise or 0) / 100) / rate * 100) if rate and rate > 0 else 0
    return converted, "USD"


def charge_currency(country: str | None) -> str:
    """Return the currency a billing country is actually CHARGED in.

    Deliberately stricter than :func:`display_price`'s country rule: an unknown
    country (``None``/blank) means "not confirmed", and an unconfirmed customer
    is a domestic one. Every account that predates the country-confirmation
    step has a NULL ``billing_country`` and an INR mandate. Defaulting those to
    USD would repoint live customers at the wrong rail, so display may guess
    USD for an unknown visitor while the charge path never does.

    ``"IN"`` (any case/whitespace) → ``"INR"``; any other country → ``"USD"``.
    """
    normalized = (country or "").strip().upper()
    return "USD" if normalized and normalized != "IN" else "INR"


def annual_saving_percent(monthly_minor: int | None, annual_minor: int | None) -> int:
    """One plan's annual saving as a whole percent, derived from its two prices.

    The ONE definition of that number for the whole backend. Every plan payload
    serves it under the existing ``annual_discount_percent`` key, so the marketing
    site, the admin app and the super-admin editor read one figure computed one
    way, the response shape is unchanged, only the value is now true.

    Deliberately NOT the stored ``Plan.annual_discount_percent`` column. That is a
    single hand-maintained int on a row carrying BOTH an INR and a USD price pair,
    so it can only ever match one rail, and it drifted: seeded Professional stores
    22 while ₹28,188 against 12 × ₹2,999 is a 21.674% saving. Deriving from the
    prices makes the badge unfalsifiable by construction.

    Reads the **INR** columns, because that is the rail the stored int always
    described and the rail every price surface renders today (the USD savings for
    the same plans are 18.77 / 18.76 / 17.40 / 20.00%, so one int never covered
    both). When a surface starts choosing its rail via :func:`display_price`, pass
    that rail's two amounts here instead, the arithmetic is currency-agnostic.

    Integer-only and multiply-before-divide: both operands stay exact, so a saving
    that is exactly N% divides to exactly N and cannot floor down to N-1.

    Rounds DOWN, never to nearest. This number sits next to a Subscribe button, so
    the failure modes are not symmetric. Understating a saving costs nothing,
    while overstating one tells a customer they will be charged less than they
    will be. 21.674% must read as 21, never 22.

    Returns ``0`` for any plan with no real annual saving to quote: free and
    contact-sales tiers (no monthly price), plans with no annual price, and the
    defensive case of an annual price at or above twelve monthly ones, which would
    otherwise produce a negative "saving". Consumers drop the badge on 0 rather
    than render "0%".

    Exactly mirrors ``annualSavingPercent`` in
    ``app/src/features/workspace/billingModel.ts``, which is the reference
    implementation. A server that disagreed with that client would reintroduce the
    two-numbers-one-name bug in a subtler form, so the guard rails (floor, the
    zero cases, the operand order) are copied deliberately rather than re-derived.
    """
    twelve_months = int(monthly_minor or 0) * 12
    annual = int(annual_minor or 0)
    if twelve_months <= 0 or annual <= 0 or annual >= twelve_months:
        return 0
    return (twelve_months - annual) * 100 // twelve_months


def seat_price(
    *,
    inr_cents: int,
    usd_cents: int,
    country: str | None = None,
    currency: str | None = None,
) -> tuple[int, str]:
    """Return ``(minor_units, currency)`` for ONE extra operator seat.

    The seat price is global (one INR amount actually charged by the single
    seat add-on plan, and one USD equivalent for the international rail) so
    unlike :func:`display_price` there is no per-plan USD fallback: callers pass
    the canonical ``config.RAZORPAY_SEAT_PLAN_PRICE_CENTS`` /
    ``config.EXTRA_SEAT_PRICE_USD_CENTS`` so every surface shows exactly what the
    seat add-on bills.

    Currency selection: an explicit ``currency`` wins (``"usd"`` → USD, anything
    else → INR); otherwise a non-Indian ``country`` (``!= "IN"``, matching
    :func:`display_price`) selects USD. ``country`` of ``None`` with no currency
    defaults to INR, the live single rail.
    """
    # Explicit currency wins; otherwise a non-Indian country selects USD.
    is_usd = currency.lower() == "usd" if currency is not None else (country is not None and country != "IN")
    if is_usd:
        return int(usd_cents or 0), "USD"
    return int(inr_cents or 0), "INR"


# RBI Digital Payments. E-mandate Framework, 2026 (notified 21 Apr 2026):
# a recurring debit above this amount requires Additional Factor of
# Authentication on EVERY charge, so the renewal stops being silent and the
# customer must re-authenticate each cycle. The Rs 1,00,000 ceiling applies
# only to insurance, mutual funds and credit card bills. SaaS does not
# qualify. Expressed in paise to match the price columns.
EMANDATE_AFA_CEILING_MINOR = 1_500_000


def emandate_warning(amount_minor: int | None, currency: str | None, *, rate_bps: int) -> str | None:
    """Warn when a per-charge amount would forfeit AFA-exempt auto-debit.

    ``amount_minor`` is the BASE price as stored on the plan row. The ceiling
    applies to what is actually DEBITED, and prices are published exclusive of
    GST, so the tax is added here rather than at the call sites: a caller that
    passed the base would test a number 18% below the one RBI cares about and
    wave through a mandate that breaches the ceiling. ``rate_bps`` is required,
    not defaulted, so adding a third caller forces the question.

    Deliberately a WARNING, not a hard block: pricing above the ceiling is a
    legitimate business decision (an enterprise tier may accept per-renewal
    re-authentication, or bill by invoice instead of by mandate). The failure
    this prevents is crossing the line *unknowingly*, and the catalogue is
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
    from app.core.tax import gross_charge_minor

    if (currency or "INR").upper() != "INR":
        return None
    charged_minor = gross_charge_minor(int(amount_minor or 0), rate_bps=rate_bps, kind="intra")
    if charged_minor <= EMANDATE_AFA_CEILING_MINOR:
        return None
    return (
        f"₹{charged_minor / 100:,.0f} per charge (₹{int(amount_minor or 0) / 100:,.0f} plus GST) "
        f"exceeds the RBI e-mandate AFA-exempt ceiling of ₹{EMANDATE_AFA_CEILING_MINOR / 100:,.0f}. "
        f"Auto-debit will require the customer to authenticate every renewal. Consider monthly "
        f"billing or invoice-based collection for this tier."
    )


def _group_indian(major: int) -> str:
    """Group an integer with the Indian numbering system (lakh/crore).

    ``1234567 → "12,34,567"``, the last three digits, then pairs. Western
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
    imprecise for large paise totals. M2). Drops the fractional part when the
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
