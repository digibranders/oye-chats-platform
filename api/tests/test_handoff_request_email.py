"""The team email for a handoff request, and its urgent variant for an incident reported in chat.

A routine request keeps its queue wording. An urgent incident used to arrive with
the same "waiting to chat" subject and a 60-second queue warning, so it read as
one more chat request instead of a visitor under attack.
"""

from unittest.mock import patch

from app.config import APP_URL
from app.services import email_service

CONTACT = {"name": "Eva", "email": "eva@x.test", "phone": "+1 415 555 0100"}


def _render(*args, **kwargs) -> tuple[str, str, dict]:
    with patch.object(email_service, "send_email_async") as send:
        email_service.send_handoff_request_email(*args, **kwargs)
    send.assert_called_once()
    (_to, subject, html_body), options = send.call_args
    return subject, html_body, options


def test_a_routine_request_keeps_its_subject_and_queue_wording():
    subject, html_body, options = _render(
        "ops@acme.test", "Acme Bot", "Question about pricing", CONTACT, reply_to="help@acme.test"
    )

    assert subject == "Eva is waiting to chat on Acme Bot"
    assert "A visitor wants to chat" in html_body
    assert "They&rsquo;re waiting in the queue right now." in html_body
    assert "Visitors typically wait less than 60 seconds before abandoning a live-chat queue." in html_body
    assert f'href="{APP_URL}/support"' in html_body
    assert "+1 415 555 0100" not in html_body
    assert options["reply_to"] == "help@acme.test"


def test_a_routine_request_without_a_contact_names_a_visitor():
    subject, html_body, _ = _render("ops@acme.test", "Acme Bot", None)

    assert subject == "A visitor is waiting to chat on Acme Bot"
    assert "No reason provided" in html_body


def test_an_urgent_incident_says_urgent_and_links_to_the_conversation():
    message = "we are under a ransomware attack right now"
    subject, html_body, options = _render(
        "ops@acme.test",
        "Acme Bot",
        message,
        CONTACT,
        reply_to="help@acme.test",
        urgent=True,
        session_id="urgent-1",
    )

    assert subject == "URGENT: Eva reported an active incident on Acme Bot"
    assert "URGENT: Eva reported an active incident" in html_body
    assert "waiting in the queue" not in html_body
    assert "60 seconds" not in html_body
    assert ">Phone<" in html_body and "+1 415 555 0100" in html_body
    assert message in html_body
    assert f'href="{APP_URL}/support?session=urgent-1"' in html_body
    assert options["reply_to"] == "help@acme.test"


def test_an_urgent_incident_without_a_phone_or_name_has_no_phone_row():
    subject, html_body, _ = _render(
        "ops@acme.test",
        "Acme Bot",
        "our servers have been hacked",
        {"name": None, "email": "eva@x.test", "phone": None},
        urgent=True,
        session_id="urgent-2",
    )

    assert subject == "URGENT: A visitor reported an active incident on Acme Bot"
    assert ">Phone<" not in html_body


def test_the_visitor_message_and_session_id_are_escaped():
    _, html_body, _ = _render(
        "ops@acme.test",
        "Acme Bot",
        "<script>alert(1)</script>",
        None,
        urgent=True,
        session_id="a b&c",
    )

    assert "<script>" not in html_body
    assert "&lt;script&gt;" in html_body
    assert f'href="{APP_URL}/support?session=a%20b%26c"' in html_body
