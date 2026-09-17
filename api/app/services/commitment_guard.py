"""A reply never states a service commitment as the company's own unless the reference does.

Production, 2026-09-17: the Eventus Security bot was asked "whats ur SLA for
patching critical CVEs? like in how many hours" and answered "We remediate
critical-severity findings within 48 hours." The only source was a general
best-practices page whose list read "Alert Triage SLAs: Remediate
critical-severity findings within 48 hours". Its URL has no article shape, so
``page_kind`` did not tag it, and the prompt rule alone did not stop the model.

This check runs on the finished answer, with no model call:

1. A sentence of the answer is a commitment when it speaks for the company
   ("we", "our", "us", the company's name, "you'll get") and states a
   commitment figure: a duration in minutes, hours, days or weeks in the same
   clause as a commitment word ("we respond in 15 min", "a 4-hour response")
   or right after a firm time bound ("within 48 hours", "under 5 minutes"),
   or a percentage with an uptime, availability or SLA word at most three
   words away in its clause ("our SLA is 99.9%"). "24x7", "founded in 2015",
   "over 500 customers", "24 hours a day", "a 30-minute call", "a 32 week
   rollout", "our webinar is in 3 days", the visitor's own timeline ("if you
   need it in 2 weeks") and "85% fewer false positives" are not.
2. Each figure of such a sentence needs support: a retrieved chunk that is not
   a general article (``page_kind``) and states the same figure. Durations are
   compared in minutes, so "48 hours", "48h", "48-hour" and "2 days" are one
   figure. An uploaded file (the owner chose it) and one of the company's
   terms pages by path ("/sla-support-tiers", "/terms", "/refund-policy")
   support every figure they hold. On any other crawled page a figure counts
   unless the sentence or bullet holding it reads as advice or an example
   (``_reads_as_advice``) with no first-person or company-name subject: the
   company's own pages state most figures with no subject ("Critical
   vulnerabilities are patched within 24 hours"), while the production
   source was a bullet list of imperatives ("Remediate critical-severity
   findings within 48 hours"). Text the owner wrote for the bot
   (instructions, description) supports any figure it contains.
3. An unsupported sentence is replaced by one gap sentence
   (``COMMITMENT_GAP_SENTENCE``), and any further one is dropped, so the figure
   never survives. When the sentence joins clauses (";", ", and", ", but"),
   only the unsupported clauses go, so "Our Starter plan is $49 per month, and
   setup takes under 5 minutes." keeps its price. The rest of the answer,
   including the team offer, stays.

Every pattern here is linear: open repeats are bounded or anchored on a literal,
and the answer and each chunk are read in bounded windows.
"""

from __future__ import annotations

import bisect
import re
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from urllib.parse import urlsplit

from app.services.page_kind import is_general_article, path_tokens

#: What replaces the first unsupported commitment sentence. The wording of the
#: answer prompt's gap rule, so a redacted reply reads like one the model wrote.
COMMITMENT_GAP_SENTENCE = "I don't have our exact figure for that."

#: An answer is read up to this many characters; a reply is far shorter.
_MAX_ANSWER_CHARS = 20_000
#: A chunk is read up to this many characters, the same bound the reference
#: context puts on it.
_MAX_CHUNK_CHARS = 5_000
#: How far a chunk sentence reaches from its figure in either direction.
_SENTENCE_REACH_CHARS = 300

_WORD_NUMBERS = {
    "one": 1.0,
    "two": 2.0,
    "three": 3.0,
    "four": 4.0,
    "five": 5.0,
    "six": 6.0,
    "seven": 7.0,
    "eight": 8.0,
    "nine": 9.0,
    "ten": 10.0,
    "eleven": 11.0,
    "twelve": 12.0,
    "fifteen": 15.0,
    "twenty": 20.0,
    "thirty": 30.0,
    "sixty": 60.0,
    "ninety": 90.0,
    "twenty-four": 24.0,
    "forty-eight": 48.0,
    "seventy-two": 72.0,
}

_NUM = (
    r"(?:\d{1,6}(?:\.\d{1,3})?|twenty-four|forty-eight|seventy-two|"
    + "|".join(sorted((w for w in _WORD_NUMBERS if "-" not in w), key=len, reverse=True))
    + r")"
)
_UNIT = r"(?:(?:business|working)[ -]days?|minutes?|mins?|hours?|hrs?|h|days?|weeks?)"
#: Every duration is compared in minutes, so "14 days" matches "2 weeks".
_MINUTES_PER_UNIT = {"minute": 1.0, "hour": 60.0, "day": 1440.0, "week": 10080.0}

#: A duration, alone or at the top of a range: "48 hours", "48-hour", "48hrs",
#: "1-2 business days", "24 to 48 hours" (both ends carry the unit), and the
#: legal "fifteen (15) days".
_DURATION_RE = re.compile(
    rf"(?<![\w.])(?P<low>{_NUM})(?:\s{{0,3}}(?:-|\u2013|to|or)\s{{0,3}}(?P<high>{_NUM}))?\)?\s{{0,3}}-?\s{{0,3}}"
    rf"(?P<unit>{_UNIT})(?![a-z0-9])",
    re.IGNORECASE,
)
#: A firm time bound just before a duration, a commitment on its own: "within
#: 48 hours", "under 2 days", "up to 4 hours", "\u2264 10 min". A bare "in" is
#: not one ("our webinar is in 3 days"). Read on a short slice.
_BOUND_BEFORE_RE = re.compile(
    r"(?:\b(?:within|under|below|less\s{1,3}than|no\s{1,3}more\s{1,3}than|at\s{1,3}most|up\s{1,3}to"
    r"|max(?:imum)?(?:\s{1,3}of)?)|\u2264|<=?)\s{0,3}(?:(?:just|about|around|roughly)\s{1,3})?$",
    re.IGNORECASE,
)
_BOUND_SLICE_CHARS = 60
#: A clause about a service commitment, where a duration is one whatever word
#: comes before it ("a 4-hour P1 response", "we respond in 15 min").
_COMMITMENT_CONTEXT_RE = re.compile(
    r"\b(?:slas?|slos?|service[ -]level|respon(?:se|ses|d|ds|ded|ding)|resol(?:ution|ve|ves|ved|ving)"
    r"|acknowledg\w{0,6}|turn\s{0,3}-?\s{0,3}around|remediat\w{0,5}|patch(?:es|ed|ing)?|guarantee[ds]?"
    r"|commit\w{0,6}|targets?|uptime|availability|onboard\w{0,4}|deliver\w{0,4}|deploy\w{0,5}|set\s{0,3}-?\s{0,3}up"
    r"|setups?|refund\w{0,3}|support\w{0,3}|fix(?:es|ed|ing)?|repl(?:y|ies|ied|ying)|get\s{1,3}back"
    r"|go-?\s{0,3}live|cancel\w{0,7})\b",
    re.IGNORECASE,
)
#: The visitor's own timeline just before a duration: "if you need it in 2
#: weeks", "your deadline in 10 days", "your timeline of 3 weeks". Read on
#: the same short slice as ``_BOUND_BEFORE_RE``.
_VISITOR_TIMELINE_RE = re.compile(
    r"(?:\byou\s{1,3}(?:need|want|require)\b(?:\s{1,3}(?:it|this|that|them|one|something)\b)?"
    r"(?:\s{1,3}(?:done|ready|live|delivered|shipped|finished|built)\b)?"
    r"|\byour\s{1,3}(?:own\s{1,3})?(?:timeline|deadline|target\s{1,3}date|launch|go-live|schedule|window)"
    r"(?:\s{1,3}(?:of|is))?)"
    r"\s{0,3}(?:(?:in|within|by|under)\s{1,3})?(?:(?:just|about|around)\s{1,3})?$",
    re.IGNORECASE,
)
#: A duration that is not a commitment: how long something runs each day or
#: week ("24 hours a day", "7 days a week"), or the length of a meeting ("a
#: 30-minute call").
_NOT_A_COMMITMENT_RE = re.compile(
    r"\s{0,3}(?:(?:a|per|each|every)\s{1,3}(?:day|week|month|year)\b"
    r"|(?:free\s{1,3})?(?:intro(?:duction|ductory)?\s{1,3})?"
    r"(?:call|calls|meeting|meetings|demo|demos|session|sessions|consultation|chat|webinar|walkthrough|video|read|briefing)\b)",
    re.IGNORECASE,
)
_PERCENT_RE = re.compile(rf"(?<![\w.])(?P<low>{_NUM})\s{{0,3}}(?:%|percent\b)", re.IGNORECASE)
#: A percentage is a commitment only with one of these words at most
#: ``_PERCENT_REACH_WORDS`` words away.
_PERCENT_CONTEXT_RE = re.compile(
    r"\b(?:uptime|availability|available|sla|slas|service[ -]level|guarantee[ds]?)\b", re.IGNORECASE
)
_PERCENT_REACH_WORDS = 3
_WORD_RE = re.compile(r"\S{1,80}")

#: The company speaking. "us" is read lowercase only, so "US-based" is not it.
_FIRST_PERSON_RE = re.compile(
    r"\b(?:we|our|ours)\b|\byou(?:['\u2019]ll|\s{1,3}will)\s{1,3}(?:get|receive|hear)\b", re.IGNORECASE
)
_LOWER_US_RE = re.compile(r"\bus\b")

#: Links and addresses are dropped before looking for the company's name,
#: which every URL on its own site carries.
_ADDRESS_RE = re.compile(r"https?://\S{1,2000}|www\.\S{1,2000}|[\w.+-]{1,64}@[\w-]{1,63}(?:\.[\w-]{1,63}){1,4}")
_DOMAIN_RE = re.compile(r"\b[\w-]{1,63}\.(?:com|net|org|io|dev|ai|co|in|app)\b", re.IGNORECASE)

#: The crawler's leading tags on a chunk: "[Document: url] [Page: 1] [Section: name]".
_CHUNK_TAGS_RE = re.compile(r"(?:\s{0,8}\[[^\]\n]{0,500}\])+")

#: Where a sentence ends inside a chunk: a line break, a list bullet, a
#: heading mark, or sentence punctuation (the Devanagari danda too) before
#: whitespace. A full stop after an abbreviation is skipped (``_ends_sentence``).
_CHUNK_BOUNDARY_RE = re.compile(r"\n|\s[*\u2022]\s|#{1,6}\s|(?P<stop>[.!?\u0964\u0965])(?=\s)")
#: Where a sentence ends inside an answer line.
_ANSWER_SENTENCE_END_RE = re.compile(r"(?P<stop>[.!?\u0964\u0965]+)(?:\s+|$)")
#: The word before a full stop that does not end a sentence: "e.g.", "i.e.",
#: "approx.", "vs.", "Dr.". "etc." ends one before a capital letter, and
#: "No." does not end one before a number ("clause No. 4").
_ABBREVIATION_RE = re.compile(r"(?:^|[^\w.])(?P<word>e\.g|i\.e|approx|vs|mr|mrs|ms|dr|etc|no)$", re.IGNORECASE)
_ABBREVIATION_REACH_CHARS = 8

#: Where independent clauses of one answer sentence join. Only these are
#: split, never a bare comma, so "Our SLA, for P1 incidents, is 4 hours." stays
#: one clause.
_CLAUSE_JOIN_RE = re.compile(r"(?:;|,\s{0,3}(?:and|but|while|whereas|so)\b)\s{0,3}", re.IGNORECASE)
_TRAILING_JOIN_RE = re.compile(r"\s{0,3}(?:;|,\s{0,3}(?:and|but|while|whereas|so))$", re.IGNORECASE)
_SENTENCE_STOPS = (".", "!", "?", "\u0964", "\u0965")

#: A chunk sentence that reads as advice or an example rather than the
#: company's own term: "e.g.", "for example", "should", "look for", "best
#: practice", "typically", "aim for", "demand".
_ADVICE_RE = re.compile(
    r"\be\.g\b|\bfor\s{1,3}example\b|\bshould\b|\bmust\b|\blook\s{1,3}for\b|\bask\s{1,3}your\s{1,3}provider\b"
    r"|\bbest\s{1,3}practices?\b|\brecommended\b|\btypically\b|\baim\s{1,3}for\b|(?<![\w-])demand\b",
    re.IGNORECASE,
)
#: A change, which is a result rather than a term: "fell from 48 hours to 4 hours".
_CHANGE_RE = re.compile(r"\bfrom\s{1,3}\d[\d.,]{0,10}\s{0,3}[a-z-]{0,12}\s{1,3}to\s{1,3}\d", re.IGNORECASE)
#: A bare imperative opening a sentence, a bullet or the text after a colon:
#: the shape of a checklist ("Remediate critical-severity findings within 48 hours").
_IMPERATIVE_RE = re.compile(
    r"(?:remediate|address|ensure|implement|establish|conduct|review|patch|monitor|define|set|track|require"
    r"|use|schedule|perform|maintain)\b",
    re.IGNORECASE,
)
#: List markers, heading marks and emphasis before a sentence's first word.
_LEAD_MARKS_RE = re.compile(r"[\s*_#>\u2022-]{0,40}(?:\d{1,3}[.)]\s{1,4})?[\s*_]{0,10}")
#: A colon before the next words, and what may sit between them.
_COLON_RE = re.compile(r":\s{1,4}[*_]{0,4}")
#: A short label before a colon or a spaced dash ("Patch releases: As needed"),
#: whose first word is a noun, not an imperative.
_LABEL_SEPARATOR_RE = re.compile(r":\s|\s[-\u2013\u2014]\s")
_LABEL_REACH_CHARS = 80
_LABEL_MAX_WORDS = 4
#: A list marker or quote at the start of an answer line.
_LINE_MARKER_RE = re.compile(r"\s{0,8}(?:[-*+\u2022]\s{1,4}|\d{1,3}[.)]\s{1,4}|>\s{0,4})?")

#: Path words of the company's own terms pages. A figure there is the
#: company's, whoever the sentence names ("The target uptime is 99.9%").
#: "policy", "trust" and "support" are absent: on a security company's site
#: "/cyber-policy/", "/zero-trust/" and "...-support-work-in-practice/" are
#: topic pages (Eventus knowledge base, 2026-09-17).
_TERMS_PAGE_TOKENS = frozenset(
    {"sla", "slas", "terms", "legal", "pricing", "plans", "tiers", "refund", "refunds", "cancellation"}
)
_SERVICE_LEVEL_RE = re.compile(r"service[-_]?level")
_NAME_SPLIT_RE = re.compile(r"[^a-z0-9]+")


@dataclass(frozen=True)
class ReferenceChunk:
    """A retrieved chunk's name and text, read once so the check touches no ORM row."""

    document_name: str
    content: str


def snapshot_chunks(chunks: Iterable[object]) -> tuple[ReferenceChunk, ...]:
    """``chunks`` as plain ``ReferenceChunk`` values, each text cut to what the check reads."""
    return tuple(
        ReferenceChunk(
            document_name=str(getattr(chunk, "document_name", "") or ""),
            content=str(getattr(chunk, "content", "") or "")[:_MAX_CHUNK_CHARS],
        )
        for chunk in chunks
    )


@dataclass(frozen=True)
class CommitmentRedaction:
    """The answer with every unsupported commitment sentence handled.

    ``figures`` names the unsupported figures, in answer order, for the metric.
    With nothing to change, ``text`` is the answer unchanged.
    """

    text: str
    figures: tuple[str, ...]

    @property
    def redacted(self) -> bool:
        return bool(self.figures)


def _number(token: str) -> float | None:
    word = token.casefold()
    if word in _WORD_NUMBERS:
        return _WORD_NUMBERS[word]
    try:
        return float(word)
    except ValueError:
        return None


def _unit(token: str) -> str:
    word = token.casefold()
    if word.startswith(("min",)):
        return "minute"
    if word == "h" or word.startswith(("hour", "hr")):
        return "hour"
    if word.startswith("week"):
        return "week"
    return "day"


def _duration_keys(match: re.Match[str]) -> list[tuple[float, str]]:
    """The duration's figures in minutes: one, or both ends of a range."""
    factor = _MINUTES_PER_UNIT[_unit(match.group("unit").split()[-1].split("-")[-1])]
    keys = []
    for name in ("low", "high"):
        token = match.group(name)
        value = _number(token) if token else None
        if value is not None:
            keys.append((value * factor, "minute"))
    return keys


def _percent_in_context(text: str, match: re.Match[str]) -> bool:
    """Whether an uptime, availability or SLA word is at most three words from the percentage."""
    reach = _PERCENT_REACH_WORDS
    before = _WORD_RE.findall(text[max(0, match.start() - 80 * reach) : match.start()])[-reach:]
    after = _WORD_RE.findall(text[match.end() : match.end() + 80 * reach])[:reach]
    return _PERCENT_CONTEXT_RE.search(" ".join((*before, *after))) is not None


def _figures(text: str, *, commitments_only: bool) -> list[tuple[tuple[float, str], int, str]]:
    """Each figure in ``text``: its key, where it starts, and how it reads.

    With ``commitments_only``, ``text`` is one clause of an answer: a duration
    needs a commitment word in it or a firm time bound right before it, one
    that runs each day, names a meeting's length or is the visitor's own
    timeline is skipped, and a percentage needs an uptime word near it.
    """
    found: list[tuple[tuple[float, str], int, str]] = []
    in_context = commitments_only and _COMMITMENT_CONTEXT_RE.search(text) is not None
    for match in _DURATION_RE.finditer(text):
        if commitments_only:
            if _NOT_A_COMMITMENT_RE.match(text, match.end()):
                continue
            before = text[max(0, match.start() - _BOUND_SLICE_CHARS) : match.start()]
            if _VISITOR_TIMELINE_RE.search(before) is not None:
                continue
            if not in_context and _BOUND_BEFORE_RE.search(before) is None:
                continue
        for key in _duration_keys(match):
            found.append((key, match.start(), match.group(0)))
    if not commitments_only or _PERCENT_CONTEXT_RE.search(text):
        for match in _PERCENT_RE.finditer(text):
            value = _number(match.group("low"))
            if value is not None and (not commitments_only or _percent_in_context(text, match)):
                found.append(((value, "percent"), match.start(), match.group(0)))
    return found


def _ends_sentence(text: str, stop: re.Match[str], after: int) -> bool:
    """Whether the punctuation ``stop`` ends a sentence, with the next word at ``after``.

    Only a single full stop can belong to an abbreviation.
    """
    if stop.group("stop") != ".":
        return True
    abbreviation = _ABBREVIATION_RE.search(text[max(0, stop.start() - _ABBREVIATION_REACH_CHARS) : stop.start()])
    if abbreviation is None:
        return True
    word = abbreviation.group("word").casefold()
    following = text[after : after + 1]
    if word == "etc":
        return following.isupper()
    if word == "no":
        return not following.isdigit()
    return False


def _reads_as_advice(sentence: str) -> bool:
    """Whether a chunk sentence or bullet reads as advice or an example, not a stated term.

    It does when it has an advice or example word, states a change, or opens
    with a bare imperative, at its start (unless that is a short label such as
    "Patch releases:") or right after a colon ("Alert Triage SLAs: Remediate ...").
    """
    if _ADVICE_RE.search(sentence) or _CHANGE_RE.search(sentence):
        return True
    lead = sentence[_LEAD_MARKS_RE.match(sentence).end() :]  # type: ignore[union-attr]  # every part is optional
    label = _LABEL_SEPARATOR_RE.search(lead, 0, _LABEL_REACH_CHARS)
    is_label = label is not None and len(lead[: label.start()].split()) <= _LABEL_MAX_WORDS
    if not is_label and _IMPERATIVE_RE.match(lead):
        return True
    return any(_IMPERATIVE_RE.match(sentence, colon.end()) for colon in _COLON_RE.finditer(sentence))


def _company_name_re(company_name: str | None) -> re.Pattern[str] | None:
    """The company's name as words: the whole name, or its first word when that is distinctive."""
    words = [word for word in _NAME_SPLIT_RE.split((company_name or "").casefold()) if word]
    if not words:
        return None
    options = [r"\s{1,3}".join(re.escape(word) for word in words), re.escape("".join(words))]
    if len(words[0]) >= 4:
        options.append(re.escape(words[0]))
    return re.compile(r"\b(?:" + "|".join(options) + r")\b", re.IGNORECASE)


def _speaks_for_company(text: str, company_re: re.Pattern[str] | None) -> bool:
    if _FIRST_PERSON_RE.search(text) or _LOWER_US_RE.search(text):
        return True
    if company_re is None:
        return False
    return company_re.search(_DOMAIN_RE.sub(" ", _ADDRESS_RE.sub(" ", text))) is not None


def _is_terms_page(document_name: str) -> bool:
    if not path_tokens(document_name).isdisjoint(_TERMS_PAGE_TOKENS):
        return True
    return _SERVICE_LEVEL_RE.search(urlsplit(document_name.strip().casefold()).path) is not None


def _is_uploaded(document_name: str) -> bool:
    return not document_name.strip().casefold().startswith(("http://", "https://"))


def _chunk_body(content: str) -> str:
    body = content[:_MAX_CHUNK_CHARS]
    tags = _CHUNK_TAGS_RE.match(body)
    return body[tags.end() :] if tags else body


def _chunk_sentence(body: str, boundaries: list[int], position: int) -> str:
    """The sentence of ``body`` around ``position``, at most ``_SENTENCE_REACH_CHARS`` either way."""
    index = bisect.bisect_right(boundaries, position)
    start = boundaries[index - 1] if index > 0 else 0
    end = boundaries[index] if index < len(boundaries) else len(body)
    return body[max(start, position - _SENTENCE_REACH_CHARS) : min(end, position + _SENTENCE_REACH_CHARS)]


def supported_figures(
    chunks: Iterable[object],
    *,
    company_name: str | None,
    owner_texts: Iterable[str | None] = (),
) -> frozenset[tuple[float, str]]:
    """The figures the reference states as the company's own.

    ``chunks`` are retrieved chunks with ``content`` and ``document_name``.
    """
    company_re = _company_name_re(company_name)
    supported: set[tuple[float, str]] = set()
    for text in owner_texts:
        if text:
            supported.update(key for key, _, _ in _figures(text[:_MAX_CHUNK_CHARS], commitments_only=False))
    for chunk in chunks:
        name = str(getattr(chunk, "document_name", "") or "")
        content = getattr(chunk, "content", None)
        if not isinstance(content, str) or not content:
            continue
        if is_general_article(name, company_name):
            continue
        body = _chunk_body(content)
        figures = _figures(body, commitments_only=False)
        if not figures:
            continue
        if _is_uploaded(name) or _is_terms_page(name):
            supported.update(key for key, _, _ in figures)
            continue
        boundaries = [
            match.end()
            for match in _CHUNK_BOUNDARY_RE.finditer(body)
            if match.group("stop") is None or _ends_sentence(body, match, match.end() + 1)
        ]
        for key, position, _ in figures:
            if key in supported:
                continue
            sentence = _chunk_sentence(body, boundaries, position)
            if _speaks_for_company(sentence, company_re) or not _reads_as_advice(sentence):
                supported.add(key)
    return frozenset(supported)


def _answer_units(line: str) -> list[str]:
    """``line`` cut into sentences, each with the whitespace after it."""
    units: list[str] = []
    start = 0
    for match in _ANSWER_SENTENCE_END_RE.finditer(line):
        if not _ends_sentence(line, match, match.end()):
            continue
        units.append(line[start : match.end()])
        start = match.end()
    if start < len(line):
        units.append(line[start:])
    return units


def _clauses(unit: str) -> list[str]:
    """``unit`` cut where independent clauses join, each piece with its joining words."""
    pieces: list[str] = []
    start = 0
    for match in _CLAUSE_JOIN_RE.finditer(unit):
        pieces.append(unit[start : match.end()])
        start = match.end()
    pieces.append(unit[start:])
    return [piece for piece in pieces if piece]


def _kept_clauses(kept: list[str], terminal: str) -> str:
    """The clauses left of a sentence, read as a sentence of their own."""
    text = _TRAILING_JOIN_RE.sub("", "".join(kept).strip()).rstrip(" ,")
    if not text.endswith(_SENTENCE_STOPS):
        text += terminal
    return text[:1].upper() + text[1:]


def redact_unsupported_commitments(
    answer: str,
    chunks: Sequence[object],
    *,
    company_name: str | None,
    owner_texts: Iterable[str | None] = (),
) -> CommitmentRedaction:
    """``answer`` with each commitment sentence the reference does not support handled.

    The first becomes ``COMMITMENT_GAP_SENTENCE``; any later one is dropped.
    """
    if not answer or len(answer) > _MAX_ANSWER_CHARS or not (_DURATION_RE.search(answer) or "%" in answer):
        return CommitmentRedaction(answer, ())
    company_re = _company_name_re(company_name)
    supported: frozenset[tuple[float, str]] | None = None
    unsupported: list[str] = []
    gap_placed = False
    lines_out: list[str] = []
    for line in answer.split("\n"):
        marker = _LINE_MARKER_RE.match(line)
        prefix = marker.group(0) if marker else ""
        units_out: list[str] = []
        changed = False
        for unit in _answer_units(line[len(prefix) :]):
            clauses = _clauses(unit)
            figures = [_figures(clause, commitments_only=True) for clause in clauses]
            if not any(figures) or not _speaks_for_company(unit, company_re):
                units_out.append(unit)
                continue
            if supported is None:
                supported = supported_figures(chunks, company_name=company_name, owner_texts=owner_texts)
            missing = [[shown for key, _, shown in found if key not in supported] for found in figures]
            if not any(missing):
                units_out.append(unit)
                continue
            changed = True
            for shown in missing:
                unsupported.extend(shown)
            stripped = unit.rstrip()
            trailing = unit[len(stripped) :] or " "
            kept = [clause for clause, shown in zip(clauses, missing, strict=True) if not shown]
            terminal = stripped[-1] if stripped.endswith(_SENTENCE_STOPS) else "."
            lead = _kept_clauses(kept, terminal) + " " if kept else ""
            if not gap_placed:
                gap_placed = True
                units_out.append(lead + COMMITMENT_GAP_SENTENCE + trailing)
            elif lead:
                units_out.append(lead.rstrip() + trailing)
        if not changed:
            lines_out.append(line)
            continue
        # A line, or a list item, left with nothing else goes.
        rest = "".join(units_out).rstrip()
        if rest:
            lines_out.append(prefix + rest)
    if not unsupported:
        return CommitmentRedaction(answer, ())
    text = re.sub(r"\n{3,}", "\n\n", "\n".join(lines_out)).strip()
    return CommitmentRedaction(text, tuple(dict.fromkeys(unsupported)))
