"""Conversational turns the knowledge base can never answer.

Production, 2026-09-10: "how are you?", "you are a good bot", "you are useless"
and "non sense" got off-topic refusals on all four bots; "h" got "Hi Eva.";
"re you a human" opened the handoff form. The router answers them before the
relevance gate can refuse them.
"""

import pytest

from app.services.intent_router import route_intent
from app.services.intent_service import bot_offers_handoff

COMPANY = "Acme"


@pytest.mark.parametrize(
    ("msg", "intent"),
    [
        ("how are you?", "how_are_you"),
        ("hey how are you doing", "how_are_you"),
        ("how's it going", "how_are_you"),
        ("you are a good bot..?", "compliment"),
        ("great bot", "compliment"),
        ("this was helpful", "compliment"),
        ("non sense", "frustration"),
        ("nonsense", "frustration"),
        ("you are useless", "frustration"),
        ("this is not helpful", "frustration"),
        ("f*** off", "abuse"),
        ("fuck off", "abuse"),
        ("fuck you", "abuse"),
        ("f u", "abuse"),
        ("screw you", "abuse"),
        ("shut up", "abuse"),
        ("fuck this", "abuse"),
        ("fuck this bot", "abuse"),
        ("this bot is shit", "abuse"),
        ("shit bot", "abuse"),
        ("go to hell", "abuse"),
        ("you are an idiot", "abuse"),
        ("idiot bot", "abuse"),
        ("asshole", "abuse"),
        ("bitch", "abuse"),
        ("bastard", "abuse"),
        ("h", "unclear"),
        ("asdfghjkl", "unclear"),
        ("qwerty", "unclear"),
        ("re you a human", "is_ai"),
        ("r u a bot", "is_ai"),
        ("are u human", "is_ai"),
    ],
)
def test_the_turn_is_routed(msg, intent):
    routed = route_intent(msg, COMPANY)
    assert routed is not None, msg
    assert routed.intent == intent


@pytest.mark.parametrize(
    "msg",
    [
        "how are your SOC services priced",
        "is your service useless for small teams?",
        "xdr",
        "soc",
        "vapt",
        "what is a good bot for sales",
        "how do you handle nonsense data",
        "tell me about h1 2026 plans",
    ],
)
def test_real_questions_are_not_swallowed(msg):
    assert route_intent(msg, COMPANY) is None


@pytest.mark.parametrize(
    "msg",
    [
        "what the fuck is your pricing",
        "holy shit that's expensive",
        "is this shit legal?",
        "how do I remove bullshit leads from my crm",
    ],
)
def test_abuse_does_not_swallow_real_questions(msg):
    routed = route_intent(msg, COMPANY)
    assert routed is None or routed.intent != "abuse", msg


def test_frustration_offers_the_team_in_words_a_yes_can_accept():
    reply = route_intent("you are useless", COMPANY, support_enabled=True).answer
    assert bot_offers_handoff(reply), reply


def test_frustration_on_a_plan_without_a_human_does_not_offer_one():
    reply = route_intent("you are useless", COMPANY, support_enabled=False).answer
    assert "team" not in reply.lower()
    assert "connect" not in reply.lower()
    assert not bot_offers_handoff(reply)


def test_unclear_asks_for_more_and_offers_no_person():
    reply = route_intent("h", COMPANY).answer
    assert "say a bit more" in reply
    assert "connect" not in reply.lower()


@pytest.mark.parametrize("msg", ["f*** off", "fuck off"])
def test_abuse_stays_calm_and_offers_no_person(msg):
    reply = route_intent(msg, COMPANY).answer
    assert "connect" not in reply.lower()
    assert "**Acme**" in reply
