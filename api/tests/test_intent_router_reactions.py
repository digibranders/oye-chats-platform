"""Replies to frustration, insults, sarcasm and distress.

Eval run 2026-09-17 (defect 6, both bots): "this bot is absolute trash" got
"Sorry to hear that." and nothing else; "stupid bot" got "That's not something
I can speak to. I cover CleanStart only."; "forget it, useless" got the scope
refusal; and "cant sleep because of work stress after the breach, which tablets
should i take" got the off-topic redirect with no care and no suggestion to see
a doctor. The router now answers each of these with one short acknowledgement
and a concrete next step, never apologises twice in a row, and answers a
visitor in distress with care and a pointer to emergency help instead of sales.
"""

from __future__ import annotations

import re
import time

import pytest

from app.services.intent_router import (
    CARE_NOTE,
    care_note,
    crisis_reply,
    follows_a_reaction_reply,
    is_verdict_on_the_chat,
    route_intent,
)
from app.services.intent_service import bot_offers_handoff

COMPANY = "Acme"
_DASHES = ("\u2014", "\u2013")


def _routed(msg: str, **kwargs):
    routed = route_intent(msg, COMPANY, **kwargs)
    assert routed is not None, msg
    return routed


# ─────────────────────────────────────────────────────────────────────────────
# Frustration and insults aimed at the bot
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "msg",
    [
        "this bot is absolute trash",
        "stupid bot",
        "forget it, useless",
        "useless bot",
        "this bot is useless",
        "your bot is garbage",
        "you're a useless bot",
        "you are so dumb",
        "u r stupid",
        "what a useless bot",
        "worst bot ever",
        "this is garbage",
        "this is a waste of time",
        "ugh, pathetic",
        "seriously, this chatbot is a joke",
        "this bot sucks",
        "you suck",
        "no help at all",
        "dumb bot lol",
        "this bot is absolute trash \U0001f644",
        "this is useless, you never answer anything",
        "you never answer anything",
        "you don't help",
        "useless bot and you never answer my questions",
    ],
)
def test_frustration_with_the_bot_is_routed(msg):
    assert _routed(msg).intent == "frustration"


@pytest.mark.parametrize(
    "msg",
    [
        "useless answer",
        "garbage",
        "trash",
        "rubbish collection days",
        "is your service useless for small teams?",
        "why is this bot so slow to load on mobile",
        "what does a garbage collection pause cost",
        "how do i stop stupid spam leads",
        "do you remove trash from construction sites",
        "is the chatbot useful for sales teams",
        "you don't answer calls on weekends?",
        "can you help me answer rfp questions",
    ],
)
def test_questions_and_answer_complaints_are_not_routed_as_frustration(msg):
    routed = route_intent(msg, COMPANY)
    assert routed is None or routed.intent != "frustration", msg


@pytest.mark.parametrize("support", [True, False])
@pytest.mark.parametrize("msg", ["this bot is absolute trash", "shut up"])
def test_reaction_replies_acknowledge_and_give_a_next_step(msg, support):
    reply = _routed(msg, support_enabled=support).answer
    first_sentence = reply.split(". ")[0]
    assert len(first_sentence.split()) <= 6, reply
    assert "one thing" in reply, reply
    assert "**Acme**" in reply, reply
    assert bot_offers_handoff(reply) is support, reply
    lowered = reply.lower()
    assert "offline" not in lowered and "unavailable" not in lowered
    assert not any(dash in reply for dash in _DASHES)


@pytest.mark.parametrize("msg", ["this bot is absolute trash", "stupid bot", "fuck off", "you are an idiot"])
def test_reaction_replies_never_repeat_the_insult(msg):
    reply = _routed(msg).answer.lower()
    for word in ("trash", "stupid", "fuck", "idiot"):
        assert word not in reply, reply


def test_the_first_frustration_reply_apologises_once():
    reply = _routed("stupid bot").answer
    assert reply.startswith("Sorry that wasn't helpful.")
    assert reply.count("Sorry") == 1


@pytest.mark.parametrize("support", [True, False])
@pytest.mark.parametrize("msg", ["stupid bot", "you are useless", "bakwas bot hai yaar", "shut up", "fuck you"])
def test_a_repeat_gets_new_wording_and_no_second_apology(msg, support):
    routed = _routed(msg, support_enabled=support)
    first = routed.answer_after("Nice to meet you, Eva! What would you like to know?")
    assert first == routed.answer
    again = routed.answer_after("Thanks, Eva. " + first)
    assert again != first
    assert "sorry" not in again.lower()
    assert bot_offers_handoff(again) is support, again
    assert not any(dash in again for dash in _DASHES)


def test_a_reaction_after_the_dissatisfied_apology_does_not_apologise_again():
    routed = _routed("forget it, useless")
    previous = "Sorry about that. I haven't been able to help with that here, but our team can."
    assert "sorry" not in routed.answer_after(previous).lower()


@pytest.mark.parametrize(
    "previous",
    [None, "", "Acme builds widgets.", "Hey. Happy to help. Want to hear about our services?"],
)
def test_ordinary_replies_are_not_reactions(previous):
    assert follows_a_reaction_reply(previous) is False


def test_routes_without_a_repeat_wording_answer_the_same_every_time():
    routed = _routed("how are you?")
    assert routed.repeat_answer is None
    assert routed.answer_after("Sorry that wasn't helpful.") == routed.answer


@pytest.mark.parametrize("msg", ["stupid bot", "shut up"])
def test_reaction_replies_read_naturally_with_no_company_name(msg):
    routed = route_intent(msg, None)
    for reply in (routed.answer, routed.answer_after(routed.answer)):
        assert "**" not in reply
        assert " us " not in f" {reply} " and "us." not in reply, reply


# ─────────────────────────────────────────────────────────────────────────────
# Sarcastic praise is never thanked
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "msg",
    [
        "great \U0001f644",
        "cool \U0001f612",
        "perfect \U0001f644\U0001f644",
        "great bot \U0001f644",
        "this was helpful \U0001f644",
        "thanks \U0001f644",
        "wow nice \U0001f44e",
    ],
)
def test_praise_with_an_annoyed_face_is_left_to_the_dissatisfaction_check(msg):
    assert route_intent(msg, COMPANY) is None, msg


@pytest.mark.parametrize("msg", ["great \U0001f60a", "great bot", "thanks!", "cool \U0001f44d"])
def test_plain_praise_is_still_thanked(msg):
    assert _routed(msg).intent in {"ack", "compliment"}


# ─────────────────────────────────────────────────────────────────────────────
# Distress: self-harm and medical emergencies
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "msg",
    [
        "i want to die",
        "I just want to die",
        "i wanna die",
        "i feel like killing myself",
        "im going to kill myself",
        "I\u2019m thinking about ending my life",
        "i want to end it all",
        "i dont want to live anymore",
        "i don't want to be alive",
        "i'm suicidal",
        "thinking about suicide",
        "i've been hurting myself",
        "everyone would be better off without me",
        "i took too many sleeping pills",
        "i have taken a whole strip of sleeping tablets",
        "i just swallowed 30 tablets",
        "i took sleeping tablets and feel strange",
        "i overdosed",
        "i've overdosed on my meds",
        "i\u2019ve taken too many pills",
        "ive swallowed a bunch of painkillers",
        "i have chest pain right now",
        "having severe chest pains, what do i do",
        "my chest hurts and my arm is numb",
        "i cant breathe",
        "i think i'm having a heart attack",
        "after the breach i lost everything and i want to die, can your team help",
    ],
)
def test_distress_gets_the_care_reply(msg):
    assert _routed(msg).intent == "crisis", msg


@pytest.mark.parametrize(
    "msg",
    [
        "how do i kill the process",
        "kill the stuck process on port 8080",
        "there is a dead link on your pricing page",
        "this price is killing me",
        "the deadline is killing us",
        "i'm dying to try this",
        "my server died last night",
        "does the kill switch work offline",
        "does the plan cover chest pain",
        "do you treat heart attack patients",
        "is there a suicide prevention module",
        "what happens when a license reaches end of life",
        "our pentest will kill the legacy app",
        "i took 2 tablets of vitamin c, do you sell more",
        "how do we end it with the old vendor",
        "i want to die hard with this framework",
        "i'm going to die of boredom reading this",
        "if this migration fails i'm going to die",
        "how do i end my life insurance policy",
        "i've taken the pricing sheet, what next",
    ],
)
def test_product_words_are_not_distress(msg):
    routed = route_intent(msg, COMPANY)
    assert routed is None or routed.intent not in {"crisis", "medical_advice"}, msg


def test_the_care_reply_points_to_emergency_help_and_not_to_sales():
    routed = _routed("i want to die", support_enabled=True)
    for reply in (routed.answer, routed.answer_after(routed.answer)):
        assert "local emergency number" in reply
        assert "crisis" in reply
        assert not re.search(r"\d", reply), "never invent a phone number"
        assert "Acme" not in reply
        assert not bot_offers_handoff(reply), reply
        assert "services" not in reply and "pricing" not in reply
        assert not any(dash in reply for dash in _DASHES)
    assert routed.answer_after(routed.answer) != routed.answer


def test_distress_wins_over_the_identity_and_business_guards():
    assert _routed("are you a bot? i want to die").intent == "crisis"
    assert _routed("what services do you offer, i want to kill myself").intent == "crisis"


# Review 2026-09-17 (finding 6): questions a healthcare or retail bot exists to
# answer got the crisis reply.
@pytest.mark.parametrize(
    "msg",
    [
        "I can't breathe through my nose, do you do septoplasty?",
        "i cant breath in this mask, do you sell N95?",
        "i can't breathe with my old inhaler, do you stock the new one",
        "I'm having a stroke of luck",
        "I have chest pain after running, should I book a cardiology consult?",
        "i have chest pains when i climb stairs, can i book an appointment",
    ],
)
def test_service_questions_with_body_words_are_not_the_crisis_reply(msg):
    routed = route_intent(msg, COMPANY)
    assert routed is None or routed.intent != "crisis", msg
    assert crisis_reply(msg) is None, msg


@pytest.mark.parametrize(
    "msg",
    [
        "I have chest pain after running, should I book a cardiology consult?",
        "i have chest pains when i climb stairs, can i book an appointment",
        "my chest hurts after coughing, do you offer a check-up",
    ],
)
def test_chest_pain_with_a_booking_question_keeps_a_short_emergency_line(msg):
    note = care_note(msg)
    assert note == CARE_NOTE
    assert "local emergency number" in note
    assert "can't help" not in note
    assert not re.search(r"\d", note), "never invent a phone number"
    assert not any(dash in note for dash in _DASHES)
    assert not follows_a_reaction_reply(note)


@pytest.mark.parametrize(
    "msg",
    [
        "i have chest pain right now",
        "I'm having crushing chest pain, can I book an appointment",
        "my chest hurts and my arm is numb, do you do ecgs",
        "i have severe chest pains, should i book a consult",
        "I'm having a stroke, can i book an appointment",
        "i cant breathe",
        "i want to die, can i book a consult",
    ],
)
def test_acute_distress_keeps_the_crisis_reply_even_with_a_booking_question(msg):
    assert crisis_reply(msg) is not None, msg
    assert _routed(msg).intent == "crisis", msg
    assert care_note(msg) == "", msg


@pytest.mark.parametrize(
    "msg",
    ["what are your opening hours", "i want to die", "I can't breathe through my nose, do you do septoplasty?", ""],
)
def test_no_emergency_line_without_chest_pain_and_a_booking_question(msg):
    assert care_note(msg) == ""


def test_the_early_crisis_reply_is_the_routers_reply():
    early = crisis_reply("my name is Sam, i want to kill myself")
    routed = _routed("my name is Sam, i want to kill myself")
    assert early == routed
    assert early.intent == "crisis"


# ─────────────────────────────────────────────────────────────────────────────
# Requests for medical advice
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "msg",
    [
        "cant sleep because of work stress after the breach, which tablets should i take",
        "what medicine should i take for my anxiety",
        "how many sleeping pills can i take",
        "which pills should I take to sleep",
        "what should i take for my headache",
        "can you recommend a sleeping pill",
    ],
)
def test_requests_for_medication_get_the_doctor_reply(msg):
    assert _routed(msg).intent == "medical_advice", msg


@pytest.mark.parametrize(
    "msg",
    [
        "which plan should i take",
        "what course should i take first",
        "do you sell sleeping pills",
        "which tablets do you support for the kiosk app",
        "what should i take to the site visit",
    ],
)
def test_other_questions_are_not_medical_advice(msg):
    routed = route_intent(msg, COMPANY)
    assert routed is None or routed.intent != "medical_advice", msg


@pytest.mark.parametrize(
    "msg",
    [
        "how many tablets should I take of your ashwagandha",
        "how many capsules should i take of ur multivitamin",
        "how many Acme tablets should i take",
    ],
)
def test_a_dosage_question_about_the_business_product_reaches_retrieval(msg):
    routed = route_intent(msg, COMPANY)
    assert routed is None or routed.intent not in {"crisis", "medical_advice"}, msg


def test_a_dosage_question_naming_another_brand_still_gets_the_doctor_reply():
    assert _routed("how many crocin tablets should i take").intent == "medical_advice"


def test_the_doctor_reply_shows_care_and_names_no_medicine():
    routed = _routed("cant sleep because of work stress after the breach, which tablets should i take")
    for reply in (routed.answer, routed.answer_after(routed.answer)):
        assert "doctor" in reply
        assert "medical advice" in reply or "medicines" in reply
        assert "**Acme**" in reply
        assert not bot_offers_handoff(reply), reply
        assert not any(dash in reply for dash in _DASHES)
    assert routed.answer.startswith("I'm sorry")
    assert routed.answer_after(routed.answer) != routed.answer


def test_the_doctor_reply_reads_naturally_with_no_company_name():
    reply = route_intent("which tablets should i take", None).answer
    assert "**" not in reply and " us" not in reply


# ─────────────────────────────────────────────────────────────────────────────
# Cost
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "msg",
    [
        "i " * 20000,
        "i want to " * 3000,
        "i took " * 3000 + "x",
        "my chest " * 3000,
        "which " * 5000,
        "ugh, " * 5000 + "useless",
        "this bot is " * 2000,
        "\U0001f644" * 20000,
    ],
)
def test_long_inputs_stay_fast(msg):
    started = time.perf_counter()
    route_intent(msg, COMPANY)
    follows_a_reaction_reply(msg)
    assert time.perf_counter() - started < 0.5


@pytest.mark.parametrize(
    ("msg", "expected"),
    [
        ("this is useless, you never answer anything", True),
        ("shut up", True),
        ("our account manager isnt responding for 3 days", False),
        ("nobody from your team answered my emails", False),
        ("what services do you offer?", False),
    ],
)
def test_a_verdict_on_the_chat_is_told_apart_from_a_customer_left_unanswered(msg, expected):
    assert is_verdict_on_the_chat(msg) is expected
