"""Deterministic intent router. Short-circuits the RAG pipeline for trivially
classifiable visitor messages so they never hit the relevance gate (which
otherwise misclassifies them as off-topic and returns the boilerplate refusal).

Three intent categories handled here:

1. **Greeting / acknowledgment**. "hi", "hello", "hey", "good morning",
   "thanks", "ok cool", lone emoji. The relevance gate sees these as
   off-topic because no chunk in the knowledge base matches "hi"; visitors
   were getting "I'm here to help with questions about <company>" as the
   first message of the conversation, which feels broken.

2. **Identity / meta**. "are you AI", "what's your name", "who made you",
   "is this conversation recorded". These are reasonable visitor questions
   but never on-topic for any company knowledge base, so they always
   short-circuit unless we handle them explicitly.

3. **Negative acknowledgement**. "no", "nope", "not really". These also
   trip the gate but are conversational glue, not off-topic refusals.

Returns ``IntentResponse`` (answer + flags) when a route matches, or ``None``
to signal "fall through to the normal RAG pipeline".

Design rules:
- Pure regex / keyword matching, no LLM call, sub-millisecond cost.
- Rules are ordered most-specific to most-generic so e.g. "thanks for the help
  but who is the CEO" never trips the bare-thanks rule (it's > 4 words).
- Routes return company-aware copy; ``company_name`` is the visible brand
  string the bot represents.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

# ─────────────────────────────────────────────────────────────────────────────
# Patterns
# ─────────────────────────────────────────────────────────────────────────────

# Words/phrases that, by themselves or with light decoration, are pure
# greetings. Match must be the whole message (after trimming punctuation).
_GREETING_TERMS = {
    "hi",
    "hii",
    "hiii",
    "hello",
    "helloo",
    "hey",
    "heyy",
    "hey there",
    "hi there",
    "hello there",
    "yo",
    "sup",
    "whats up",
    "what's up",
    "good morning",
    "good afternoon",
    "good evening",
    "morning",
    "evening",
    "namaste",
    "hola",
    "howdy",
    "greetings",
    "gm",
    "ge",
}

# Acknowledgements / closers. Short, non-question, no information request.
_ACK_TERMS = {
    "thanks",
    "thank you",
    "thanks!",
    "ty",
    "tysm",
    "thx",
    "thank u",
    "ok",
    "okay",
    "ok cool",
    "cool",
    "got it",
    "great",
    "nice",
    "awesome",
    "perfect",
    "alright",
    "sure",
    "sounds good",
    "fine",
    "k",
    "kk",
}

# Negative ack. Visitor declining a previous offer.
_NEG_ACK_TERMS = {
    "no",
    "nope",
    "not really",
    "no thanks",
    "no thank you",
    "nah",
    "not now",
    "maybe later",
}

# Lone emoji or single punctuation.
_EMOJI_OR_PUNCT_RE = re.compile(r"^[\W_]+$", re.UNICODE)

# Identity / meta. Patterns that ask about the bot itself, not the company.
_IS_AI_RE = re.compile(
    r"(?ix)\b(?:"
    r"are\s+you\s+(?:an?\s+)?(ai|bot|robot|chatbot|machine|computer|human|real\s+(?:person|human))"
    r"|(?:am|are)\s+i\s+(?:talking\s+to|chatting\s+with)\s+(?:a\s+)?(?:human|person|bot|ai|robot)"
    r"|is\s+this\s+(?:a\s+)?(?:bot|ai|chatbot|human|real)"
    r"|are\s+you\s+(?:a\s+)?(?:real|live)\s+(?:person|human|agent)"
    r")\b"
)

_WHO_MADE_YOU_RE = re.compile(
    r"(?ix)\b(?:"
    r"who\s+(?:made|built|created|developed|owns)\s+you"
    r"|what\s+(?:platform|software|technology|ai\s+model|llm)\s+(?:are\s+you|do\s+you\s+use|powers\s+you)"
    r"|how\s+(?:were|are)\s+you\s+(?:built|made|trained)"
    r")\b"
)

_BOT_NAME_RE = re.compile(
    r"(?ix)\b(?:"
    r"what(?:'s|\s+is)\s+your\s+name"
    r"|who\s+are\s+you"
    r")\b"
)

_RECORDED_RE = re.compile(
    r"(?ix)\b(?:"
    r"is\s+this\s+(?:conversation|chat|call)\s+(?:recorded|saved|stored|logged|monitored)"
    r"|are\s+(?:you|we|my\s+messages|our\s+messages)\s+(?:recording|saving|storing|logging)"
    r"|do\s+you\s+(?:save|record|store|log|keep)\s+(?:this|our|my|the)\s+(?:chat|conversation|messages?)"
    r")\b"
)

_REMEMBER_RE = re.compile(
    r"(?ix)\b(?:"
    r"(?:can|do)\s+you\s+remember\s+(?:our|my|the)\s+(?:last|previous|earlier)\s+(?:conversation|chat|messages?)"
    r"|do\s+you\s+(?:keep|have)\s+(?:any\s+)?memory"
    r")\b"
)

# ─────────────────────────────────────────────────────────────────────────────
# Response shape
# ─────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class IntentResponse:
    """Deterministic short-circuit response.

    Attributes
    ----------
    answer
        The text to return verbatim.
    intent
        Short label (greeting | ack | neg_ack | is_ai | bot_name | who_made_you
        | recorded | remember). Used for logs/metrics, not shown to visitor.
    """

    answer: str
    intent: str


# ─────────────────────────────────────────────────────────────────────────────
# Normaliser
# ─────────────────────────────────────────────────────────────────────────────


def _normalise(text: str) -> str:
    """Lowercase, trim, strip surrounding punctuation, collapse whitespace.

    Conservative: only touches the outer edges. Internal punctuation is kept
    so we don't accidentally normalise "i don't know" to "i dont know" and
    miss real intent matches downstream.
    """
    s = (text or "").strip().lower()
    # Strip leading/trailing punctuation and whitespace (keeps internal "'")
    s = re.sub(r"^[\s\W_]+|[\s\W_]+$", "", s, flags=re.UNICODE)
    s = re.sub(r"\s+", " ", s)
    return s


# ─────────────────────────────────────────────────────────────────────────────
# Public router
# ─────────────────────────────────────────────────────────────────────────────


def route_intent(
    question: str,
    company_name: str | None,
    *,
    support_enabled: bool = True,
    platform_branded: bool = True,
) -> IntentResponse | None:
    """Match ``question`` against deterministic intent rules.

    Returns an ``IntentResponse`` when a rule matches, or ``None`` to signal
    "no match. Proceed with the normal RAG pipeline".

    ``company_name`` is the brand name to use in responses; ``None`` falls
    back to a neutral phrasing. ``support_enabled`` is whether the bot's plan
    offers a human path (live chat or offline message): the identity replies
    only offer to connect the visitor when it does. ``platform_branded`` is
    False for a workspace that bought branding removal, whose canned replies
    must not name the platform.
    """
    if not question or not isinstance(question, str):
        return None

    raw = question.strip()
    norm = _normalise(raw)

    # 1) Lone emoji / punctuation → greeting
    if not norm and _EMOJI_OR_PUNCT_RE.match(raw):
        return _greeting(company_name)

    if not norm:
        return None

    # Word count gate: identity/meta patterns can be longer; greetings/acks
    # must be short or risk swallowing real questions ("thanks for telling me
    # about your services, what about pricing").
    word_count = len(norm.split())

    # 2) Identity / meta. Match before length gate so longer phrasings work
    if _IS_AI_RE.search(norm):
        return _is_ai(company_name, support_enabled)
    if _RECORDED_RE.search(norm):
        return _recorded(company_name, support_enabled)
    if _REMEMBER_RE.search(norm):
        return _remember(company_name)
    if _WHO_MADE_YOU_RE.search(norm):
        return _who_made_you(company_name, platform_branded)
    if _BOT_NAME_RE.search(norm):
        return _bot_name(company_name)

    # 3) Greetings. Only if the WHOLE message is a greeting term
    if word_count <= 4 and norm in _GREETING_TERMS:
        return _greeting(company_name)

    # 4) Acks. Only if WHOLE message is an ack term
    if word_count <= 4 and norm in _ACK_TERMS:
        return _ack(company_name)

    # 5) Negative ack
    if word_count <= 4 and norm in _NEG_ACK_TERMS:
        return _neg_ack(company_name)

    return None


# ─────────────────────────────────────────────────────────────────────────────
# Response builders. Kept short & on-brand.
# ─────────────────────────────────────────────────────────────────────────────


def _co(company_name: str | None) -> str:
    return f"**{company_name}**" if company_name else "us"


# The greeting reply is two parts: a warm lead and a body that offers the next
# step. They are kept separable so a returning visitor's "Welcome back, {name}!"
# opener (prepended in rag_service._maybe_append_name_ask) can drop the lead,
# which would otherwise double the greeting: "Welcome back, Steve! Hey. Happy to
# help." See strip_greeting_lead below.
_GREETING_LEAD = "Hey. Happy to help."


def _greeting(company_name: str | None) -> IntentResponse:
    co = _co(company_name)
    return IntentResponse(
        answer=f"{_GREETING_LEAD} Want to hear about our services, see recent work, or chat with the team at {co}?",
        intent="greeting",
    )


def strip_greeting_lead(text: str) -> str:
    """Return ``text`` without the greeting's warm lead when it opens with it.

    Used when a returning-visitor "Welcome back, {name}!" opener is prepended to
    the canned greeting reply: that opener is itself the greeting, so the lead
    ("Hey. Happy to help.") would double it. A no-op for any text that does not
    start with the lead, so it is safe to call on non-greeting early-return
    replies (e.g. QA-cache hits) too.
    """
    if not text:
        return text
    stripped = text.lstrip()
    if stripped.startswith(_GREETING_LEAD):
        return stripped[len(_GREETING_LEAD) :].lstrip()
    return stripped


def _ack(company_name: str | None) -> IntentResponse:
    co = _co(company_name)
    return IntentResponse(
        answer=f"Glad that helped. Anything else you want to know about {co}?",
        intent="ack",
    )


def _neg_ack(company_name: str | None) -> IntentResponse:
    co = _co(company_name)
    return IntentResponse(
        answer=f"No problem. I'm here whenever you have a question about {co}.",
        intent="neg_ack",
    )


def _is_ai(company_name: str | None, support_enabled: bool = True) -> IntentResponse:
    co = _co(company_name)
    # The human-handoff offer is a plan entitlement, not a platform fact: a
    # bot with no live-chat or offline-message path must not dangle one.
    handoff = " If you'd rather talk to a human on the team, just say so." if support_enabled else ""
    return IntentResponse(
        answer=f"I'm an AI assistant for {co}. Happy to help with services, work, or how we operate.{handoff}",
        intent="is_ai",
    )


def _bot_name(company_name: str | None) -> IntentResponse:
    co = _co(company_name)
    return IntentResponse(
        answer=f"I'm the {co} AI assistant. Here to answer questions about our services, team, and work.",
        intent="bot_name",
    )


def _who_made_you(company_name: str | None, platform_branded: bool = True) -> IntentResponse:
    co = _co(company_name)
    # A workspace that bought branding removal has paid for the platform name
    # not to appear anywhere in its widget; the canned identity reply is part
    # of that widget.
    if platform_branded:
        answer = (
            f"I'm built on the OyeChats platform, customised for {co}. Anything specific you'd like to know about us?"
        )
    else:
        answer = (
            f"I'm the AI assistant for {co}, built for this website. Anything specific you'd like to know about us?"
        )
    return IntentResponse(answer=answer, intent="who_made_you")


def _recorded(company_name: str | None, support_enabled: bool = True) -> IntentResponse:
    co = _co(company_name)
    # Transcripts are stored for every bot (the dashboard's inbox and analytics
    # read them), so "saved" is a platform fact. The offer to connect is not.
    offer = " Want me to connect you with someone directly?" if support_enabled else ""
    return IntentResponse(
        answer=f"Yes. Chats are saved so the {co} team can follow up if needed.{offer}",
        intent="recorded",
    )


def _remember(company_name: str | None) -> IntentResponse:
    co = _co(company_name)
    return IntentResponse(
        answer=(
            f"I keep context within this conversation but don't carry memory across sessions. "
            f"What can I help with on {co} today?"
        ),
        intent="remember",
    )
