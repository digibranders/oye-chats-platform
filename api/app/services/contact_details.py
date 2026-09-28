"""Email addresses and phone numbers written in chat text.

Two readers with different costs of a mistake:

- ``mentions_contact`` asks whether a bot reply gives the visitor a way to reach
  the business ("Write to us at hello@acme.com."). A false positive only keeps a
  message form closed, so it counts any seven digits.
- ``find_contact`` reads a visitor's message for their own contact details. On
  2026-09-28 an urgent alert reached the team with a name and no email or phone,
  so the urgent reply now asks for one in the chat and the next message is read
  here. A false positive emails the team a number that is not the visitor's, so a
  phone number needs ten digits, a leading "+", or a message that calls it a
  phone number. A date, a clock time, an IP address, a version, a timestamp, a
  12-digit ID and a number labelled as something else ("invoice 2024001234",
  "ticket #9876543210") are never one, and neither is a value the message gives
  as someone else's ("the attacker called us from +44 7700 900123").
- ``is_only_contact`` says whether a message holds nothing but the contact
  details, so the caller knows whether there is also a question to answer.

Every repeat is bounded, so each scan is linear on any input. Rules only: no
model call.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

#: An email address inside running text.
EMAIL_IN_TEXT_RE = re.compile(r"[\w.+'-]{1,64}@[\w-]{1,63}(?:\.[\w-]{1,63}){1,4}")
#: A run that may be a phone number: digits with spaces, brackets, dots or hyphens.
PHONE_IN_TEXT_RE = re.compile(r"(?<![\w.])\+?\(?\d[\d ().-]{5,18}\d(?!\w|\.\d)")
_ISO_DATE_RE = re.compile(r"\d{4}-\d{2}-\d{2}")
#: The fewest digits a reply's phone number has.
PHONE_MIN_DIGITS = 7

#: E.164 caps a full international number at 15 digits.
_PHONE_MAX_DIGITS = 15
#: Enough digits to be a phone number on their own (an Indian or US mobile, a UK landline).
_PHONE_SELF_EVIDENT_DIGITS = 10
_IPV4_RE = re.compile(r"\d{1,3}(?:\.\d{1,3}){3}")
#: Words that say a shorter number is a phone number ("my phone is 9123 4567").
_PHONE_CUE_RE = re.compile(r"(?i)\b(?:phone|call|mobile|cell|number|whatsapp|tel|telephone|landline|ring|text|sms)\b")

#: A number run in a visitor's message. ``PHONE_IN_TEXT_RE`` with one more rule:
#: the run never starts after or ends before a colon and a digit, so the "10" of
#: "2026-09-28 10:15" is not glued to the date.
_VISITOR_PHONE_RE = re.compile(r"(?<![\w.:#])\+?\(?\d[\d ().-]{5,18}\d(?!\w|\.\d|:\d)")
#: A date anywhere in a run or beside it: 2026-09-28, 28.09.2026, 28/09/26.
_DATE_RE = re.compile(r"(?<!\d)(?:\d{4}[./-]\d{1,2}[./-]\d{1,2}|\d{1,2}[./-]\d{1,2}[./-](?:\d{4}|\d{2}))(?!\d)")
#: A clock time: 10:15, 9:05:30.
_CLOCK_RE = re.compile(r"\d{1,2}:\d{2}")
#: The token right before a run and right after it, when only spaces part them.
_TOKEN_BEFORE_RE = re.compile(r"(\S{1,24})[ \t]{1,4}$")
_TOKEN_AFTER_RE = re.compile(r"^[ \t]{1,4}(\S{1,24})")
#: How far either side of a value its clause is read, in characters.
_CLAUSE_REACH = 80
#: Where a clause ends: a comma, a semicolon, a line break, or a sentence stop.
_CLAUSE_BREAK_RE = re.compile(r"[,;!?\n]|\.(?:\s|$)")
#: Words just before a number that say what it is. The nearest of these or of
#: ``_OWN_NUMBER_WORDS`` decides: "my invoice number is 2024001234" is an
#: invoice, "call me on 022 2345 6789" a phone. "number" and "no" say neither.
_LABEL_WORDS = frozenset(
    [
        "invoice",
        "inv",
        "ticket",
        "tkt",
        "order",
        "account",
        "acct",
        "id",
        "ref",
        "reference",
        "case",
        "version",
        "ver",
        "build",
        "error",
        "err",
        "code",
        "transaction",
        "txn",
        "serial",
        "receipt",
        "policy",
        "aadhaar",
        "aadhar",
        "pan",
        "gst",
        "gstin",
        "pin",
        "otp",
        "uid",
        "utr",
        "awb",
        "tracking",
        "card",
        "ip",
        "port",
        "pid",
        "hash",
        "cve",
        "kb",
        "event",
        "record",
        "records",
        "iban",
        "ifsc",
        "routing",
        "amount",
        "rs",
        "inr",
        "usd",
        "timestamp",
        "epoch",
        "sku",
        "model",
        "license",
        "licence",
        "key",
        "token",
        "batch",
        "bill",
        "customer",
        "member",
        "employee",
        "emp",
        "roll",
        "registration",
        "reg",
        "hex",
    ]
)
_OWN_NUMBER_WORDS = frozenset(
    [
        "phone",
        "call",
        "mobile",
        "cell",
        "whatsapp",
        "tel",
        "telephone",
        "landline",
        "ring",
        "text",
        "sms",
        "contact",
        "reach",
        "me",
    ]
)
#: How many words before a number are read for a label.
_LABEL_REACH_WORDS = 4
_WORD_RE = re.compile(r"[a-z]+")
#: A value the message gives as someone else's: the attacker's, a scammer's,
#: the sender of a phishing email. Read in the value's own clause.
_THIRD_PARTY_RE = re.compile(
    r"\b(?:attackers?|hackers?|scam\w{0,10}|phish\w{0,10}|spoof\w{0,10}|fraud\w{0,10}|impersonat\w{0,10}"
    r"|pretend\w{0,10}|posing|posed\s+as|fake|suspicious|malicious|criminals?|senders?|callers?"
    r"|(?:they|someone|somebody|he|she|a\s+guy|a\s+man|a\s+woman)\s+(?:\w{1,20}\s+){0,2}?"
    r"(?:called|rang|phoned|emailed|mailed|texted|messaged|whatsapped|sent|wrote|contacted))\b"
)
#: "from" right before the value: "called us from +44 7700 900123".
_FROM_BEFORE_RE = re.compile(r"\bfrom\s+(?:(?:the|this|that|a|an|number|address|email|mail|id|phone)\s+){0,2}$")
#: The value as the subject of a call or an email: "+44 7700 900123 called us".
_ACTS_AFTER_RE = re.compile(r"^\s*(?:called|rang|phoned|emailed|mailed|texted|messaged|sent|keeps?)\b")
#: The words that may sit around contact details in a message that says
#: nothing else: "it's +91 98765 43210, please call asap".
_CONTACT_FILLER = frozenset(
    [
        "my",
        "our",
        "me",
        "us",
        "i",
        "im",
        "i'm",
        "am",
        "it",
        "it's",
        "its",
        "is",
        "this",
        "that's",
        "thats",
        "the",
        "a",
        "an",
        "number",
        "no",
        "num",
        "phone",
        "mobile",
        "mob",
        "cell",
        "email",
        "e-mail",
        "mail",
        "id",
        "whatsapp",
        "sms",
        "text",
        "call",
        "ring",
        "reach",
        "contact",
        "touch",
        "get",
        "hold",
        "of",
        "in",
        "with",
        "on",
        "at",
        "via",
        "by",
        "to",
        "or",
        "and",
        "please",
        "pls",
        "plz",
        "thanks",
        "thank",
        "you",
        "thx",
        "ty",
        "here",
        "best",
        "use",
        "can",
        "whichever",
        "faster",
        "quicker",
        "easier",
        "fine",
        "ok",
        "okay",
        "sure",
        "yes",
        "yeah",
        "yep",
        "asap",
        "urgently",
        "now",
        "right",
        "away",
        "immediately",
        "quickly",
        "soon",
        "anytime",
        "any",
        "time",
        "work",
        "personal",
        "office",
        "direct",
        "line",
        "landline",
        "tel",
        "telephone",
        "try",
        "reachable",
        "available",
        "hi",
        "hello",
        "hey",
        "sir",
        "maam",
        "just",
        "number's",
        "email's",
    ]
)
_FILLER_WORD_RE = re.compile(r"[a-z][a-z'-]{0,30}")


#: What the team is told when an urgent alert has no email or phone for the
#: visitor: the email's contact row and the inbox notification's body. The alert
#: goes out inside the visitor's chat turn, so they were on the page then. The
#: support-request email, also sent inside the turn, uses the same row.
URGENT_NO_CONTACT_LINE = (
    "No email or phone yet. Reply in the conversation now: they were on the page when this was sent."
)
#: The same, for a push notification body, which has no room for the second half.
URGENT_NO_CONTACT_SHORT = "No email or phone yet. Reply in the conversation now."


@dataclass(frozen=True)
class FoundContact:
    """The first email address and the first phone number in a message, as written."""

    email: str | None = None
    phone: str | None = None

    def __bool__(self) -> bool:
        return bool(self.email or self.phone)

    def values(self) -> list[str]:
        """The found values in reading order: email first, then phone."""
        return [value for value in (self.email, self.phone) if value]


def _digit_count(text: str) -> int:
    return sum(char.isdigit() for char in text)


def mentions_contact(text: str) -> bool:
    """Whether ``text`` names an email address or a phone number of seven or more digits."""
    if "@" in text and EMAIL_IN_TEXT_RE.search(text):
        return True
    return any(
        _digit_count(match.group(0)) >= PHONE_MIN_DIGITS and _ISO_DATE_RE.fullmatch(match.group(0)) is None
        for match in PHONE_IN_TEXT_RE.finditer(text)
    )


def _phone_shape_is_plausible(candidate: str, *, cued: bool) -> bool:
    """Whether the digits of a run can be a phone number, before any context is read."""
    if _IPV4_RE.fullmatch(candidate) or _DATE_RE.search(candidate) or candidate.count(".") >= 3:
        # An IP address, a date, or a version ("10.0.19045.3693").
        return False
    digits = "".join(char for char in candidate if char.isdigit())
    international = candidate.startswith("+") or digits.startswith("00")
    if international:
        count = len(digits) - (2 if digits.startswith("00") and not candidate.startswith("+") else 0)
        return PHONE_MIN_DIGITS <= count <= _PHONE_MAX_DIGITS
    groups = [len(group) for group in re.split(r"\D+", candidate) if group]
    if groups == [4, 4, 4]:
        # Aadhaar is written 1234 5678 9012.
        return False
    count = len(digits)
    if count == 12:
        # Only India's country code without the "+" before a mobile number.
        return digits.startswith("91") and digits[2] in "6789"
    if count > 11:
        return False
    if count == 10 and digits.startswith("1"):
        # A unix timestamp ("1727500000"). No Indian mobile or US area code starts with 1.
        return False
    if count >= _PHONE_SELF_EVIDENT_DIGITS:
        return True
    return count >= PHONE_MIN_DIGITS and cued


def _beside_a_date_or_time(text: str, start: int, end: int) -> bool:
    """Whether the token touching the run on either side is a date or a clock time."""
    before = _TOKEN_BEFORE_RE.search(text[max(0, start - 30) : start])
    after = _TOKEN_AFTER_RE.match(text[end : end + 30])
    return any(
        _DATE_RE.search(token.group(1)) or _CLOCK_RE.search(token.group(1))
        for token in (before, after)
        if token is not None
    )


def _labelled_as_something_else(text: str, start: int) -> bool:
    """Whether the words just before a number say it is not a phone number."""
    if text[max(0, start - 2) : start].strip() == "#":
        return True
    before = _clause_before(text, start).lower()
    for word in reversed(_WORD_RE.findall(before)[-_LABEL_REACH_WORDS:]):
        if word in _LABEL_WORDS:
            return True
        if word in _OWN_NUMBER_WORDS:
            return False
    return False


def _clause_before(text: str, start: int) -> str:
    before = text[max(0, start - _CLAUSE_REACH) : start]
    breaks = list(_CLAUSE_BREAK_RE.finditer(before))
    return before[breaks[-1].end() :] if breaks else before


def _clause_after(text: str, end: int) -> str:
    after = text[end : end + _CLAUSE_REACH]
    brk = _CLAUSE_BREAK_RE.search(after)
    return after[: brk.start()] if brk else after


def _someone_elses(text: str, start: int, end: int) -> bool:
    """Whether the value's clause gives it as an attacker's, a scammer's or a sender's."""
    before = _clause_before(text, start).lower()
    after = _clause_after(text, end).lower()
    return bool(
        _THIRD_PARTY_RE.search(before)
        or _THIRD_PARTY_RE.search(after)
        or _FROM_BEFORE_RE.search(before)
        or _ACTS_AFTER_RE.match(after)
    )


def _find_phone(text: str, *, cued: bool) -> str | None:
    for match in _VISITOR_PHONE_RE.finditer(text):
        candidate, start, end = match.group(0), match.start(), match.end()
        if text[end : end + 1] == "@":
            # The digits are an email address's local part.
            continue
        if (
            _phone_shape_is_plausible(candidate, cued=cued)
            and not _beside_a_date_or_time(text, start, end)
            and not _labelled_as_something_else(text, start)
            and not _someone_elses(text, start, end)
        ):
            return candidate
    return None


def _find_email(text: str) -> str | None:
    if "@" not in text:
        return None
    for match in EMAIL_IN_TEXT_RE.finditer(text):
        if not _someone_elses(text, match.start(), match.end()):
            return match.group(0)
    return None


def find_contact(text: object) -> FoundContact:
    """The visitor's own email address and phone number in ``text``, if it gives them."""
    if not isinstance(text, str) or not text:
        return FoundContact()
    cued = _PHONE_CUE_RE.search(text) is not None
    return FoundContact(email=_find_email(text), phone=_find_phone(text, cued=cued))


def is_only_contact(text: object, found: FoundContact) -> bool:
    """Whether ``text`` says nothing but the contact details in ``found``.

    "it's +91 98765 43210, please call" is only contact; "+91 98765 43210. what
    should we do first?" also asks something, which the caller answers too.
    """
    if not isinstance(text, str) or not found:
        return False
    rest = text
    for value in found.values():
        rest = rest.replace(value, " ")
    rest = rest.replace("\u2019", "'").lower()
    if "?" in rest:
        return False
    return all(word in _CONTACT_FILLER for word in _FILLER_WORD_RE.findall(rest))
