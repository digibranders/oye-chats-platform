"""Meeting/scheduling answer gate.

A visitor asking to book a meeting, demo, or call must always land somewhere
real. When the bot has an online scheduler configured, the existing booking-card
flow handles it. When it does NOT, this gate answers the turn deterministically
instead of leaving it to the prompt.

WHY DETERMINISTIC, kept here so nobody re-litigates it as over-engineering. The
"no scheduler configured" case was already handled, in the system prompt: an
else-branch told the model to offer the team and emit
``[LEAVE_MESSAGE_CARD]``. Measured end-to-end on real bots, it failed on BOTH
plan shapes:

* **Paid** (rich knowledge base, live chat on): the model replied "I'll connect
  you with our team about a meeting" and never emitted the token, so
  ``show_leave_message`` stayed unset. The visitor got a promise and no form.
* **Free**: the model replied "I'll open a quick form so they can reach out",
  which is a promise the plan cannot keep at all -- the card is blocked by the
  plan's human-support entitlement, so the form can never appear.

Two structural reasons it could not be fixed in the prompt:

1. The leave-message SAFETY NET cannot cover scheduling. It fires only when the
   visitor's turn AND the bot's reply both look like an async contact request,
   and scheduling phrasing matches neither predicate ("can I book a meeting?"
   scores False on the question side), so a forgotten token is never rescued.
2. On a bot whose retrieval returns nothing relevant, the relevance gate's
   off-scope refusal returns BEFORE generation, so the prompt instruction is
   never reached at all. A scheduling request is inherently not in the knowledge
   base, which makes that the common path rather than the rare one.

This module therefore decides the turn before either mechanism can lose it, the
same reasoning that produced ``pricing_gate``.

THE FREE BRANCH hands over the customer's own public contact page rather than
promising an in-chat channel. Free has no live queue and no leave-message form,
so any wording implying follow-up is a promise the plan cannot keep. A public
page on the customer's own website is information, not a channel, so it does not
leak the paid feature -- the identical reasoning ``pricing_gate`` already uses,
and the copy deliberately matches so the bot has one voice for one action.

Pure module by design: no DB, no I/O, and no import from ``rag_service`` (which
imports this one). Everything here is a decision the callers act on.

KNOWN LIMITATION, deliberate: ``is_meeting_question`` is an English regex, so a
scheduling request in another language does not fire the gate and falls through
to the prompt as before. That is the safe direction (nothing regresses for those
visitors) and it matches the same constraint on ``pricing_gate`` and the CRAG
judge. Fix them together, not separately.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from app.services.pricing_gate import normalize_url

# A meeting noun followed by one of these is a THING, not an event: "demo
# video", "call recording", "session pricing", "appointment policy". Those are
# knowledge-base questions and must never be read as a request for time.
_MEETING_NOUN_SUFFIX = (
    r"(?!\s+(?:video|recording|recordings|transcript|log|logs|history|notes|minutes|"
    r"room|rooms|space|venue|policy|policies|pricing|price|prices|fee|fees|cost|costs|"
    r"cancellation|center|centre|link|page))"
)

# A first-person invitation: "let's", "lets" (either apostrophe), or "let us"
# opening the message. The spaced "let us" is anchored because mid-sentence it
# is usually a product question ("does it let us meet with clients online").
_LETS = r"(?:^\s*let\s+us|\blet['’]?s)"

_WEEKDAY = r"(?:mon|tues|wednes|thurs|fri|satur|sun)day"

# A time the visitor offers: "tomorrow", "next week", "on Friday", "at 3pm", "in
# an hour". "at" and "in" need a number or a time word, because "at your venue"
# and "in HubSpot" are places and products. The number takes no word boundary,
# since "3pm" runs straight on.
_WHEN = (
    r"(?:(?:at|in)\s+\d"
    r"|(?:today|tomorrow|tonight|soon|sometime|later|asap"
    r"|(?:this|next)\s+(?:week|weekend|month|morning|afternoon|evening|" + _WEEKDAY + r")"
    r"|(?:on\s+)?" + _WEEKDAY + r"|in\s+(?:an?\s+(?:hour|few|couple|bit)|the\s+(?:morning|afternoon|evening)))\b)"
)

# The visitor has finished the request: punctuation or the end of the message.
_REQUEST_END = r"\s*(?:[.?!,;:]|$)"

# After an invited meeting noun, the request ends there, or goes on to say when,
# with whom, or what about. Any other word makes the noun part of a thing: "a
# call tracking number", "a demo account", "an appointment to Google Calendar",
# "a call with WhatsApp Business", "a session of yoga". "with" needs a person, so
# a product name after it stays an integration question.
_MEETING_REQUEST_ENDS = (
    r"(?=" + _REQUEST_END + r"|\s+(?:please\b|about\b|to\s+(?:discuss|talk)\b|" + _WHEN + r"|with\s+(?:you|us|me"
    r"|(?:your|our|the)\s+(?:[a-z]+\s+)?(?:team|founders?|co-?founders?|experts?|specialists?|consultants?"
    r"|people|staff))\b))"
)

# "let's meet" and "let's catch up" carry no noun, so what follows decides: the
# end of the message or a time. "let's meet the founders", "let's meet at your
# venue" and "let's catch up on the new pricing" are about a page, a place and a
# topic.
_INVITATION_ENDS = r"(?=" + _REQUEST_END + r"|\s+(?:please\b|" + _WHEN + r"))"

_INVITED_MEETING = (
    r"(?:(?:quick|short|brief|video|phone)\s+)?"
    r"(?:meeting|call|demo|appointment|consultation|walkthrough|session)\b" + _MEETING_REQUEST_ENDS
)

# Scheduling VERB + meeting NOUN in tight co-occurrence. Requiring both keeps
# "do you have meeting rooms?" (a product question about the customer's
# offering) out of the gate while catching every ordinary way a visitor asks to
# get time with someone.
#
# ``have``, ``want``, ``need`` and ``request`` are deliberately NOT in the broad
# verb list: with 40 characters of slack they fired on "do you have a demo
# video?", "I need to call your office", "I want the appointment cancellation
# policy" and "I have a question about the session pricing", hijacking
# knowledge-base questions on every bot without a scheduler. They appear only in
# the article-anchored branch below ("I want a demo", "request a call"), where
# the noun has to follow the article directly.
_MEETING_RE = re.compile(
    r"\b(?:book|schedule|set\s*up|setup|arrange|organis|organiz|fix|"
    r"reserve|get\s+on|hop\s+on|jump\s+on)\w*\b[^.?!]{0,40}?"
    r"\b(?:meeting|meet|demo|call|appointment|consultation|walkthrough|"
    r"discovery|session|slot|time\s+slot)\b"
    + _MEETING_NOUN_SUFFIX
    + r"|\b(?:want|need|would\s+like|'?d\s+like|request(?:ing)?)\s+(?:a|an|some|another)\s+"
    r"(?:meeting|demo|call|appointment|consultation|walkthrough|session)\b"
    + _MEETING_NOUN_SUFFIX
    + r"|\b(?:can|could|shall)\s+we\s+(?:meet|talk|connect|catch\s+up)\b"
    r"|\b(?:book|schedule)\s+(?:a|an|some)\s+time\b"
    # "get a demo" / "get an appointment". ``get`` is deliberately NOT in the
    # verb list above: on its own it is far too broad ("where do I get a copy of
    # the demo video") and a false positive here hijacks a legitimate
    # knowledge-base question into "I can't book that directly". Anchored
    # tightly to the article + noun instead.
    r"|\bget\s+(?:a|an)\s+(?:meeting|demo|call|appointment|consultation|walkthrough|session)\b"
    # "lets connect a meeting", "let's connect on a call", "connect for a quick
    # call". ``connect`` is NOT in the verb list above either: it is how a
    # visitor asks for a person ("connect me with the team") and how they ask
    # about an integration ("how many users can connect on a call", "does it
    # connect to my meeting room system"). So it needs a first-person invitation
    # in front, or to open the message, an article plus a meeting noun after,
    # and the request has to end on that noun (``_MEETING_REQUEST_ENDS``), which
    # drops "connect a call to my CRM" even behind "I want to".
    r"|(?:^\s*|(?:" + _LETS + r"|\b(?:can|could|shall)\s+we|\bwe\s+(?:can|could|should)"
    r"|\b(?:like|want)\s+to|\bwanna)\s+)"
    r"connect\s+(?:(?:on|over|for|via|in)\s+)?(?:a|an)\s+"
    + _INVITED_MEETING
    # "let's meet", "let us catch up": the invitation is the request, so these
    # need no noun, like "can we meet" above, but they must end there or on a
    # time. "have" and "do" still need an article and a meeting noun, since
    # "let's have a look at pricing" is not.
    + r"|"
    + _LETS
    + r"\s+(?:meet|catch\s+up)\b"
    + _INVITATION_ENDS
    + r"|"
    + _LETS
    + r"\s+(?:have|do)\s+(?:a|an)\s+"
    + _INVITED_MEETING,
    re.IGNORECASE,
)

# Phrases that use scheduling words but are NOT a request for time with the
# team. Checked first so a verb/noun hit cannot override them.
_MEETING_DISQUALIFIER_RE = re.compile(
    r"\b(?:cancel|reschedul|postpone|move)\w*\s+(?:my|the|our)\s+"
    r"(?:meeting|call|appointment|demo)\b"
    r"|\bmeeting\s+(?:room|space|venue)s?\b"
    r"|\balready\s+(?:booked|scheduled)\b",
    re.IGNORECASE,
)


def is_meeting_question(question: object) -> bool:
    """True when the visitor is asking to get time with the team.

    Deliberately narrower than "the message mentions a meeting": it needs a
    scheduling verb near a meeting noun, or one of the fixed "can we meet"
    shapes. A bot whose knowledge base is ABOUT meetings (a venue, an events
    company) must still be able to answer questions on that subject from its
    own content, so a bare noun never fires the gate.
    """
    if not isinstance(question, str) or not question.strip():
        return False
    if _MEETING_DISQUALIFIER_RE.search(question):
        return False
    return bool(_MEETING_RE.search(question))


def scheduler_is_configured(bot: object) -> bool:
    """Whether this bot has a usable online scheduler.

    Mirrors ``rag_service._resolve_meeting_booking``: the feature must be
    enabled AND the provider's URL must actually be set. An enabled bot with a
    blank URL has no scheduler, and offering its booking card would render a
    link to nowhere.
    """
    if bot is None or not getattr(bot, "meeting_booking_enabled", False):
        return False
    provider = getattr(bot, "meeting_provider", None) or "calendly"
    attr = {"calendly": "calendly_url", "zcal": "zcal_url", "calcom": "calcom_url"}.get(provider, "calendly_url")
    url = getattr(bot, attr, None)
    return bool(isinstance(url, str) and url.strip())


@dataclass(frozen=True)
class MeetingPivot:
    """The canned reply for a scheduling turn the bot cannot book.

    ``suggest_handoff`` routes the visitor to a live operator; ``needs_message_card``
    tells the caller to set ``show_leave_message`` the way its own leave-message
    path already does. As in ``pricing_gate.PricingPivot``, ``text`` carries no
    card token: the sentinel is an LLM-to-server signal that both pipelines strip
    before persisting, so putting one here would ship the literal string to the
    visitor and render no card.

    Both flags are False on the Free branch. Free has no in-chat channel, so the
    reply must stay a plain pointer to a public page rather than a promise of
    follow-up the plan cannot keep.
    """

    text: str
    suggest_handoff: bool
    needs_message_card: bool


def meeting_pivot(
    *,
    company_name: str | None,
    support_enabled: bool,
    live_chat_enabled: bool,
    contact_url: str | None = None,
) -> MeetingPivot:
    """The reply for a scheduling request on a bot with no scheduler.

    ``support_enabled`` is the PLAN half of the human-support gate (does this
    bot's plan include ``live_chat`` at all). ``live_chat_enabled`` is the
    EFFECTIVE real-time value and only chooses between the live handoff and the
    async message card on a paid plan.

    ``contact_url`` is read ONLY on the Free branch, where it is the difference
    between pointing the visitor at a real destination and dead-ending them. It
    is re-validated through ``normalize_url`` rather than trusted from the
    caller: this string is pasted into a visitor's reply and persisted to
    ``chat_messages.content``, so a future caller reading it from somewhere else
    must not be able to render "You can get in touch here: javascript:alert(1)".
    """
    cn = f"**{company_name}**" if company_name else "us"
    usable_contact = contact_url.strip() if isinstance(contact_url, str) and normalize_url(contact_url) else None

    if not support_enabled:
        if usable_contact:
            # Phrasing deliberately matches ``pricing_gate.pricing_pivot``'s Free
            # branch after the first sentence, so the bot has one voice for one
            # action ("here is where to go"), and it promises nothing beyond the
            # link: on Free there is no queue to join and no form to open.
            return MeetingPivot(
                text=(f"I can't set up meetings for {cn} directly. You can get in touch here: {usable_contact}"),
                suggest_handoff=False,
                needs_message_card=False,
            )
        return MeetingPivot(
            text=(
                f"I can't set up meetings for {cn} directly. Is there something else about {cn} I can help you with?"
            ),
            suggest_handoff=False,
            needs_message_card=False,
        )

    if live_chat_enabled:
        return MeetingPivot(
            text=f"I can't book that directly, but I can connect you with the {cn} team. Want me to do that now?",
            suggest_handoff=True,
            needs_message_card=False,
        )

    return MeetingPivot(
        text=(f"I can't book that directly. I'll open a quick message form so the {cn} team can get back to you."),
        suggest_handoff=False,
        needs_message_card=True,
    )
