"""Urgent incidents reported in chat.

On 2026-09-10 a visitor on two security companies' bots wrote "we are under a
ransomware attack right now, please help!" and got the generic offline form. A
report of an active incident needs the fastest human route and a priority alert,
decided in code and worded by a template.

A false positive is expensive: it replaces the answer and pages the owner. So the
detector says urgent only for a report of something happening to the visitor
now. It stands down for a question about incidents, a hypothetical, an incident
in the past, a third party's incident and a question about the service that
happens to use the words ("I need urgent help with pricing").

Every rule is a bounded pattern and the stand-down facts are computed once per
clause, so a 20,000-character message is judged in a few milliseconds.
"""

from __future__ import annotations

import re
from bisect import bisect_right
from collections.abc import Iterator

from app.services.handoff_reply import HandoffOffer
from app.services.pricing_gate import normalize_url

# ── Rule 1: a first-person report ("we are under attack", "our site got hacked") ──

#: Who the incident happens to.
_SUBJECT_RE = re.compile(r"(?i)\b(?:we|we're|we've|i|i'm|i've|our|my|us)\b")

#: A subject describing a service rather than an incident: "we help companies that got hacked".
_SERVICE_VERB_RE = re.compile(r"(?i)\s+(?:help|protect|secure|support|serve|assist|recover|restore|fix|clean)\b")

#: Someone else's incident: "our old vendor got hacked", "my friend got hacked".
_THIRD_PARTY_RE = re.compile(
    r"(?i)\b(?:vendor|provider|competitor|friend|supplier|partner|neighbou?r|former|previous)\b"
)

#: What happened. "breached", "compromised" and "hijacked" count only in the
#: passive, because "our client breached the contract" and "we compromised on the
#: design" are not incidents.
_INCIDENT_VERB_RE = re.compile(
    r"(?i)\b(?:"
    r"under\s+(?:an?\s+)?(?:\w+\s+)?attack"
    r"|being\s+(?:attacked|hacked|ddosed)"
    r"|hacked(?!-|\s+together\b)"
    r"|(?:been|was|were|is|are|got|get|getting)\s+(?:\w+\s+)?(?:breached|compromised|hijacked)"
    r"|ransomwared|defaced|phished|ddosed"
    r"|encrypted\s+by\s+(?:\w+\s+)?(?:ransomware|malware|hackers?|attackers?)"
    r"|infected\s+(?:with|by)\s+(?:\w+\s+)?(?:ransomware|malware)"
    r"|hit\s+(?:by|with)\s+(?:an?\s+)?(?:\w+\s+)?(?:ransomware|malware|attack|cyber\s*attack)"
    r"|(?:seeing|having|experiencing|dealing\s+with)\s+(?:an?\s+)?"
    r"(?:data\s+|security\s+|cyber\s*|ddos\s+|ransomware\s+)?(?:breach|attack|intrusion)(?!\s+of\b)"
    r")\b"
)

#: The most characters allowed between the subject and the incident verb.
_MAX_SUBJECT_GAP = 40
#: Longest subject word ("we're"), so the look-back window can hold a whole one.
_LONGEST_SUBJECT = 5

# ── Rules 2 to 4: reports that do not start with the visitor ──────────────────

#: A noun that names the incident. Not before "of", an article or a possessive:
#: "help, my landlord breached the lease" is a contract, not an attack.
_INCIDENT_NOUN = (
    r"\b(?:hacked|breach(?:ed)?|ransomware|malware|ddos|cyber\s*attack)\b"
    r"(?!\s+(?:of|the|a|an|my|our|their|this)\b)"
)
_PLEA = r"\b(?:help|asap|sos)\b"

#: Reports that stand whoever asks, even inside a question to the business.
_REPORT_RE = re.compile(
    r"(?i)"
    + "|".join(
        (
            # 2. The attacker is the subject: "ransomware hit us", "someone got into our email".
            r"\b(?:ransomware|malware|hackers?|attackers?|someone)\b[^.?!]{0,30}?"
            r"\b(?:hit|hacked|hijacked|took\s+over|got\s+into|broke\s+into|(?:is|are)\s+in(?:side)?|stole)\b"
            r"[^.?!]{0,20}?\b(?:us|our|my|me)\b",
            # 3. A plea, then the incident: "help!! ransomware on all our servers".
            _PLEA + r"[\s!,:-]{1,6}(?:\b(?:we|we're|we've|our|my|i|i'm|i've)\b[^.?!]{0,30}?)?" + _INCIDENT_NOUN,
            # 4. The incident, then a plea: "ransomware!!! help".
            _INCIDENT_NOUN + r"[\s!,:-]{0,6}(?:please\s+)?" + _PLEA,
        )
    )
)

#: Signs of an incident that a question to the business can explain away:
#: "is urgent help available on weekends?" asks about a service.
_SIGNAL_RE = re.compile(
    r"(?i)"
    + "|".join(
        (
            # 5. An incident described as happening: "an active incident on our network".
            r"\b(?:active|ongoing|live)\s+(?:security\s+|cyber\s*)?(?:incident|breach|attack|intrusion)\b",
            r"\b(?:breach|attack|ransomware|intrusion)\s+(?:is\s+)?(?:in\s+progress|underway)\b",
            r"\bransom\s+(?:note|demand)\b",
            # 6. A bare plea: "urgent help needed now". Not "urgent help with pricing"
            #    or "urgent help needed with GST filing", which name the topic.
            r"\b(?:urgent|emergency)\s+(?:help|assistance)\b"
            r"(?!\s+(?:with|on|for|about|regarding|to|in)\b)"
            r"(?!\s+(?:needed|required)\s+(?:with|for)\b)",
            # 7. Malware found on the visitor's machines: "malware on all our PCs".
            #    Not "we scan for malware on our servers".
            r"(?<!\bfor\s)\b(?:ransomware|malware)\s+(?:is\s+|are\s+)?(?:on|in|across)\s+"
            r"(?:all\s+(?:of\s+)?)?(?:our|my)\b",
        )
    )
)

# ── Stand-downs, judged on the clause that holds the match ────────────────────

#: Time words that keep an incident current: "we were hacked last week and they are still in".
_PRESENT_RE = re.compile(
    r"(?i)\b(?:still|currently|right\s+now|ongoing|in\s+progress|as\s+we\s+speak|at\s+the\s+moment)\b"
)

#: A hypothetical or a question about protection. Counted only when it comes
#: before the incident, so "we've been hacked, how do we recover?" stays a report.
_HYPOTHETICAL_RE = re.compile(
    r"(?i)\b(?:if|what\s+if|in\s+case|suppose|how\s+(?:do|would|can|to|does|should)|protect|prevent|avoid"
    r"|against|worried|afraid|concerned|could\s+(?:get|be)|would\s+(?:get|be))\b"
)

#: An incident in the past: "last year", "in 2023", "in the 2021 incident",
#: "hacked before so". "before they..." looks forward, so it is not past.
_PAST_RE = re.compile(
    r"(?i)\b(?:last\s+(?:week|month|year)|(?:days?|weeks?|months?|years?)\s+ago|in\s+(?:the\s+)?(?:19|20)\d{2}"
    r"|previously|in\s+the\s+past|back\s+in"
    r"|before(?!\s+(?:i|we|you|he|she|they|it|the|a|an|anyone|someone|everything)\b))\b"
)

#: A sentence that opens as a question to the business: "do you offer emergency
#: plumbing now?". A leading greeting is allowed so "hi, do you ..." reads the same.
_SERVICE_QUESTION_RE = re.compile(
    r"(?i)\s*(?:(?:hi|hello|hey)\b[\s,!]*)?(?:do|does|can|could|is|are|will|would|what|which)\b"
)

#: A sentence: rules never cross a full stop or a question mark. "!" stays inside
#: so "ransomware!!! help" is one sentence.
_SENTENCE_RE = re.compile(r"[^.?]+")

#: Where a clause ends inside a sentence.
_CLAUSE_BREAK_RE = re.compile(r"(?i)[,;:]|\b(?:but|so)\b")

#: Smart Link keywords that name the owner's emergency page. Not "urgent" or
#: "incident", which also label an "urgent delivery" page or an HR "incident report".
_EMERGENCY_KEYWORDS = frozenset({"emergency", "incident response"})


def _first_person_reports(sentence: str) -> Iterator[tuple[int, int]]:
    """Spans of rule 1: an incident verb with a first-person subject at most
    ``_MAX_SUBJECT_GAP`` characters before it, no third party and no "!" between
    them, and a subject that is not describing a service.

    Anchored on the verb, which is rare, rather than on the subject, which is
    everywhere: the scan stays linear even on "we we we ...".
    """
    for verb in _INCIDENT_VERB_RE.finditer(sentence):
        window_start = max(0, verb.start() - _MAX_SUBJECT_GAP - _LONGEST_SUBJECT)
        for subject in _SUBJECT_RE.finditer(sentence, window_start, verb.start()):
            gap = sentence[subject.end() : verb.start()]
            if (
                len(gap) > _MAX_SUBJECT_GAP
                or "!" in gap
                or _THIRD_PARTY_RE.search(gap)
                or _SERVICE_VERB_RE.match(sentence, subject.end())
            ):
                continue
            yield subject.start(), verb.end()
            break


class _Clauses:
    """The clauses of one sentence and the stand-down facts of each, computed
    at most once per clause however many matches fall inside it."""

    def __init__(self, sentence: str) -> None:
        self._sentence = sentence
        self._spans: list[tuple[int, int]] = []
        start = 0
        for brk in _CLAUSE_BREAK_RE.finditer(sentence):
            self._spans.append((start, brk.start()))
            start = brk.end()
        self._spans.append((start, len(sentence)))
        self._starts = [span_start for span_start, _ in self._spans]
        self._facts: dict[int, tuple[bool, bool, int | None]] = {}

    def _facts_of(self, index: int) -> tuple[bool, bool, int | None]:
        """(present, past, end of the first hypothetical marker) for one clause."""
        facts = self._facts.get(index)
        if facts is None:
            start, end = self._spans[index]
            clause = self._sentence[start:end]
            hypothetical = _HYPOTHETICAL_RE.search(clause)
            facts = (
                bool(_PRESENT_RE.search(clause)),
                bool(_PAST_RE.search(clause)),
                start + hypothetical.end() if hypothetical else None,
            )
            self._facts[index] = facts
        return facts

    def reports(self, start: int, end: int) -> bool:
        """Whether the match at ``start:end`` survives the stand-downs of its clauses."""
        first = bisect_right(self._starts, start) - 1
        last = max(first, bisect_right(self._starts, end - 1) - 1)
        facts = [self._facts_of(index) for index in range(first, last + 1)]
        if any(present for present, _, _ in facts):
            return True
        if any(marker_end is not None and marker_end <= end for _, _, marker_end in facts):
            return False
        return not any(past for _, past, _ in facts)


def _sentence_reports_incident(sentence: str) -> bool:
    clauses = _Clauses(sentence)
    if any(clauses.reports(start, end) for start, end in _first_person_reports(sentence)):
        return True
    if any(clauses.reports(match.start(), match.end()) for match in _REPORT_RE.finditer(sentence)):
        return True
    if _SERVICE_QUESTION_RE.match(sentence):
        return False
    return any(clauses.reports(match.start(), match.end()) for match in _SIGNAL_RE.finditer(sentence))


def is_urgent_incident(question: object) -> bool:
    """True when the visitor reports an incident happening to them, not one they ask about."""
    if not isinstance(question, str) or not question.strip():
        return False
    return any(_sentence_reports_incident(sentence.group(0)) for sentence in _SENTENCE_RE.finditer(question))


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
    repeat: bool = False,
) -> HandoffOffer:
    """The reply to an urgent incident. "Flagged" is only said on a plan whose team gets the alert.

    ``repeat`` is True when the team was already alerted in this conversation.
    The visitor gets new words that point at the same form instead of the
    identical text, and the same flags as the first reply. Neither duplicates
    anything: the widget re-opens the handoff form, and it shows the message
    card at most once per conversation, so the second flag is ignored there.
    """
    co = f"**{company_name}**" if company_name else "the team"
    urgent_link = f" If this is an active incident, don't wait for a reply: {emergency_url}" if emergency_url else ""
    if not support_enabled:
        # No team is alerted on this plan, so there is nothing to call a repeat.
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
    already_flagged = f"I've already flagged this to {co} as a priority."
    if not live_chat_enabled:
        text = (
            f"{already_flagged} Leave your details in the message form so they can reach you as soon as possible."
            if repeat
            else (
                f"This sounds urgent, so I've flagged it to {co} as a priority. I'll open a quick message form "
                f"so they can reach you as soon as possible."
            )
        )
        return HandoffOffer(text=text + urgent_link, suggest_handoff=False, needs_message_card=True)
    if team_available:
        text = (
            f"{already_flagged} The form is just below: share your details there and I'll connect you with them "
            "right away."
            if repeat
            else (
                f"This sounds urgent, so I've flagged it to {co} as a priority. Share your details in the form "
                f"below and I'll connect you with them right away."
            )
        )
        return HandoffOffer(text=text + urgent_link, suggest_handoff=True, needs_message_card=False)
    text = (
        f"{already_flagged} The form is just below: share your details there so they can reach you as soon as possible."
        if repeat
        else (
            "This sounds urgent. Our team is offline right now, but I've flagged it to them as a priority. "
            "Share your details in the form below so they can reach you as soon as possible."
        )
    )
    return HandoffOffer(text=text + urgent_link, suggest_handoff=True, needs_message_card=False)
