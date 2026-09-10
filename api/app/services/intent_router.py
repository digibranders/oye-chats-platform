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
    # typos: "re you a human", "r u a bot", "are u human"
    r"|(?:r|re|ar|are)\s+(?:you|u|yu)\s+(?:an?\s+)?(?:ai|bot|robot|chatbot|human|real\s+(?:person|human))"
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

# A message that ALSO asks about the business is a knowledge question wearing
# an identity opener. Live: "who are you and what do you offer" was answered by
# the canned greeting with no content at all, because the identity patterns
# match on the opening words and short-circuit before retrieval. The canned
# identity replies are only right when the whole message is about the bot
# itself. Deliberately narrow: these words almost never appear in a genuine
# "are you a bot" and always do in a question the knowledge base should answer.
_ASKS_ABOUT_BUSINESS_RE = re.compile(
    r"(?ix)\b(?:"
    r"offer|offers|offering|provide|provides|sell|sells"
    r"|services?|products?|pricing|prices?|cost|costs|plans?"
    r"|what\s+do\s+you\s+do|what\s+does\s+(?:the\s+)?company|about\s+(?:the\s+)?company"
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

# Small talk / social reflexes the knowledge base can never answer. Whole-message
# matches only, so a real question that happens to contain one of these words
# still reaches retrieval ("how are your SOC services priced" is not a greeting).
_HOW_ARE_YOU_RE = re.compile(
    r"^(?:(?:hi|hey|hello)\s+)?(?:how\s+(?:are|r)\s+(?:you|u)(?:\s+doing)?(?:\s+today)?"
    r"|how'?s\s+it\s+going|how\s+do\s+you\s+do)$"
)
_COMPLIMENT_RE = re.compile(
    r"^(?:you(?:'re|\s+are)\s+(?:a\s+)?(?:good|great|nice|helpful|smart|awesome|amazing|cool)"
    r"(?:\s+(?:bot|assistant|chatbot))?"
    r"|(?:good|great|nice)\s+(?:bot|job|work)"
    r"|(?:this|that)\s+(?:is|was)\s+(?:helpful|great|awesome|useful))$"
)
_FRUSTRATION_RE = re.compile(
    r"^(?:non\s?sense|useless|not\s+helpful|wtf"
    r"|you(?:'re|\s+are)\s+(?:useless|stupid|dumb|wrong|not\s+helpful|no\s+help)"
    r"|this\s+is\s+(?:useless|stupid|nonsense|not\s+helpful))$"
)
# Directed abuse, whole message only. An unanchored word search would swallow
# real questions that merely contain a swear word ("what the fuck is your
# pricing"), so every branch below matches the full normalised message, not a
# substring. Linear: no nested unbounded quantifiers, just bounded repeats.
_ABUSE_RE = re.compile(
    r"^(?:"
    r"f\*+\s*(?:off|you|u)?"
    r"|f+u+c+k+\s*(?:off|you|u|this(?:\s+bot)?)?"
    r"|f\s*u"
    r"|screw\s+you"
    r"|shut\s+up"
    r"|go\s+to\s+hell"
    r"|you(?:'re|\s+are)\s+an?\s+idiot"
    r"|idiot\s+bot"
    r"|this\s+bot\s+is\s+shit"
    r"|shit\s+bot"
    r"|asshole"
    r"|bitch"
    r"|bastard"
    r")$"
)
# Gibberish / too-short-to-mean-anything. A lone letter, a run of 6+ consonants
# with no vowel, or a keyboard-mash substring (adjacent-key runs).
_UNCLEAR_RE = re.compile(
    r"^(?:[a-z]|[b-df-hj-np-tv-z]{6,}"
    r"|[a-z]*(?:asdf|sdfg|dfgh|fghj|ghjk|hjkl|qwer|wert|erty|rtyu|tyui|yuio|uiop|zxcv)[a-z]*)$"
)
_NAME_RECALL_RE = re.compile(
    r"^(?:what(?:'s|\s+is)\s+my\s+name|do\s+you\s+(?:know|remember)\s+my\s+name|who\s+am\s+i)$"
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
        | recorded | remember | how_are_you | compliment | frustration | abuse
        | unclear | name_recall). Used for logs/metrics, not shown to visitor.
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
    visitor_name: str | None = None,
) -> IntentResponse | None:
    """Match ``question`` against deterministic intent rules.

    Returns an ``IntentResponse`` when a rule matches, or ``None`` to signal
    "no match. Proceed with the normal RAG pipeline".

    ``company_name`` is the brand name to use in responses; ``None`` falls
    back to a neutral phrasing. ``support_enabled`` is whether the bot's plan
    offers a human path (live chat or offline message): the identity replies
    only offer to connect the visitor when it does. ``platform_branded`` is
    False for a workspace that bought branding removal, whose canned replies
    must not name the platform. ``visitor_name`` is the visitor's known name,
    if any; it is used only by the name-recall route ("what's my name?").
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

    # 2) Identity / meta. Match before the length gate so longer phrasings work,
    #    unless the message also asks about the business: then it is a knowledge
    #    question with an identity opener and belongs to the RAG pipeline.
    # Privacy and retention first, and NOT behind the business-word guard. The
    # knowledge base has no chunk saying whether the chat is recorded, so
    # falling through to retrieval on "is this chat recorded and does it cost
    # anything" answers neither half: the visitor asked a question only the
    # platform can answer, and gets a pivot.
    if _RECORDED_RE.search(norm):
        return _recorded(company_name, support_enabled)
    if _REMEMBER_RE.search(norm):
        return _remember(company_name)

    # The rest of the identity family stands down when the message also asks
    # about the business, because there retrieval has the better answer.
    if not _ASKS_ABOUT_BUSINESS_RE.search(norm):
        if _IS_AI_RE.search(norm):
            return _is_ai(company_name, support_enabled)
        if _WHO_MADE_YOU_RE.search(norm):
            return _who_made_you(company_name, platform_branded)
        if _BOT_NAME_RE.search(norm):
            return _bot_name(company_name)

    # 2b) Conversation about the conversation. Whole-message matches only, so a
    #     real question that contains these words still reaches retrieval.
    if (
        word_count == 1
        and _UNCLEAR_RE.match(norm)
        and norm not in _GREETING_TERMS
        and norm not in _ACK_TERMS
        and norm not in _NEG_ACK_TERMS
    ):
        return _unclear(company_name)
    if word_count <= 8:
        if _NAME_RECALL_RE.match(norm):
            return _name_recall(company_name, visitor_name)
        if _HOW_ARE_YOU_RE.match(norm):
            return _how_are_you(company_name)
        if _COMPLIMENT_RE.match(norm):
            return _compliment(company_name)
        if _FRUSTRATION_RE.match(norm):
            return _frustration(company_name, support_enabled)
        if _ABUSE_RE.match(norm):
            return _abuse(company_name)

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


def _how_are_you(company_name: str | None) -> IntentResponse:
    return IntentResponse(
        answer=f"Doing well, thanks for asking. What can I help you with at {_co(company_name)}?",
        intent="how_are_you",
    )


def _compliment(company_name: str | None) -> IntentResponse:
    return IntentResponse(
        answer=f"Thank you, that's kind. Anything else I can help with at {_co(company_name)}?",
        intent="compliment",
    )


def _frustration(company_name: str | None, support_enabled: bool = True) -> IntentResponse:
    # The human-handoff offer is a plan entitlement, not a platform fact: a bot
    # with no live-chat or offline-message path must not dangle one.
    offer = " or I can connect you with the team" if support_enabled else ""
    return IntentResponse(
        answer=f"Sorry that wasn't helpful. Tell me what you're looking for and I'll try again{offer}.",
        intent="frustration",
    )


def _abuse(company_name: str | None) -> IntentResponse:
    return IntentResponse(
        answer=f"I'm here to help with anything about {_co(company_name)} whenever you're ready.",
        intent="abuse",
    )


def _unclear(company_name: str | None) -> IntentResponse:
    return IntentResponse(
        answer=(
            f"Could you say a bit more about what you're looking for? "
            f"I can help with {_co(company_name)}'s services, pricing or getting in touch."
        ),
        intent="unclear",
    )


def _name_recall(company_name: str | None, visitor_name: str | None) -> IntentResponse:
    name = " ".join(str(visitor_name).split())[:40] if visitor_name else ""
    if name:
        answer = f"You're {name}. What can I help you with at {_co(company_name)}?"
    else:
        answer = "I don't know your name yet. You can tell me anytime."
    return IntentResponse(answer=answer, intent="name_recall")
