"""Stop the company's own prices from streaming on a bot whose pricing belongs to the team.

The pricing gate decides from the question's wording, so a typo it cannot read
("what is th picin for SOC as a Service", production 2026-09-10) lets a pricing
question reach the model, which then quotes figures from the knowledge base.
This guard watches the ANSWER as it streams. It holds back any tail of a chunk
that could still become a figure once the next chunk arrives, so no part of a
figure it trips on reaches the visitor.

Not every amount is the company's price. A security bot quotes GDPR fines, a
legal bot quotes court fees and a jobs bot quotes salaries; replacing those
answers with the pricing escalation hands a helped visitor to the team and
records the turn as unanswered. So a figure trips only on a price signal:

* the turn carries one (``signal=True``): the question reads like a pricing
  question, typos and plan words included
  (``pricing_gate.question_has_fuzzy_price_word``), or the session was already
  escalated on pricing;
* or the figure's own sentence names the company's price;
* or the figure is inside a price context.

Own-price words. Plan words count on their own: plan, package, subscription,
tier, edition, a product licence ("annual licence"), retainer, quote, quotation,
pricing, "starts at", "starting at" or "starting from", and a rate per user,
seat, licence, device or endpoint. Fee, price and billing words (price, fee,
charge, tariff, rate, cost, invoice, billed, billing) count only in a sentence
that also says the price is the company's: "our", "we" or "us" (not "US"). "The
court fee is ₹12,000" is the court's; "our onboarding fee is ₹25,000" is the
company's. The company's name is not read: a name with full stops in it ("S.K.
Traders", "Dr. Lal PathLabs") split the sentence differently in a whole answer
and in a stream, so a company that speaks of itself in the third person streams.
A cadence ("per month", "a year") never counts: fines, breaches and salaries come
in it too.

Not the company's. A first-person word that says whose the price is not does not
count and opens no context: "not" or "never" with "us", "our" or "we" at most two
words on ("set by the court, not by us", "not our firm"), and "rather than",
"instead of", "other than", "separately from", "independent of" or "outside"
before "us" or "our". Nor does a plan or a package in another sense: a salary,
relief or benefits package, or an insurance, treatment or payment plan. The
question signal skips a wider set of plans, because a word that is a safe
question-side exclusion can still be a plan TIER a company sells: "the Business
plan", "our Care plan" and "the Recovery plan" all name a tier here, so "business",
"care" and "recovery" no longer exclude a plan from being the company's own in an
ANSWER, even though "what's your business plan?" still carries no pricing signal
as a QUESTION.

Price context. An own-price word, or a markdown table header row naming a price,
cost, fee, rate, charge, amount or plan, opens a context that covers the figures
after it until its paragraph, list or table ends: at a blank line, a line after a
list that is not a list item or indented, or a line after a table that is not a
table row. A lead ending in a colon, a heading, or a line naming plans or packages
carries the context across one blank line. A context ends ``_CONTEXT_CAP_CHARS``
characters after its last own-price word. A markdown heading naming pricing,
prices, plans, packages or rates opens a context for its whole section: until a
heading of the same or a higher level, or ``_SECTION_CAP_CHARS`` characters after
the heading.

Without a turn signal or a context, a figure is held until its sentence ends,
and released intact, or until its sentence names the company's price, and
tripped on. Only words within ``_HOLD_CAP_CHARS`` characters of the figure
count. ``answer_trips_price_guard`` feeds a whole answer through the same
guard, so the cache read decides exactly as the stream does.

Pure module: no DB, no I/O, and no import from ``rag_service``.
"""

from __future__ import annotations

import re
from collections.abc import Iterable

from app.services.pricing_gate import (
    _CURRENCY_AMOUNT_RE,
    _NOT_OWN_PACKAGE_WORDS,
    _NOT_OWN_PLAN_WORDS_ANSWER,
    normalize_url,
)

#: The gate's own "currency symbol carrying a digit" pattern is reused as is, and
#: its symbol class is lifted out of it so the hold below can never know fewer
#: symbols than the figure test does.
_SYMBOL_CLASS_MATCH = re.fullmatch(r"(\[[^\]]+\])\\s\*\\d", _CURRENCY_AMOUNT_RE.pattern)
if _SYMBOL_CLASS_MATCH is None:
    raise RuntimeError(
        "pricing_gate._CURRENCY_AMOUNT_RE is no longer '[symbols]\\s*\\d'; update price_guard to match its new shape"
    )
_SYMBOL_CLASS = _SYMBOL_CLASS_MATCH.group(1)

#: Codes written before an amount in any case ("Rs. 5,000", "usd 499").
_CURRENCY_CODES = ("rs", "inr", "usd", "eur", "gbp")
#: Codes read before an amount only in capitals, and only before an amount that
#: looks like money (two digits, a thousands group or cents): "AED 4,500", "SGD
#: 49.99". Lower case "try 3" and a version such as "PHP 8.2" are not figures.
_CAPITAL_CURRENCY_CODES = (
    "AED", "SGD", "AUD", "CAD", "JPY", "CNY", "CHF", "NZD", "ZAR", "SAR", "QAR", "KWD", "MYR", "IDR", "PHP", "BDT",
    "LKR", "NPR", "PKR", "HKD", "SEK", "NOK", "DKK", "THB", "VND", "KRW", "BRL", "MXN", "TRY", "EGP", "NGN", "KES",
)  # fmt: skip
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
#: What a grouped or decimal amount with no symbol is billed by ("1,20,000/year",
#: "45,000 per user", "49.99 per month").
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
#: An amount with cents ("49.99"): at most 9 characters.
_DECIMAL_AMOUNT = r"\d{1,6}\.\d{2}"
#: A prefix of any amount, for the hold. It must reach the longest grouped amount
#: (32 characters), or the head of one would be emitted before its unit.
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
    # A capitals-only code before an amount that looks like money: "AED 4,500".
    rf"|\b(?-i:{_alternation(_CAPITAL_CURRENCY_CODES)})\s*\d(?:\d|,\d|\.\d\d)"
    # An amount followed by a currency or Indian unit word: "1,200 dollars", "50 lakh".
    rf"|\b{_AMOUNT}\s*(?:{_alternation(_AMOUNT_UNITS)})\b"
    # A grouped or decimal amount with no symbol, billed by a period or unit. The
    # separator is what tells "45,000 per user" and "49.99 per month" from "5 per user".
    rf"|\b(?:{_GROUPED_AMOUNT}|{_DECIMAL_AMOUNT})\s*(?:/|per\s+)\s*(?:{_alternation(_BILLING_UNITS)})\b",
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
    rf"|\b(?-i:{_alternation(_prefixes(_CAPITAL_CURRENCY_CODES))})\Z"
    rf"|\b(?-i:{_alternation(_CAPITAL_CURRENCY_CODES)})\s*(?:\d[.,]?\d?)?\Z"
    rf"|\b{_AMOUNT_PREFIX}\s*(?:{_UNIT_PREFIXES}|per\s+(?:{_BILLING_PREFIXES})?|/\s*(?:{_BILLING_PREFIXES})?)?\Z",
    re.IGNORECASE,
)

#: Up to three spaces between the words of a phrase, and never a line break, so a
#: phrase never spans two sentences and never outgrows ``_TAIL_CHARS``.
_SEP_MAX = 3
_SEP = rf"[^\S\n]{{1,{_SEP_MAX}}}"
#: The longest word a disclaimer, or a plan in another sense, may carry in between.
_MIDDLE_WORD_MAX = 20

#: Words that make a figure the company's price on their own.
_OWN_PRICE_WORDS = (
    r"plans?|packages?|subscriptions?|tiers?|editions?|retainers?|quote|quoted|quotations?|pricing"
    rf"|starts{_SEP}at|starting{_SEP}(?:at|from)"
    rf"|per{_SEP}(?:user|seat|licen[cs]e|device|endpoint)s?"
    rf"|(?:annual|perpetual|software|enterprise|site|volume|subscription){_SEP}licen[cs]es?"
)
#: Words that name a price or a bill without saying whose: a court's fee, a home's
#: price and a hospital's invoice read the same. They count only beside a first-person word.
_QUALIFIED_PRICE_WORDS = r"pric(?:e|es|ed)|fees?|charge[sd]?|tariffs?|rates?|costs?|invoices?|invoiced|billed|billing"
#: "us" only in lower or title case: "US" is the country. "we're" and "we've" read as "we".
_FIRST_PERSON_WORDS = r"our|we|(?-i:us|Us)"
#: A word that names a price column in a table header and nothing else: "| Item | Amount |".
_HEADER_ONLY_WORDS = r"amounts?"
#: Every word ``_PRICE_WORDS_RE`` reads on its own. A disclaimer or a plan in another
#: sense never takes one as its middle word: the stream settles such a word as soon as
#: the character after it arrives, before the phrase around it is complete, so the
#: whole answer must read it on its own too.
_READ_ON_ITS_OWN = rf"(?:{_OWN_PRICE_WORDS}|{_QUALIFIED_PRICE_WORDS}|{_FIRST_PERSON_WORDS}|{_HEADER_ONLY_WORDS})\b"
_MIDDLE_WORD = rf"(?:(?!{_READ_ON_ITS_OWN})[a-z]{{1,{_MIDDLE_WORD_MAX}}}{_SEP})?"
#: A first-person word that says whose the price is not ("set by the court, not by
#: us", "billed separately from our clinic"), and a plan or a package in another sense
#: ("salary package", "health insurance plans"). Neither counts. Each ends on the word
#: it neutralises, so the stream never settles that word before the phrase is known.
_NOT_OURS = (
    rf"(?:not|never){_SEP}{_MIDDLE_WORD}(?:{_FIRST_PERSON_WORDS})"
    rf"|(?:(?:rather|other){_SEP}than|instead{_SEP}of|separately{_SEP}from|independent(?:ly)?{_SEP}of|outside)"
    rf"{_SEP}(?:our|(?-i:us|Us))"
    rf"|(?:{_alternation(_NOT_OWN_PLAN_WORDS_ANSWER)}){_SEP}{_MIDDLE_WORD}plans?"
    rf"|(?:{_alternation(_NOT_OWN_PACKAGE_WORDS)}){_SEP}{_MIDDLE_WORD}packages?"
)
#: The longest phrase ``_PRICE_WORDS_RE`` reads: a package in another sense with a middle word.
_LONGEST_PHRASE_CHARS = (
    max(len(word) for word in (*_NOT_OWN_PLAN_WORDS_ANSWER, *_NOT_OWN_PACKAGE_WORDS))
    + 2 * _SEP_MAX
    + _MIDDLE_WORD_MAX
    + len("packages")
)

#: Every word the guard reads in an answer. Leftmost first, so a disclaimer or a plan
#: in another sense is found before the word it ends on. Every alternative starts a
#: word or a slash, and checking that first keeps a long run of digits cheap.
_PRICE_WORDS_RE = re.compile(
    r"(?=\b[a-z]|/)"
    rf"(?:(?P<not_ours>\b(?:{_NOT_OURS})\b)"
    rf"|(?P<own>\b(?:{_OWN_PRICE_WORDS})\b|/[^\S\n]{{0,{_SEP_MAX}}}(?:user|seat)s?\b)"
    rf"|(?P<qualified>\b(?:{_QUALIFIED_PRICE_WORDS})\b)"
    rf"|(?P<first_person>\b(?:{_FIRST_PERSON_WORDS})\b)"
    rf"|(?P<header>\b(?:{_HEADER_ONLY_WORDS})\b))",
    re.IGNORECASE,
)
#: Own-price words that name plans or packages, for a lead line (see the module note).
_PLAN_WORDS = frozenset(
    {"plan", "plans", "package", "packages", "tier", "tiers", "edition", "editions", "subscription", "subscriptions"}
)
#: A table header row naming one of these opens a price context.
_TABLE_HEADER_WORDS = frozenset(
    {
        "price", "prices", "pricing", "cost", "costs", "fee", "fees", "plan", "plans", "rate", "rates", "charge",
        "charges", "amount", "amounts",
    }
)  # fmt: skip
#: A markdown heading naming one of these opens a price context for its section.
_SECTION_WORDS = frozenset({"pricing", "price", "prices", "plans", "packages", "rates"})


#: Abbreviations whose full stop does not end a sentence: units, titles and company
#: suffixes ("Dr. Rao", "Acme Pvt. Ltd.").
_ABBREVIATIONS = (
    "rs", "p.m", "p.a", "a.m", "approx", "incl", "excl", "e.g", "i.e", "vs", "no", "nos", "avg", "min", "max", "est",
    "dr", "mr", "mrs", "ms", "st", "jr", "sr", "inc", "ltd", "pvt", "co", "corp", "bros",
)  # fmt: skip
#: Where a sentence ends: a full stop, "!" or "?" followed by whitespace, or a
#: line break. The whitespace keeps a decimal point ("4.45") and anything else
#: inside a number out; the look-behinds keep "Rs. 5,000", "approx. 20" and an
#: initial ("S.K. Traders", "J. Smith") out. The full stop is matched before the
#: look-behinds, so they run only at a full stop. The end of the stream ends a
#: sentence too, which ``flush`` handles.
_SENTENCE_END_RE = re.compile(
    r"(?:\."
    + "".join(rf"(?<!\b{re.escape(abbreviation)}\.)" for abbreviation in _ABBREVIATIONS)
    + r"(?<!\b(?-i:[A-Z])\.)|[!?])(?=\s)|\n",
    re.IGNORECASE,
)

_PLAIN = "plain"
_LIST = "list"
_TABLE = "table"
_INDENTED = "indented"
_TABLE_ROW_RE = re.compile(r"[^\S\n]*\|")
_LIST_ITEM_RE = re.compile(r"[^\S\n]*(?:[-*+•]|\d{1,3}[.)])[^\S\n]")
_HEADING_RE = re.compile(r"[^\S\n]{0,3}#{1,6}[^\S\n]")
_BOLD_LINE_RE = re.compile(r"(?:\*\*|__)[^*_\n]+(?:\*\*|__)[^\S\n]*:?")
_TABLE_SEPARATOR_RE = re.compile(r"\|?(?:[^\S\n]*:?-+:?[^\S\n]*\|)+(?:[^\S\n]*:?-+:?[^\S\n]*)?")

#: Characters of already-emitted text kept so ``\b`` reads correctly at the start
#: of the next chunk ("hou" + "rs 5" is "hours 5", not "Rs 5").
_CONTEXT_CHARS = 1
#: How far after an unpriced figure a word may still make it the company's price.
#: The figure is released once its sentence ends or this much has arrived.
_HOLD_CAP_CHARS = 300
#: How far after its last own-price word a price context reaches.
_CONTEXT_CAP_CHARS = 600
#: How far after its heading a price section reaches.
_SECTION_CAP_CHARS = 1_200
#: The end of the emitted answer kept so a word or phrase split across chunks is
#: still read whole. Longer than any phrase in ``_PRICE_WORDS_RE`` and than the
#: look-behinds in ``_SENTENCE_END_RE``.
_TAIL_CHARS = _LONGEST_PHRASE_CHARS + 8
#: The start of a line kept to tell a list item, a table row, a heading or a
#: table separator; and the end kept to tell a lead ending in a colon.
_LINE_HEAD_CHARS = 200
_LINE_END_CHARS = 16

_END = 0
_WORD = 1


def _heading_level(head: str) -> int | None:
    heading = _HEADING_RE.match(head)
    return heading.group().count("#") if heading else None


def _line_kind(head: str) -> str:
    if _TABLE_ROW_RE.match(head):
        return _TABLE
    if _LIST_ITEM_RE.match(head):
        return _LIST
    if head[:1].isspace():
        return _INDENTED
    return _PLAIN


class _AnswerReader:
    """Reads the emitted answer once, in order: whose price the current sentence names, and the price context.

    ``read`` is handed each piece of emitted text with the character that follows
    it, if that has arrived. A word or full stop at the very end is settled only
    once its next character is known, so the tail of the emitted text is kept and
    read again with the next piece; everything already settled is skipped.
    """

    def __init__(self, words: re.Pattern[str]) -> None:
        self._words = words
        #: The end of the emitted text, and where it starts in the whole answer.
        self._tail = ""
        self._tail_start = 0
        #: Where the last settled word and sentence end finish in the whole answer.
        self._words_done = 0
        self._ends_done = 0
        #: The current sentence: a word that counts on its own, a fee or price
        #: word, and a first-person word.
        self._own = False
        self._qualified = False
        self._first_person = False
        #: The current line.
        self._line = 0
        self._head = ""
        self._head_overflowed = False
        self._line_end = ""
        self._line_has_text = False
        self._line_names_plans = False
        self._line_has_header_word = False
        self._line_names_price_section = False
        #: The last line with text, and the blank lines since it.
        self._previous_kind = _PLAIN
        self._previous_lead = False
        self._previous_header_word = False
        self._blank_run = 0
        #: The price context: open, the line it was last opened on, and its cap.
        self._context_open = False
        self._context_line = -1
        self._context_until = -1
        #: The section a heading naming prices opened: open, the heading's level, and its cap.
        self._section_open = False
        self._section_level = 0
        self._section_until = -1

    @property
    def position(self) -> int:
        """How many characters have been emitted."""
        return self._tail_start + len(self._tail)

    def sentence_flags(self) -> tuple[bool, bool, bool]:
        return self._own, self._qualified, self._first_person

    def sentence_names_own_price(self) -> bool:
        return self._own or (self._qualified and self._first_person)

    def in_price_context(self, position: int) -> bool:
        """Whether a figure starting at ``position``, the end of the emitted text, is in a price context."""
        return self._in_paragraph_context(position) or self._in_price_section(position)

    def _in_paragraph_context(self, position: int) -> bool:
        if not self._context_open or position > self._context_until:
            return False
        return self._context_line == self._line or self._continues(_line_kind(self._head))

    def _in_price_section(self, position: int) -> bool:
        """A heading of the section's level or a higher one ends the section, on its own line too."""
        if not self._section_open or position > self._section_until:
            return False
        level = _heading_level(self._head)
        return level is None or level > self._section_level

    def read(self, text: str, lookahead: str) -> None:
        scan = self._tail + text
        probe = scan + lookahead
        base = self._tail_start
        events: list[tuple[int, int, re.Match[str]]] = []
        for end in _SENTENCE_END_RE.finditer(probe):
            if end.start() >= len(scan):
                break
            if base + end.start() >= self._ends_done:
                events.append((end.start(), _END, end))
        for word in self._words.finditer(probe):
            # Settled only when the character after it has arrived ("plan" + "et").
            if word.end() > len(scan) or word.end() == len(probe):
                break
            # A word cut by the start of the tail was read whole before.
            if (word.start() > 0 or base == 0) and base + word.end() > self._words_done:
                events.append((word.start(), _WORD, word))
        events.sort(key=lambda event: event[0])
        line_from = len(self._tail)
        for index, kind, match in events:
            if kind == _WORD:
                self._words_done = base + match.end()
                self._read_word(match, base + match.end())
                continue
            self._ends_done = base + match.end()
            self._own = self._qualified = self._first_person = False
            if match.group() == "\n":
                self._extend_line(scan[line_from:index])
                self._end_line(base + index)
                line_from = index + 1
        self._extend_line(scan[line_from:])
        keep = scan[-_TAIL_CHARS:]
        self._tail_start = base + len(scan) - len(keep)
        self._tail = keep

    def _read_word(self, match: re.Match[str], end: int) -> None:
        group = match.lastgroup
        if group == "not_ours":
            return
        word = match.group().lower()
        was_own_price = self.sentence_names_own_price()
        if group == "own":
            self._own = True
            self._line_names_plans = self._line_names_plans or word in _PLAN_WORDS
        elif group == "qualified":
            self._qualified = True
        elif group == "first_person":
            self._first_person = True
        self._line_has_header_word = self._line_has_header_word or word in _TABLE_HEADER_WORDS
        self._line_names_price_section = self._line_names_price_section or word in _SECTION_WORDS
        if (
            group == "own"
            or (group == "qualified" and self._first_person)
            or (not was_own_price and self.sentence_names_own_price())
        ):
            self._open_context(end)

    def _open_context(self, end: int) -> None:
        self._context_open = True
        self._context_line = self._line
        self._context_until = end + _CONTEXT_CAP_CHARS

    def _extend_line(self, segment: str) -> None:
        if not segment:
            return
        if not self._head_overflowed:
            room = _LINE_HEAD_CHARS - len(self._head)
            self._head += segment[:room]
            self._head_overflowed = len(segment) > room
        self._line_end = (self._line_end + segment)[-_LINE_END_CHARS:]
        self._line_has_text = self._line_has_text or not segment.isspace()

    def _end_line(self, newline: int) -> None:
        if not self._line_has_text:
            self._blank_run += 1
            if self._context_open and not self._continues(_PLAIN):
                self._context_open = False
        else:
            kind = _line_kind(self._head)
            if self._context_open and self._context_line < self._line and not self._continues(kind):
                self._context_open = False
            if (
                kind == _TABLE
                and self._blank_run == 0
                and self._previous_kind == _TABLE
                and self._previous_header_word
                and not self._head_overflowed
                and _TABLE_SEPARATOR_RE.fullmatch(self._head.strip())
            ):
                self._open_context(newline)
            self._read_heading(newline)
            self._previous_kind = kind
            self._previous_lead = self._is_lead()
            self._previous_header_word = self._line_has_header_word
            self._blank_run = 0
        self._line += 1
        self._head = ""
        self._head_overflowed = False
        self._line_end = ""
        self._line_has_text = False
        self._line_names_plans = False
        self._line_has_header_word = False
        self._line_names_price_section = False

    def _read_heading(self, newline: int) -> None:
        """A heading ends a price section of its level or a deeper one; a heading naming prices opens one."""
        level = _heading_level(self._head)
        if level is None:
            return
        if self._section_open and level <= self._section_level:
            self._section_open = False
        if not self._line_names_price_section:
            return
        if self._section_open:
            # A deeper price heading inside a price section extends that section.
            self._section_until = max(self._section_until, newline + _SECTION_CAP_CHARS)
            return
        self._section_open = True
        self._section_level = level
        self._section_until = newline + _SECTION_CAP_CHARS

    def _continues(self, kind: str) -> bool:
        """Whether a line of ``kind``, after the lines already read, stays in the context's block."""
        if self._blank_run:
            return self._blank_run == 1 and self._previous_lead
        if self._previous_kind == _LIST:
            return kind in (_LIST, _INDENTED)
        if self._previous_kind == _TABLE:
            return kind == _TABLE
        return True

    def _is_lead(self) -> bool:
        """A line that introduces what follows it: ends in a colon, is a heading, or names plans."""
        return (
            self._line_end.rstrip().rstrip("*_").rstrip().endswith(":")
            or bool(_HEADING_RE.match(self._head))
            or (not self._head_overflowed and bool(_BOLD_LINE_RE.fullmatch(self._head.strip())))
            or self._line_names_plans
        )


class PriceStreamGuard:
    """Feed streamed chunks in; get back only text that cannot be part of a figure the guard trips on.

    ``signal`` is the turn's own price signal (see the module note). With it every
    figure trips. Without it a figure trips when its sentence names the company's
    price or it is inside a price context; otherwise the figure and the rest of its
    sentence are held until that is known.

    Each ``feed`` scans the text still held plus the new chunk, and a short tail of
    the emitted answer, never the whole answer. What is held is bounded (a figure
    prefix of at most a few dozen characters, or ``_HOLD_CAP_CHARS`` of a held
    sentence) and so are the amount patterns, so the work per streamed character is
    bounded. The one exception is an unbroken run of whitespace after a currency
    symbol, code or amount, which is held in full until something else arrives.
    """

    def __init__(self, *, signal: bool = False) -> None:
        self._signal = signal
        self._words = _PRICE_WORDS_RE
        self._reader = _AnswerReader(self._words)
        #: Emitted text just before ``_pending``, so ``\b`` reads the real neighbour.
        self._context = ""
        #: Text fed in and not emitted yet.
        self._pending = ""
        #: Above zero while ``_pending`` starts with an unpriced figure of this length.
        self._held_figure_len = 0
        #: While a figure is held, measured from the start of ``_pending``: how far
        #: its sentence was read for words, where the last word read ends, where the
        #: search for the sentence end resumes, and what the sentence named so far.
        self._held_read = 0
        self._held_word_end = 0
        self._held_end_from = 0
        self._held_own = False
        self._held_qualified = False
        self._held_first_person = False
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
                progressed = self._settle_held_figure(emitted, final=final)
            else:
                progressed = self._scan(emitted, final=final)
            if self._tripped:
                return ""
            if not progressed:
                break
        return "".join(emitted)

    def _scan(self, emitted: list[str], *, final: bool) -> bool:
        """Outside a held figure: trip on a figure, start holding one, or emit up to a possible figure.

        Returns True when a hold started and the held figure must be settled next.
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
            # The text before the figure is emitted first, so the answer is read
            # up to the figure itself.
            self._emit(emitted, window, start, match.start())
            if self._reader.sentence_names_own_price() or self._reader.in_price_context(self._reader.position):
                self._trip()
                return False
            self._held_figure_len = match.end() - match.start()
            self._held_own, self._held_qualified, self._held_first_person = self._reader.sentence_flags()
            self._held_read = 0
            self._held_word_end = 0
            self._held_end_from = self._held_figure_len
            return True
        cut = len(window)
        if not final:
            hold = _HOLD_RE.search(window, start)
            if hold:
                cut = hold.start()
        self._emit(emitted, window, start, cut)
        return False

    def _settle_held_figure(self, emitted: list[str], *, final: bool) -> bool:
        """Trip if the held figure's sentence names the company's price; release the figure once it cannot.

        Only the first ``_HOLD_CAP_CHARS`` characters from the figure are read, so
        the decision does not depend on how the answer was chunked. Each call reads
        only what arrived since the last one, plus enough overlap for a word split
        across chunks. Returns True when the figure was released and scanning
        continues after it.
        """
        window = self._context + self._pending
        start = len(self._context)
        limit = start + _HOLD_CAP_CHARS
        # One character past the cap, so a word or full stop ending at it is settled.
        bound = min(len(window), limit + 1)
        end = _SENTENCE_END_RE.search(window, start + self._held_end_from, bound)
        sentence_ended = end is not None and end.start() < limit
        if end is None:
            # A full stop that has arrived last may still be followed by whitespace.
            self._held_end_from = max(self._held_figure_len, bound - start - 1)
        stop = end.start() if end is not None and sentence_ended else limit
        for word in self._words.finditer(window, start + max(0, self._held_read - _TAIL_CHARS), bound):
            if word.start() >= stop or word.end() > limit:
                break
            # A word at the very end of what has arrived may still grow into
            # another one ("plan" + "et"): only a later chunk or ``flush`` decides.
            if word.end() == len(window) and not final:
                break
            if word.end() - start <= self._held_word_end:
                continue
            self._held_word_end = word.end() - start
            self._held_own = self._held_own or word.lastgroup == "own"
            self._held_qualified = self._held_qualified or word.lastgroup == "qualified"
            self._held_first_person = self._held_first_person or word.lastgroup == "first_person"
            if self._held_own or (self._held_qualified and self._held_first_person):
                self._trip()
                return False
        self._held_read = bound - start
        if not (sentence_ended or final or len(window) > limit):
            return False
        figure_end = start + self._held_figure_len
        self._held_figure_len = 0
        self._emit(emitted, window, start, figure_end)
        return True

    def _emit(self, emitted: list[str], window: str, start: int, cut: int) -> None:
        """Emit ``window[start:cut]`` and keep the rest pending."""
        text = window[start:cut]
        if text:
            emitted.append(text)
        lookahead = window[cut : cut + 1]
        if not self._signal and (text or lookahead):
            self._reader.read(text, lookahead)
        self._pending = window[cut:]
        self._context = window[max(0, cut - _CONTEXT_CHARS) : cut]

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
