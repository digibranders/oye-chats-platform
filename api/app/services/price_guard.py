"""Stop the company's own prices from streaming on a bot whose pricing belongs to the team.

The pricing gate decides from the question's wording, so a typo it cannot read
("what is th picin for SOC as a Service", production 2026-09-10) lets a pricing
question reach the model, which then quotes figures from the knowledge base.
This guard watches the ANSWER as it streams. It holds back any tail of a chunk
that could still become a figure once the next chunk arrives, so no part of a
figure it trips on reaches the visitor.

Not every amount is the company's price. A security bot quotes GDPR fines and
breach costs, and a jobs bot quotes salaries; replacing those answers with the
pricing escalation hands a helped visitor to the team and records the turn as
unanswered. So a figure trips only on a price signal:

* the turn carries one (``signal=True``): the question reads like a pricing
  question, typos included (``pricing_gate.question_has_fuzzy_price_word``), or
  the session was already escalated on pricing;
* or the figure's own sentence names a price, a plan or a fee (``_OWN_PRICE_RE``).
  An amount billed "per month" or a "cost" alone does not: fines, breaches and
  salaries come in those words too.

Without a turn signal a figure is held until its sentence ends, and released
intact, or until an own-price word arrives in that sentence, and tripped on. The
hold lasts at most ``_HOLD_CAP_CHARS`` characters.

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

#: The amounts are bounded, so a long comma-joined run of numbers ("560001,560002,
#: ...") costs a fixed amount of work at each position instead of a rescan of the
#: whole run on every chunk. An amount before a unit word: at most 26 characters.
_AMOUNT = r"\d[\d,]{0,20}(?:\.\d{1,4})?"
#: A grouped amount ("2,66,250", "1,20,000.50"): at most 32 characters.
_GROUPED_AMOUNT = r"\d{1,3}(?:,\d{2,3}){1,6}(?:\.\d{1,4})?"
#: A prefix of either amount, for the hold. It must reach the longest grouped
#: amount (32 characters), or the head of one would be emitted before its unit.
_AMOUNT_PREFIX = r"\d[\d,.]{0,31}"


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
    rf"|\b{_AMOUNT}\s*(?:{_alternation(_AMOUNT_UNITS)})\b"
    # A grouped amount with no symbol, billed by a period or unit. The thousands
    # separator is what tells "45,000 per user" from "5 per user".
    rf"|\b{_GROUPED_AMOUNT}\s*(?:/|per\s+)\s*(?:{_alternation(_BILLING_UNITS)})\b",
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
    rf"|\b{_AMOUNT_PREFIX}\s*(?:{_UNIT_PREFIXES}|per\s+(?:{_BILLING_PREFIXES})?|/\s*(?:{_BILLING_PREFIXES})?)?\Z",
    re.IGNORECASE,
)

#: Words that make a figure in the same sentence the company's own price. A
#: cadence ("per month", "a year") and "cost", "pay", "budget" or "rate" are left
#: out on purpose: fines, breach costs, salaries and tax thresholds use them too.
#: Phrases never cross a line break, so a match cannot span two sentences.
_OWN_PRICE_RE = re.compile(
    r"\b(?:pric(?:e|es|ed|ing)|fees?|charges?|charged|tariffs?|plans?|packages?|subscriptions?|tiers?"
    r"|quot(?:e|es|ed|ation)|invoice[sd]?|billed|billing|retainers?"
    r"|start(?:s|ing)?[^\S\n]+(?:at|from)"
    r"|per[^\S\n]+(?:user|seat|licen[cs]e|device|endpoint)s?)\b"
    r"|/[^\S\n]*(?:user|seat)s?\b",
    re.IGNORECASE,
)

#: Where a sentence ends: a full stop, "!" or "?" followed by whitespace, or a
#: line break. The whitespace keeps a decimal point ("4.45") and anything else
#: inside a number out; the look-behind keeps the full stop in "Rs. 5,000" out.
#: The end of the stream ends a sentence too, which ``flush`` handles.
_SENTENCE_END_RE = re.compile(r"(?<!\b[Rr][Ss])[.!?](?=\s)|\n")

#: Characters of already-emitted text kept so ``\b`` reads correctly at the start
#: of the next chunk ("hou" + "rs 5" is "hours 5", not "Rs 5").
_CONTEXT_CHARS = 1
#: How much of a sentence may be held after an unpriced figure while the guard
#: waits for the sentence to end or name a price. Past this the text is released.
_HOLD_CAP_CHARS = 300
#: The end of the emitted part of the current sentence, kept so an own-price word
#: split across chunks is still read. Longer than any phrase in ``_OWN_PRICE_RE``.
_SENTENCE_TAIL_CHARS = 32


class PriceStreamGuard:
    """Feed streamed chunks in; get back only text that cannot be part of a figure the guard trips on.

    ``signal`` is the turn's own price signal (see the module note). With it every
    figure trips. Without it a figure trips only when its sentence names a price,
    and the figure and the rest of its sentence are held until that is known.

    Each ``feed`` scans the text still held plus the new chunk, and a short tail of
    the emitted sentence, never the whole answer. What is held is bounded (a figure
    prefix of at most a few dozen characters, or ``_HOLD_CAP_CHARS`` of a held
    sentence) and so are the amount patterns, so the work per streamed character is
    bounded. The one exception is an unbroken run of whitespace after a currency
    symbol, code or amount, which is held in full until something else arrives.
    """

    def __init__(self, *, signal: bool = False) -> None:
        self._signal = signal
        #: Emitted text just before ``_pending``, so ``\b`` reads the real neighbour.
        self._context = ""
        #: Text fed in and not emitted yet.
        self._pending = ""
        #: Above zero while ``_pending`` starts with an unpriced figure of this length.
        self._held_figure_len = 0
        #: The end of the emitted part of the current sentence, and where scanning it
        #: starts (1 when its first character is only there as context).
        self._sentence_tail = ""
        self._sentence_tail_from = 0
        #: An own-price word was read in the emitted part of the current sentence.
        self._sentence_priced = False
        self._tripped = False

    @property
    def tripped(self) -> bool:
        """True once a figure tripped the guard. Nothing is emitted after that."""
        return self._tripped

    @property
    def held(self) -> str:
        """Text fed in but not emitted, so never shown to the visitor. Empty after a trip."""
        return self._pending

    def feed(self, chunk: str) -> str:
        if self._tripped or not chunk:
            return ""
        self._pending += chunk
        return self._advance(final=False)

    def flush(self) -> str:
        """The held text, at the end of the stream: emitted, or tripped on."""
        if self._tripped:
            return ""
        return self._advance(final=True)

    def _advance(self, *, final: bool) -> str:
        emitted: list[str] = []
        while self._pending:
            if self._held_figure_len:
                progressed = self._settle_held_sentence(emitted, final=final)
            else:
                progressed = self._scan(emitted, final=final)
            if self._tripped:
                return ""
            if not progressed:
                break
        return "".join(emitted)

    def _scan(self, emitted: list[str], *, final: bool) -> bool:
        """Outside a held sentence: trip on a figure, start holding one, or emit up to a possible figure.

        Returns True when a hold started and the held sentence must be settled next.
        """
        window = self._context + self._pending
        start = len(self._context)
        for match in _FIGURE_RE.finditer(window, start):
            # A figure ending on a letter at the very end of what has arrived may
            # still turn into an ordinary word ("2 euro" + "pean"). It is held
            # below and decided by the next chunk, or by ``flush``.
            if not final and match.end() == len(window) and window[-1].isalpha():
                continue
            if self._signal:
                self._trip()
                return False
            # The text before the figure is emitted first, so the sentence it
            # belongs to is read up to the figure itself.
            self._emit(emitted, window, start, match.start())
            if self._sentence_priced:
                self._trip()
                return False
            self._held_figure_len = match.end() - match.start()
            return True
        cut = len(window)
        if not final:
            hold = _HOLD_RE.search(window, start)
            if hold:
                cut = hold.start()
        self._emit(emitted, window, start, cut)
        return False

    def _settle_held_sentence(self, emitted: list[str], *, final: bool) -> bool:
        """Trip if the held figure's sentence names a price; release it once the sentence ends.

        Returns True when text was released and scanning continues after it.
        """
        window = self._context + self._pending
        start = len(self._context)
        end = _SENTENCE_END_RE.search(window, start + self._held_figure_len)
        stop = end.end() if end else len(window)
        for word in _OWN_PRICE_RE.finditer(window, start):
            if word.start() >= stop:
                break
            # A word at the very end of what has arrived may still grow into
            # another one ("plan" + "et"): only a later chunk or ``flush`` decides.
            if end or final or word.end() < len(window) or not window[-1].isalpha():
                self._trip()
                return False
            break
        if end or final:
            release = stop
        elif len(self._pending) >= _HOLD_CAP_CHARS:
            # Released at the cap, but a figure starting at the end is still held.
            hold = _HOLD_RE.search(window, start + self._held_figure_len)
            release = hold.start() if hold else len(window)
        else:
            return False
        self._held_figure_len = 0
        self._emit(emitted, window, start, release)
        return True

    def _emit(self, emitted: list[str], window: str, start: int, cut: int) -> None:
        """Emit ``window[start:cut]`` and keep the rest pending."""
        text = window[start:cut]
        if text:
            emitted.append(text)
        if not self._signal:
            self._track_sentence(text, lookahead=window[cut : cut + 1])
        self._pending = window[cut:]
        self._context = window[max(0, cut - _CONTEXT_CHARS) : cut]

    def _track_sentence(self, text: str, *, lookahead: str) -> None:
        """Follow the emitted part of the current sentence: where it starts and whether it names a price.

        ``lookahead`` is the character that follows ``text``, or "" when it has not
        arrived: a full stop or a word at the very end is only settled once it has.
        """
        scan = self._sentence_tail + text
        probe = scan + lookahead
        sentence_from = self._sentence_tail_from
        for end in _SENTENCE_END_RE.finditer(probe, sentence_from):
            if end.end() > len(scan):
                break
            sentence_from = end.end()
        if sentence_from > self._sentence_tail_from:
            self._sentence_priced = False
        if not self._sentence_priced:
            for word in _OWN_PRICE_RE.finditer(probe, sentence_from):
                if word.end() <= len(scan) and (lookahead or word.end() < len(scan) or not scan[-1].isalpha()):
                    self._sentence_priced = True
                break
        keep_from = max(sentence_from, len(scan) - _SENTENCE_TAIL_CHARS)
        context_from = max(0, keep_from - _CONTEXT_CHARS)
        self._sentence_tail = scan[context_from:]
        self._sentence_tail_from = keep_from - context_from

    def _trip(self) -> None:
        self._tripped = True
        self._pending = ""
        self._held_figure_len = 0


def answer_trips_price_guard(text: object, *, signal: bool) -> bool:
    """True when a complete answer would trip a guard with this turn's ``signal``."""
    if not isinstance(text, str) or not text:
        return False
    guard = PriceStreamGuard(signal=signal)
    guard.feed(text)
    guard.flush()
    return guard.tripped


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
