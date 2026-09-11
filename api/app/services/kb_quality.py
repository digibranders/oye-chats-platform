"""Pure detectors for knowledge-base content that is not a statement of fact.

Used by ``scripts/kb_junk_report.py`` today and intended for the ingestion
pipeline in Phase 2.

Production, 2026-09-10: Eventus told visitors it operates in about 250
countries. The chunk was a crawled form's country dropdown, ingested as
knowledge and then read back by the LLM as a fact. CleanStart separately
handed out "(555) 123-4567", a placeholder phone number left on its own
site. Both detectors below are pure functions over chunk text, no I/O, so
they can run in a read-only report (Phase 0) and later at ingestion time
(Phase 2) without any behavior difference between the two call sites.
"""

from __future__ import annotations

import re

# ── Option lists (dropdowns, filters) mistaken for facts ────────────────────
#
# A crawled form's <select> options land in the knowledge base as ordinary
# prose-looking text ("Afghanistan Albania Algeria ..."). Nobody wrote a
# sentence claiming "we operate in these 190 countries"; the crawler just
# captured every <option> on a country picker. The signal that separates
# this from real prose ("we have offices in India and Canada") is *how many
# distinct places are named with no connecting language*. Prose about a
# handful of countries is normal; a chunk naming 25+ distinct countries (or
# 20+ distinct US or Indian states) is a dropdown, not a fact.

_COUNTRY_NAMES = frozenset(
    [
        "afghanistan",
        "albania",
        "algeria",
        "argentina",
        "armenia",
        "australia",
        "austria",
        "azerbaijan",
        "bahamas",
        "bahrain",
        "bangladesh",
        "barbados",
        "belarus",
        "belgium",
        "belize",
        "benin",
        "bermuda",
        "bhutan",
        "bolivia",
        "botswana",
        "brazil",
        "bulgaria",
        "cambodia",
        "cameroon",
        "canada",
        "chile",
        "china",
        "colombia",
        "croatia",
        "cuba",
        "cyprus",
        "denmark",
        "ecuador",
        "egypt",
        "estonia",
        "ethiopia",
        "fiji",
        "finland",
        "france",
        "georgia",
        "germany",
        "ghana",
        "greece",
        "guatemala",
        "honduras",
        "hungary",
        "iceland",
        "india",
        "indonesia",
        "iran",
        "iraq",
        "ireland",
        "israel",
        "italy",
        "jamaica",
        "japan",
        "jordan",
        "kazakhstan",
        "kenya",
        "kuwait",
        "latvia",
        "lebanon",
        "libya",
        "lithuania",
        "luxembourg",
        "malaysia",
        "maldives",
        "malta",
        "mexico",
        "moldova",
        "monaco",
        "mongolia",
        "morocco",
        "nepal",
        "netherlands",
        "nigeria",
        "norway",
        "oman",
        "pakistan",
        "panama",
        "paraguay",
        "peru",
        "philippines",
        "poland",
        "portugal",
        "qatar",
        "romania",
        "russia",
        "rwanda",
        "senegal",
        "serbia",
        "singapore",
        "slovakia",
        "slovenia",
        "somalia",
        "spain",
        "sudan",
        "sweden",
        "switzerland",
        "syria",
        "taiwan",
        "tanzania",
        "thailand",
        "tunisia",
        "turkey",
        "uganda",
        "ukraine",
        "uruguay",
        "uzbekistan",
        "venezuela",
        "vietnam",
        "yemen",
        "zambia",
        "zimbabwe",
    ]
)

_US_STATES = frozenset(
    [
        "alabama",
        "alaska",
        "arizona",
        "arkansas",
        "california",
        "colorado",
        "connecticut",
        "delaware",
        "florida",
        "georgia",
        "hawaii",
        "idaho",
        "illinois",
        "indiana",
        "iowa",
        "kansas",
        "kentucky",
        "louisiana",
        "maine",
        "maryland",
        "massachusetts",
        "michigan",
        "minnesota",
        "mississippi",
        "missouri",
        "montana",
        "nebraska",
        "nevada",
        "new hampshire",
        "new jersey",
        "new mexico",
        "new york",
        "north carolina",
        "north dakota",
        "ohio",
        "oklahoma",
        "oregon",
        "pennsylvania",
        "rhode island",
        "south carolina",
        "south dakota",
        "tennessee",
        "texas",
        "utah",
        "vermont",
        "virginia",
        "washington",
        "west virginia",
        "wisconsin",
        "wyoming",
    ]
)

_INDIAN_STATES = frozenset(
    [
        "andhra pradesh",
        "arunachal pradesh",
        "assam",
        "bihar",
        "chhattisgarh",
        "goa",
        "gujarat",
        "haryana",
        "himachal pradesh",
        "jharkhand",
        "karnataka",
        "kerala",
        "madhya pradesh",
        "maharashtra",
        "manipur",
        "meghalaya",
        "mizoram",
        "nagaland",
        "odisha",
        "punjab",
        "rajasthan",
        "sikkim",
        "tamil nadu",
        "telangana",
        "tripura",
        "uttar pradesh",
        "uttarakhand",
        "west bengal",
    ]
)

#: How many distinct country names make a chunk a list of options rather than prose.
OPTION_LIST_MIN_COUNTRIES = 25
#: How many distinct US or Indian state names make a chunk a list of options.
OPTION_LIST_MIN_STATES = 20


def _compile_phrase_alternation(phrases: frozenset[str]) -> re.Pattern[str]:
    """Build one word-bounded alternation, longest phrase first.

    Longest-first only matters for match *extent* (so "new york" is not cut
    short by a shorter alternative sharing a prefix); ``\\b`` on both ends
    already keeps every phrase's matches distinct for our purposes (we only
    count how many distinct phrases occur, not where).
    """
    ordered = sorted(phrases, key=len, reverse=True)
    return re.compile(r"\b(?:" + "|".join(re.escape(p) for p in ordered) + r")\b")


_COUNTRY_PATTERN = _compile_phrase_alternation(_COUNTRY_NAMES)
_US_STATE_PATTERN = _compile_phrase_alternation(_US_STATES)
_INDIAN_STATE_PATTERN = _compile_phrase_alternation(_INDIAN_STATES)


def is_option_list(content: str) -> bool:
    """True if ``content`` reads like a dropdown of countries or states.

    Linear in ``len(content)``: three single-pass regex scans, no nested
    quantifiers, no backtracking blowup risk.
    """
    text = (content or "").lower()
    countries = len(set(_COUNTRY_PATTERN.findall(text)))
    if countries >= OPTION_LIST_MIN_COUNTRIES:
        return True
    us_states = len(set(_US_STATE_PATTERN.findall(text)))
    if us_states >= OPTION_LIST_MIN_STATES:
        return True
    indian_states = len(set(_INDIAN_STATE_PATTERN.findall(text)))
    return indian_states >= OPTION_LIST_MIN_STATES


# ── Placeholder contacts (never a real phone number, email or address) ──────
#
# Each pattern below matches text that is never a genuine contact detail:
# either it is a stock placeholder ("example.com", "123-456-7890", "lorem
# ipsum") that template and starter-site authors leave behind, or it falls in
# a block NANPA reserves for fiction (555-01XX, in *any* North American area
# code). Real-looking numbers that merely contain the digits "555" without
# occupying one of those two shapes (e.g. an Indian landline "022 5551
# 2345") are deliberately left alone; the word-boundary anchors below are
# what keeps them out.
#
# Every local part is bounded (``{1,64}``) so email matching stays linear
# even on pathological input.
_PLACEHOLDER_PATTERNS = (
    # "(555) 123-4567": 555 used as an area code. This is the exact shape
    # that CleanStart's own site gave out as its phone number.
    re.compile(r"\(?\b555\)?[\s.-]?\d{3}[\s.-]?\d{4}\b"),
    # A real area code followed by the 555 exchange and a subscriber number
    # in 0100-0199: NANPA's block reserved for fiction, never assigned to a
    # real subscriber even when the surrounding text claims otherwise.
    re.compile(r"\b\d{3}[\s.-]?555[\s.-]?01\d{2}\b"),
    # Digit-placeholder phone shapes template authors leave in place.
    re.compile(r"(?i)\bxxx[\s.-]?xxx[\s.-]?xxxx\b"),
    re.compile(r"\b000[\s.-]?000[\s.-]?0000\b"),
    re.compile(r"\(?\b123\)?[\s.-]?456[\s.-]?7890\b"),
    re.compile(r"\b1234567890\b"),
    # Placeholder email domains and local parts.
    re.compile(
        r"(?i)\b[\w.+-]{1,64}@(?:example\.(?:com|org|net)|yourdomain\.com|domain\.com|company\.com|email\.com)\b"
    ),
    re.compile(r"(?i)\byourname@[\w.-]{1,64}\b"),
    # Placeholder street address.
    re.compile(r"(?i)\b123\s+main\s+st(?:reet)?\b"),
    # Filler text.
    re.compile(r"(?i)\blorem ipsum\b"),
)


def placeholder_contacts(content: str) -> list[str]:
    """Return the placeholder phone numbers, emails and text found in ``content``.

    Never returns unrelated chunk content, only the matched placeholder
    substrings themselves, so a caller can log or display the result without
    leaking anything else in the chunk.
    """
    text = content or ""
    found: list[str] = []
    for pattern in _PLACEHOLDER_PATTERNS:
        for match in pattern.finditer(text):
            raw = match.group(0)
            value = raw.lower() if "lorem" in raw.lower() else raw
            if value not in found:
                found.append(value)
    return found
