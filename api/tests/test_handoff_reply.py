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

import pytest

from app.services.handoff_reply import handoff_reply

_ALL = [(available, repeat) for available in (True, False) for repeat in (False, True)]


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
        assert (
            text == "Our team is offline right now. Share your details in the form below and they'll get back to you."
        )
        assert "connect you" not in text

    def test_a_repeat_points_at_the_form_already_open(self):
        assert handoff_reply(team_available=True, repeat=True) == (
            "The form is just below. Share your details there and I'll connect you with our team."
        )
        assert handoff_reply(team_available=False, repeat=True) == (
            "The form is just below. Share your details there and our team will get back to you."
        )

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
