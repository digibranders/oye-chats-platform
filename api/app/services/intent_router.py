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
# Stretched spellings ("hiiiiii", "heyyyy") are matched through
# ``term_spellings``, so a word is listed once plus any double-letter spelling
# visitors type ("hii", "heyy"), which that function leaves alone.
_GREETING_TERMS = {
    "hi",
    "hii",
    "hello",
    "helloo",
    "hey",
    "heyy",
    # Common misspellings and chat spellings.
    "halo",
    "hallo",
    "helo",
    "hlo",
    "hlw",
    "hy",
    "hye",
    "hiya",
    "heya",
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

# Negative ack. Visitor declining a previous offer. "n" means no the same way
# a bare "y" means yes; see rag_service._AFFIRMATIVE_RE and
# intent_service._BARE_AFFIRMATION_RE / _BARE_REFUSAL_RE for the counterpart.
_NEG_ACK_TERMS = {
    "no",
    "n",
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
#
# Visitors ask in chat shorthand ("r u a bot or real", "u a bot?"), by a model's
# name ("is this chatgpt?") and as a choice ("human or bot"). On 2026-09-11 "is
# this chatgpt?" went to retrieval and got "That specific detail sits with the
# team", because the branches only knew "are you ..." and "is this a bot".
#
# Guards that keep a question about something else out:
# - "real" and "automated" count only as the whole predicate, at the end of the
#   message or before "or": "are you real estate agents" and "is this automated
#   backup included" are questions for the knowledge base.
# - A bot, model or human noun followed by a modifier or a business noun names
#   a product or a trade: "is this AI-powered", "is this gpt based", "are you a
#   machine learning firm", "are you a computer repair shop", "is this human
#   hair". So does a business noun after "or": "are you a person or company".
# - "is that ..." in a message that names a photo, an image or a video asks
#   about the picture: "is that a real person in the photo".
# - "human" before "resources", "rights" or "capital" is not a person.
# - "agent" counts only as a "real" or "live" agent: a visitor to an insurance or
#   property business asking "are you an agent" means a licensed one.
# - The "human or bot" choice counts only at the end of the message, so "do you
#   do ai or human translation" reaches retrieval.
# Stretched spellings ("are youuu a bottt") are matched through
# ``term_spellings`` at the call site. Every branch is a sequence of bounded
# pieces with no nested repeats, so a long message costs linear time.
_MODEL_NOUN = r"(?:chat\s?gpt|gpt(?:-?\d[\w.]*)?|open\s?ai)"
_BOT_NOUN = rf"(?:ai|bot|robot|chatbot|machine|computer|{_MODEL_NOUN})"
_HUMAN_NOUN = r"(?:humans?(?!\s+(?:resources?|rights|capital))|person)"
_REAL_HUMAN = rf"(?:real|live|actual)\s+(?:{_HUMAN_NOUN}|people|agents?)"
_WHOLE_PREDICATE = r"(?=\s*$|\s+or\b)"
_NOT_A_MODIFIER = (
    r"(?![\s\-]*(?:powered|based|driven|enabled|generated|integration|integrated|plugin|api|compatible"
    r"|tools?|features?|learning"
    r"|(?:or\s+(?:an?\s+)?)?(?:shops?|stores?|dealers?|dealerships?|repairs?|hair|salons?|clinics?|company|companies"
    r"|firms?|agency|agencies|startups?|business(?:es)?))\b)"
)
_SUSPECTED_IDENTITY = (
    rf"(?:(?:{_BOT_NOUN}|{_HUMAN_NOUN}|{_REAL_HUMAN}){_NOT_A_MODIFIER}|(?:real|automated){_WHOLE_PREDICATE}"
    r"|someone\s+real)"
)
_IS_AI_RE = re.compile(
    r"(?ix)\b(?:"
    # "are you a bot", with the chat spellings "r u", "re you", "ar yu"
    rf"(?:are|r|re|ar)\s+(?:you|u|yu|ya)\s+(?:an?\s+)?{_SUSPECTED_IDENTITY}"
    # "am i talking to a real person"
    rf"|(?:am|are)\s+i\s+(?:talking|chatting|speaking|texting)\s+(?:to|with)\s+(?:an?\s+)?{_SUSPECTED_IDENTITY}"
    # "is this chatgpt", "is it a bot", "is this a real person". The "that" group
    # lets ``_asks_if_ai`` drop the match in a message about a photo or a video.
    rf"|is\s+(?:this|it|(?P<that>that))\s+(?:an?\s+)?"
    rf"(?:bot|robot|chatbot|{_MODEL_NOUN}|{_HUMAN_NOUN}|{_REAL_HUMAN}){_NOT_A_MODIFIER}"
    # "is this ai", "is this real", "is this automated". "this" only: "is it an ai
    # tool" is usually a question about a product.
    rf"|is\s+this\s+(?:an?\s+)?(?:ai{_NOT_A_MODIFIER}"
    rf"|(?:real|automated(?:\s+(?:reply|replies|response|responses|chat|messages?))?){_WHOLE_PREDICATE})"
    # "u a bot", "you're a bot", "you are a bot", "u r a bot", as the whole message
    rf"|^(?:(?:u|you|yu)(?:\s+(?:are|r))?|ur|your|youre|you're)\s+(?:an?\s+)?"
    rf"(?:ai|bot|robot|chatbot|machine|{_MODEL_NOUN}|{_HUMAN_NOUN}|{_REAL_HUMAN}|real){_WHOLE_PREDICATE}"
    # "human or bot", "bot or real", as the end of the message
    rf"|(?:real\s+)?(?:{_HUMAN_NOUN}|people)\s+or\s+(?:an?\s+)?{_BOT_NOUN}(?=\s*$)"
    rf"|{_BOT_NOUN}\s+or\s+(?:an?\s+)?(?:{_HUMAN_NOUN}|people|{_REAL_HUMAN}|real)(?=\s*$)"
    r")\b"
)
#: A picture the visitor is looking at, which an "is that ..." question is about.
_MEDIA_RE = re.compile(
    r"\b(?:photo(?:graph)?s?|pics?|pictures?|images?|videos?|vids?|clips?|footage|screenshots?|selfies?|reels?"
    r"|thumbnails?)\b"
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
    # "who am i talking to" and a bare "what are you", as the whole message only:
    # "what are you offering this month" is a question for the knowledge base.
    r"|^who\s+am\s+i\s+(?:talking|chatting|speaking)\s+(?:to|with)$"
    r"|^what\s+are\s+(?:you|u)$"
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
# Hindi and Hinglish verdicts on the bot, whole message only: "bakwas"
# (nonsense), "bekaar" (useless), "faltu" (worthless), "ghatiya" (lousy). On
# 2026-09-11 "bakwas bot hai yaar" missed the frustration route, so it went to
# generation, and a bot with multilingual off answered in Hinglish ("Samjha.")
# while another refused it as off-topic. The word may only be wrapped in the
# particles a chat verdict carries ("ye bot bakwas hai yaar", "bakwas band
# karo"), so a question that uses it ("faltu charges kyu lagaye", why the extra
# charges) still reaches retrieval. Every repeat is bounded, so matching stays
# linear.
_HINGLISH_FRUSTRATION_RE = re.compile(
    r"^(?:(?:ye|yeh|yah|kya|kitna|bilkul|ekdum|bahut|bohot|total|full)\s+){0,2}"
    r"(?:(?:bot|chatbot|service|jawab|reply|answer)\s+)?"
    r"(?:bakwa+s|bakva+s|beka+r|fa+ltu|ghatiy?a+)"
    r"(?:\s+(?:bot|chatbot|service|jawab|reply|answer|hai|he|h|ho|hain|yaar|yar|bhai|bro|re|chat|cheez"
    r"|band|mat|karo|kar)){0,4}$"
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
# One-word gibberish: a lone letter (not k, n or y, which mean ok, no and yes),
# six or more consonants (y counts as a vowel), or a keyboard run. The caller
# checks the word is ASCII letters only, which also keeps matching linear.
_UNCLEAR_RE = re.compile(
    r"^(?:[a-jlmo-xz]"
    r"|[b-df-hj-np-tv-xz]{6,}"
    r"|[a-z]*(?:asdf|sdfg|dfgh|fghj|ghjk|hjkl|qwer|werty|rtyu|tyui|yuio|uiop|zxcv)[a-z]*)$"
)
# "What name do you have for me?" Whole message only and anchored at both ends,
# so it needs no word-count gate: "so what name do u have for me now" is nine
# words and got an off-topic refusal on 2026-09-11. A question that only mentions
# a name ("what name should i use for the invoice", "whats my name on the
# account") does not match.
_NAME_RECALL_RE = re.compile(
    r"^(?:(?:so|ok|okay|and|then|hey|hmm|wait)\s+)?"
    r"(?:what(?:'s|s|\s+is)\s+my\s+name"
    r"|what\s+name\s+(?:do|did|have)\s+(?:you|u)\s+(?:have|got|get|save|saved|use|know)(?:\s+(?:for|of|on)\s+me)?"
    r"|what\s+name\s+did\s+i\s+give(?:\s+(?:you|u))?"
    r"|what\s+did\s+i\s+(?:say|tell\s+(?:you|u))\s+my\s+name\s+(?:was|is)"
    r"|(?:(?:do|did)\s+)?(?:you|u)\s+(?:know|remember|have|get)\s+my\s+name"
    r"|remember\s+my\s+name"
    r"|(?:tell\s+me|say)\s+my\s+name"
    r"|what\s+(?:do|will|did)\s+(?:you|u)\s+call\s+me"
    r"|who\s+am\s+i)"
    r"(?:\s+(?:now|again|then))?$"
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
    # Strip leading/trailing punctuation and whitespace (keeps internal "'").
    # An index walk, not ``[\s\W_]+$``: searching for that suffix retries at
    # every position of a run of punctuation that does not reach the end, which
    # is quadratic (20k characters of "!" took most of a second). A character
    # is in ``[\s\W_]`` exactly when it is not alphanumeric.
    start, end = 0, len(s)
    while start < end and not s[start].isalnum():
        start += 1
    while end > start and not s[end - 1].isalnum():
        end -= 1
    return re.sub(r"\s+", " ", s[start:end])


# A run of three or more of the same letter: the "iiii" in "hiiii".
_STRETCHED_RUN_RE = re.compile(r"([a-z])\1{2,}")


def term_spellings(norm: str) -> tuple[str, str, str]:
    """``norm`` and its two de-stretched spellings, for the term-set lookups.

    Visitors stretch short replies ("hiiiiiiiiii", "okkkk", "nooo") and the
    term sets cannot list every length. Each run of three or more of the same
    letter is collapsed to two letters in one spelling and to one in the other,
    because the word underneath may have either ("helloo" keeps a double "o",
    "no" has a single one). A run of exactly two is left alone, so "gee" never
    becomes "ge", the "good evening" abbreviation.

    Both spellings collapse every run the same way, so a message that stretches
    a double letter and a single letter at once ("gooood morninggg") matches
    only when one of the two results is a term. Two fixed spellings, rather
    than one per combination of runs, keep the cost linear in the message.
    """
    return (
        norm,
        _STRETCHED_RUN_RE.sub(r"\1\1", norm),
        _STRETCHED_RUN_RE.sub(r"\1", norm),
    )


def _asks_if_ai(norm: str) -> bool:
    """Whether ``norm``, in any of its ``term_spellings``, asks if the visitor is talking to a bot.

    An "is that ..." match does not count in a message that names a photo, an
    image or a video: "is that a real person in the photo" asks about the
    picture. Linear: each spelling is scanned once.
    """
    names_media = _MEDIA_RE.search(norm) is not None
    for spelling in term_spellings(norm):
        for match in _IS_AI_RE.finditer(spelling):
            if not (names_media and match.group("that")):
                return True
    return False


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
        if _asks_if_ai(norm):
            return _is_ai(company_name, support_enabled)
        if _WHO_MADE_YOU_RE.search(norm):
            return _who_made_you(company_name, platform_branded)
        if _BOT_NAME_RE.search(norm):
            return _bot_name(company_name)

    # 3) Greetings, acks and negative acks. Only if the WHOLE message is a
    #    term, allowing for stretched letters (see ``term_spellings``). Matched
    #    ahead of the gibberish check below: a stretched "k", "thx", "gm" or "n"
    #    is six or more consonants, which that check would read as unclear.
    if word_count <= 4:
        spellings = term_spellings(norm)
        if any(spelling in _GREETING_TERMS for spelling in spellings):
            return _greeting(company_name)
        if any(spelling in _ACK_TERMS for spelling in spellings):
            return _ack(company_name)
        if any(spelling in _NEG_ACK_TERMS for spelling in spellings):
            return _neg_ack(company_name)

    # 4) One-word gibberish. The ASCII-letters-only guard keeps matching
    #    linear for a long adversarial input. The term sets are matched above,
    #    so this check does not need to exclude them.
    if word_count == 1 and norm.isascii() and norm.isalpha() and _UNCLEAR_RE.match(norm):
        return _unclear(company_name, support_enabled)

    # 5) Small talk and social reflexes, whole message only. Name recall sits
    #    outside the word gate because its pattern is anchored at both ends.
    if _NAME_RECALL_RE.match(norm):
        return _name_recall(company_name, visitor_name)
    if word_count <= 8:
        if _HOW_ARE_YOU_RE.match(norm):
            return _how_are_you(company_name)
        if _COMPLIMENT_RE.match(norm):
            return _compliment(company_name)
        if _FRUSTRATION_RE.match(norm) or _HINGLISH_FRUSTRATION_RE.match(norm):
            return _frustration(company_name, support_enabled)
        if _ABUSE_RE.match(norm):
            return _abuse(company_name)

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
    # No company name reads oddly as "at us", so this route gets its own
    # neutral close instead of routing the None case through ``_co``.
    if company_name:
        answer = f"Doing well, thanks for asking. What can I help you with at {_co(company_name)}?"
    else:
        answer = "Doing well, thanks for asking. What can I help you with?"
    return IntentResponse(answer=answer, intent="how_are_you")


def _compliment(company_name: str | None) -> IntentResponse:
    if company_name:
        answer = f"Thank you, that's kind. Anything else I can help with at {_co(company_name)}?"
    else:
        answer = "Thank you, that's kind. Anything else I can help with?"
    return IntentResponse(answer=answer, intent="compliment")


def _frustration(company_name: str | None, support_enabled: bool = True) -> IntentResponse:
    # The human-handoff offer is a plan entitlement, not a platform fact: a bot
    # with no live-chat or offline-message path must not dangle one.
    offer = ", or I can connect you with the team" if support_enabled else ""
    return IntentResponse(
        answer=f"Sorry that wasn't helpful. Tell me what you're looking for and I'll try again{offer}.",
        intent="frustration",
    )


def _abuse(company_name: str | None) -> IntentResponse:
    if company_name:
        answer = f"I'm here to help with anything about {_co(company_name)} whenever you're ready."
    else:
        answer = "I'm here to help whenever you're ready."
    return IntentResponse(answer=answer, intent="abuse")


def _unclear(company_name: str | None, support_enabled: bool = True) -> IntentResponse:
    # "getting in touch" is a plan entitlement (live chat / offline message),
    # not a platform fact; see ``_frustration`` and ``_is_ai`` for the same rule.
    # Without it the list drops to two items, so the joiner drops the comma too.
    topics = "services, pricing or getting in touch" if support_enabled else "services or pricing"
    who = _co(company_name) + "'s" if company_name else "our"
    return IntentResponse(
        answer=f"Could you say a bit more about what you're looking for? I can help with {who} {topics}.",
        intent="unclear",
    )


def _name_recall(company_name: str | None, visitor_name: str | None) -> IntentResponse:
    name = " ".join(str(visitor_name).split())[:40] if visitor_name else ""
    if name and company_name:
        answer = f"You're {name}. What can I help you with at {_co(company_name)}?"
    elif name:
        answer = f"You're {name}. What can I help you with?"
    else:
        answer = "I don't know your name yet. You can tell me anytime."
    return IntentResponse(answer=answer, intent="name_recall")
