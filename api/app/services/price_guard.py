"""Stop price figures from streaming on a bot whose pricing belongs to the team.

The pricing gate decides from the question's wording, so a typo it cannot read
("what is th picin for SOC as a Service", production 2026-09-10) lets a pricing
question reach the model, which then quotes figures from the knowledge base.
This guard watches the ANSWER as it streams and trips on the first figure. It
holds back any tail of a chunk that could still become a figure once the next
chunk arrives, so no part of the figure itself reaches the visitor.

Pure module: no DB, no I/O, and no import from ``rag_service``.
"""

from __future__ import annotations

import re
from collections.abc import Iterable

from app.services.pricing_gate import _CURRENCY_AMOUNT_RE, normalize_url

#: The gate's own "currency symbol carrying a digit" pattern is reused as is, and
#: its symbol class is lifted out of it so the hold below can never know fewer
#: symbols than the figure test does.
_SYMBOL_CLASS_MATCH = re.fullmatch(r"(\[[^\]]+\])\\s\*\\d", _CURRENCY_AMOUNT_RE.pattern)
if _SYMBOL_CLASS_MATCH is None:
    raise RuntimeError(
        "pricing_gate._CURRENCY_AMOUNT_RE is no longer '[symbols]\\s*\\d'; update price_guard to match its new shape"
    )
_SYMBOL_CLASS = _SYMBOL_CLASS_MATCH.group(1)

#: Codes written before an amount ("Rs. 5,000", "USD 499").
_CURRENCY_CODES = ("rs", "inr", "usd", "eur", "gbp")
#: Words written after an amount ("2,66,250 rupees", "50 lakh", "499 USD").
_AMOUNT_UNITS = (
    *_CURRENCY_CODES,
    "rupee",
    "rupees",
    "dollar",
    "dollars",
    "euro",
    "euros",
    "pound",
    "pounds",
    "lakh",
    "lakhs",
    "lac",
    "lacs",
    "crore",
    "crores",
)
#: What a grouped amount with no symbol is billed by ("1,20,000/year", "45,000 per user").
_BILLING_UNITS = (
    "month",
    "months",
    "mo",
    "year",
    "years",
    "yr",
    "yrs",
    "annum",
    "user",
    "users",
    "seat",
    "seats",
    "licence",
    "licences",
    "license",
    "licenses",
    "device",
    "devices",
    "endpoint",
    "endpoints",
    "hour",
    "hours",
    "hr",
    "hrs",
)


def _alternation(words: Iterable[str]) -> str:
    """Longest first, so a regex alternation never settles for a shorter word."""
    return "|".join(re.escape(word) for word in sorted(set(words), key=len, reverse=True))


def _prefixes(words: Iterable[str]) -> set[str]:
    return {word[:end] for word in words for end in range(1, len(word) + 1)}


_FIGURE_RE = re.compile(
    # A currency symbol before a digit: "₹2,66,250", "$ 499".
    rf"{_CURRENCY_AMOUNT_RE.pattern}"
    # A currency code before a digit: "Rs. 5,000", "INR 2.5 lakh".
    rf"|\b(?:rs\.?|{_alternation(c for c in _CURRENCY_CODES if c != 'rs')})\s*\d"
    # An amount followed by a currency or Indian unit word: "1,200 dollars", "50 lakh".
    rf"|\b\d[\d,]*(?:\.\d+)?\s*(?:{_alternation(_AMOUNT_UNITS)})\b"
    # A grouped amount with no symbol, billed by a period or unit. The thousands
    # separator is what tells "45,000 per user" from "5 per user".
    rf"|\b\d{{1,3}}(?:,\d{{2,3}})+(?:\.\d+)?\s*(?:/|per\s+)\s*(?:{_alternation(_BILLING_UNITS)})\b",
    re.IGNORECASE,
)

_PARTIAL_CODES = _prefixes(_CURRENCY_CODES) - set(_CURRENCY_CODES)
_UNIT_PREFIXES = _alternation(_prefixes(_AMOUNT_UNITS) | _prefixes(["per"]))
_BILLING_PREFIXES = _alternation(_prefixes(_BILLING_UNITS))

#: A tail that could still become a figure once the next chunk arrives. Every
#: proper prefix of a ``_FIGURE_RE`` match must match here (anchored at the end),
#: or a figure split across chunks would be emitted before it is recognised.
_HOLD_RE = re.compile(
    rf"{_SYMBOL_CLASS}\s*\Z"
    rf"|\b(?:{_alternation(_PARTIAL_CODES)})\Z"
    rf"|\b(?:rs\.?|{_alternation(c for c in _CURRENCY_CODES if c != 'rs')})\s*\Z"
    rf"|\b\d[\d,.]*\s*(?:{_UNIT_PREFIXES}|per\s+(?:{_BILLING_PREFIXES})?|/\s*(?:{_BILLING_PREFIXES})?)?\Z",
    re.IGNORECASE,
)

#: Characters of already-emitted text kept so ``\b`` reads correctly at the start
#: of the next chunk ("hou" + "rs 5" is "hours 5", not "Rs 5").
_CONTEXT_CHARS = 1


class PriceStreamGuard:
    """Feed streamed chunks in; get back only text that cannot be part of a price figure.

    Each ``feed`` scans the held tail plus the new chunk, never the whole answer,
    so a long answer streamed in small chunks costs linear time. Nothing already
    emitted can be the start of a figure, because such a tail is always held.
    """

    def __init__(self) -> None:
        self._context = ""
        self._pending = ""
        self._tripped = False

    @property
    def tripped(self) -> bool:
        """True once a price figure was seen. Nothing is emitted after that."""
        return self._tripped

    def feed(self, chunk: str) -> str:
        if self._tripped or not chunk:
            return ""
        window = self._context + self._pending + chunk
        start = len(self._context)
        for match in _FIGURE_RE.finditer(window, start):
            # A figure ending on a letter at the very end of what has arrived may
            # still turn into an ordinary word ("2 euro" + "pean"). It is held
            # below and decided by the next chunk, or by ``flush``.
            if match.end() == len(window) and window[-1].isalpha():
                continue
            return self._trip()
        hold = _HOLD_RE.search(window, start)
        cut = hold.start() if hold else len(window)
        self._pending = window[cut:]
        self._context = window[max(0, cut - _CONTEXT_CHARS) : cut]
        return window[start:cut]

    def flush(self) -> str:
        """The held tail, at the end of the stream: emitted, or tripped on if it is a figure."""
        if self._tripped:
            return ""
        held, self._pending = self._pending, ""
        if held and _FIGURE_RE.search(self._context + held, len(self._context)):
            return self._trip()
        return held

    def _trip(self) -> str:
        self._tripped = True
        self._pending = ""
        return ""


def price_figure_start(text: object) -> int | None:
    """Where the first price figure in a complete text starts, or None."""
    if not isinstance(text, str) or not text:
        return None
    match = _FIGURE_RE.search(text)
    return match.start() if match else None


def contains_price_figure(text: object) -> bool:
    """True when a complete answer states a price figure the guard would trip on."""
    return price_figure_start(text) is not None


def price_guard_applies(
    *,
    gate_outcome: str,
    pricing_url: object,
    answer_from_knowledge_base: bool,
    support_enabled: bool,
    judges_bypassed: bool,
) -> bool:
    """Whether this turn's answer is watched for price figures.

    The bots the gate would escalate a pricing question on: no owner opt-in to
    knowledge-base pricing, no usable pricing page (the same ``normalize_url``
    test that sends ``evaluate_pricing_gate`` to ``escalate_no_url``), a plan with
    a human to escalate to, and a turn the gate read as ``not_pricing``. A turn it
    answered, escalated or stood down on is already handled. English only, like
    the gate: a bypassed-judges conversation is left to the knowledge base.
    """
    return (
        gate_outcome == "not_pricing"
        and not answer_from_knowledge_base
        and support_enabled
        and not judges_bypassed
        and normalize_url(pricing_url) is None
    )
