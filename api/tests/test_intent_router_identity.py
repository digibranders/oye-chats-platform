"""Identity, name recall and Hinglish frustration turns the router must answer.

Production, 2026-09-11:
- "is this chatgpt?" went to retrieval and got "That specific detail sits with
  the team", because the is-AI route only knew "are you ...".
- "so what name do u have for me now" got an off-topic refusal: the recall
  route matched three exact phrasings and sat behind an eight-word gate.
- "bakwas bot hai yaar" ("this bot is rubbish") missed the frustration route,
  so an English-only bot answered in Hinglish ("Samjha.") and another refused
  it as off-topic.
"""

import time

import pytest

from app.services.intent_router import route_intent

COMPANY = "Acme"


@pytest.mark.parametrize(
    "msg",
    [
        "r u a bot or real",
        "u a bot?",
        "you a bot",
        "are u real",
        "are you real?",
        "r u real",
        "r u human",
        "are yu a bot",
        "r u a robot",
        "are youuu a bottt",
        "ur a bot",
        "you're a bot",
        "are you chatgpt",
        "is this chatgpt?",
        "is this chat gpt",
        "is this gpt",
        "is this openai",
        "is this an ai",
        "is this ai?",
        "is it a bot",
        "is this a real person",
        "is this a bot or a human",
        "is this automated",
        "is this automated?",
        "am i talking to a human",
        "am i talking to a bot",
        "am i talking to a real person",
        "am i chatting with a real human",
        "am i speaking to a person",
        "real person or bot",
        "human or bot",
        "bot or human?",
        "ai or human",
        "hello? are you a real person",
        "you are a bot",
        "you are a bot?",
        "u r a bot",
        "are you a real human being",
        "am i talking to ai",
        "is this an automated chat",
        "is this a person or a bot",
        "are you human or ai",
        "are you automated",
        "is that a bot",
        "is that a real person replying",
    ],
)
def test_identity_questions_route_to_is_ai(msg):
    routed = route_intent(msg, COMPANY)
    assert routed is not None, msg
    assert routed.intent == "is_ai", msg


@pytest.mark.parametrize(
    "msg",
    [
        "are you real estate agents",
        "is this real estate listing still available",
        "is this real leather",
        "are you really open on sundays",
        "is this ai powered",
        "is this AI-powered?",
        "is this gpt based",
        "is this chatgpt integration available",
        "is this automated backup included",
        "do you do ai or human translation",
        "is it an ai tool",
        "i want to talk to a real person",
        "can i speak to a human",
        "is anyone there",
        "are you a bot? what services do you provide",
        "is this a live chat",
        "is this a real company",
        "are you open",
        # A business noun after the bot or human noun names a trade, not the bot.
        "is this human hair",
        "are you a computer repair shop",
        "r u a machine shop",
        "are you a robot store",
        "are you a machine dealer",
        "are you a human hair salon",
        "are you a computer clinic",
        "are you a person or company",
        "are you a real person or a business",
        # "is that" about a photo, an image or a video asks about the picture.
        "is that a real person in the photo",
        "is that a real person in this picture",
        "in the video, is that a real person",
        "is that a robot in the image",
    ],
)
def test_questions_about_something_else_are_not_is_ai(msg):
    routed = route_intent(msg, COMPANY)
    assert routed is None or routed.intent != "is_ai", msg


@pytest.mark.parametrize(
    "msg", ["who am i talking to", "who am i chatting with?", "who am i speaking to", "what are you", "what are u?"]
)
def test_asking_who_is_on_the_other_end_routes_to_bot_name(msg):
    routed = route_intent(msg, COMPANY)
    assert routed is not None, msg
    assert routed.intent == "bot_name", msg


@pytest.mark.parametrize(
    "msg", ["what are you offering this month", "what are your hours", "what are you doing about my order"]
)
def test_a_question_that_starts_with_what_are_you_is_not_bot_name(msg):
    routed = route_intent(msg, COMPANY)
    assert routed is None or routed.intent != "bot_name", msg


@pytest.mark.parametrize(
    "msg",
    [
        "what name do u have for me",
        "so what name do u have for me now",
        "what name do you have for me?",
        "what's my name now",
        "whats my name",
        "what is my name?",
        "do you know my name",
        "do u know my name",
        "do you remember my name",
        "what did i say my name was",
        "what did i tell you my name was",
        "what name did i give you",
        "who am i",
        "remember my name?",
        "tell me my name",
        "what do you call me",
    ],
)
def test_name_recall_phrasings_route_to_name_recall(msg):
    routed = route_intent(msg, COMPANY, visitor_name="Priya")
    assert routed is not None, msg
    assert routed.intent == "name_recall", msg
    assert "You're Priya." in routed.answer


@pytest.mark.parametrize(
    "msg",
    [
        "what name should i use for the invoice",
        "whats my name on the account",
        "do you know my name is on the contract",
        "what's my plan",
    ],
)
def test_other_questions_about_names_are_not_recall(msg):
    routed = route_intent(msg, COMPANY, visitor_name="Priya")
    assert routed is None or routed.intent != "name_recall", msg


@pytest.mark.parametrize(
    "msg",
    [
        "bakwas bot hai yaar",
        "bakwas",
        "bakwaas",
        "bakwas hai yaar",
        "kya bakwas hai",
        "ye bot bakwas hai",
        "bekaar",
        "bekar bot",
        "bilkul bekaar hai",
        "faltu",
        "faltu bot hai",
        "ghatiya",
        "ghatiya service",
        "bakwas band karo",
        "bakwas mat karo",
    ],
)
def test_hinglish_frustration_routes_to_frustration_in_english(msg):
    routed = route_intent(msg, "CleanStart")
    assert routed is not None, msg
    assert routed.intent == "frustration", msg
    assert routed.answer.startswith("Sorry that wasn't helpful."), routed.answer


@pytest.mark.parametrize(
    "msg",
    [
        "faltu charges kyu lagaye",
        "bekar hai kya ye plan",
        "what does ghatiya mean",
        "bakwas se kaise bache",
    ],
)
def test_hinglish_questions_that_use_those_words_are_not_frustration(msg):
    routed = route_intent(msg, COMPANY)
    assert routed is None or routed.intent != "frustration", msg


@pytest.mark.parametrize(
    "msg",
    [
        "actually" + " " * 20000 + "x",
        "fix" + "!" * 20000 + "x",
        "r u " * 5000,
        "is this " * 2500,
        "bakwas " * 3000,
        "what name do u have for me " * 800,
        "am i talking to a " * 1200,
        "human or " * 2500,
        "is that a real person " * 900 + "photo",
        "are you a person or " * 1000,
    ],
)
def test_routing_stays_linear_on_long_input(msg):
    started = time.perf_counter()
    route_intent(msg, COMPANY)
    assert time.perf_counter() - started < 0.5
