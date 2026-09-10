"""A question held behind the name gate must still get an answer.

The bot asks a first-time visitor for their name and defers whatever they
actually asked. When the name arrives, the deferred question is replayed. It
was skipped whenever ``intent_router`` could route it, and the comment beside
that guard said the point was to avoid replaying a GREETING, which is right:
answering "hi" again after "Nice to meet you, Eva!" greets them twice.

The router answers eight intents though, and five of them are real questions.
So a visitor could open with "Are you a human?", be asked their name, give it,
and receive "Nice to meet you, Eva! What would you like to know?" with their
question dropped. Three eval cases had been passing on a grader lenient enough
to score that as a correct answer to "Who made you?".
"""

from __future__ import annotations

import pytest

from app.services.rag_service import _deferred_is_worth_replaying


class TestRealQuestionsAreReplayed:
    @pytest.mark.parametrize(
        "deferred",
        [
            "Are you a human?",
            "Who made you?",
            "Is this conversation recorded?",
            "do you remember me",
            "what do you charge for the Growth plan",
            "what does Acme do",
        ],
    )
    def test_it_is_worth_replaying(self, deferred):
        assert _deferred_is_worth_replaying(deferred, "Acme Analytics") is True


class TestSocialRepliesAreNot:
    """Replaying these would greet the visitor twice in two consecutive turns."""

    @pytest.mark.parametrize("deferred", ["hi", "hello", "good morning", "thanks", "ok", "no thanks"])
    def test_it_is_skipped(self, deferred):
        from app.services.intent_router import route_intent

        routed = route_intent(deferred, "Acme Analytics")
        assert routed is not None, "this test needs a message the router actually routes"
        assert routed.intent in {"greeting", "ack", "neg_ack"}
        assert _deferred_is_worth_replaying(deferred, "Acme Analytics") is False


class TestTheGuardIsNotJustRoutability:
    def test_an_identity_question_routes_but_is_still_replayed(self):
        """The regression in one assertion: routable and worth replaying are
        different things, and conflating them is what dropped the question."""
        from app.services.intent_router import route_intent

        routed = route_intent("Who made you?", "Acme Analytics")
        assert routed is not None and routed.intent == "who_made_you"
        assert _deferred_is_worth_replaying("Who made you?", "Acme Analytics") is True
