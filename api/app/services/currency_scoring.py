"""Normalise a stated money amount to the qualification rubric's currency.

WHY THIS EXISTS. Budget rubrics are denominated in one currency (the shipped
BANT preset uses USD: "Under $1K/mo", "$1K-5K/mo", "$5K-20K/mo", "$20K+/mo"),
but visitors state budgets in their own. The LLM extractor matched the RAW
MAGNITUDE against those bands with no conversion, so "50,000 rupees per month"
(about $600) scored 25/25 -- the TOP band, "$20K+/mo" -- a roughly 30x
over-valuation that silently ranked a small lead as the most valuable on the
platform. It is invisible in the transcript: the number is quoted back
correctly, only the score is wrong.

WHAT IS DETERMINISTIC AND WHAT IS NOT, because the split is the whole design:

* CONVERSION happens HERE, in code. This is where the 30x error lived, and it
  is arithmetic -- reproducible, unit-testable, auditable. The extractor's own
  contract is "STRICT ... default to NO SIGNAL ... NEVER INFER", and asking it
  to do FX is exactly the inference it forbids everywhere else.
* BAND MATCHING stays with the extractor. Rubric options carry only a free-text
  ``label`` (admin-editable, and MEDDIC/custom frameworks use entirely
  different wording), so parsing ranges out of them would be guesswork. Once
  the amount is expressed in the rubric's own currency the extractor already
  does this reliably -- it scores "$5,000/mo" and "500 USD/mo" correctly today.

RATES ARE COARSE ON PURPOSE. Bands span an order of magnitude, so a rate that
is 10% stale cannot move a value across a boundary; only a wrong CURRENCY can.
That is why a fixed table is sufficient and a live FX feed would be a liability
(a network call on the extraction path that can fail).

FAILS CLOSED. Text with no recognisable currency, or a currency absent from the
table, yields ``None`` and the extractor is left exactly as it was -- no hint,
no guess. An unscored budget is a better outcome than one scored 30x wrong,
the same call ``pricing_gate`` already makes about stale prices.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

#: Approximate value of one unit in USD. Reviewed periodically; see the module
#: docstring for why precision here does not matter and currency identity does.
#: Last reviewed: 2026-09.
RATES_TO_USD: dict[str, float] = {
    "USD": 1.0,
    "EUR": 1.08,
    "GBP": 1.27,
    "INR": 0.012,
    "JPY": 0.0067,
    "AUD": 0.66,
    "CAD": 0.74,
    "SGD": 0.75,
    "AED": 0.27,
    "CHF": 1.12,
    "ZAR": 0.055,
    "BRL": 0.19,
}

#: Symbols shared by several currencies resolve to the dominant one. "$" is
#: overwhelmingly USD in this product's traffic, and the alternatives (CAD/AUD/
#: SGD) sit within ~35% of USD -- far too close to cross a band boundary, so a
#: mis-resolution here is harmless in a way that mistaking INR for USD is not.
_SYMBOL_CURRENCY = {"$": "USD", "€": "EUR", "£": "GBP", "₹": "INR", "¥": "JPY"}

_WORD_CURRENCY = {
    "usd": "USD",
    "dollar": "USD",
    "dollars": "USD",
    "us dollars": "USD",
    "eur": "EUR",
    "euro": "EUR",
    "euros": "EUR",
    "gbp": "GBP",
    "pound": "GBP",
    "pounds": "GBP",
    "quid": "GBP",
    "inr": "INR",
    "rupee": "INR",
    "rupees": "INR",
    "rs": "INR",
    "rs.": "INR",
    "re": "INR",
    "jpy": "JPY",
    "yen": "JPY",
    "aud": "AUD",
    "cad": "CAD",
    "sgd": "SGD",
    "aed": "AED",
    "dirham": "AED",
    "dirhams": "AED",
    "chf": "CHF",
    "zar": "ZAR",
    "brl": "BRL",
}

#: Indian numbering, which is how an INR budget is most often written.
_SCALE_WORDS = {
    "k": 1_000,
    "m": 1_000_000,
    "mn": 1_000_000,
    "bn": 1_000_000_000,
    "lakh": 100_000,
    "lakhs": 100_000,
    "lac": 100_000,
    "lacs": 100_000,
    "crore": 10_000_000,
    "crores": 10_000_000,
}

_NUM = r"(\d[\d,]*(?:\.\d+)?)"
# ``\b`` is load-bearing: without it the "m" of "monthly" matched as the
# millions suffix and "Rs. 50,000 monthly" was read as 50 BILLION rupees.
_SCALE = r"(?:(k|m|mn|bn|lakhs?|lacs?|crores?)\b)?"
_WORDS = "|".join(sorted((re.escape(w) for w in _WORD_CURRENCY), key=len, reverse=True))

# "₹50,000" / "$5k" / "€2000"
_SYMBOL_FIRST = re.compile(r"([₹$€£¥])\s*" + _NUM + r"\s*" + _SCALE, re.IGNORECASE)
# "50,000 rupees" / "5k USD" / "2 lakh inr"
_AMOUNT_THEN_WORD = re.compile(_NUM + r"\s*" + _SCALE + r"\s*(" + _WORDS + r")\b", re.IGNORECASE)
# "INR 50,000" / "Rs. 5000"
_WORD_THEN_AMOUNT = re.compile(r"\b(" + _WORDS + r")\s*\.?\s*" + _NUM + r"\s*" + _SCALE, re.IGNORECASE)

# "2 lakh a month" / "1 crore" -- Indian numbering with no currency marker.
# Tried last, only after every currency-marked pattern has failed.
_INDIAN_SCALE_ONLY = re.compile(_NUM + r"\s*(lakhs?|lacs?|crores?)\b", re.IGNORECASE)

_PER_YEAR_RE = re.compile(r"(?:/\s*(?:yr|year)|per\s+year|per\s+annum|a\s+year|annually|p\.?a\.?)\b", re.IGNORECASE)


@dataclass(frozen=True)
class MoneyAmount:
    """A money amount found in visitor text, converted to the rubric currency."""

    currency: str
    amount: float
    per_month: float
    converted: float
    target_currency: str
    raw: str


def _to_float(num: str, scale: str | None) -> float | None:
    try:
        value = float(num.replace(",", ""))
    except ValueError:
        return None
    if scale:
        key = scale.lower()
        value *= _SCALE_WORDS.get(key) or _SCALE_WORDS.get(key.rstrip("s"), 1)
    return value


def detect_money(text: object, target_currency: str = "USD") -> MoneyAmount | None:
    """Find a stated amount and express it in ``target_currency`` per month.

    Returns ``None`` when nothing is recognised, when the currency is not in
    ``RATES_TO_USD``, or when the target currency itself is unknown -- callers
    must treat that as "no information", never as zero.

    A bare number with no currency marker is deliberately NOT matched: "5000"
    alone is as likely to be a headcount or a CVE count as a budget, and
    guessing its currency is the very failure this module exists to remove.
    """
    if not isinstance(text, str) or not text.strip():
        return None
    target = (target_currency or "USD").upper()
    if target not in RATES_TO_USD:
        return None

    match = _SYMBOL_FIRST.search(text)
    if match:
        currency = _SYMBOL_CURRENCY.get(match.group(1))
        value = _to_float(match.group(2), match.group(3))
    else:
        match = _AMOUNT_THEN_WORD.search(text)
        if match:
            currency = _WORD_CURRENCY.get(match.group(3).lower())
            value = _to_float(match.group(1), match.group(2))
        else:
            match = _WORD_THEN_AMOUNT.search(text)
            if match:
                currency = _WORD_CURRENCY.get(match.group(1).lower())
                value = _to_float(match.group(2), match.group(3))
            else:
                match = _INDIAN_SCALE_ONLY.search(text)
                if not match:
                    return None
                currency = None  # resolved to INR by the lakh/crore rule below
                value = _to_float(match.group(1), match.group(2))

    # "2 lakh a month" / "1 crore" carry no currency marker, but those words are
    # Indian numbering and are not used for any other currency in practice. A
    # narrow, named inference rather than the general "guess the currency of a
    # bare number" this module refuses to make -- and it matters, because INR is
    # exactly the currency the un-normalised scoring was worst at.
    if not currency and match.lastindex:
        groups = [(match.group(i) or "").lower().rstrip("s") for i in range(1, match.lastindex + 1)]
        if any(g in ("lakh", "lac", "crore") for g in groups):
            currency = "INR"

    if not currency or value is None or value <= 0 or currency not in RATES_TO_USD:
        return None

    # Rubric bands are monthly, so an annual figure is spread across the year
    # rather than compared against a monthly band twelve times too large.
    per_month = value / 12 if _PER_YEAR_RE.search(text) else value
    converted = per_month * RATES_TO_USD[currency] / RATES_TO_USD[target]
    return MoneyAmount(
        currency=currency,
        amount=value,
        per_month=per_month,
        converted=converted,
        target_currency=target,
        raw=match.group(0).strip(),
    )


def _format(amount: float, currency: str) -> str:
    if amount >= 1000:
        return f"{amount / 1000:,.1f}".rstrip("0").rstrip(".") + f"K {currency}"
    return f"{amount:,.0f} {currency}"


def normalization_hint(text: object, target_currency: str = "USD") -> str | None:
    """A prompt line stating the amount in the rubric's currency, or None.

    Returned as an authoritative pre-computed fact rather than an instruction to
    convert: the extractor is told the answer, not asked to work it out. None
    when nothing was detected, or when the visitor already used the rubric's own
    currency and there is therefore nothing to clarify.
    """
    found = detect_money(text, target_currency)
    if found is None or found.currency == found.target_currency:
        return None
    return (
        "CURRENCY NORMALISATION (pre-computed, authoritative — use this figure, "
        "do NOT convert it yourself):\n"
        f"The visitor stated {_format(found.per_month, found.currency)} per month, "
        f"which is approximately {_format(found.converted, found.target_currency)} per month. "
        f"Score any budget signal against the rubric using the "
        f"{found.target_currency} figure, not the raw number the visitor typed."
    )
