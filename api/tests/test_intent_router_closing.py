"""A visitor closing the chat, or greeting it again, is not off topic.

Evaluation 2026-09-17, both production security bots: "thanks thats all for
now" got the scope refusal ("I stick to topics about CleanStart. Are you
exploring our services..."), which re-opens a conversation the visitor just
closed. "hello again" at the start of a returning visit got "Welcome back, Eva!"
followed by the same refusal. The router answers both before the relevance gate
can refuse them: a closing gets one short warm line with no question, and a
greeting said "again" is a greeting.
"""

import time

import pytest

from app.services.intent_router import route_intent

COMPANY = "CleanStart"
_DASHES = ("—", "–")


@pytest.mark.parametrize(
    "msg",
    [
        "thanks thats all for now",
        "Thanks, that's all for now!",
        "thats all",
        "that's all for today, thank you",
        "ok bye thanks",
        "no thats it thank you",
        "nope, that's it. thanks",
        "bye",
        "goodbye!",
        "ok thanks bye",
        "thank you so much, that's everything",
        "im done thanks",
        "i'm all set, thank you",
        "nothing else, thanks",
        "that's all i needed",
        "cool, have a great day",
        "thanks a lot, see you later",
        "great thanks, take care",
        "byeee",
    ],
)
def test_a_closing_gets_the_closing_reply(msg):
    routed = route_intent(msg, COMPANY)
    assert routed is not None, msg
    assert routed.intent == "closing", msg


def test_the_closing_reply_is_one_warm_line_with_no_question():
    answer = route_intent("thanks thats all for now", COMPANY).answer

    assert "?" not in answer
    assert "**CleanStart**" in answer
    assert len(answer.split()) <= 15
    assert not any(dash in answer for dash in _DASHES)
    # No re-opening: no offer, no scope line, no sales route.
    for phrase in ("services", "pricing", "team", "stick to", "here to help with"):
        assert phrase not in answer.lower()


def test_the_closing_reply_reads_well_without_a_company_name():
    answer = route_intent("ok bye", None).answer

    assert "?" not in answer
    assert " us." not in answer and "**" not in answer


@pytest.mark.parametrize(
    "msg",
    [
        "thanks, what does the soc plan cost?",
        "thanks thats all for now, but what does the soc plan cost",
        "that's it?",
        "that's it?!",
        "thats all?!! ",
        "that's it ?!.",
        "is that all?",
        "thats all the services you offer?",
        "that's all you do",
        "i'm done with my current vendor, what do you offer",
        "thanks for the info, can you book a demo",
        "bye the way do you do audits",
        "good day to call you?",
        "is it all set up for fintech",
        "have a great day planned for the launch?",
    ],
)
def test_a_real_question_is_not_a_closing(msg):
    routed = route_intent(msg, COMPANY)
    assert routed is None or routed.intent != "closing", msg


def test_a_bare_thanks_is_still_the_ack():
    assert route_intent("thanks", COMPANY).intent == "ack"


@pytest.mark.parametrize(
    "msg",
    ["hello again", "hi again!", "hey there again", "hiii again", "Hello once again", "i'm back", "im back"],
)
def test_a_greeting_said_again_is_a_greeting(msg):
    routed = route_intent(msg, COMPANY)
    assert routed is not None, msg
    assert routed.intent == "greeting", msg


@pytest.mark.parametrize(
    "msg",
    ["hello again, what's your pricing", "again", "hello again and again and again what now", "i'm back pain"],
)
def test_a_question_after_a_greeting_again_is_not_a_greeting(msg):
    routed = route_intent(msg, COMPANY)
    assert routed is None or routed.intent != "greeting", msg


@pytest.mark.parametrize(
    "msg",
    [
        "thanks " * 5000,
        "ok " * 5000 + "bye",
        "no, " * 5000 + "thats it",
        "thanks thats all " * 1200,
        "bye " * 5000 + "?",
        "hello " + "again " * 5000,
        "that's all for now" + "!" * 20000 + "x",
    ],
)
def test_closing_and_greeting_stay_linear_on_long_input(msg):
    started = time.perf_counter()
    route_intent(msg, COMPANY)
    assert time.perf_counter() - started < 0.5
