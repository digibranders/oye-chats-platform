"""Finding an email address or a phone number in a visitor's chat message.

On 2026-09-28 an urgent alert reached the team with a name and no way to reach the
visitor. The urgent reply now asks for a phone number or email in the chat, so the
next message is read for one. A wrong match emails the team a number that is not
the visitor's, so the phone rule is stricter than "seven digits somewhere".
"""

import pytest

from app.services.contact_details import FoundContact, find_contact, mentions_contact


@pytest.mark.parametrize(
    ("message", "email"),
    [
        ("eva@acme.test", "eva@acme.test"),
        ("you can reach me at Eva.Rao+soc@acme.co.in.", "Eva.Rao+soc@acme.co.in"),
        ("email: ops-team@sub.acme.io please hurry", "ops-team@sub.acme.io"),
    ],
)
def test_an_email_address_is_found(message, email):
    assert find_contact(message) == FoundContact(email=email, phone=None)


@pytest.mark.parametrize(
    ("message", "phone"),
    [
        # Indian mobile numbers, as visitors type them.
        ("+91 98765 43210", "+91 98765 43210"),
        ("call me on 9876543210", "9876543210"),
        ("my number is +91-98765-43210 thanks", "+91-98765-43210"),
        ("098765 43210", "098765 43210"),
        # International formats.
        ("+1 (415) 555-0100", "+1 (415) 555-0100"),
        ("reach me on +44 20 7946 0958.", "+44 20 7946 0958"),
        ("(415) 555-0100 is my cell", "(415) 555-0100"),
        # A short local number counts when the message says it is a phone number.
        ("my phone is 9123 4567", "9123 4567"),
        ("+65 9123 4567", "+65 9123 4567"),
    ],
)
def test_a_phone_number_is_found(message, phone):
    assert find_contact(message) == FoundContact(email=None, phone=phone)


def test_an_email_and_a_phone_number_are_both_found():
    found = find_contact("eva@acme.test or +91 98765 43210, whichever is faster")
    assert found == FoundContact(email="eva@acme.test", phone="+91 98765 43210")
    assert found


@pytest.mark.parametrize(
    "message",
    [
        "they are still encrypting our servers",
        "the attacker IP is 192.168.10.254",
        "it started on 2026-09-28 at 10:30",
        "it started on 28.09.2026",
        "it started on 28/09/2026",
        "we have 1200000 records exposed",
        "ticket 4471234",
        "please hurry",
        "",
    ],
)
def test_a_message_without_contact_details_finds_nothing(message):
    found = find_contact(message)
    assert found == FoundContact(email=None, phone=None)
    assert not found


@pytest.mark.parametrize("message", [None, 42, ["eva@acme.test"]])
def test_a_non_string_finds_nothing(message):
    assert not find_contact(message)


def test_the_scan_is_linear_on_long_input():
    import timeit

    message = "1 2 3 4 5 6 7 8 9 0 " * 2000 + "a@" * 2000
    assert timeit.timeit(lambda: find_contact(message), number=1) < 2.0


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("Write to us at hello@eventussecurity.com.", True),
        ("Call +91 22 4000 1234 any time.", True),
        ("Our office opened on 2019-04-01.", False),
        ("We answer within one business day.", False),
    ],
)
def test_mentions_contact_keeps_the_lenient_reply_check(text, expected):
    """The reply-side check the leave-message safety net used before this module existed."""
    assert mentions_contact(text) is expected
