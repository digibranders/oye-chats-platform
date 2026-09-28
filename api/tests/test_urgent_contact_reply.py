"""The urgent reply asks for a phone number or email when the team has neither.

On 2026-09-28 the owner got an urgent alert with the name "Eva" and no email, and
asked how the team could reach her. A panicked visitor may never fill in a form,
so the reply asks in the chat as well, and keeps the form for those who prefer it.
"""

import pytest

from app.services.intent_service import bot_offers_handoff
from app.services.urgent_route import urgent_reply

ASK = "What's the best phone number or email to reach you on right now?"


def _reply(**over):
    kwargs = dict(
        company_name="Acme",
        support_enabled=True,
        live_chat_enabled=True,
        team_available=True,
        emergency_url=None,
        contact_url=None,
        ask_for_contact=True,
    )
    kwargs.update(over)
    return urgent_reply(**kwargs)


def test_team_available_asks_for_contact_and_keeps_the_form():
    assert _reply().text == (
        "This sounds urgent, so I've flagged it to **Acme** as a priority. What's the best phone number or email "
        "to reach you on right now? Type it here, or share your details in the form below and I'll connect you "
        "with them right away."
    )


def test_team_offline_asks_for_contact_and_keeps_the_form():
    assert _reply(team_available=False).text == (
        "This sounds urgent, so I've flagged it to **Acme** as a priority. What's the best phone number or email "
        "to reach you on right now? Type it here, or share your details in the form below so the team can "
        "contact you as soon as possible."
    )


def test_no_live_chat_asks_for_contact_and_keeps_the_message_form():
    reply = _reply(live_chat_enabled=False)
    assert reply.text == (
        "This sounds urgent, so I've flagged it to **Acme** as a priority. What's the best phone number or email "
        "to reach you on right now? Type it here, or I'll open a quick message form so the team can contact you "
        "as soon as possible."
    )
    assert reply.needs_message_card is True and reply.suggest_handoff is False


def test_a_repeat_asks_again_in_new_words():
    assert _reply(repeat=True).text == (
        "I've already flagged this to **Acme** as a priority. Type the best phone number or email to reach you "
        "on here, or share your details in the form just below and I'll connect you with them right away."
    )
    assert _reply(team_available=False, repeat=True).text == (
        "I've already flagged this to **Acme** as a priority. Type the best phone number or email to reach you "
        "on here, or share your details in the form just below so the team can contact you as soon as possible."
    )
    assert _reply(live_chat_enabled=False, repeat=True).text == (
        "I've already flagged this to **Acme** as a priority. Type the best phone number or email to reach you "
        "on here, or leave your details in the message form so the team can contact you as soon as possible."
    )


def test_the_flags_do_not_change_with_the_ask():
    for over in ({}, {"team_available": False}, {"live_chat_enabled": False}):
        for repeat in (False, True):
            asked = _reply(repeat=repeat, **over)
            plain = _reply(repeat=repeat, ask_for_contact=False, **over)
            assert (asked.suggest_handoff, asked.needs_message_card) == (
                plain.suggest_handoff,
                plain.needs_message_card,
            )


def test_a_team_that_already_has_the_contact_is_not_asked_for_it_again():
    assert ASK not in _reply(ask_for_contact=False).text
    assert "phone number" not in _reply(ask_for_contact=False, repeat=True).text


def test_a_plan_without_a_team_never_asks():
    """Nobody is alerted on that plan, so nobody would read the number."""
    assert _reply(support_enabled=False, contact_url="https://acme.com/contact") == _reply(
        support_enabled=False, contact_url="https://acme.com/contact", ask_for_contact=False
    )


@pytest.mark.parametrize("repeat", [False, True])
@pytest.mark.parametrize(
    ("live_chat_enabled", "team_available"), [(True, True), (True, False), (False, True), (False, False)]
)
@pytest.mark.parametrize("emergency_url", [None, "https://acme.com/incident"])
def test_every_reply_that_asks_still_closes_on_an_offer(live_chat_enabled, team_available, repeat, emergency_url):
    reply = _reply(
        live_chat_enabled=live_chat_enabled, team_available=team_available, repeat=repeat, emergency_url=emergency_url
    )
    assert bot_offers_handoff(reply.text) is True, reply.text
    assert "**Acme**" in reply.text
    assert chr(0x2014) not in reply.text and chr(0x2013) not in reply.text, "no em or en dash"
