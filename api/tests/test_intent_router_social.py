"""Conversational turns the knowledge base can never answer.

Production, 2026-09-10: "how are you?", "you are a good bot", "you are useless"
and "non sense" got off-topic refusals on all four bots; "h" got "Hi Eva.";
"re you a human" opened the handoff form. The router answers them before the
relevance gate can refuse them.

Production, 2026-09-10 (second pass): the gibberish route's keyboard-run branch
also matched "property" and "liberty" (they contain "erty"), so 32 ordinary
dictionary words got "Could you say a bit more..." instead of an answer, and a
bare "y" after "Want me to connect you with the team?" never reached the
handoff classifier because the single-letter branch treated it as gibberish.
"""

import time

import pytest

from app.services.intent_router import (
    _ACK_TERMS,
    _COMPLIMENT_RE,
    _GREETING_TERMS,
    _HOW_ARE_YOU_RE,
    _NEG_ACK_TERMS,
    route_intent,
)
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
        ("zxcvbnm", "unclear"),
        ("hmmmmm", "unclear"),
        ("n", "neg_ack"),
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
def test_abuse_stays_calm_and_offers_the_team_only_on_a_plan_with_one(msg):
    """Eval 2026-09-17: a calm reply with no next step left an upset visitor
    nowhere to go, so the reply offers the team when the plan has one."""
    with_team = route_intent(msg, COMPANY, support_enabled=True).answer
    without = route_intent(msg, COMPANY, support_enabled=False).answer
    assert "**Acme**" in with_team and "**Acme**" in without
    assert bot_offers_handoff(with_team), with_team
    assert "connect" not in without.lower()
    assert not bot_offers_handoff(without), without


# ─────────────────────────────────────────────────────────────────────────────
# Gibberish route precision: real words must reach retrieval, not "unclear".
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "word",
    ["property", "liberty", "poverty", "puberty", "rhythm", "bcrypt", "y", "n", "k"],
)
def test_real_words_are_not_swallowed_by_unclear(word):
    routed = route_intent(word, COMPANY)
    assert routed is None or routed.intent != "unclear", word


def _stretched_spellings(term: str) -> list[str]:
    """``term`` with each of its letters in turn repeated to a run of five."""
    return [term[:i] + ch * 5 + term[i + 1 :] for i, ch in enumerate(term) if ch.isalpha()]


@pytest.mark.parametrize(
    ("terms", "intent"),
    [(_GREETING_TERMS, "greeting"), (_ACK_TERMS, "ack"), (_NEG_ACK_TERMS, "neg_ack")],
)
def test_every_term_and_its_stretched_spellings_route_to_their_intent(terms, intent):
    """A stretched term is still that term, and the gibberish route must not
    take it first: "kkkkkk", "thxxxx", "gmmmmm" and "nnnnnn" are six or more
    consonants, so they read as unclear before the term sets were matched ahead
    of the gibberish check."""
    for term in sorted(terms):
        for msg in (term, *_stretched_spellings(term)):
            routed = route_intent(msg, COMPANY)
            assert routed is not None, msg
            assert routed.intent == intent, msg


def test_y_is_not_routed_as_unclear():
    routed = route_intent("y", COMPANY)
    assert routed is None or routed.intent != "unclear"


def test_n_is_routed_as_neg_ack():
    assert route_intent("n", COMPANY).intent == "neg_ack"


def test_timing_on_a_long_keyboard_mash_with_a_digit():
    mash = ("qwertyuiopasdfghjklzxcvbnm" * 200)[:4999] + "1"
    started = time.perf_counter()
    route_intent(mash, COMPANY)
    assert time.perf_counter() - started < 0.5


def test_timing_on_a_long_erty_run():
    mash = "erty" * 1250
    assert len(mash) == 5000
    started = time.perf_counter()
    route_intent(mash, COMPANY)
    assert time.perf_counter() - started < 0.5


# ─────────────────────────────────────────────────────────────────────────────
# No company name: replies must read naturally, never "us's" or "at us".
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "msg",
    [
        "how are you?",
        "great bot",
        "shut up",
        "h",
        "what's my name",
    ],
)
def test_replies_read_naturally_with_no_company_name(msg):
    routed = route_intent(msg, None, visitor_name="Eva")
    assert routed is not None, msg
    reply = routed.answer
    assert reply, msg
    assert "us's" not in reply, reply
    assert " at us" not in reply, reply
    assert "about us whenever" not in reply, reply


# ─────────────────────────────────────────────────────────────────────────────
# The unclear reply respects the support-entitlement plan.
# ─────────────────────────────────────────────────────────────────────────────


def test_unclear_offers_getting_in_touch_when_support_is_enabled():
    reply = route_intent("h", COMPANY, support_enabled=True).answer
    assert "getting in touch" in reply


def test_unclear_drops_getting_in_touch_without_support():
    reply = route_intent("h", COMPANY, support_enabled=False).answer
    assert "getting in touch" not in reply
    assert "services" in reply and "pricing" in reply


# ─────────────────────────────────────────────────────────────────────────────
# Praise for the company, and pleasantries the "how are you" shapes missed.
#
# Production, 2026-09-18, Eventus Security and CleanStart, both after the name
# step: "nice website btw, very clean design" got the gap line ("I don't have
# that detail here. Want me to loop in the team on this?") and "hey hows ur day
# going" got the scope refusal ("I'm focused on questions about CleanStart").
# Both reached the relevance gate because the compliment route only knew praise
# aimed at the bot itself and the pleasantry route knew three fixed shapes.
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "msg",
    [
        "nice website btw, very clean design",
        "nice website",
        "love the new site",
        "i love your website",
        "your product looks great",
        "the new design is really clean",
        "your team is great",
        "great work",
        "really nice site btw",
        "your app looks slick",
    ],
)
def test_praise_for_the_company_is_routed_as_a_compliment(msg):
    routed = route_intent(msg, COMPANY)
    assert routed is not None, msg
    assert routed.intent == "compliment", msg


@pytest.mark.parametrize(
    "msg",
    [
        "hey hows ur day going",
        "hows your day going",
        "how is your day going",
        "hows your day",
        "how are things going",
        "hows everything going",
    ],
)
def test_pleasantries_are_routed_as_how_are_you(msg):
    routed = route_intent(msg, COMPANY)
    assert routed is not None, msg
    assert routed.intent == "how_are_you", msg


@pytest.mark.parametrize(
    "msg",
    [
        "nice website, what does your SOC service cost?",
        "nice website, do you have pricing",
        "your product looks great, can i get a demo",
        "i love the design of your dashboard, how much is it",
        "how are your SOC services priced",
        "how is your product different from Zoho",
        "hows the pricing work for 50 seats",
        "is your website down",
        "what makes your platform great",
        "do you have a good product for small teams",
    ],
)
def test_a_real_question_with_praise_in_it_still_reaches_retrieval(msg):
    assert route_intent(msg, COMPANY) is None, msg


def test_the_pleasantry_reply_is_short_warm_and_offers_help():
    """The rubric fails an opener of "Doing well", "Absolutely" or "Of course",
    the same openers ``response_style`` already bans for the answer model."""
    reply = route_intent("hey hows ur day going", COMPANY).answer
    assert not reply.startswith(("Doing well", "Doing great", "Absolutely", "Of course"))
    assert f"**{COMPANY}**" in reply
    assert reply.count("?") == 1
    assert len(reply.split()) <= 20


def test_the_compliment_reply_thanks_the_visitor_and_offers_help():
    reply = route_intent("nice website btw, very clean design", COMPANY).answer
    assert reply.lower().startswith("thank")
    assert f"**{COMPANY}**" in reply
    assert reply.count("?") == 1


@pytest.mark.parametrize("dash", [chr(0x2014), chr(0x2013)])
@pytest.mark.parametrize("msg", ["nice website btw, very clean design", "hey hows ur day going"])
def test_the_new_replies_carry_no_dashes(msg, dash):
    assert dash not in route_intent(msg, COMPANY).answer


@pytest.mark.parametrize("pattern", [_COMPLIMENT_RE, _HOW_ARE_YOU_RE])
def test_timing_on_a_long_near_miss(pattern):
    """Bounded repeats only. The word gate keeps a message this long away from
    these patterns, so they are timed directly."""
    mash = ("very nice website btw, " * 250)[:4999] + "x"
    started = time.perf_counter()
    pattern.match(mash)
    assert time.perf_counter() - started < 0.5
