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
  phone number, and an IP address or a date is never one.

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
_DATE_RE = re.compile(r"\d{1,4}[./-]\d{1,2}[./-]\d{1,4}")
#: Words that say a shorter number is a phone number ("my phone is 9123 4567").
_PHONE_CUE_RE = re.compile(r"(?i)\b(?:phone|call|mobile|cell|number|whatsapp|tel|telephone|landline|ring|text|sms)\b")


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


def _is_phone_number(candidate: str, *, followed_by: str, cued: bool) -> bool:
    if followed_by == "@":
        # The digits are an email address's local part.
        return False
    if _IPV4_RE.fullmatch(candidate) or _DATE_RE.fullmatch(candidate):
        return False
    digits = _digit_count(candidate)
    if digits > _PHONE_MAX_DIGITS:
        return False
    if digits >= _PHONE_SELF_EVIDENT_DIGITS:
        return True
    return digits >= PHONE_MIN_DIGITS and (candidate.startswith("+") or cued)


def find_contact(text: object) -> FoundContact:
    """The visitor's email address and phone number in ``text``, if it gives them."""
    if not isinstance(text, str) or not text:
        return FoundContact()
    email_match = EMAIL_IN_TEXT_RE.search(text) if "@" in text else None
    cued = _PHONE_CUE_RE.search(text) is not None
    phone = None
    for match in PHONE_IN_TEXT_RE.finditer(text):
        followed_by = text[match.end() : match.end() + 1]
        if _is_phone_number(match.group(0), followed_by=followed_by, cued=cued):
            phone = match.group(0)
            break
    return FoundContact(email=email_match.group(0) if email_match else None, phone=phone)
