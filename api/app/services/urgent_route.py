"""Urgent incidents reported in chat.

On 2026-09-10 a visitor on two security companies' bots wrote "we are under a
ransomware attack right now, please help!" and got the generic offline form. A
report of an active incident needs the fastest human route and a priority alert,
decided in code and worded by a template.

A false positive is expensive: it replaces the answer and pages the owner. So the
detector says urgent only for a report of something happening to the visitor
now, and stands down for a question about incidents, a hypothetical, an incident
in the past and a question about the service that happens to use the words.
"""

from __future__ import annotations

import re

from app.services.handoff_reply import HandoffOffer
from app.services.pricing_gate import normalize_url

#: A first-person report: "we are under attack", "our servers have been hacked".
#: The gap is bounded and cannot cross a sentence end, so the scan stays linear.
_FIRST_PERSON_INCIDENT = (
    r"\b(?:we|we're|we've|i|i'm|i've|our|my|us)\b[^.?!]{0,40}?"
    r"\b(?:under\s+(?:an?\s+)?(?:\w+\s+)?attack|being\s+attacked|hacked|breached|compromised|ransomwared|encrypted\s+by)\b"
)
_FIRST_PERSON_INCIDENT_RE = re.compile(r"(?i)" + _FIRST_PERSON_INCIDENT)

#: Anything that reads as an incident report. Rule by rule:
#: 1. a first-person report (above);
#: 2. an incident described as happening: "an active incident on our network";
#: 3. a plea marked urgent: "urgent help needed now";
#: 4. a plea naming the incident: "help, our site got hacked".
_URGENT_RE = re.compile(
    r"(?i)"
    + "|".join(
        (
            _FIRST_PERSON_INCIDENT,
            r"\b(?:active|ongoing|live)\s+(?:security\s+)?(?:incident|breach|attack)\b",
            r"\b(?:urgent|emergency)\b[^.?!]{0,30}\b(?:help|now|asap|immediately)\b",
            r"\b(?:help|asap)\b[^.?!]{0,30}\b(?:hacked|breach|ransomware|attack)\b",
        )
    )
)

#: A hypothetical or a question about protection: "what if we are breached?".
_HYPOTHETICAL_RE = re.compile(
    r"(?i)\b(?:if|what\s+if|in\s+case|suppose|how\s+(?:do|would|can|to|does)|protect|prevent|avoid|against)\b"
)

#: Words that put the incident in the present, overriding a hypothetical or past marker.
_NOW_RE = re.compile(r"(?i)\b(?:right\s+now|now|currently|ongoing|active|asap|immediately|urgent|emergency)\b")

#: An incident in the past: "last year", "a few months ago", "in 2023", "previously".
_PAST_RE = re.compile(
    r"(?i)\b(?:last\s+(?:week|month|year)|(?:days?|weeks?|months?|years?)\s+ago"
    r"|in\s+(?:19|20)\d{2}|previously|in\s+the\s+past)\b"
)

#: A sentence that opens as a question to the business: "do you offer emergency
#: plumbing now?", "is urgent help available on weekends?". A leading greeting is
#: allowed so "hi, do you ..." reads the same.
_SERVICE_QUESTION_RE = re.compile(
    r"(?i)^\s*(?:(?:hi|hello|hey)\b[\s,!]*)?(?:do|does|can|could|is|are|will|would|what|which)\b"
)

#: Sentence ends. The rules above never match across one, so each sentence is judged alone.
_SENTENCE_END_RE = re.compile(r"[.?!]+")

_EMERGENCY_KEYWORDS = frozenset({"emergency", "incident", "incident response", "urgent"})


def _sentence_reports_incident(sentence: str) -> bool:
    """True when this sentence reads as a report rather than a question about the service."""
    if not _URGENT_RE.search(sentence):
        return False
    # A question to the business counts only when it also carries a first-person
    # report ("can you help, we've been hacked"); otherwise it asks about a service.
    return not _SERVICE_QUESTION_RE.search(sentence) or bool(_FIRST_PERSON_INCIDENT_RE.search(sentence))


def is_urgent_incident(question: object) -> bool:
    """True when the visitor reports an incident happening to them, not one they ask about."""
    if not isinstance(question, str) or not question.strip():
        return False
    present = bool(_NOW_RE.search(question))
    # "What happens if we are breached?" imagines an incident.
    if _HYPOTHETICAL_RE.search(question) and not present:
        return False
    # "Our site got hacked last year" is background for a sales question.
    if _PAST_RE.search(question) and not present:
        return False
    return any(_sentence_reports_incident(sentence) for sentence in _SENTENCE_END_RE.split(question))


def emergency_url_from_answer_links(answer_links: object) -> str | None:
    """The owner's emergency page, from a Smart Link keyword like "emergency".

    http(s) with a host only: ``normalize_url`` returns None for any other scheme
    (``javascript:``, ``ftp:``) and for a URL without a host.
    """
    if not isinstance(answer_links, list):
        return None
    for entry in answer_links:
        if not isinstance(entry, dict):
            continue
        keyword = entry.get("keyword")
        url = entry.get("url")
        if (
            isinstance(keyword, str)
            and keyword.strip().lower() in _EMERGENCY_KEYWORDS
            and isinstance(url, str)
            and normalize_url(url)
        ):
            return url.strip()
    return None


def urgent_reply(
    *,
    company_name: str | None,
    support_enabled: bool,
    live_chat_enabled: bool,
    team_available: bool,
    emergency_url: str | None,
    contact_url: str | None,
) -> HandoffOffer:
    """The reply to an urgent incident. "Flagged" is only said on a plan whose team gets the alert."""
    co = f"**{company_name}**" if company_name else "the team"
    urgent_link = f" If this is an active incident, don't wait for a reply: {emergency_url}" if emergency_url else ""
    if not support_enabled:
        page = emergency_url or contact_url
        if page:
            return HandoffOffer(
                text=f"This sounds urgent. Please contact {co} directly: {page}",
                suggest_handoff=False,
                needs_message_card=False,
            )
        return HandoffOffer(
            text=f"This sounds urgent. Please contact {co} directly through their website.",
            suggest_handoff=False,
            needs_message_card=False,
        )
    if not live_chat_enabled:
        return HandoffOffer(
            text=(
                f"This sounds urgent, so I've flagged it to {co} as a priority. I'll open a quick message form "
                f"so they can reach you as soon as possible.{urgent_link}"
            ),
            suggest_handoff=False,
            needs_message_card=True,
        )
    if team_available:
        return HandoffOffer(
            text=(
                f"This sounds urgent, so I've flagged it to {co} as a priority. Share your details in the form "
                f"below and I'll connect you with them right away.{urgent_link}"
            ),
            suggest_handoff=True,
            needs_message_card=False,
        )
    return HandoffOffer(
        text=(
            "This sounds urgent. Our team is offline right now, but I've flagged it to them as a priority. "
            f"Share your details in the form below so they can reach you as soon as possible.{urgent_link}"
        ),
        suggest_handoff=True,
        needs_message_card=False,
    )
