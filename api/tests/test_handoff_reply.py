"""The reply to "connect me" describes the form the widget actually opens.

Reported from a live bot on 2026-09-10. A visitor typed "connect me", the
widget opened the "Talk to a human" form, and the bot said "I'll open a quick
message form for you". The handoff decision is made before generation, but the
words were left to the model, which copied the leave-a-message example from the
prompt. A second "connect me" got "I'll open the message form now."

``handoff_reply`` is the fixed wording for that turn: it names the form below,
says what happens next, tells the truth when nobody is available, and does not
repeat itself when the visitor asks again.
"""

from __future__ import annotations

import time

import pytest

from app.services.handoff_reply import handoff_reply, handoff_waiting_reply, requested_thing, unhelped_offer
from app.services.intent_service import bot_offers_handoff
from app.services.urgent_route import urgent_reply

_ALL = [(available, repeat) for available in (True, False) for repeat in (False, True)]


def _every_fixed_handoff_text() -> list[str]:
    """Every reply the three fixed-wording routes can send, across all their flags."""
    texts = [handoff_reply(team_available=available, repeat=repeat) for available, repeat in _ALL]
    texts += [
        handoff_reply(team_available=available, repeat=True, request="the escalation matrix")
        for available in (True, False)
    ]
    texts += [handoff_waiting_reply(team_available=available) for available in (True, False)]
    texts += [
        unhelped_offer(live_chat_enabled=live, team_available=available).text
        for live in (True, False)
        for available in (True, False)
    ]
    texts += [
        urgent_reply(
            company_name=company_name,
            support_enabled=support,
            live_chat_enabled=live,
            team_available=available,
            emergency_url=emergency_url,
            contact_url=contact_url,
            repeat=repeat,
        ).text
        for company_name in ("Acme", None)
        for support in (True, False)
        for live in (True, False)
        for available in (True, False)
        for emergency_url in (None, "https://acme.example/incident")
        for contact_url in (None, "https://acme.example/contact")
        for repeat in (False, True)
    ]
    return texts


class TestNobodyOnTheDashboardIsNotOffline:
    """Nobody on the dashboard is not a team that is offline.

    Product owner, 2026-09-11: an operator can be in another tab or come back from
    a push on their phone, and the handoff route queues the visitor and alerts the
    team when push or an open socket can reach anyone. "Our team is offline right
    now" told the visitor nobody would come.
    """

    @pytest.mark.parametrize("text", _every_fixed_handoff_text())
    def test_no_fixed_reply_calls_the_team_offline(self, text):
        assert "offline" not in text.lower(), text

    def test_the_parametrisation_covers_the_nobody_available_replies(self):
        texts = _every_fixed_handoff_text()
        assert handoff_reply(team_available=False, repeat=False) in texts
        assert unhelped_offer(live_chat_enabled=True, team_available=False).text in texts

    @pytest.mark.parametrize(
        "text",
        [
            handoff_reply(team_available=False, repeat=False),
            handoff_reply(team_available=False, repeat=True),
            unhelped_offer(live_chat_enabled=True, team_available=False).text,
        ],
        ids=["handoff", "handoff-repeat", "unhelped"],
    )
    def test_nobody_available_is_worded_true_in_every_unavailable_state(self, text):
        """``team_available`` is False when nobody is on the dashboard, and also
        outside business hours and when the queue is full, where the widget shows
        the message form and nobody is waiting on the visitor. "I'll let our team
        know you're waiting" was false in those two. Passing the details on is
        true in all three."""
        assert "waiting" not in text.lower()
        for word in ("offline", "away", "unavailable"):
            assert word not in text.lower(), word
        assert text.endswith("I'll pass them to our team.")


class TestTheWordsMatchTheForm:
    @pytest.mark.parametrize(("available", "repeat"), _ALL)
    def test_it_points_at_the_form_and_never_calls_it_a_message_form(self, available, repeat):
        text = handoff_reply(team_available=available, repeat=repeat)
        assert "form" in text
        assert "message form" not in text.lower()

    def test_first_ask_with_the_team_available(self):
        assert handoff_reply(team_available=True, repeat=False) == (
            "Sure. Share your details in the form below and I'll connect you with our team."
        )

    def test_first_ask_with_nobody_available_does_not_promise_a_live_chat(self):
        text = handoff_reply(team_available=False, repeat=False)
        assert text == "Sure. Share your details in the form below and I'll pass them to our team."
        assert "connect you" not in text

    def test_first_ask_with_nobody_available_closes_on_an_offer(self):
        """An "ok" on the next turn opens the form again instead of the router's small talk."""
        assert bot_offers_handoff(handoff_reply(team_available=False, repeat=False))

    def test_a_repeat_points_at_the_form_already_open(self):
        assert handoff_reply(team_available=True, repeat=True) == (
            "The form is just below. Share your details there and I'll connect you with our team."
        )
        assert handoff_reply(team_available=False, repeat=True) == (
            "The form is just below. Share your details there and I'll pass them to our team."
        )

    def test_a_repeat_with_nobody_available_still_closes_on_an_offer(self):
        """The repeat is an offer too, so an "ok" after it reopens the form like the first reply."""
        assert bot_offers_handoff(handoff_reply(team_available=False, repeat=True))

    @pytest.mark.parametrize("available", [True, False])
    def test_a_repeat_is_worded_differently(self, available):
        assert handoff_reply(team_available=available, repeat=True) != handoff_reply(
            team_available=available, repeat=False
        )

    @pytest.mark.parametrize(("available", "repeat"), _ALL)
    def test_no_dashes_and_says_our_team(self, available, repeat):
        text = handoff_reply(team_available=available, repeat=repeat)
        assert "—" not in text and "–" not in text
        assert "human team" not in text
        assert "our team" in text.lower()


class TestARepeatAcknowledgesWhatTheVisitorJustSaid:
    """Evaluation 2026-09-28: "hello?? nobody is replying" after the form got "The
    form is just below." with the wait unacknowledged (x-human-nobody-replying,
    both bots), and "i need the escalation matrix now" after the support reply got
    the same line with the request unacknowledged (x-support-escalation, both)."""

    def test_the_waiting_reply_says_sorry_for_the_wait_and_points_at_the_form(self):
        assert handoff_waiting_reply(team_available=False) == (
            "Sorry for the wait, nobody has picked this up yet. "
            "The form is just below. Share your details there and I'll pass them to our team."
        )
        assert handoff_waiting_reply(team_available=True) == (
            "Sorry for the wait, nobody has picked this up yet. "
            "The form is just below. Share your details there and I'll connect you with our team."
        )

    @pytest.mark.parametrize("available", [True, False])
    def test_the_waiting_reply_closes_on_an_offer_and_never_calls_the_team_offline(self, available):
        text = handoff_waiting_reply(team_available=available)
        assert bot_offers_handoff(text)
        for word in ("offline", "away", "unavailable"):
            assert word not in text.lower(), word
        assert text.endswith(handoff_reply(team_available=available, repeat=True))

    def test_a_new_request_after_the_form_is_named(self):
        assert handoff_reply(team_available=False, repeat=True, request="the escalation matrix") == (
            "I've added your request for the escalation matrix to what the team will see. "
            "The form is just below. Share your details there and I'll pass them to our team."
        )
        assert handoff_reply(team_available=True, repeat=True, request="the escalation matrix") == (
            "I've added your request for the escalation matrix to what the team will see. "
            "The form is just below. Share your details there and I'll connect you with our team."
        )

    @pytest.mark.parametrize("available", [True, False])
    def test_the_named_request_closes_on_an_offer(self, available):
        assert bot_offers_handoff(handoff_reply(team_available=available, repeat=True, request="a callback"))

    @pytest.mark.parametrize("available", [True, False])
    def test_a_request_is_only_named_on_a_repeat(self, available):
        """The first offer already answers the request with the form."""
        assert handoff_reply(team_available=available, repeat=False, request="the escalation matrix") == (
            handoff_reply(team_available=available, repeat=False)
        )

    @pytest.mark.parametrize("available", [True, False])
    def test_no_request_keeps_the_plain_repeat(self, available):
        for request in (None, "", "   "):
            assert handoff_reply(team_available=available, repeat=True, request=request) == handoff_reply(
                team_available=available, repeat=True
            )

    @pytest.mark.parametrize("text", _every_fixed_handoff_text())
    def test_no_dashes_in_any_fixed_reply(self, text):
        assert "\u2014" not in text and "\u2013" not in text, text


class TestRequestedThing:
    """What a repeat message asks for, in the visitor's own words, or None when it
    asks for a person again or names nothing the reply could repeat."""

    @pytest.mark.parametrize(
        ("message", "expected"),
        [
            ("i need the escalation matrix now", "the escalation matrix"),
            ("I need the escalation matrix NOW!!", "the escalation matrix"),
            ("ok so i need the escalation matrix asap please", "the escalation matrix"),
            ("can you send me the SLA document please", "the SLA document"),
            ("could someone share your onboarding checklist", "your onboarding checklist"),
            ("we need a copy of the contract", "a copy of the contract"),
            ("i want a refund", "a refund"),
            ("send me the invoice for march", "the invoice for march"),
            ("we are looking for a quote for 50 seats", "a quote for 50 seats"),
            ("i'd like the audit report, thanks", "the audit report"),
            ("hi, i need help with the portal login", "help with the portal login"),
        ],
    )
    def test_a_request_is_named_in_the_visitor_words(self, message, expected):
        assert requested_thing(message) == expected

    @pytest.mark.parametrize(
        "message",
        [
            "connect me to someone from sales",
            "connect me",
            "i need to talk to a human",
            "i want to speak with the team",
            "get me a person",
            "can i talk to someone",
            "i need a human",
            "escalate this",
            "please escalate",
            "hello?? nobody is replying",
            "escalation matrix?",
            "the escalation matrix please",
            "yes",
            "",
            "   ",
            None,
            42,
            "i need " + "x" * 200,
            "i need the full list of everything you have ever done for every customer in every region since 2010",
        ],
    )
    def test_a_person_ask_a_bare_noun_or_nothing_names_no_request(self, message):
        assert requested_thing(message) is None

    @pytest.mark.parametrize(
        "message",
        [
            "i need " * 5000,
            "please " * 5000 + "send me the brochure",
            "i need the brochure " + "now " * 5000,
            "can you " * 3000 + "x",
        ],
    )
    def test_it_is_linear_on_long_input(self, message):
        started = time.perf_counter()
        requested_thing(message)
        assert time.perf_counter() - started < 0.5
