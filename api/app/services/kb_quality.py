"""Pure detectors for knowledge-base content that is not a statement of fact.

Used by ``scripts/kb_junk_report.py``, by retrieval in ``rag_service`` (see
``first_visitor_placeholder`` at the end), and intended for the ingestion
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

2026-09-11 approval review: two more gaps in the same pair of detectors.
An ISO-code list, a flag-emoji picker, a radio-button list, a numbered
list and a comma-separated picker (with a "Select" header or an "Other"
entry) all still read as prose, so the picker-gap check now also strips
list codes, emoji, list numbers and bullets, and comma-separated runs get
their own marker-or-no-sentence-language check rather than being treated
as automatically prose. Unfenced code examples (a bare Terraform block, a
Ruby constant, a SQL INSERT) were landing in the main report, while the
existing unindented "key: value" pattern was loose enough to also catch a
real contact footer ("Email: yourname@company.com"); both are fixed
without swallowing genuine prose. ``_in_fenced_or_backtick_region``
rescanned the whole chunk per placeholder match, which made a chunk with a
few thousand matches quadratic; fenced-block spans, backtick positions and
line starts are now computed once per chunk and looked up with ``bisect``.

2026-09-11 controller decision: four review rounds of layout rules for the
*gaps* between place names kept finding new shapes in both directions --
a bracketed dial code, a semicolon-separated picker or "(1)" numbering
read as prose, while "Customer support is available in the following
countries:" followed by a numbered list, a bold "**Delivery coverage**:
..." sentence, and an "Australia vs Austria vs Azerbaijan ..." sports
sentence (its "vs" stripped as if it were a list code) all read as a
picker. Chasing separator shapes cannot end well: a separator says
nothing about whether a list is a scraped form or real prose, so this
was never going to converge. ``form_options`` now requires a marker that
actually says "this is a picker" -- a dial code, a "Select" prompt or
placeholder, ``<option>``/``value="`` markup, a flag emoji, or an ISO
code, each attached to several of the run's own names -- and every other
dense place-name run, whatever its separators, goes to ``place_list``
instead. The former per-gap "strip every kind of debris and see what's
left" pass is gone; a 2-3 letter token is never generic debris now, only
possible ISO-code evidence when it is genuinely upper-case and sitting
right next to a name, so "vs", "and", "or", "the", "us" are never
stripped. Two more documentation-example shapes are recognized while
we're in here: an nginx/Apache directive block (bare "key value;" lines
between "{" and "}") and a raw HTTP/email header dump (two or more
consecutive "From:"/"To:"/"Reply-To:"/"Authorization:"/"Content-Type:"/
"Host:" lines) -- a real one-field-per-line contact footer ("Email:
yourname@company.com") never uses those protocol header names, so it
still reports normally.

2026-09-11 review, round two: ``picker_instruction`` and ``option_markup``
were checked with a plain whole-chunk ``.search``, so a real office or
coverage list on a page that also carried an unrelated "Select a location
below to see opening hours" widget, a "results found for your search"
message, a "Country*" field on a contact form, or a stray ``value="..."``
attribute *anywhere else in the chunk* was reported as a picker, even when
that marker had nothing to do with the place-name run itself. Both markers
now have to sit within a bounded window of the run's own span, the same
way the dial-code, flag and ISO-code markers already do (see
``_INSTRUCTION_MARKER_WINDOW``). A "Select"/"Choose" prompt also has to be
*about* a place to count: "Select your country of residence" is picker
evidence, but "Select an issue type" and "Choose a report year" are a
support form and a report archive, not a picker, even sitting right next
to a run purely by coincidence (see ``_instruction_names_a_place``).
"""

from __future__ import annotations

import bisect
import re
import unicodedata
from dataclasses import dataclass
from typing import Literal

# ── Option lists (dropdowns, filters) mistaken for facts ────────────────────
#
# A crawled form's <select> options land in the knowledge base as ordinary
# prose-looking text ("Afghanistan Albania Algeria ..."). Nobody wrote a
# sentence claiming "we operate in these 190 countries"; the crawler just
# captured every <option> on a country picker. Density alone -- a chunk
# naming 25+ distinct countries (or 20+ distinct US or Indian states) --
# only says the chunk is a *dense place-name run*; it says nothing about
# whether that run is a scraped dropdown or a real coverage claim a bot
# owner wrote themselves ("we ship to all 28 states"). Separators cannot
# settle that either: a real sentence and a scraped picker are both
# routinely comma-separated, and a picker can just as easily be written
# with semicolons, slashes or "(1)" numbering. What actually distinguishes
# a picker is a marker that only a picker carries: a dial code, a "Select"
# prompt, leftover ``<option>``/``value="`` markup, a flag emoji, or an
# ISO code, each tied to the run's own names (see ``_find_marker`` below).
# A dense run with one of those markers is reported as "form_options" --
# usually safe to remove. Every other dense run, whatever its separators,
# is a "place_list": possibly real content, so it gets a lower-priority
# "check before removing" callout instead of a removal suggestion.

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


def _compile_raw_phrase_alternation(phrases: frozenset[str]) -> re.Pattern[str]:
    """Build the same alternation as ``_compile_phrase_alternation``, case-insensitively but unfolded.

    Used only for marker detection (see ``_find_marker`` below), which has
    to tell "AF" (an upper-case ISO code) apart from "vs" or "and" -- a
    distinction that only survives if the source text is matched as-is,
    not lowercased first. ``re.IGNORECASE`` still matches a name in any
    case; it just does not erase the case of everything *around* the match
    the way folding the whole chunk to lowercase would.
    """
    ordered = sorted(phrases, key=len, reverse=True)
    return re.compile(r"\b(?:" + "|".join(re.escape(p) for p in ordered) + r")\b", re.IGNORECASE)


_COUNTRY_PATTERN_RAW = _compile_raw_phrase_alternation(_COUNTRY_NAMES)
_US_STATE_PATTERN_RAW = _compile_raw_phrase_alternation(_US_STATES)
_INDIAN_STATE_PATTERN_RAW = _compile_raw_phrase_alternation(_INDIAN_STATES)
_RAW_PATTERNS: dict[str, re.Pattern[str]] = {
    "countries": _COUNTRY_PATTERN_RAW,
    "us_states": _US_STATE_PATTERN_RAW,
    "indian_states": _INDIAN_STATE_PATTERN_RAW,
}

# ── Picker markers ───────────────────────────────────────────────────────
#
# A dense place-name run is "form_options" only when it carries one of
# these markers. Two are global: real prose never contains a "Select a
# country" prompt or a leftover ``<option value="...">`` tag, so finding
# either anywhere in the chunk decides it outright. The other three --
# a dial code, a flag emoji, an ISO code -- are common enough on their own
# ("+1" is also a US area code someone dialed from; a bare 2-3 letter
# upper-case token could be almost anything) that they only count when
# several of them sit right next to the run's own names; see
# ``_marker_adjacent_count``.
_PICKER_INSTRUCTION_RE = re.compile(
    r"(?i)\bselect\b|\bchoose\b|please\s+select|--\s*select\s*--|country\*|results?\s+found|no\s+results"
)
_OPTION_MARKUP_RE = re.compile(r'(?i)<option\b|value\s*=\s*["\']')

# Regional-indicator flag pairs, plus the common emoji/symbol blocks a
# picker's own icons are drawn from (misc symbols & pictographs, dingbats,
# the variation-selector and zero-width-joiner marks emoji sequences use).
_EMOJI_RE = re.compile(r"[\U0001F1E6-\U0001F1FF\U0001F300-\U0001FAFF\u2600-\u27BF\uFE0F\u200D]")

# A dial code right before or after a name: "+93 Afghanistan", "Afghanistan
# +93", "Australia (+1)". Optional parens, 1-4 digits (covers every real
# country calling code).
_DIAL_CODE_BEFORE_RE = re.compile(r"\(?\+\d{1,4}\)?\s*$")
_DIAL_CODE_AFTER_RE = re.compile(r"^\s*\(?\+\d{1,4}\)?")
# An upper-case 2-3 letter ISO code right before or after a name: "AF
# Afghanistan", "Afghanistan (AF)". Deliberately case-sensitive -- see the
# module docstring's 2026-09-11 controller-decision entry -- so a lower-case
# connector word ("vs", "and", "the", "us") sitting next to a name in
# ordinary prose is never mistaken for a code; only a genuine all-caps token
# is.
_ISO_CODE_BEFORE_RE = re.compile(r"\b[A-Z]{2,3}\s*$")
_ISO_CODE_AFTER_RE = re.compile(r"^\s*\(?[A-Z]{2,3}\)?\b")

#: How many of the run's own name occurrences must carry the same marker
#: right next to them before it counts as evidence of a picker.
_MARKER_MIN_NAMES = 5
#: Window (characters) checked immediately before/after each name match for
#: a dial code, a flag emoji or an ISO code. Deliberately small and fixed:
#: these markers sit right next to the name they belong to ("+93
#: Afghanistan", not "+93 ... a few sentences later ... Afghanistan"), and a
#: small fixed window keeps this linear in the number of name occurrences.
_DIAL_CODE_WINDOW = 10
_FLAG_WINDOW = 6
_ISO_CODE_WINDOW = 8

#: Window (characters) checked before the run's first name and after its
#: last name for a "Select"/"Choose" prompt or leftover <option>/value="
#: markup -- the same "must sit next to the run, not merely anywhere in
#: the chunk" requirement the per-name dial-code/flag/ISO-code checks
#: already apply. A crawled form's picker prompt sits right next to its own
#: options; a "Select a location below to see opening hours" widget three
#: paragraphs above a genuine office list, or a "-- Select --" nav leftover
#: at the top of an unrelated page, does not, and must not count.
_INSTRUCTION_MARKER_WINDOW = 150

#: Words that make a "Select"/"Choose" prompt's *object* a place, so
#: "Select your country of residence" counts as picker evidence while
#: "Select an issue type" or "Choose a report year" does not, even when the
#: prompt happens to sit right next to a dense place-name run.
_PLACE_OBJECT_WORDS_RE = re.compile(
    r"(?i)\b(?:countr(?:y|ies)|states?|regions?|locations?|nationalit(?:y|ies)|residence)\b"
)
_SENTENCE_BOUNDARY_RE = re.compile(r"[.!?\n]")


def _marker_adjacent_count(
    matches: list[re.Match[str]],
    content: str,
    before_re: re.Pattern[str],
    after_re: re.Pattern[str],
    window: int,
    minimum: int,
) -> bool:
    """True once ``minimum`` of ``matches`` each carry the marker right next to them.

    Exits as soon as the minimum is reached rather than scanning every
    match, so a chunk with thousands of name occurrences and an obvious
    marker on the first handful never pays for the rest.
    """
    count = 0
    for match in matches:
        start, end = match.start(), match.end()
        before = content[max(0, start - window) : start]
        after = content[end : end + window]
        if before_re.search(before) or after_re.search(after):
            count += 1
            if count >= minimum:
                return True
    return False


_MARKER_DESCRIPTIONS: dict[str, str] = {
    "dial_codes": "dial codes",
    "picker_instruction": "a Select prompt",
    "option_markup": "option markup",
    "flags": "flag icons",
    "iso_codes": "country codes",
}


def _instruction_names_a_place(window: str, match: re.Match[str]) -> bool:
    """True if the sentence around ``match`` in ``window`` names a place.

    Bounded by the nearest sentence-ending punctuation on each side (or the
    window's own edge, for a match in the window's first or last sentence),
    so a "Select"/"Choose" prompt whose own sentence is about something
    else entirely ("Select an issue type") can't borrow a place word that
    belongs to a different sentence two paragraphs away.
    """
    start_bound = 0
    for boundary in _SENTENCE_BOUNDARY_RE.finditer(window, 0, match.start()):
        start_bound = boundary.end()
    end_match = _SENTENCE_BOUNDARY_RE.search(window, match.end())
    end_bound = end_match.start() if end_match else len(window)
    return bool(_PLACE_OBJECT_WORDS_RE.search(window[start_bound:end_bound]))


def _find_instruction_marker(window: str) -> bool:
    """True if ``window`` carries a Select/Choose prompt whose object is a place."""
    return any(_instruction_names_a_place(window, match) for match in _PICKER_INSTRUCTION_RE.finditer(window))


def _find_marker(category: Literal["countries", "us_states", "indian_states"], content: str) -> str | None:
    """The strongest picker marker in ``content`` for ``category``, or ``None``.

    A "Select a country" prompt or a leftover ``<option>``/``value="``
    attribute only counts when it sits within ``_INSTRUCTION_MARKER_WINDOW``
    characters of the run's own span (see the module docstring's 2026-09-11
    round-two entry) -- neither shows up in ordinary prose, but a form
    widget or nav leftover elsewhere on the same page is not evidence about
    *this* run. A "Select"/"Choose" prompt additionally has to be about a
    place (``_instruction_names_a_place``). Dial codes, flags and ISO codes
    are checked after those two, with a raw, case-preserving re-scan of
    ``content``, since they need to be tied to several of the run's own
    name occurrences rather than merely present nearby.
    """
    raw_matches = list(_RAW_PATTERNS[category].finditer(content))
    if raw_matches:
        window_start = max(0, raw_matches[0].start() - _INSTRUCTION_MARKER_WINDOW)
        window_end = min(len(content), raw_matches[-1].end() + _INSTRUCTION_MARKER_WINDOW)
        window = content[window_start:window_end]
        if _OPTION_MARKUP_RE.search(window):
            return "option_markup"
        if _find_instruction_marker(window):
            return "picker_instruction"

    if _marker_adjacent_count(
        raw_matches, content, _DIAL_CODE_BEFORE_RE, _DIAL_CODE_AFTER_RE, _DIAL_CODE_WINDOW, _MARKER_MIN_NAMES
    ):
        return "dial_codes"
    if _marker_adjacent_count(raw_matches, content, _EMOJI_RE, _EMOJI_RE, _FLAG_WINDOW, _MARKER_MIN_NAMES):
        return "flags"
    if _marker_adjacent_count(
        raw_matches, content, _ISO_CODE_BEFORE_RE, _ISO_CODE_AFTER_RE, _ISO_CODE_WINDOW, _MARKER_MIN_NAMES
    ):
        return "iso_codes"
    return None


@dataclass(frozen=True)
class OptionListMatch:
    """One place-name category that reached the option-list density threshold.

    ``marker`` names which picker marker was found for a "form_options"
    match ("dial_codes", "picker_instruction", "option_markup", "flags" or
    "iso_codes"); it is ``None`` for a "place_list" match, which by
    definition carries none of them.
    """

    kind: Literal["form_options", "place_list"]
    category: Literal["countries", "us_states", "indian_states"]
    distinct_count: int
    marker: str | None = None


def _category_match(
    pattern: re.Pattern[str],
    text: str,
    minimum: int,
    category: Literal["countries", "us_states", "indian_states"],
    original: str,
) -> OptionListMatch | None:
    matches = list(pattern.finditer(text))
    distinct_count = len({m.group(0) for m in matches})
    if distinct_count < minimum:
        return None

    marker = _find_marker(category, original)
    kind: Literal["form_options", "place_list"] = "form_options" if marker is not None else "place_list"
    return OptionListMatch(kind=kind, category=category, distinct_count=distinct_count, marker=marker)


def option_list_match(content: str) -> OptionListMatch | None:
    """Classify ``content`` as a form's option list, a prose place list, or neither.

    Checked in a fixed order (countries, US states, Indian states) and the
    first category that reaches its density threshold wins; a chunk that
    happens to name a lot of both countries and states is unusual enough
    in practice that picking one category to report is fine.

    Linear in ``len(content)``: three single-pass regex scans to find the
    density, plus -- only for a category that actually reaches its
    threshold -- a marker search that is either two whole-chunk regex
    scans (the global markers) or one more single-pass scan plus a
    fixed-window check per name occurrence (the per-name markers). No
    nested quantifiers, no backtracking blowup risk.
    """
    original = content or ""
    text = _fold(original).replace("&", " and ")
    for pattern, minimum, category in (
        (_COUNTRY_PATTERN, OPTION_LIST_MIN_COUNTRIES, "countries"),
        (_US_STATE_PATTERN, OPTION_LIST_MIN_STATES, "us_states"),
        (_INDIAN_STATE_PATTERN, OPTION_LIST_MIN_STATES, "indian_states"),
    ):
        match = _category_match(pattern, text, minimum, category, original)  # type: ignore[arg-type]
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
    A dense place-name run with no picker marker -- a real coverage list
    ("we ship to all 28 states") just as much as a bare, markerless list of
    names -- is reported separately by ``option_list_kind`` returning
    "place_list", not here.
    """
    return option_list_kind(content) == "form_options"


def option_list_reason(match: OptionListMatch) -> str:
    """Human-readable reason for the report, naming the marker for a form_options match."""
    if match.kind == "form_options" and match.marker is not None:
        marker_desc = _MARKER_DESCRIPTIONS[match.marker]
        return f"looks like a form's country or state picker (it has {marker_desc}): usually safe to remove"
    return "many place names listed: check whether this is a real coverage or office list before removing anything"


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

#: Lorem-ipsum filler, the one filler pattern a visitor-facing chunk is dropped for.
_LOREM_IPSUM_RE = re.compile(r"(?i)\blorem ipsum\b")

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
    (re.compile(r"\(?\b000\)?[\s.-]?000[\s.-]?0000\b"), "phone"),
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
    (_LOREM_IPSUM_RE, "filler"),
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

# Each match runs every one of these against its own local context, so the
# checks are grouped into as few compiled patterns as make sense: one
# ``re.Pattern.search`` call already tries every branch of its own
# alternation in C, while each *separate* pattern object is a full extra
# pass over the context string. Kept as one tuple entry per *shape* only
# where combining would make an already-hard-to-read pattern unreadable.
# Every one of these is checked against a match's own local context, so
# each is paired with a cheap literal-character guard (a plain Python
# ``in`` substring test, O(context length) at C speed) that must pass
# before the backtracking regex itself ever runs: a match sitting in a
# stretch of ordinary prose contains none of the punctuation any of these
# shapes need, and the guard rejects it in a fraction of the time a full
# regex search over the same context would take. This matters because
# every match in a chunk runs the whole list: on a chunk with a few
# thousand matches and no code-shaped punctuation anywhere near any of
# them, the guards turn "N full regex scans" into "N cheap substring
# checks", which is most of what keeps this linear-time in practice, not
# just in big-O.
_JSON_LINE_RE = re.compile(r'"[\w.-]+"\s*:\s*(?:[\["{]|")')  # "key": [ / { / "value"
# YAML key: value, at the start of a real, indented line (a top-level,
# unindented "Email: yourname@company.com" is exactly the shape a real
# contact footer uses, so that must stay unmatched); or a YAML key: "value"
# with no real line break to anchor on, unanchored -- some crawls collapse
# every newline in a <pre> block into plain whitespace (seen on
# CleanStart's own site), so a bareword key immediately followed by a
# colon and an opening quote is checked on its own too.
_YAML_LINE_RE = re.compile(r'(?m)^[ \t]+[\w.-]+:\s+\S|\b[a-z_][\w.-]{1,40}:\s*"')
_CLI_FLAG_RE = re.compile(r"(?:^|[\s\"'])--[A-Za-z][\w-]*")  # --email, --docker-email
# A general "identifier = value" assignment (HCL, Ruby constant, an
# ENV_VAR, an ini file, ...), any case, with or without spaces or quotes
# around "=": `default = "support@example.com"`, `ADMIN_EMAIL = "..."`.
_ASSIGNMENT_RE = re.compile(r"\b[A-Za-z_][\w.-]{0,40}\s*=\s*[\"']?\S")
_SHELL_PROMPT_OR_VAR_RE = re.compile(r"(?m:^\s*[$#]\s)|\$[A-Za-z_][A-Za-z0-9_]*")
_MARKDOWN_TABLE_ROW_RE = re.compile(r"\|[^|\n]*\|")
# SQL statements: an address inside INSERT/VALUES/UPDATE/SELECT is a
# database seed script or a query example, not a leaked contact.
_SQL_STATEMENT_RE = re.compile(
    r"""(?ix) \b insert \s+ into \b | \b values \s* \( | \b update \s+ [\w.\"'`]+ \s+ set \b
         | \b select \b [\s\S]{0,120}? \b from \b"""
)
# A brace paired with an assignment operator nearby: an HCL block
# (`variable "x" {`) or an object literal wrapping a key: value or key =
# value pair, even when the value isn't on the same line as the brace.
_BRACE_ASSIGNMENT_RE = re.compile(r"[{}][\s\S]{0,150}?[=:]|[=:][\s\S]{0,150}?[{}]")
# An nginx/Apache-style config directive: a bare identifier, whitespace,
# some content, a terminating semicolon ("listen 80;", "server_name
# example.com;"). Paired with the brace guard below, since a directive line
# on its own (no enclosing `{`/`}` block anywhere in the context) is common
# enough in ordinary prose ("Contact us; we reply within a day.") that it
# needs the block shape to mean anything.
_BRACE_DIRECTIVE_RE = re.compile(r"(?m)^[ \t]*[A-Za-z_][\w-]*[ \t]+\S[^\n;]*;[ \t]*$")
# Two or more consecutive email/HTTP header lines ("From:", "To:",
# "Reply-To:", "Authorization:", "Content-Type:", "Host:", ...): a raw
# request/header dump, not a real contact footer (a genuine footer is one
# field per line under a human label like "Email:"/"Phone:", never these
# protocol header names).
_HTTP_HEADER_NAME = r"(?:From|To|Reply-To|Authorization|Content-Type|Host|Cc|Bcc)"
_HTTP_HEADER_BLOCK_RE = re.compile(
    rf"(?im)^[ \t]*{_HTTP_HEADER_NAME}:[ \t]*\S[^\n]*\n[ \t]*{_HTTP_HEADER_NAME}:[ \t]*\S"
)


def _looks_like_code_line(context: str, *, markdown_tables: bool = True) -> bool:
    if '"' in context and _JSON_LINE_RE.search(context):
        return True
    if ":" in context and (_YAML_LINE_RE.search(context) or _HTTP_HEADER_BLOCK_RE.search(context)):
        return True
    if "-" in context and _CLI_FLAG_RE.search(context):
        return True
    if "=" in context and _ASSIGNMENT_RE.search(context):
        return True
    if ("$" in context or "#" in context) and _SHELL_PROMPT_OR_VAR_RE.search(context):
        return True
    if markdown_tables and "|" in context and _MARKDOWN_TABLE_ROW_RE.search(context):
        return True
    if ("{" in context or "}" in context) and (
        _BRACE_ASSIGNMENT_RE.search(context) or _BRACE_DIRECTIVE_RE.search(context)
    ):
        return True
    lowered = context.lower()
    return any(kw in lowered for kw in ("insert", "values", "update", "select")) and bool(
        _SQL_STATEMENT_RE.search(context)
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
#: Unioned with the match's own enclosing line (see ``_ExampleContext``) so
#: a SQL statement or HCL block that runs long still gets checked "on the
#: match's line", not just within a fixed character radius.
_CONTEXT_RADIUS = 200


@dataclass(frozen=True)
class _ExampleContext:
    """Content plus everything ``_is_in_example`` needs, computed once.

    2026-09-11 review: ``_in_fenced_or_backtick_region`` used to rescan the
    *entire* content on every single match (once with ``finditer`` to find
    fenced blocks, once more with ``sub`` to mask them out, then a
    ``count()`` up to the match) -- O(content length) of work per match,
    which made a chunk with a few thousand matches quadratic overall. Fenced
    spans, inline-backtick positions (outside fences) and line-start offsets
    are computed exactly once per content here; each match then looks itself
    up with ``bisect`` in O(log n) instead of rescanning.
    """

    content: str
    fenced_starts: list[int]
    fenced_ends: list[int]
    backtick_positions: list[int]
    line_starts: list[int]


def _build_example_context(content: str) -> _ExampleContext:
    fenced_spans = [(m.start(), m.end()) for m in _FENCED_BLOCK_RE.finditer(content)]
    # Mask out fenced blocks (same length, so positions don't shift) so
    # their own backticks don't skew inline-backtick parity for text that
    # comes after them.
    masked = _FENCED_BLOCK_RE.sub(lambda m: " " * len(m.group(0)), content)
    backtick_positions = [m.start() for m in re.finditer("`", masked)]
    line_starts = [0]
    line_starts.extend(m.end() for m in re.finditer("\n", content))
    return _ExampleContext(
        content=content,
        fenced_starts=[s for s, _ in fenced_spans],
        fenced_ends=[e for _, e in fenced_spans],
        backtick_positions=backtick_positions,
        line_starts=line_starts,
    )


def _in_fenced_or_backtick_region(ctx: _ExampleContext, pos: int) -> bool:
    idx = bisect.bisect_right(ctx.fenced_starts, pos) - 1
    if idx >= 0 and ctx.fenced_starts[idx] <= pos < ctx.fenced_ends[idx]:
        return True
    return bisect.bisect_left(ctx.backtick_positions, pos) % 2 == 1


def _enclosing_line_span(ctx: _ExampleContext, pos: int) -> tuple[int, int]:
    """The (start, end) of the line containing ``pos``, both O(log n).

    ``line_starts`` already holds every line's start offset, so the next
    line's start minus the newline it begins after is this line's end; a
    plain ``content.find("\\n", pos)`` would rescan from ``pos`` to the next
    newline (or the end of the string, for the common case of one huge line
    with no newlines at all) on every call, which is exactly the
    per-match O(content length) cost this whole context object exists to
    avoid.
    """
    idx = bisect.bisect_right(ctx.line_starts, pos) - 1
    start = ctx.line_starts[idx] if idx >= 0 else 0
    end = ctx.line_starts[idx + 1] - 1 if idx + 1 < len(ctx.line_starts) else len(ctx.content)
    return start, end


#: Cap on how far the enclosing-line union in ``_local_context`` may grow a
#: match's context beyond the fixed radius. A real SQL statement or HCL
#: block is tens to a few hundred characters; a crawl that collapsed every
#: newline in a `<pre>` block (or a chunk that simply never wrapped) can
#: make the "enclosing line" the entire chunk, and unioning that in for
#: every match would turn a bounded, O(1)-per-match window back into an
#: O(content length) one -- exactly the per-match content rescan this
#: whole module is trying to get rid of.
_MAX_LINE_UNION_CHARS = 2_000


def _local_context(ctx: _ExampleContext, start: int, end: int) -> str:
    """A window of text around the match, for code/config-line checks.

    The union of a fixed radius and the match's own enclosing line, so a
    long SQL statement or HCL assignment that runs past the radius is still
    checked in full, while a match in the middle of ordinary prose keeps the
    tight, cheap fixed-radius window. The union is capped (see
    ``_MAX_LINE_UNION_CHARS``) so a pathologically long line can never blow
    the window back up to the size of the whole chunk.
    """
    content = ctx.content
    line_start, line_end = _enclosing_line_span(ctx, start)
    if line_end - line_start > _MAX_LINE_UNION_CHARS:
        line_start, line_end = start, end
    window_start = min(max(0, start - _CONTEXT_RADIUS), line_start)
    window_end = max(min(len(content), end + _CONTEXT_RADIUS), line_end)
    return content[window_start:window_end]


def _is_in_example(ctx: _ExampleContext, start: int, end: int, *, for_visitors: bool = False) -> bool:
    """True if the match at ``start``-``end`` sits inside a code or documentation example.

    ``for_visitors`` drops the two signals that only make sense for the owner's
    report (see "Placeholders a visitor must never be told" below): a markdown
    table row and a nearby bracketed field. Every other signal is shared.
    """
    if _in_fenced_or_backtick_region(ctx, start):
        return True
    context = _local_context(ctx, start, end)
    if _looks_like_code_line(context, markdown_tables=not for_visitors):
        return True
    if not for_visitors and "[" in context and _BRACKET_PLACEHOLDER_RE.search(context):
        return True
    content = ctx.content
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
    ctx = _build_example_context(text)
    for pattern, kind in _PLACEHOLDER_PATTERNS:
        for match in pattern.finditer(text):
            raw = match.group(0)
            display = raw.lower() if kind == "filler" else raw
            in_example = _is_in_example(ctx, match.start(), match.end())
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


# ── Placeholders a visitor must never be told ────────────────────────────────
#
# Production, 2026-09-11: CleanStart's bot told a visitor "The enterprise
# phone number is +1 (555) 123-4567 for Enterprise tier customers only." The
# number sat on a crawled draft page (/knowledge-hub/sla-documentation) along
# with "+1-XXX-XXX-XXXX" and "[Big 4 Firm Name]", and retrieval put the chunk
# in the prompt like any other.
#
# ``placeholder_findings`` answers the report's question: should the owner
# delete this? Retrieval asks a different one: may the model read this chunk
# as fact? A dropped chunk takes every true sentence in it along, so three
# rules follow from the difference.
#
# - Only values that are never real. Every phone shape above is a block
#   reserved for fiction or a digit mask, and "lorem ipsum" is filler.
#   Placeholder emails, addresses and names stay report-only: "email.com" and
#   "company.com" are real domains, and a real "123 Main Street" or "Jane
#   Smith" exists.
# - Template fields stay report-only too. "Enter your [First Name]",
#   "Welcome, [Your Name]!" and "Your Company Name Here" are the product of an
#   email-marketing, legal-document or invoicing tenant, and dropping them hid
#   that tenant's help content. The accepted cost: a draft page's unfilled
#   "[Big 4 Firm Name]" reaches the model.
# - A bracketed field or a markdown table row near a match is not evidence of
#   documentation. The report reads "[CISO Name]" near a match as a template
#   example and stays quiet, and its bracket check also matches any
#   "[Contact us](...)" link, which says nothing about the number beside it;
#   an SLA page lays out its escalation numbers in exactly a table row.
#
# Everything else that marks real documentation still exempts a match: a
# fenced or backticked span, a JSON/YAML/CLI/assignment/shell/SQL line, a
# "Copy code" block, an "e.g." cue, a link target.

VisitorPlaceholderKind = PlaceholderKind

#: Placeholder phone numbers and lorem-ipsum filler. The report's other filler
#: patterns ("Company Name Here") are template labels.
_VISITOR_PLACEHOLDER_PATTERNS = tuple(
    entry for entry in _PLACEHOLDER_PATTERNS if entry[1] == "phone" or entry[0] is _LOREM_IPSUM_RE
)


@dataclass(frozen=True)
class VisitorPlaceholder:
    """A placeholder a chunk states outside any example: its kind and the matched text."""

    kind: VisitorPlaceholderKind
    value: str


def first_visitor_placeholder(content: str) -> VisitorPlaceholder | None:
    """The first placeholder in ``content`` a visitor must never be told, or ``None``.

    Only a placeholder phone number or lorem-ipsum filler counts; a template
    field such as "[First Name]" never does. The scan stops at the first one
    found outside an example: one is enough to keep the chunk out of the
    prompt. The example context is only built once a candidate turns up, so a
    clean chunk costs a few single-pass regex scans.

    Linear in ``len(content)``: every pattern is bounded, the context is built
    at most once, and each candidate is checked against a fixed-size window
    (see ``_is_in_example``).
    """
    text = content or ""
    ctx: _ExampleContext | None = None
    for pattern, kind in _VISITOR_PLACEHOLDER_PATTERNS:
        for match in pattern.finditer(text):
            if ctx is None:
                ctx = _build_example_context(text)
            if not _is_in_example(ctx, match.start(), match.end(), for_visitors=True):
                return VisitorPlaceholder(kind=kind, value=match.group(0))
    return None
