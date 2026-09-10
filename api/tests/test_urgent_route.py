"""A visitor reporting an active incident gets the fastest route, not a generic form.

Production, 2026-09-10: "we are under a ransomware attack right now, please
help!" got "Our team is offline right now. Share your details..." on all four
bots, including two security companies.
"""

import pytest

from app.services.intent_service import bot_offers_handoff
from app.services.urgent_route import emergency_url_from_answer_links, is_urgent_incident, urgent_reply


@pytest.mark.parametrize(
    "msg",
    [
        "we are under a ransomware attack right now, please help!",
        "our servers have been hacked",
        "I think we've been breached",
        "there is an active incident on our network",
        "urgent help needed now",
        "help, our site got hacked",
        "we've been hacked, please help now",
        "our website is hacked and down right now",
        "Are you there? urgent help needed now!",
    ],
)
def test_urgent_incidents_are_recognised(msg):
    assert is_urgent_incident(msg) is True


@pytest.mark.parametrize(
    "msg",
    [
        "what is your incident response service?",
        "tell me about ransomware attacks",
        "do you handle emergency response?",
        "how do you protect against being hacked?",
        "what happens if we are breached?",
        "",
        # An incident in the past is context for a sales question, not an emergency.
        "our site got hacked last year, what do you offer?",
        "we were breached in 2023",
        "I was hacked a few months ago",
        # A question about the service names the words without reporting anything.
        "do you offer emergency plumbing now?",
        "is urgent help available on weekends?",
        "do you provide emergency incident response now?",
        "can you help with ransomware attacks?",
    ],
)
def test_questions_about_incidents_are_not_urgent(msg):
    assert is_urgent_incident(msg) is False


def test_a_non_string_is_not_urgent():
    assert is_urgent_incident(None) is False


def test_the_emergency_link_comes_from_a_smart_link():
    links = [
        {"keyword": "pricing", "url": "https://acme.com/pricing"},
        {"keyword": "Emergency", "url": " https://acme.com/incident "},
    ]
    assert emergency_url_from_answer_links(links) == "https://acme.com/incident"


@pytest.mark.parametrize(
    "links",
    [
        None,
        "x",
        [{"keyword": "emergency", "url": "javascript:alert(1)"}],
        [{"keyword": "emergency", "url": "ftp://acme.com/x"}],
        [{"keyword": "emergency", "url": "https://"}],
        [{"keyword": "emergency"}],
    ],
)
def test_an_unusable_emergency_link_is_ignored(links):
    assert emergency_url_from_answer_links(links) is None


def _reply(**over):
    kwargs = dict(
        company_name="Acme",
        support_enabled=True,
        live_chat_enabled=True,
        team_available=True,
        emergency_url=None,
        contact_url=None,
    )
    kwargs.update(over)
    return urgent_reply(**kwargs)


def test_team_available_opens_the_form_and_says_it_is_flagged():
    r = _reply()
    assert r.suggest_handoff is True and r.needs_message_card is False
    assert "flagged" in r.text and "form below" in r.text


def test_team_offline_says_so_and_still_flags():
    r = _reply(team_available=False)
    assert "offline" in r.text and "flagged" in r.text
    assert r.suggest_handoff is True


def test_no_live_chat_opens_the_message_card():
    r = _reply(live_chat_enabled=False)
    assert r.suggest_handoff is False and r.needs_message_card is True


def test_the_emergency_link_is_offered_first_when_configured():
    r = _reply(emergency_url="https://acme.com/incident")
    assert "https://acme.com/incident" in r.text


def test_a_plan_without_a_human_points_to_a_page_and_claims_no_flagging():
    r = _reply(support_enabled=False, contact_url="https://acme.com/contact")
    assert "https://acme.com/contact" in r.text
    assert "flagged" not in r.text
    assert r.suggest_handoff is False and r.needs_message_card is False


def test_a_yes_after_the_live_reply_is_a_handoff_and_after_the_no_human_reply_is_not():
    """The next turn reads the bot's closing paragraph: "yes" after an offer of the
    team becomes a handoff, "yes" after a pointer to a page does not."""
    assert bot_offers_handoff(_reply().text) is True
    assert bot_offers_handoff(_reply(emergency_url="https://acme.com/incident").text) is True
    assert bot_offers_handoff(_reply(support_enabled=False, contact_url="https://acme.com/contact").text) is False
    assert bot_offers_handoff(_reply(support_enabled=False).text) is False
