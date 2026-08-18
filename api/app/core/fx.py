"""Foreign-exchange conversion for export invoices. Pure, integer-only, no I/O.

WHY THIS EXISTS
---------------
A supply billed in USD is still reported to the GST department in rupees:
GSTR-1 Table 6A (exports) carries the INR taxable value, and an export made
WITHOUT a LUT attracts IGST that is remitted in INR. So every non-INR document
needs an INR mirror, and the mirror needs a defensible rate.

Rule 34(2) of the CGST Rules sets that rate for SERVICES: "the applicable rate
of exchange determined as per the generally accepted accounting principles for
the date of the time of supply". (Goods use the CBIC-notified Customs rate under
Rule 34(1); services deliberately do not.)

Razorpay's payment entity supplies exactly that. On a non-INR payment it
returns ``base_amount``. "the converted payment amount ... represented in the
smallest unit of the base_currency". Converted at "the exchange rate
(according to the processing bank) on the date the payment was made". That is a
bank rate on the transaction date: a realised, third-party-evidenced,
GAAP-consistent rate, and it is the same figure Razorpay settles on, so the
invoice reconciles against the settlement and the FIRC.

We therefore never *choose* a rate. We record the one the money actually moved
at, and store it on the document so an assessing officer can reproduce the
arithmetic years later.

THE ONE THING THIS MODULE DEFENDS AGAINST
-----------------------------------------
Unit confusion. ``base_amount`` is documented in paise, but if it ever arrives
in rupees (an API change, a zero-decimal currency such as JPY, a hand-built
payload in a backfill) the implied rate lands 100x off and the document would
misstate the taxable value by two orders of magnitude. A missing tax document
can be issued late; a wrong one has already been filed. So an implausible rate
is a hard refusal, not a warning.
"""

from __future__ import annotations

# Rates are stored as integer micros (INR per 1 unit of the foreign currency,
# x 1_000_000) so nothing on a statutory document ever touches binary float.
MICROS = 1_000_000

# Plausibility band for INR per one unit of a foreign currency, in micros.
# Wide on purpose: it is a unit-confusion tripwire, NOT an FX opinion. The
# floor sits below AED (~23) and the ceiling above GBP (~113) and KWD (~280),
# so every currency a customer might realistically pay in passes, while the
# 100x-off cases (0.89 and 8,944) fall outside.
MIN_PLAUSIBLE_RATE_MICROS = 5 * MICROS
MAX_PLAUSIBLE_RATE_MICROS = 500 * MICROS


class FxError(ValueError):
    """The captured conversion cannot produce a reportable INR value."""


def _round_half_up(numerator: int, denominator: int) -> int:
    """Round ``numerator / denominator`` to the nearest integer, halves up.

    Integer-only, mirroring ``app.core.tax._round_half_up``. Money never goes
    through a float.
    """
    return (2 * numerator + denominator) // (2 * denominator)


def implied_rate_micros(foreign_minor: int, inr_minor: int) -> int:
    """INR per one unit of the foreign currency, in micros.

    Derived from the two amounts Razorpay actually converted between, so the
    rate is evidence rather than an assumption. ``foreign_minor`` is the charge
    in its own minor units (cents); ``inr_minor`` is Razorpay's ``base_amount``
    in paise.
    """
    if foreign_minor <= 0:
        raise FxError(f"foreign amount must be positive to imply a rate, got {foreign_minor}")
    if inr_minor < 0:
        raise FxError(f"INR amount must be non-negative, got {inr_minor}")
    return _round_half_up(inr_minor * MICROS, foreign_minor)


def is_plausible_rate(rate_micros: int) -> bool:
    """Whether a rate is inside the unit-confusion tripwire band."""
    return MIN_PLAUSIBLE_RATE_MICROS <= rate_micros <= MAX_PLAUSIBLE_RATE_MICROS


def convert_minor(foreign_minor: int, rate_micros: int) -> int:
    """Convert a foreign minor-unit amount to paise at ``rate_micros``.

    Used for the COMPONENTS of the breakup (taxable value, tax). The document
    TOTAL is never re-derived through this, it is Razorpay's ``base_amount``
    verbatim, so the invoice ties to the settlement to the paisa.
    """
    if foreign_minor < 0:
        raise FxError(f"amount must be non-negative, got {foreign_minor}")
    if rate_micros <= 0:
        raise FxError(f"rate must be positive, got {rate_micros}")
    return _round_half_up(foreign_minor * rate_micros, MICROS)
