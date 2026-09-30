"""Fixed wording for the turn a visitor asks for a person.

The pipeline decides a handoff before generation (``suggest_handoff``), and the
widget opens its "Talk to a human" form from that flag. The words used to be
left to the model. On 2026-09-10 a live bot answered "connect me" with "I'll
open a quick message form for you", copied from the leave-a-message example in
the prompt, above the "Talk to a human" form, then "I'll open the message form
now." when the visitor asked again.

The reply has one job: say what the form below is for and what happens after it.

A repeat acknowledges what the visitor just said before pointing at the form
again. On the 2026-09-28 evaluation "hello?? nobody is replying" and "i need the
escalation matrix now", both after the form was offered, got the same "The form
is just below." on both production bots, with the wait and the request
unacknowledged. ``handoff_waiting_reply`` says sorry for the wait, and
``handoff_reply(..., request=...)`` names the request (``requested_thing`` reads
it from the message).
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from app.core.langfuse_client import contains_secret
from app.services.intent_router import carries_abuse
from app.services.intent_service import detect_handoff_intent_keywords

#: Greetings and fillers a request may open with: "hi, i need", "ok so can you send".
_REQUEST_FILLER = r"(?:(?:hi|hey|hello|ok|okay|so|and|also|but|please|pls|plz|just|now|then|yes|yeah)[\s,.!:;-]+){0,4}"
#: How a visitor asks for a thing: "i need", "can you send me", "we are looking
#: for". Anchored at the start, every piece bounded, so a match costs linear time.
_REQUEST_OPENER_RE = re.compile(
    rf"^{_REQUEST_FILLER}"
    r"(?:(?:i|we)(?:\s+(?:also|just|really|urgently|still|now))?\s+"
    r"(?:need|want|require|would\s+like|(?:am|are)\s+(?:still\s+)?looking\s+for)"
    # "i'd like", "we're looking for", "im looking for": the contraction sits on the subject.
    r"|(?:i|we)'?(?:d\s+like|(?:m|re)\s+(?:still\s+)?looking\s+for)"
    r"|(?:can|could|will|would|pls|please)\s+(?:you|u|someone|somebody|anyone)\s+(?:please\s+|pls\s+)?"
    r"(?:send|share|give|get|provide|forward|email|mail|show)(?:\s+(?:me|us))?"
    r"|(?:send|share|give|provide|forward|email|mail|show)\s+(?:me|us)"
    r"|looking\s+for)"
    r"\s+(?:to\s+(?:get|have|see|receive)\s+)?(?:please\s+|pls\s+)?",
    re.IGNORECASE,
)
#: Words that end a request without naming it: "the escalation matrix now please".
_REQUEST_TAIL = frozenset(
    {"now", "asap", "immediately", "today", "please", "pls", "plz", "urgently", "thanks", "thx", "already", "again",
     "tho", "though"}
)  # fmt: skip
#: A request for a person or the team is a handoff repeat, not a thing to note.
_PERSON_RE = re.compile(
    r"\b(?:human|person|people|someone|somebody|anyone|anybody|agent|reps?|representative|operator|manager|staff"
    r"|team|support|sales|colleague|executive|expert|specialist|advis[eo]r|consultant)\b",
    re.IGNORECASE,
)
#: A word of the request: letters, digits and the punctuation names carry ("SOC 2", "e-mail", "what's").
_REQUEST_WORD_RE = re.compile(r"^[\w'&/-]+$")
_REQUEST_PUNCTUATION = ".,;:!?\"'()[]"
#: How a request the reply can name begins: a plain noun phrase. "your request
#: for to cancel my subscription" is not a sentence, and "help with the login",
#: "it" and "everything" name no thing.
_REQUEST_DETERMINERS = frozenset({"the", "a", "an", "my", "our"})
#: A card, an account or a phone number, however it is spaced: six or more digits.
_LONG_NUMBER_RE = re.compile(r"\d(?:[\s.-]?\d){5,}")
#: Words addressed to the company, or claiming something of it, that would read
#: as the bot's own in its reply: "a free lifetime licence promised by your CEO".
_SECOND_PERSON_OR_PROMISE_RE = re.compile(
    r"\b(?:you|your|yours|u|ur|y'?all|promis\w{0,4}|guarante\w{0,4}|owe[ds]?|owing|entitled|assured|agreed"
    r"|committed|pledged|sworn?|told|said)\b",
    re.IGNORECASE,
)
#: Longer than this and the words are a story, not a thing the reply can name.
_MAX_REQUEST_WORDS = 8
_MAX_REQUEST_CHARS = 60
#: Longer than this is not a one-line request; nothing is read from it.
_MAX_MESSAGE_CHARS = 300


def requested_thing(message: object) -> str | None:
    """What a message asks for, in the visitor's own words, or None.

    "i need the escalation matrix now" names "the escalation matrix", which the
    repeat handoff reply repeats back so the visitor knows it was heard. None
    when the message asks for a person or the team (a handoff repeat says the
    form line instead), opens with no request verb ("escalation matrix?"), or
    names something too long to repeat.

    The words go into the bot's reply and the stored transcript, so nothing
    unsafe is repeated either (review, 2026-09-30: "i need my api key
    sk_live_... reset" put the key back into both, undoing the redaction of the
    visitor's message). None when the message carries a secret, a run of six or
    more digits (a card, an account, a phone number) or abuse, when the request
    is worded at the company or as a promise ("a free lifetime licence promised
    by your CEO"), and when it does not begin as a plain noun phrase ("to cancel
    my subscription", "help with the login"). The plain repeat line is said
    instead. Pure and linear.
    """
    if not isinstance(message, str):
        return None
    text = " ".join(message.split())
    if not text or len(text) > _MAX_MESSAGE_CHARS or detect_handoff_intent_keywords(text):
        return None
    if contains_secret(text) or _LONG_NUMBER_RE.search(text) is not None or carries_abuse(text):
        return None
    opener = _REQUEST_OPENER_RE.match(text)
    if opener is None:
        return None
    words = [stripped for word in text[opener.end() :].split() if (stripped := word.strip(_REQUEST_PUNCTUATION))]
    while words and words[-1].lower() in _REQUEST_TAIL:
        words.pop()
        if words and words[-1].lower() == "right" and len(words) > 1:
            # "right now" goes as one.
            words.pop()
    named = " ".join(words)
    if (
        not words
        or len(words) > _MAX_REQUEST_WORDS
        or len(named) > _MAX_REQUEST_CHARS
        or words[0].lower() not in _REQUEST_DETERMINERS
        or any(_REQUEST_WORD_RE.match(word) is None for word in words)
        or _PERSON_RE.search(named) is not None
        or _SECOND_PERSON_OR_PROMISE_RE.search(named) is not None
    ):
        return None
    return named


def handoff_reply(*, team_available: bool, repeat: bool, request: str | None = None) -> str:
    """The reply shown above the handoff form.

    ``team_available`` is whether anyone can take the chat now (inside business
    hours and someone reachable). It is False in states the visitor cannot tell
    apart: nobody on the dashboard, where ``POST /operators/handoff`` queues the
    visitor and pushes anyone reachable on a phone or another tab; and outside
    business hours or with the queue full, where the widget shows the message
    form and nobody is waiting on the visitor. So the words promise only what is
    true in all of them, that the details go to the team, and never call the
    team offline, away or unavailable.

    ``repeat`` is True when this conversation was already offered the form. The
    widget re-opens it if the visitor closed it, so on a repeat the form is below
    again, and the reply points at it instead of announcing it a second time.

    ``request`` is what this message asks for (see ``requested_thing``), named
    on a repeat so a visitor who asked for something new hears that it was
    noted, not the same form line again. Ignored on a first offer, which the
    form itself answers.
    """
    if repeat:
        line = (
            "The form is just below. Share your details there and I'll connect you with our team."
            if team_available
            else "The form is just below. Share your details there and I'll pass them to our team."
        )
        named = " ".join(request.split()) if isinstance(request, str) else ""
        if named:
            return f"I've added your request for {named} to what the team will see. {line}"
        return line
    if team_available:
        return "Sure. Share your details in the form below and I'll connect you with our team."
    return "Sure. Share your details in the form below and I'll pass them to our team."


def handoff_waiting_reply(*, team_available: bool) -> str:
    """The reply to a visitor chasing a person after the form was offered.

    "hello?? nobody is replying" is a wait, so the reply says so before it points
    at the form again. Nobody has picked the chat up because the team only gets
    the visitor through the form, which is what the form line says.
    """
    return f"Sorry for the wait, nobody has picked this up yet. {handoff_reply(team_available=team_available, repeat=True)}"


@dataclass(frozen=True)
class HandoffOffer:
    """A fixed reply that hands the visitor to the team, and how the widget opens it."""

    text: str
    suggest_handoff: bool
    needs_message_card: bool


def unhelped_offer(*, live_chat_enabled: bool, team_available: bool) -> HandoffOffer:
    """The reply after two turns in a row the bot could not help with.

    On 2026-09-10 a visitor asked a live bot four times to buy the company and
    got a refusal or a model-written brush-off every time, never the team. This
    says plainly that the bot could not help, then offers the channel the plan
    has: the live form when live chat is on, the message card when it is off.
    When nobody can take the chat, the live form's words promise only to pass
    the details to the team, for the reason ``handoff_reply`` gives. Only called
    on a plan that includes human support.
    """
    if not live_chat_enabled:
        return HandoffOffer(
            text="I haven't been able to help with that here. I'll open a quick message form so our team can get back to you.",
            suggest_handoff=False,
            needs_message_card=True,
        )
    if team_available:
        return HandoffOffer(
            text=(
                "I haven't been able to help with that here, but our team can. "
                "Share your details in the form below and I'll connect you with them."
            ),
            suggest_handoff=True,
            needs_message_card=False,
        )
    return HandoffOffer(
        text=(
            "I haven't been able to help with that here, but our team can. "
            "Share your details in the form below and I'll pass them to our team."
        ),
        suggest_handoff=True,
        needs_message_card=False,
    )
