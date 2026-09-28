"""Finding an email address or a phone number in a visitor's chat message.

On 2026-09-28 an urgent alert reached the team with a name and no way to reach the
visitor. The urgent reply now asks for a phone number or email in the chat, so the
next message is read for one. A wrong match emails the team a number that is not
the visitor's, so the phone rule is stricter than "seven digits somewhere".
"""

import pytest

from app.services.contact_details import FoundContact, find_contact, is_only_contact, mentions_contact


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


@pytest.mark.parametrize(
    "message",
    [
        # A date and a clock time: the number run stops at the colon.
        "logins at 2026-09-28 10:15 from 185.220.101.4",
        "date 28.09.2026 10",
        "it began 28/09/2026 10 and has not stopped",
        "at 10:15 9876543",
        # A unix timestamp.
        "1727500000",
        "first seen 1727500000",
        # Reference numbers the message labels as something else.
        "invoice 2024001234",
        "ticket #9876543210",
        "#9876543210",
        "account 123456789012",
        "account number 1234567",
        "order id: 9876543210",
        "my invoice number is 2024001234",
        # An Aadhaar-shaped number.
        "1234 5678 9012",
        # A version and an error code.
        "version 10.0.19045.3693",
        "error code 0x80070005 2147942405",
        "build 10.0.19045.3693 crashed",
    ],
)
def test_a_number_that_is_not_a_phone_number_is_not_one(message):
    assert find_contact(message).phone is None


@pytest.mark.parametrize(
    "message",
    [
        "the attacker called us from +44 7700 900123",
        "they called from +44 7700 900123",
        "we got a scam call from 9876543210",
        "the phishing email came from support@paypa1-secure.com",
        "they emailed us from support@paypa1-secure.com",
        "the sender was billing@paypa1-secure.com",
        "a spoofed number +44 7700 900123 keeps calling",
    ],
)
def test_someone_elses_contact_details_are_not_the_visitors(message):
    assert not find_contact(message)


@pytest.mark.parametrize(
    ("message", "expected"),
    [
        ("+91 98765 43210", FoundContact(phone="+91 98765 43210")),
        ("9876543210", FoundContact(phone="9876543210")),
        ("call me on 022 2345 6789", FoundContact(phone="022 2345 6789")),
        ("+44 7700 900123", FoundContact(phone="+44 7700 900123")),
        ("my number is +44 7700 900123", FoundContact(phone="+44 7700 900123")),
        ("eva@acme.com", FoundContact(email="eva@acme.com")),
        ("0044 7700 900123", FoundContact(phone="0044 7700 900123")),
        ("91 98765 43210", FoundContact(phone="91 98765 43210")),
        ("13812345678", FoundContact(phone="13812345678")),
        ("this is Eva from Acme, eva@acme.com", FoundContact(email="eva@acme.com")),
        ("we got phished last week. call me on 9876543210", FoundContact(phone="9876543210")),
        ("phone: 9876543210", FoundContact(phone="9876543210")),
        ("it started 28.09.2026, call me on 9876543210", FoundContact(phone="9876543210")),
    ],
)
def test_the_visitors_own_contact_details_are_still_found(message, expected):
    assert find_contact(message) == expected


@pytest.mark.parametrize(
    ("message", "only"),
    [
        ("+91 98765 43210", True),
        ("eva@acme.test", True),
        ("my number is +91 98765 43210", True),
        ("it's +91 98765 43210, please call", True),
        ("eva@acme.test or +91 98765 43210, whichever is faster", True),
        ("you can reach me at eva@acme.test. thanks!", True),
        ("call me on 9876543210 asap", True),
        ("+91 98765 43210. what should we do first?", False),
        ("eva@acme.test, also do you offer backups", False),
        ("9876543210 and please tell me how to reset every password in the domain", False),
    ],
)
def test_only_contact_tells_a_bare_answer_from_one_with_more_to_say(message, only):
    assert is_only_contact(message, find_contact(message)) is only


@pytest.mark.parametrize("message", [None, 42, ["eva@acme.test"]])
def test_a_non_string_finds_nothing(message):
    assert not find_contact(message)


def test_the_scan_is_linear_on_long_input():
    import timeit

    message = "1 2 3 4 5 6 7 8 9 0 " * 2000 + "a@" * 2000
    assert timeit.timeit(lambda: find_contact(message), number=1) < 2.0


@pytest.mark.parametrize(
    "seed",
    [
        "9876543210 ",
        "the attacker called from ",
        "invoice ",
        "#98765 ",
        "10:15 ",
        "28.09.2026 ",
        "a@b.co ",
        "1.2.3.4.5 ",
        "call me on +44 ",
    ],
)
def test_every_rule_is_linear_on_a_long_adversarial_message(seed):
    import timeit

    message = (seed * (20_000 // len(seed) + 1))[:20_000]
    found = find_contact(message)
    assert timeit.timeit(lambda: find_contact(message), number=1) < 2.0
    assert timeit.timeit(lambda: is_only_contact(message, found), number=1) < 2.0


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
