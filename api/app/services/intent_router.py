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

4. **Reactions and distress**. Frustration, insults, a visitor who may hurt
   themselves or is having a medical emergency, and a request for medication.
   Each reply acknowledges the feeling in one clause and gives a next step;
   distress gets care and emergency help, never a sales route.

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

_REMEMBER_VERB = r"(?:remember|remeber|rember|rememeber|remembr|recall|recogni[sz]e)"
_REMEMBER_RE = re.compile(
    r"(?ix)\b(?:"
    rf"(?:can|do)\s+(?:you|u|ya|yu)\s+{_REMEMBER_VERB}\s+(?:our|my|the)\s+(?:last|previous|earlier)\s+"
    r"(?:conversation|chat|messages?)"
    r"|do\s+you\s+(?:keep|have)\s+(?:any\s+)?memory"
    r")\b"
)
# "Do you remember me?" in chat shorthand, whole message only: "do u remember
# me?" missed the route in production, reached the gate and opened the unhelped
# handoff form. Anchored at both ends, so a product question about a "remember
# me" login ("remember me to reset my password", "does the login remember me on
# this device") still reaches retrieval.
_REMEMBER_ME_RE = re.compile(
    r"^(?:(?:hi|hey|hello|so|ok|okay|and|wait|hmm)\s+){0,2}"
    rf"(?:(?:(?:do|did|can|will|would)\s+)?(?:you|u|ya|yu)\s+(?:still\s+)?)?{_REMEMBER_VERB}\s+me"
    r"(?:\s+(?:from|since)\s+(?:last\s+(?:time|week|chat)|before|yesterday|earlier|our\s+last\s+chat))?$"
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

# Frustration aimed at the bot itself, whole message only (eval 2026-09-17:
# "this bot is absolute trash" got "Sorry to hear that." and nothing else, and
# "stupid bot" got a scope refusal). A trash noun on its own ("garbage",
# "rubbish collection days") is a question for a waste business, so the nouns
# count only with the bot or "this is" around them. A complaint about the last
# answer ("useless answer") is left to ``visitor_reaction``, which reads the
# reply it is about. Up to two filler words may open or close the message
# ("ugh, pathetic", "dumb bot lol"). Every repeat is bounded and the filler
# separators share no characters with the words, so matching stays linear.
_REACTION_FILLER = (
    r"(?:ugh+|argh+|forget\s+it|whatever|seriously|wow|man|bro|dude|omg|smh|meh|honestly|jeez|come\s+on|nah|no"
    r"|ok|okay)"
)
_REACTION_TAIL = r"(?:bro|man|dude|yaar|honestly|seriously|lol|smh|ugh+|mate)"
_VERDICT_BOT = r"(?:bot|chat\s?bot|assistant|ai|thing|chat|service)"
_VERDICT_INTENSIFIER = (
    r"(?:(?:so|such|absolute(?:ly)?|complete(?:ly)?|total(?:ly)?|utter(?:ly)?|pure|really|very|freaking|bloody)\s+)?"
)
_VERDICT_ADJECTIVE = (
    r"(?:useless|stupid|dumb|pathetic|worthless|pointless|terrible|awful|horrible|ridiculous|clueless|lame"
    r"|the\s+worst)"
)
_VERDICT_NOUN = (
    r"(?:(?:an?\s+)?(?:piece\s+of\s+)?(?:trash|garbage|rubbish|junk|crap)|an?\s+joke"
    r"|a\s+waste\s+of\s+(?:my\s+)?time|no\s+help|not\s+helpful)"
)
_BOT_VERDICT_RE = re.compile(
    rf"^(?:{_REACTION_FILLER}[\s,.!?]+){{0,2}}(?:"
    # "this bot is absolute trash", "your chatbot is useless"
    rf"(?:(?:this|that|the|your|ur)\s+)?{_VERDICT_BOT}\s+(?:is|was|'s|s|seems)\s+{_VERDICT_INTENSIFIER}"
    rf"(?:{_VERDICT_ADJECTIVE}|{_VERDICT_NOUN})"
    # "you're a useless bot", "u r stupid"
    rf"|(?:you(?:'re|re|\s+are|\s+r)|u\s+(?:r|are)|ur)\s+{_VERDICT_INTENSIFIER}(?:an?\s+)?"
    rf"(?:{_VERDICT_ADJECTIVE}|{_VERDICT_NOUN})(?:\s+{_VERDICT_BOT})?"
    # "what a useless bot"
    rf"|(?:what|such)\s+an?\s+{_VERDICT_INTENSIFIER}{_VERDICT_ADJECTIVE}\s+{_VERDICT_BOT}"
    # "useless", "stupid bot", "worst bot ever", "garbage bot"
    rf"|{_VERDICT_INTENSIFIER}{_VERDICT_ADJECTIVE}(?:\s+{_VERDICT_BOT})?(?:\s+ever)?"
    rf"|(?:(?:the\s+)?(?:worst|dumbest|stupidest)|trash|garbage|rubbish|junk|crap)\s+{_VERDICT_BOT}(?:\s+ever)?"
    # "this is garbage", "this is a waste of time"
    rf"|(?:this|that|it)\s+(?:is|was|'s|s)\s+{_VERDICT_INTENSIFIER}(?:{_VERDICT_ADJECTIVE}|{_VERDICT_NOUN})"
    # "this bot sucks", "you suck"
    rf"|(?:(?:this|that|the|your)\s+)?{_VERDICT_BOT}\s+sucks|(?:you|u)\s+suck|(?:this|it)\s+sucks"
    r"|no\s+help(?:\s+at\s+all)?"
    rf")(?:[\s,.!?]+{_REACTION_TAIL}){{0,2}}$"
)

#: Faces a visitor sends at a reply that did not help. ``visitor_reaction``
#: reads the same set: rolling eyes, unamused, pouting, angry, huffing, thumbs
#: down, facepalm, expressionless, neutral, confused, disappointed, weary,
#: tired, raised eyebrow.
ANNOYED_EMOJI = "[\U0001f644\U0001f612\U0001f621\U0001f620\U0001f624\U0001f44e\U0001f926\U0001f611\U0001f610\U0001f615\U0001f61e\U0001f629\U0001f62b\U0001f928]"
_ANNOYED_EMOJI_RE = re.compile(ANNOYED_EMOJI)

# Distress: a visitor who may hurt themselves or is having a medical emergency.
# Matched anywhere in the message and at any length, ahead of every other
# route, because the reply must reach them whatever else the message asks.
# Each branch needs the visitor's own voice ("i want to die", "my chest
# hurts"), so product talk stays out: "kill the process", "dead link", "this
# price is killing me", "end my life insurance policy", "do you treat heart
# attack patients". Every group is literal words or a bounded run, so a search
# is linear in the message.
_PILLS = r"(?:pills?|tablets?|capsules?|meds|medicines?|medications?|painkillers?)"
_SLEEPING_PILLS = r"sleeping\s+(?:pills?|tablets?)"
_MANY = (
    r"(?:too\s+many|a\s+lot\s+of|lots\s+of|loads\s+of|a\s+bunch\s+of|a\s+handful\s+of|all\s+(?:of\s+)?(?:my|the)"
    r"|(?:a\s+whole|an\s+entire)\s+(?:bottle|strip|pack|packet|box)\s+of|[1-9]\d+|twenty|thirty|forty|fifty)"
)
_I_TOOK = r"\bi(?:\s+have|'ve|ve|\s+had)?\s+(?:just\s+|already\s+)?(?:took|taken|swallowed|popped)\s+"
_CRISIS_RE = re.compile(
    r"(?:"
    # Self-harm and suicide
    # "i'm going to die" is left out: at work it is nearly always a figure of speech.
    r"\bi\s+(?:just\s+|really\s+|honestly\s+|kinda\s+|kind\s+of\s+)?(?:want|wanna|wish)\s+(?:to\s+)?die\b"
    r"(?!\s+(?:hard|laughing|of|for|in|on|with))"
    r"|\bi\s+wish\s+i\s+(?:was|were)\s+dead\b|\bwant\s+to\s+be\s+dead\b"
    r"|\bkill(?:ing)?\s+my\s?self\b"
    r"|\bend(?:ing)?\s+my\s+(?:own\s+)?life\b(?!\s+(?:insurance|cover|policy|assurance|plan))"
    r"|\btak(?:e|ing)\s+my\s+own\s+life\b"
    r"|\b(?:to|gonna|going\s+to|i'll|i\s+will|just)\s+end\s+it\s+all\b"
    r"|\b(?:don't|dont|do\s+not)\s+want\s+to\s+(?:live|be\s+alive)(?:\s+any\s?more|\s*$|\s*[,.!?])"
    r"|\b(?:nothing|no\s+reason)\s+to\s+live\s+for\b|\bno\s+reason\s+to\s+live\b"
    r"|\bbetter\s+off\s+(?:dead|without\s+me)\b"
    r"|\bsuicidal\b|\b(?:commit(?:ting)?|attempt(?:ing)?)\s+suicide\b"
    r"|\b(?:thinking|thought|think)\s+(?:of|about)\s+suicide\b(?!\s+prevention)"
    r"|\b(?:been|keep|started|want\s+to|going\s+to|gonna|thinking\s+(?:of|about))\s+(?:hurting|harming|cutting)\s+myself\b"
    r"|\b(?:want\s+to|going\s+to|gonna)\s+(?:hurt|harm|cut)\s+myself\b"
    # An overdose, or sleeping pills already taken
    r"|\bi(?:\s+have|'ve|ve)?\s+(?:just\s+|already\s+)?overdosed\b"
    r"|\b(?:took|taken|take|taking|had)\s+an\s+overdose\b"
    rf"|{_I_TOOK}{_MANY}\s+(?:[a-z]+\s+)?{_PILLS}\b"
    rf"|{_I_TOOK}(?:(?:my|some|the|a\s+few|a\s+couple\s+of|two|three)\s+)?{_SLEEPING_PILLS}\b"
    # A medical emergency
    r"|\b(?:i\s+have|i've\s+got|ive\s+got|i\s+got|i'm\s+having|im\s+having|i\s+am\s+having|having|i\s+feel|feeling"
    r"|getting)\s+(?:(?:a|some|really|very|bad|severe|sharp|strong|crushing)\s+){0,2}"
    r"(?:chest\s+pains?|pains?\s+in\s+my\s+chest|chest\s+tightness|tightness\s+in\s+my\s+chest)\b"
    r"|\bmy\s+chest\s+(?:hurts|is\s+hurting|is\s+tight|feels\s+tight|is\s+in\s+pain|is\s+pounding)\b"
    r"|\bi\s+(?:can't|cant|cannot|can\s+not)\s+breathe?\b"
    r"|\b(?:i'm|im|i\s+am)\s+having\s+an?\s+(?:heart\s+attack|stroke|seizure)\b"
    r")"
)
# A request for medication, which the bot must never answer: "which tablets
# should i take". "which plan should i take" and "do you sell sleeping pills"
# are questions for the knowledge base.
_MEDICAL_ADVICE_RE = re.compile(
    r"(?:"
    rf"\b(?:which|what|how\s+many|how\s+much)\s+(?:[a-z]+\s+)?(?:{_SLEEPING_PILLS}|{_PILLS}|drugs?|antidepressants?)"
    r"\s+(?:should|can|could|do|shall|must)\s+i\s+(?:take|have)\b"
    r"|\bwhat\s+(?:should|can|could|do)\s+i\s+take\s+(?:to\s+(?:sleep|relax|calm\s+down)"
    r"|for\s+(?:my\s+|the\s+|a\s+|this\s+)?(?:sleep|insomnia|stress|anxiety|depression|pain|headaches?|migraines?"
    r"|fever|cold|cough|panic\s+attacks?))\b"
    rf"|\b(?:recommend|suggest|prescribe)\s+(?:me\s+)?(?:a|an|any|some)\s+(?:good\s+)?(?:{_SLEEPING_PILLS}"
    r"|medicines?|medications?|painkillers?|antidepressants?)\b"
    rf"|\bshould\s+i\s+take\s+(?:a\s+|some\s+|any\s+)?(?:{_SLEEPING_PILLS}|painkillers?|antidepressants?|melatonin)\b"
    r")"
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
        | crisis | medical_advice | unclear | name_recall). Used for
        logs/metrics, not shown to visitor.
    repeat_answer
        The wording for a turn right after another reaction reply, or None
        when the route answers the same every time. See ``answer_after``.
    """

    answer: str
    intent: str
    repeat_answer: str | None = None

    def answer_after(self, previous_reply: str | None) -> str:
        """The text to send when the bot's previous reply was ``previous_reply``.

        A visitor who stays upset hears new words and no second apology:
        ``repeat_answer`` when the previous reply was itself a reaction reply
        (see ``follows_a_reaction_reply``), ``answer`` otherwise.
        """
        if self.repeat_answer is not None and follows_a_reaction_reply(previous_reply):
            return self.repeat_answer
        return self.answer


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


def _reads_as_praise(norm: str) -> bool:
    """Whether ``norm`` is only thanks or praise: an ack term or a compliment."""
    return any(spelling in _ACK_TERMS for spelling in term_spellings(norm)) or _COMPLIMENT_RE.match(norm) is not None


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
# A "yes" to an offer with options
# ─────────────────────────────────────────────────────────────────────────────

#: A blank line, which may hold spaces or a carriage return.
_PARAGRAPH_BREAK_RE = re.compile(r"\n\s*\n")
#: The space after the end of a sentence.
_SENTENCE_BREAK_RE = re.compile(r"(?<=[.?!])\s+")
#: How an offer that lists what the visitor can pick opens: "Want to hear about
#: ...", "Would you like to ...", "Are you exploring ...".
_OPTION_LEAD_RE = re.compile(
    r"^(?:"
    r"(?:do\s+you\s+)?want\s+(?:me\s+)?to"
    r"|would\s+you\s+like(?:\s+me)?\s+to"
    r"|would\s+it\s+help\s+to"
    r"|(?:are\s+you\s+)?(?:curious|interested)\s+(?:about|in)"
    r"|are\s+you\s+(?:looking\s+(?:at|for|into)|exploring)"
    r")\s+"
)
#: A question that asks what the visitor wants without naming anything. The
#: sentence after it lists the options: "What would you like to know? Our
#: services, recent work, or how to get started with Acme?"
_OPEN_QUESTION_RE = re.compile(
    r"^(?:what\s+would\s+you\s+like\s+to\s+(?:know|explore|see)"
    r"|what\s+can\s+i\s+help\s+(?:you\s+)?with"
    r"|what\s+brings\s+you\s+here(?:\s+today)?)\?$"
)
#: Where one option ends and the next starts: a comma, "or", or both.
_OPTION_SPLIT_RE = re.compile(r",\s*(?:or\s+)?|\s+or\s+")
#: The words that open an option without naming its topic ("hear about", "see").
_OPTION_VERB_RE = re.compile(
    r"^(?:(?:hear|know|learn|find\s+out|read)\s+(?:more\s+)?about|see|explore|check\s+out|look\s+at|discuss)\s+"
)
#: An option that is a person rather than a topic. A "yes" to it is a handoff,
#: which the handoff affirmation decides.
_TEAM_OPTION_RE = re.compile(
    r"\b(?:team|someone|somebody|human|person|expert|specialist|connect(?:ing)?|in\s+touch|contact)\b"
)
_SERVICES_OPTION_RE = re.compile(r"\b(?:services?|offerings?)\b")
#: A topic that already says whose it is.
_DETERMINED_TOPIC_RE = re.compile(r"^(?:your|the|a|an)\b")
#: The standalone question a "yes" to the services option is answered as.
SERVICES_QUESTION = "what services do you offer"


def offered_option_question(bot_message: str | None) -> str | None:
    """The question a bare "yes" to ``bot_message`` asks, when that message offers options.

    ``bot_message`` offers options when its closing sentence is a question that
    lists two or more things the visitor can pick, after an offer ("Want to hear
    about our services, see recent work, or chat with the team?") or after an
    open question ("What would you like to know? Our services, recent work, or
    how to get started?"). Agreeing to that picks the first option, so the turn
    is answered as a standalone question about it: the services option is
    ``SERVICES_QUESTION``, "how to X" is "how do i X", and any other topic is
    "tell me about your X".

    None when the message offers no options, or when the first option is a
    person ("connect you with our team, or ..."): a "yes" to that is a handoff.
    Only the closing paragraph is read, like ``intent_service.bot_offers_handoff``,
    because an answer puts its follow-up question there. Pure and linear.
    """
    text = (bot_message or "").replace("*", "").strip()
    closing = _PARAGRAPH_BREAK_RE.split(text)[-1]
    sentences = [" ".join(sentence.lower().split()) for sentence in _SENTENCE_BREAK_RE.split(closing)]
    sentences = [sentence for sentence in sentences if sentence]
    if not sentences or not sentences[-1].endswith("?"):
        return None
    offer = sentences[-1].rstrip("?").strip()
    lead = _OPTION_LEAD_RE.match(offer)
    if lead is not None:
        body = offer[lead.end() :]
    elif len(sentences) >= 2 and _OPEN_QUESTION_RE.match(sentences[-2]):
        body = offer
    else:
        return None
    options = [option.strip() for option in _OPTION_SPLIT_RE.split(body) if option.strip()]
    if len(options) < 2 or _TEAM_OPTION_RE.search(options[0]):
        return None
    topic = _OPTION_VERB_RE.sub("", options[0], count=1)
    if _SERVICES_OPTION_RE.search(topic):
        return SERVICES_QUESTION
    if topic.startswith("how to "):
        return f"how do i {topic[len('how to ') :]}"
    topic = re.sub(r"\bour\b", "your", topic)
    if _DETERMINED_TOPIC_RE.match(topic) is None:
        topic = f"your {topic}"
    return f"tell me about {topic}"


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

    # 1) Lone emoji / punctuation → greeting. A lone eye-roll is a reaction to
    #    the last reply, not a hello: the pipeline's dissatisfaction check reads
    #    it together with that reply.
    if not norm and _EMOJI_OR_PUNCT_RE.match(raw):
        if _ANNOYED_EMOJI_RE.search(raw):
            return None
        return _greeting(company_name)

    if not norm:
        return None

    # Distress first, at any length and whatever else the message asks: the
    # reply must reach a visitor who may be in danger. The curly apostrophe is
    # straightened for these patterns only.
    care_text = norm.replace("\u2019", "'")
    if _CRISIS_RE.search(care_text):
        return _crisis()
    if _MEDICAL_ADVICE_RE.search(care_text):
        return _medical_advice(company_name)

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
    if _REMEMBER_RE.search(norm) or _REMEMBER_ME_RE.match(norm):
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

    # Praise sent with an annoyed face ("great 🙄", "this was helpful 🙄") is
    # sarcasm, and thanking it back is the worst reply. It goes to the
    # pipeline, whose dissatisfaction check reads it with the reply before it.
    if word_count <= 8 and _ANNOYED_EMOJI_RE.search(raw) and _reads_as_praise(norm):
        return None

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
        if _FRUSTRATION_RE.match(norm) or _HINGLISH_FRUSTRATION_RE.match(norm) or _BOT_VERDICT_RE.match(norm):
            return _frustration(company_name, support_enabled)
        if _ABUSE_RE.match(norm):
            return _abuse(company_name, support_enabled)

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


# Reaction replies: one short clause for the feeling, then a next step. The
# first reply to a frustrated visitor apologises once; a reply right after any
# reaction reply (see ``follows_a_reaction_reply``) uses new words and no
# apology, so an upset visitor never hears the same line or a loop of sorries.
# The offer of the team is a plan entitlement, not a platform fact, and uses
# "connect you with", which ``intent_service.bot_offers_handoff`` reads as an
# offer, so a "yes" to it opens the form. It never says whether anyone is
# online: the form works either way (see ``handoff_reply``).
_FRUSTRATION_LEAD = "Sorry that wasn't helpful."
_FRUSTRATION_REPEAT_LEAD = "Let's try this another way."
_ABUSE_LEAD = "Understood, I'll keep this short."
_ABUSE_REPEAT_LEAD = "I'm still here if you need anything"
_CRISIS_LEAD = "I'm really sorry you're going through this."
_CRISIS_REPEAT_LEAD = "Your safety matters more than anything here."
_MEDICAL_LEAD = "I'm sorry you're dealing with this."
_MEDICAL_REPEAT_LEAD = "I can't advise on medicines"
_TEAM_OFFER = "I can connect you with the team"

#: Openings of the replies to an upset visitor, the router's and the
#: dissatisfied reply's in ``visitor_reaction``. A model reply that apologised
#: with "Sorry about that." counts too, so the next reply does not apologise again.
REACTION_REPLY_LEADS = (
    _FRUSTRATION_LEAD,
    _FRUSTRATION_REPEAT_LEAD,
    _ABUSE_LEAD,
    _ABUSE_REPEAT_LEAD,
    _CRISIS_LEAD,
    _CRISIS_REPEAT_LEAD,
    _MEDICAL_LEAD,
    _MEDICAL_REPEAT_LEAD,
    "Sorry about that.",
    "Understood.",
)


def follows_a_reaction_reply(previous_reply: str | None) -> bool:
    """Whether the bot's previous reply was a reply to an upset visitor.

    Searched anywhere in the reply, because a by-name opener ("Thanks, Eva. ")
    may come first. Linear: one substring scan per lead.
    """
    if not previous_reply or not isinstance(previous_reply, str):
        return False
    return any(lead in previous_reply for lead in REACTION_REPLY_LEADS)


def _about(company_name: str | None) -> str:
    """The phrase " about **Acme**", or nothing when the company is unknown."""
    return f" about {_co(company_name)}" if company_name else ""


def _frustration(company_name: str | None, support_enabled: bool = True) -> IntentResponse:
    about = _about(company_name)
    if support_enabled:
        answer = (
            f"{_FRUSTRATION_LEAD} Try asking another way, or tell me the one thing you need{about}. "
            "I can also connect you with the team."
        )
        repeat = f"{_FRUSTRATION_REPEAT_LEAD} Ask me about one thing at a time{about}, or {_TEAM_OFFER}."
    else:
        answer = (
            f"{_FRUSTRATION_LEAD} Try asking another way, or tell me the one thing you need{about}, "
            "and I'll look again."
        )
        repeat = f"{_FRUSTRATION_REPEAT_LEAD} Ask me about one thing at a time{about}, and I'll answer what I can."
    return IntentResponse(answer=answer, intent="frustration", repeat_answer=repeat)


def _abuse(company_name: str | None, support_enabled: bool = True) -> IntentResponse:
    about = _about(company_name)
    offer = f", or {_TEAM_OFFER}" if support_enabled else ""
    return IntentResponse(
        answer=f"{_ABUSE_LEAD} If you need anything{about}, ask me one thing at a time{offer}.",
        intent="abuse",
        repeat_answer=f"{_ABUSE_REPEAT_LEAD}{about}. Ask me one thing at a time{offer}.",
    )


def _crisis() -> IntentResponse:
    # No company, no services and no team: a visitor who may be in danger
    # needs emergency help, not a sales route. No phone number either, since
    # the right one depends on where the visitor is.
    return IntentResponse(
        answer=(
            f"{_CRISIS_LEAD} I can't help with this here, but please call your local emergency number "
            "or a crisis helpline right now, or ask someone near you for help."
        ),
        intent="crisis",
        repeat_answer=(
            f"{_CRISIS_REPEAT_LEAD} Please call your local emergency number or a crisis helpline now, "
            "or ask someone near you to stay with you."
        ),
    )


def _medical_advice(company_name: str | None) -> IntentResponse:
    close = (
        f"If there's anything about {_co(company_name)} I can help with, just ask."
        if company_name
        else "If there's anything else I can help with, just ask."
    )
    return IntentResponse(
        answer=(
            f"{_MEDICAL_LEAD} I can't give medical advice, so please speak with a doctor or pharmacist "
            f"before taking anything. {close}"
        ),
        intent="medical_advice",
        repeat_answer=f"{_MEDICAL_REPEAT_LEAD}, but a doctor or pharmacist can. {close}",
    )


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
