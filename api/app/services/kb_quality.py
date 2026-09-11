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

2026-09-11 review: the first version conflated two different things under
one boolean. "25 country names with nothing but whitespace and dial codes
between them" is a scraped <select> element. "25 country names joined by
commas and 'and', in a sentence about where the company operates" is a
real coverage claim that happens to name a lot of places, and deleting it
on a bot owner's behalf would delete correct content. The same review
found that the placeholder-contact patterns fired on documentation
examples (a CLI flag, a JSON sample, a YAML config) at least as often as
on genuine leaked placeholders, so placeholder matches now carry whether
they sit inside that kind of example.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from typing import Literal

# ── Option lists (dropdowns, filters) mistaken for facts ────────────────────
#
# A crawled form's <select> options land in the knowledge base as ordinary
# prose-looking text ("Afghanistan Albania Algeria ..."). Nobody wrote a
# sentence claiming "we operate in these 190 countries"; the crawler just
# captured every <option> on a country picker. The signal that separates
# this from real prose ("we have offices in India and Canada") is *how many
# distinct places are named with no connecting language*. Prose about a
# handful of countries is normal; a chunk naming 25+ distinct countries (or
# 20+ distinct US or Indian states) with picker-shaped separators (nothing
# but whitespace, dial codes and list debris between names) is a dropdown.
# The same density written with commas and "and" is a real coverage list
# and gets a lower-priority "check before removing" callout instead.

# Full ISO 3166-1 country and territory short names, plus common alternate
# forms a real site is likely to use (official short name is not always
# what a marketing page or a phone-input picker prints). Matched case- and
# accent-insensitively (see ``_fold``), longest phrase first, so a name
# that is a prefix of a longer one ("Guinea" inside "Papua New Guinea")
# never steals the shorter match out from under the longer one.
_COUNTRY_NAMES = frozenset(
    [
        "afghanistan",
        "åland islands",
        "albania",
        "algeria",
        "american samoa",
        "andorra",
        "angola",
        "anguilla",
        "antarctica",
        "antigua and barbuda",
        "argentina",
        "armenia",
        "aruba",
        "ascension island",
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
        "bonaire",
        "bosnia and herzegovina",
        "botswana",
        "bouvet island",
        "brazil",
        "british indian ocean territory",
        "british virgin islands",
        "brunei",
        "bulgaria",
        "burkina faso",
        "burundi",
        "cabo verde",
        "cape verde",
        "cambodia",
        "cameroon",
        "canada",
        "caribbean netherlands",
        "cayman islands",
        "central african republic",
        "chad",
        "chile",
        "china",
        "christmas island",
        "cocos islands",
        "cocos (keeling) islands",
        "colombia",
        "comoros",
        "democratic republic of the congo",
        "republic of the congo",
        "congo",
        "cook islands",
        "costa rica",
        "croatia",
        "cuba",
        "curaçao",
        "cyprus",
        "czech republic",
        "czechia",
        "denmark",
        "djibouti",
        "dominica",
        "dominican republic",
        "ecuador",
        "egypt",
        "el salvador",
        "equatorial guinea",
        "eritrea",
        "estonia",
        "eswatini",
        "swaziland",
        "ethiopia",
        "falkland islands",
        "faroe islands",
        "fiji",
        "finland",
        "france",
        "french guiana",
        "french polynesia",
        "french southern territories",
        "gabon",
        "gambia",
        "georgia",
        "germany",
        "ghana",
        "gibraltar",
        "greece",
        "greenland",
        "grenada",
        "guadeloupe",
        "guam",
        "guatemala",
        "guernsey",
        "guinea-bissau",
        "guinea",
        "guyana",
        "haiti",
        "heard island and mcdonald islands",
        "honduras",
        "hong kong",
        "hungary",
        "iceland",
        "india",
        "indonesia",
        "iran",
        "iraq",
        "ireland",
        "isle of man",
        "israel",
        "italy",
        "ivory coast",
        "côte d'ivoire",
        "cote d'ivoire",
        "jamaica",
        "japan",
        "jersey",
        "jordan",
        "kazakhstan",
        "kenya",
        "kiribati",
        "kosovo",
        "kuwait",
        "kyrgyzstan",
        "laos",
        "latvia",
        "lebanon",
        "lesotho",
        "liberia",
        "libya",
        "liechtenstein",
        "lithuania",
        "luxembourg",
        "macao",
        "macau",
        "madagascar",
        "malawi",
        "malaysia",
        "maldives",
        "mali",
        "malta",
        "marshall islands",
        "martinique",
        "mauritania",
        "mauritius",
        "mayotte",
        "mexico",
        "micronesia",
        "moldova",
        "monaco",
        "mongolia",
        "montenegro",
        "montserrat",
        "morocco",
        "mozambique",
        "myanmar",
        "burma",
        "namibia",
        "nauru",
        "nepal",
        "netherlands",
        "new caledonia",
        "new zealand",
        "nicaragua",
        "niger",
        "nigeria",
        "niue",
        "norfolk island",
        "north korea",
        "north macedonia",
        "macedonia",
        "northern mariana islands",
        "norway",
        "oman",
        "pakistan",
        "palau",
        "palestine",
        "palestinian territory",
        "panama",
        "papua new guinea",
        "paraguay",
        "peru",
        "philippines",
        "pitcairn islands",
        "pitcairn",
        "poland",
        "portugal",
        "puerto rico",
        "qatar",
        "réunion",
        "reunion",
        "romania",
        "russia",
        "russian federation",
        "rwanda",
        "saint barthélemy",
        "saint helena",
        "saint kitts and nevis",
        "saint lucia",
        "saint martin",
        "saint pierre and miquelon",
        "saint vincent and the grenadines",
        "samoa",
        "san marino",
        "sao tome and principe",
        "são tomé and príncipe",
        "saudi arabia",
        "senegal",
        "serbia",
        "seychelles",
        "sierra leone",
        "singapore",
        "sint maarten",
        "slovakia",
        "slovenia",
        "solomon islands",
        "somalia",
        "south africa",
        "south georgia",
        "south korea",
        "south sudan",
        "spain",
        "sri lanka",
        "sudan",
        "suriname",
        "svalbard and jan mayen",
        "svalbard",
        "sweden",
        "switzerland",
        "syria",
        "taiwan",
        "tajikistan",
        "tanzania",
        "thailand",
        "timor-leste",
        "east timor",
        "togo",
        "tokelau",
        "tonga",
        "trinidad and tobago",
        "tunisia",
        "turkiye",
        "türkiye",
        "turkey",
        "turkmenistan",
        "turks and caicos islands",
        "tuvalu",
        "uganda",
        "ukraine",
        "united arab emirates",
        "united kingdom",
        "united states minor outlying islands",
        "united states",
        "uruguay",
        "uzbekistan",
        "vanuatu",
        "vatican city",
        "holy see",
        "venezuela",
        "vietnam",
        "viet nam",
        "british virgin islands",
        "us virgin islands",
        "wallis and futuna",
        "western sahara",
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

#: A category is "form_options" only when at least this fraction of the gaps
#: between consecutive matches look like picker debris rather than prose.
_FORM_OPTIONS_GAP_THRESHOLD = 0.8


def _fold(text: str) -> str:
    """Lowercase and strip accents, so "Côte d'Ivoire" and "cote d'ivoire" match.

    NFKD decomposes an accented letter into the base letter plus a
    combining mark; dropping every combining-mark codepoint leaves the
    plain ASCII-ish base letter behind.
    """
    decomposed = unicodedata.normalize("NFKD", text)
    stripped = "".join(ch for ch in decomposed if not unicodedata.combining(ch))
    return stripped.lower()


def _compile_phrase_alternation(phrases: frozenset[str]) -> re.Pattern[str]:
    """Build one word-bounded alternation, longest phrase first.

    Longest-first matters for match *extent*: ``re`` alternation takes the
    first alternative that matches at a given position, not the longest
    one, so without this ordering a short phrase that is a prefix of a
    longer one at the same starting position ("Guinea" at the start of
    "Guinea-Bissau") would win and truncate the match, and the two would
    then be miscounted as separate distinct names.
    """
    ordered = sorted((_fold(p) for p in phrases), key=len, reverse=True)
    return re.compile(r"\b(?:" + "|".join(re.escape(p) for p in ordered) + r")\b")


_COUNTRY_PATTERN = _compile_phrase_alternation(_COUNTRY_NAMES)
_US_STATE_PATTERN = _compile_phrase_alternation(_US_STATES)
_INDIAN_STATE_PATTERN = _compile_phrase_alternation(_INDIAN_STATES)

# Text that separates two consecutive picker entries and nothing else: list
# bullets, a dial code ("+93"), a result count ("244 results found"), the
# picker's own chrome ("Select a country", "-- Select --"). Stripped out one
# kind at a time; whatever whitespace is left over decides the verdict.
_DIAL_CODE_RE = re.compile(r"\+\d{1,4}")
_PICKER_WORDS_RE = re.compile(r"(?i)\b(?:select|choose|results?\s+found)\b")
_BULLET_RE = re.compile(r"[\-\*•\d]")


def _is_picker_gap(gap: str) -> bool:
    cleaned = _DIAL_CODE_RE.sub(" ", gap)
    cleaned = _PICKER_WORDS_RE.sub(" ", cleaned)
    cleaned = _BULLET_RE.sub(" ", cleaned)
    return cleaned.strip() == ""


@dataclass(frozen=True)
class OptionListMatch:
    """One place-name category that reached the option-list density threshold."""

    kind: Literal["form_options", "place_list"]
    category: Literal["countries", "us_states", "indian_states"]
    distinct_count: int


def _category_match(
    pattern: re.Pattern[str], text: str, minimum: int, category: Literal["countries", "us_states", "indian_states"]
) -> OptionListMatch | None:
    matches = list(pattern.finditer(text))
    distinct_count = len({m.group(0) for m in matches})
    if distinct_count < minimum:
        return None

    gaps = [text[a.end() : b.start()] for a, b in zip(matches, matches[1:], strict=False)]
    picker_gaps = sum(1 for gap in gaps if _is_picker_gap(gap))
    fraction_picker = (picker_gaps / len(gaps)) if gaps else 1.0
    kind: Literal["form_options", "place_list"] = (
        "form_options" if fraction_picker >= _FORM_OPTIONS_GAP_THRESHOLD else "place_list"
    )
    return OptionListMatch(kind=kind, category=category, distinct_count=distinct_count)


def option_list_match(content: str) -> OptionListMatch | None:
    """Classify ``content`` as a form's option list, a prose place list, or neither.

    Checked in a fixed order (countries, US states, Indian states) and the
    first category that reaches its density threshold wins; a chunk that
    happens to name a lot of both countries and states is unusual enough
    in practice that picking one category to report is fine.

    Linear in ``len(content)``: three single-pass regex scans plus one pass
    over each category's own matches to classify the gaps between them, no
    nested quantifiers, no backtracking blowup risk.
    """
    text = _fold(content or "").replace("&", " and ")
    for pattern, minimum, category in (
        (_COUNTRY_PATTERN, OPTION_LIST_MIN_COUNTRIES, "countries"),
        (_US_STATE_PATTERN, OPTION_LIST_MIN_STATES, "us_states"),
        (_INDIAN_STATE_PATTERN, OPTION_LIST_MIN_STATES, "indian_states"),
    ):
        match = _category_match(pattern, text, minimum, category)  # type: ignore[arg-type]
        if match is not None:
            return match
    return None


def option_list_kind(content: str) -> Literal["form_options", "place_list"] | None:
    """ "form_options" for a picker, "place_list" for a dense prose/comma list, else None."""
    match = option_list_match(content)
    return match.kind if match else None


def is_option_list(content: str) -> bool:
    """True if ``content`` reads like a dropdown of countries or states.

    Kept for compatibility: only the "form_options" classification counts.
    A real coverage list ("we ship to all 28 states") is reported
    separately by ``option_list_kind`` returning "place_list", not here.
    """
    return option_list_kind(content) == "form_options"


_OPTION_LIST_REASONS: dict[str, str] = {
    "countries": "country dial-code picker",
    "us_states": "US states list",
    "indian_states": "Indian states list",
}


def option_list_reason(match: OptionListMatch) -> str:
    """Human-readable reason naming which category tripped, for the report."""
    return _OPTION_LIST_REASONS[match.category]


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
#
# 2026-09-11 review: 53 of 54 hits on CleanStart's own docs were this exact
# shape: a placeholder address inside a CLI flag, a JSON/YAML sample, or a
# shell snippet demonstrating how to configure a webhook or a signer. That
# is correct documentation, not a leaked placeholder, so every match now
# also records whether it sits inside that kind of example.
PlaceholderKind = Literal["phone", "email", "address", "name", "filler"]

_PLACEHOLDER_PATTERNS: tuple[tuple[re.Pattern[str], PlaceholderKind], ...] = (
    # "(555) 123-4567": 555 used as an area code. This is the exact shape
    # that CleanStart's own site gave out as its phone number.
    (re.compile(r"\(?\b555\)?[\s.-]?\d{3}[\s.-]?\d{4}\b"), "phone"),
    # A real area code followed by the 555 exchange and a subscriber number
    # in 0100-0199: NANPA's block reserved for fiction, never assigned to a
    # real subscriber even when the surrounding text claims otherwise.
    (re.compile(r"\b\d{3}[\s.-]?555[\s.-]?01\d{2}\b"), "phone"),
    # Digit-placeholder phone shapes template authors leave in place.
    (re.compile(r"(?i)\bxxx[\s.-]?xxx[\s.-]?xxxx\b"), "phone"),
    (re.compile(r"\b000[\s.-]?000[\s.-]?0000\b"), "phone"),
    (re.compile(r"\(?\b123\)?[\s.-]?456[\s.-]?7890\b"), "phone"),
    (re.compile(r"\b1234567890\b"), "phone"),
    # Placeholder email domains and local parts.
    (
        re.compile(
            r"(?i)\b[\w.+-]{1,64}@(?:example\.(?:com|org|net)|yourdomain\.com|domain\.com|company\.com|email\.com)\b"
        ),
        "email",
    ),
    (re.compile(r"(?i)\byourname@[\w.-]{1,64}\b"), "email"),
    # Placeholder street address.
    (re.compile(r"(?i)\b123\s+main\s+st(?:reet)?\b"), "address"),
    # Stock placeholder names.
    (re.compile(r"(?i)\bjohn\s+doe\b"), "name"),
    (re.compile(r"(?i)\bjane\s+doe\b"), "name"),
    (re.compile(r"(?i)\bjane\s+smith\b"), "name"),
    (re.compile(r"(?i)\byour\s+name\s+here\b"), "name"),
    # Filler text and unfilled template labels. "Company Name Here" and
    # "Your Name Here" both carry "Here", an unambiguous unfilled-field
    # marker. Bare "Your Company Name" (without "Here") is deliberately
    # NOT matched: production content genuinely uses that exact phrase in
    # ordinary advice prose ("monitor for your company name, domain,
    # executive names..." on an Eventus threat-intel page), so matching it
    # would flag real content, not a leaked placeholder.
    (re.compile(r"(?i)\blorem ipsum\b"), "filler"),
    (re.compile(r"(?i)\byour\s+company\s+name\s+here\b"), "filler"),
    (re.compile(r"(?i)\bcompany\s+name\s+here\b"), "filler"),
)

# ── "In example" detection ───────────────────────────────────────────────────
#
# A placeholder value counts as "in an example" when the surrounding text
# marks it as documentation rather than a leaked real value: it sits inside
# backticks or a fenced code block, on a line shaped like a CLI flag, a
# YAML/JSON/env-var assignment or a shell prompt, near the crawler's own
# "Copy code" marker for a <pre> block, near a bracketed template
# placeholder ("[start_date]", "[CISO Name]"), or right after an
# "e.g." / "for example" / "such as" / "like" cue.

_FENCED_BLOCK_RE = re.compile(r"```.*?```", re.DOTALL)

_CODE_LINE_PATTERNS = (
    re.compile(r"(?:^|[\s\"'])--[A-Za-z][\w-]*"),  # CLI flag: --email, --docker-email
    re.compile(r'"[\w.-]+"\s*:\s*[\["{]'),  # JSON "key": [ / { / "value" opener
    re.compile(r'"[\w.-]+"\s*:\s*"'),  # JSON "key": "value"
    re.compile(r"(?m)^\s*[\w.-]+:\s+\S"),  # YAML key: value, at the start of a real line
    # YAML key: "value" without a real line break to anchor on: some crawls
    # collapse every newline in a <pre> block into plain whitespace (seen on
    # CleanStart's own site), so a bareword key immediately followed by a
    # colon and an opening quote is checked on its own, unanchored.
    re.compile(r"\b[a-z_][\w.-]{1,40}:\s*\""),
    re.compile(r"\b[A-Z][A-Z0-9_]{1,30}=\S"),  # ENV_VAR=value
    re.compile(r"(?m)^\s*[$#]\s"),  # shell prompt
    re.compile(r"\$[A-Za-z_][A-Za-z0-9_]*"),  # $VAR
    re.compile(r"\|[^|\n]*\|"),  # markdown table row
)

_EXAMPLE_TRIGGER_RE = re.compile(r"(?i)(?:e\.g\.,?|for example,?|such as|like)\s*[:\-]?\s*[\[(]?\s*$")
# A markdown link's URL target, "[shown text](mailto:...)": the address is
# repeated verbatim right after the visible link text, so it inherits the
# same in-example verdict as that text rather than being judged alone.
_MARKDOWN_LINK_HREF_RE = re.compile(r"(?i)\]\((?:mailto:|tel:)?$")
_BRACKET_PLACEHOLDER_RE = re.compile(r"\[[A-Za-z][\w .'-]{1,40}\]")
_COPY_CODE_MARKER = "Copy code"

#: How far back to look for a "Copy code" marker or an example-introducing phrase.
_LOOKBACK_CHARS = 600
_TRIGGER_LOOKBACK_CHARS = 60
#: Radius (in characters) used for the code-line/bracket-placeholder context.
#: A fixed window rather than "the enclosing line": real JSON/YAML samples
#: routinely put a key on one line and its value on the next, and some
#: crawls (CleanStart's own) collapse every newline in a <pre> block into
#: plain whitespace, so there may be no reliable line to bound by at all.
_CONTEXT_RADIUS = 200


def _in_fenced_or_backtick_region(content: str, pos: int) -> bool:
    for fence in _FENCED_BLOCK_RE.finditer(content):
        if fence.start() <= pos < fence.end():
            return True
    # Mask out fenced blocks so their backticks don't skew inline-backtick
    # parity for text that comes after them.
    masked = _FENCED_BLOCK_RE.sub(lambda m: " " * len(m.group(0)), content)
    return masked.count("`", 0, pos) % 2 == 1


def _local_context(content: str, start: int, end: int) -> str:
    """A fixed-radius window of text around the match, for code/config-line checks."""
    return content[max(0, start - _CONTEXT_RADIUS) : min(len(content), end + _CONTEXT_RADIUS)]


def _is_in_example(content: str, start: int, end: int) -> bool:
    if _in_fenced_or_backtick_region(content, start):
        return True
    context = _local_context(content, start, end)
    if any(pattern.search(context) for pattern in _CODE_LINE_PATTERNS):
        return True
    if _BRACKET_PLACEHOLDER_RE.search(context):
        return True
    lookback = content[max(0, start - _LOOKBACK_CHARS) : start]
    if _COPY_CODE_MARKER in lookback:
        return True
    trigger_window = content[max(0, start - _TRIGGER_LOOKBACK_CHARS) : start]
    if _EXAMPLE_TRIGGER_RE.search(trigger_window):
        return True
    return bool(_MARKDOWN_LINK_HREF_RE.search(trigger_window))


@dataclass(frozen=True)
class PlaceholderFinding:
    """One placeholder match: its text, what kind it is, and whether it sits in an example."""

    value: str
    kind: PlaceholderKind
    in_example: bool


def placeholder_findings(content: str) -> list[PlaceholderFinding]:
    """Return every placeholder match in ``content``, classified and located.

    Never returns unrelated chunk content, only the matched placeholder
    substrings themselves, so a caller can log or display the result
    without leaking anything else in the chunk.
    """
    text = content or ""
    # Deduplicated separately per (kind, in_example) bucket: the same value
    # can legitimately appear once as a real leaked placeholder and again
    # inside an unrelated example elsewhere in the same chunk, and both are
    # worth keeping. Within a bucket, repeats collapse to the first-seen
    # original case.
    seen: set[tuple[str, PlaceholderKind, bool]] = set()
    findings: list[PlaceholderFinding] = []
    for pattern, kind in _PLACEHOLDER_PATTERNS:
        for match in pattern.finditer(text):
            raw = match.group(0)
            display = raw.lower() if kind == "filler" else raw
            in_example = _is_in_example(text, match.start(), match.end())
            dedup_key = (display.lower(), kind, in_example)
            if dedup_key in seen:
                continue
            seen.add(dedup_key)
            findings.append(PlaceholderFinding(value=display, kind=kind, in_example=in_example))
    return findings


def placeholder_contacts(content: str) -> list[str]:
    """Return the non-example placeholder values found in ``content``.

    Kept for compatibility: a value that ``placeholder_findings`` marks as
    sitting inside a code or documentation example (a CLI flag, a JSON
    sample, a YAML config) is left out, since that is correct documentation
    rather than a leaked placeholder. Deduplicated case-insensitively,
    keeping the first-seen original case for display.
    """
    return [finding.value for finding in placeholder_findings(content) if not finding.in_example]
