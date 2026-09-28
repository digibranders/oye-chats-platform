"""The team emails around an urgent incident, with and without a way to reach the visitor.

On 2026-09-28 an urgent alert showed Name "Eva" and an Email row with only a dash,
and the owner asked how the team could reach her. The alert now says plainly that
there is no email or phone yet and what to do instead, and two follow-ups exist:
the contact details once the visitor types them in the chat, and a reminder when
none arrive.
"""

from unittest.mock import patch

import pytest

from app.config import APP_URL
from app.services import email_service

NO_CONTACT_LINE = "No email or phone yet. Reply in the conversation now: they were on the page when this was sent."
MESSAGE = "we are under a ransomware attack right now"


def _capture(send, *args, **kwargs) -> tuple[str, str, dict]:
    with patch.object(email_service, "send_email_async") as outbox:
        send(*args, **kwargs)
    outbox.assert_called_once()
    (_to, subject, html_body), options = outbox.call_args
    return subject, html_body, options


def _alert(contact):
    return _capture(
        email_service.send_handoff_request_email,
        "soc@acme.test",
        "Acme Bot",
        MESSAGE,
        contact,
        reply_to="help@acme.test",
        urgent=True,
        session_id="urgent-1",
    )


def _no_dashes(html_body: str) -> None:
    for dash in (chr(0x2014), chr(0x2013), "&#8212;", "&mdash;", "&ndash;"):
        assert dash not in html_body, dash


@pytest.mark.parametrize("contact", [None, {"name": "Eva", "email": None, "phone": None}])
def test_an_alert_without_email_or_phone_says_so_and_what_to_do(contact):
    subject, html_body, _ = _alert(contact)

    assert NO_CONTACT_LINE in html_body
    assert ">Email<" not in html_body and ">Phone<" not in html_body
    assert (
        "The chat asked them for a phone number or email. You will get another email as soon as they share one, "
        "or in a few minutes if they have not." in html_body
    )
    assert "may still be on the way" not in html_body
    assert MESSAGE in html_body
    assert f'href="{APP_URL}/support?session=urgent-1"' in html_body
    _no_dashes(html_body)
    if contact:
        assert subject == "URGENT: Eva reported an active incident on Acme Bot"


def test_an_alert_with_an_email_shows_it_and_drops_the_no_contact_lines():
    _, html_body, _ = _alert({"name": "Eva", "email": "eva@x.test", "phone": None})

    assert ">Email<" in html_body and "mailto:eva@x.test" in html_body
    assert ">Phone<" not in html_body
    assert NO_CONTACT_LINE not in html_body
    assert "Reach out as soon as you can." in html_body
    assert "may still be on the way" not in html_body
    _no_dashes(html_body)


def test_an_alert_with_only_a_phone_shows_the_phone_and_no_empty_email_row():
    _, html_body, _ = _alert({"name": "Eva", "email": None, "phone": "+91 98765 43210"})

    assert ">Phone<" in html_body and "+91 98765 43210" in html_body
    assert ">Email<" not in html_body
    assert NO_CONTACT_LINE not in html_body
    _no_dashes(html_body)


def test_the_contact_follow_up_names_the_value_and_links_the_conversation():
    subject, html_body, options = _capture(
        email_service.send_urgent_contact_email,
        "soc@acme.test",
        "Acme Bot",
        "Eva",
        email="eva@x.test",
        phone="+91 98765 43210",
        reply_to="help@acme.test",
        session_id="urgent-1",
    )

    assert subject == "Contact details for Eva: eva@x.test, +91 98765 43210"
    assert "Contact details for Eva" in html_body
    assert "mailto:eva@x.test" in html_body and "+91 98765 43210" in html_body
    assert "shared how to reach them in the chat" in html_body
    assert f'href="{APP_URL}/support?session=urgent-1"' in html_body
    assert options["reply_to"] == "help@acme.test"
    _no_dashes(html_body)


def test_the_contact_follow_up_for_an_unnamed_visitor_with_a_phone_only():
    subject, html_body, _ = _capture(
        email_service.send_urgent_contact_email,
        "soc@acme.test",
        "Acme Bot",
        None,
        email=None,
        phone="+1 (415) 555-0100",
        reply_to=None,
        session_id="urgent-2",
    )

    assert subject == "Contact details for a visitor: +1 (415) 555-0100"
    assert ">Email<" not in html_body
    _no_dashes(html_body)


def test_the_no_contact_follow_up_says_so_with_the_presence_line():
    presence = "Still on the page: their chat window checked in less than a minute ago."
    subject, html_body, _ = _capture(
        email_service.send_urgent_no_contact_email,
        "soc@acme.test",
        "Acme Bot",
        "Eva",
        presence=presence,
        minutes_since_alert=3,
        reply_to="help@acme.test",
        session_id="urgent-1",
    )

    assert subject == "Still no contact details for Eva"
    assert presence in html_body
    assert "3 minutes ago" in html_body
    assert "has not shared an email or phone number yet" in html_body
    assert f'href="{APP_URL}/support?session=urgent-1"' in html_body
    _no_dashes(html_body)


def test_the_follow_ups_escape_what_the_visitor_typed():
    _, html_body, _ = _capture(
        email_service.send_urgent_contact_email,
        "soc@acme.test",
        "Acme Bot",
        "<b>Eva</b>",
        email=None,
        phone="+91 98765 43210",
        reply_to=None,
        session_id="a b&c",
    )

    assert "<b>Eva</b>" not in html_body and "&lt;b&gt;Eva&lt;/b&gt;" in html_body
    assert f'href="{APP_URL}/support?session=a%20b%26c"' in html_body
