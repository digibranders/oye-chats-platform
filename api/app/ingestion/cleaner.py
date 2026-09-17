import re
from urllib.parse import unquote

from app.security.injection_patterns import compile_line_anchored_strip_pattern
from app.services.kb_quality import is_country_name, starts_with_country_name

# A "cell" that is nothing but a single markdown link. I.e. a nav-bar entry.
# Used to distinguish pipe-separated nav rows from real markdown data tables.
_NAV_LINK_CELL_RE = re.compile(r"^\s*\[([^\]]+)\]\([^)]+\)\s*$")

# ---------------------------------------------------------------------------
# Media URL extraction
# ---------------------------------------------------------------------------
# Runs BEFORE clean_text so we capture URLs that live inside markdown links
# (``[Watch the demo](https://youtube.com/…)``). The cleaner strips those
# link wrappers a few lines below, so if we don't capture here they are lost
# forever. Plain-URL occurrences survive cleaning too and would still be
# caught, but many crawled pages format their video/file references as
# markdown links, which is why this pass is unconditional at ingest time.

# YouTube URL patterns. Canonical, short, embed, and shorts forms. The
# 11-char video ID is YouTube's stable identifier and is what the widget
# uses to build the thumbnail URL, so extraction focuses on that.
_YOUTUBE_URL_RE = re.compile(
    r"https?://(?:www\.|m\.)?"
    r"(?:youtube\.com/(?:watch\?(?:[^\s\"'<>()\[\]]*&)?v=|embed/|v/|shorts/)|youtu\.be/)"
    r"([A-Za-z0-9_-]{11})"
    r"(?:[?&#][^\s\"'<>()\[\]]*)?",
    re.IGNORECASE,
)

# Downloadable file URLs. Extensions we surface as attachment cards in
# chat. Kept conservative on purpose: only formats a visitor would expect
# to open or download from a business site.
_DOWNLOAD_EXTENSIONS = ("pdf", "docx", "doc", "xlsx", "xls", "pptx", "ppt", "csv", "zip", "rtf", "odt", "ods", "odp")
# The trailing lookahead pins the extension to a URL terminator, not to
# a domain label or a longer word. Three failure modes it blocks:
#   1. ``https://hub.docker.com`` → greedy body backtracked until ``.doc``
#      matched inside the domain. The ``k`` after ``.doc`` is a letter.
#   2. ``https://help.xlsx.io/guide`` → ``.xlsx`` matched with ``.io``
#      still to follow. The ``.i`` after the extension is a domain-label
#      start (``.`` + letter), not a URL terminator.
#   3. ``https://cdn.x.com/foo.pdf.backup`` → ``.pdf.backup`` isn't a
#      PDF; the extension is followed by ``.b`` which is another label.
# The lookahead rejects a following alphanumeric OR a ``.<alphanumeric>``
# sequence, but ALLOWS a trailing ``.`` at the end of a sentence
# (``.pdf.`` followed by whitespace or end of string), which is
# subsequently swept off by ``_URL_TRAILING_PUNCT`` on the caller side.
# Result: real URLs. ``foo.pdf``, ``foo.pdf/preview``, ``foo.pdf?v=1``,
# ``foo.pdf#page=3``, ``foo.pdf.`` at end of sentence. All match; domain
# labels containing an extension prefix. ``hub.docker.com``,
# ``help.xlsx.io``. Do not.
_FILE_URL_RE = re.compile(
    r"https?://[^\s\"'<>()\[\]]+\.(?:" + "|".join(_DOWNLOAD_EXTENSIONS) + r")"
    r"(?!(?:[A-Za-z0-9]|\.[A-Za-z0-9]))"
    r"(?:\?[^\s\"'<>()\[\]]*)?",
    re.IGNORECASE,
)


def is_valid_file_url(url: object) -> bool:
    """True when ``url`` is a well-formed downloadable-file URL.

    Read-time re-validation of file URLs pulled from the DB. Older ingestion runs
    used a greedy regex that scraped domain labels like ``hub.docker.com`` as fake
    ``.doc`` files, and those junk entries still live in existing bots'
    ``metadata_info.media_urls.files``. The readers that build something from a
    file entry apply this one check: in ``rag_service`` the retrieved-media
    whitelist and name set, the AVAILABLE MEDIA catalog, the topical card and the
    secondary-chip picker, and in ``document_request`` the file catalog. That keeps
    the junk out of them without a migration or a re-crawl. The stream's bot-wide
    URL whitelist does not apply it; it only admits string URLs.

    Two checks combined:
      1. It matches ``_FILE_URL_RE`` starting at position 0, the same
         boundary-aware regex ingestion now uses, so pre-fix domain-label
         false positives (``hub.docker.com`` to ``hub.doc``) are rejected
         when the regex sees a following letter or ``.<letter>``.
      2. The URL contains a ``/`` in its path portion (after ``://``).
         This rejects the terminally clipped junk like a bare
         ``https://hub.doc``, which passes the regex on shape alone
         (no letter follows) but has no path segment, so it cannot be a
         real file. Real files always live at ``host/path.ext``.
    """
    if not isinstance(url, str) or not url:
        return False
    if not _FILE_URL_RE.match(url):
        return False
    scheme_sep = url.find("://")
    if scheme_sep == -1:
        return False
    return "/" in url[scheme_sep + 3 :]


# Trailing punctuation that URL regexes commonly sweep up. Strip before
# using the URL so we don't emit ``https://example.com/file.pdf.`` etc.
_URL_TRAILING_PUNCT = ".,;:!?)]}>\"'"

# YouTube CHANNEL URL, the ``@handle`` / ``/c/`` / ``/user/`` / ``/channel/UC...``
# shapes. Almost every content-producing customer's website links to
# their channel from a "Follow us" section, header, or footer. Detecting
# that channel URL at ingest time lets Layer 1.5 auto-expand it into the
# full list of videos on that channel (see
# ``enrich_media_urls_with_channel_videos`` in youtube_metadata.py).
#
# The four capture groups match the four URL forms. At least ONE group
# is always populated on a match, the caller doesn't need to
# distinguish which, just needs the full matched URL to hand to the
# channel fetcher.
_YOUTUBE_CHANNEL_URL_RE = re.compile(
    r"https?://(?:www\.|m\.)?youtube\.com/"
    r"(?:@([A-Za-z0-9_\-.]{1,64})"
    r"|c/([A-Za-z0-9_\-.]{1,64})"
    r"|user/([A-Za-z0-9_\-.]{1,64})"
    r"|channel/(UC[A-Za-z0-9_-]{22}))"
    r"(?![A-Za-z0-9_\-.])",  # boundary - @cleanstart shouldn't match @cleanstart2 as a prefix
    re.IGNORECASE,
)


def extract_media_urls(text: str) -> dict:
    """Scan raw text for YouTube video URLs and downloadable file URLs.

    MUST run BEFORE :func:`clean_text`, the cleaner strips markdown link
    wrappers, so URLs that lived inside ``[text](url)`` markup would be
    permanently lost by the time it returns.

    Returns a dict with the shape::

        {
            "youtube": [{"video_id": "abc123", "url": "https://…"}, …],
            "files":   [{"url": "https://…/brochure.pdf", "name": "brochure.pdf"}, …],
        }

    Duplicates are removed (first occurrence wins). Empty categories are
    omitted, and an empty dict is returned when nothing was found so
    callers can cheaply short-circuit before allocating metadata keys.
    """
    if not text:
        return {}

    youtube_seen: set[str] = set()
    youtube: list[dict[str, str]] = []
    for match in _YOUTUBE_URL_RE.finditer(text):
        video_id = match.group(1)
        if video_id in youtube_seen:
            continue
        youtube_seen.add(video_id)
        youtube.append({"video_id": video_id, "url": match.group(0)})

    files_seen: set[str] = set()
    files: list[dict[str, str]] = []
    for match in _FILE_URL_RE.finditer(text):
        url = match.group(0).rstrip(_URL_TRAILING_PUNCT)
        if not url or url in files_seen:
            continue
        files_seen.add(url)
        # Derive a human-readable filename from the URL's path segment,
        # ignoring any query string. Falls back to a generic label so the
        # widget always has something to render.
        path = url.split("?", 1)[0]
        name = path.rsplit("/", 1)[-1] or "download"
        files.append({"url": url, "name": name})

    # YouTube channel URLs. Layer 1.5 auto-discover. Almost every content
    # customer links to their YouTube channel somewhere on their site
    # ("Follow us on YouTube" in the footer, social icons, About page).
    # We capture those URLs here so the ingestion pipeline can auto-fetch
    # every video on the channel and inject them into the bot's media
    # catalog. Customers get their full video library surfaced without
    # ever having to configure it manually.
    channels_seen: set[str] = set()
    channels: list[str] = []
    for match in _YOUTUBE_CHANNEL_URL_RE.finditer(text):
        raw = match.group(0).rstrip(_URL_TRAILING_PUNCT)
        canonical = raw.lower()
        if canonical in channels_seen:
            continue
        channels_seen.add(canonical)
        channels.append(raw)

    result: dict = {}
    if youtube:
        result["youtube"] = youtube
    if files:
        result["files"] = files
    if channels:
        result["youtube_channels"] = channels
    return result


# Whole-line markdown links. Group 1 is the anchor text, which is real content
# and is preserved; the URL around it is navigation noise.
_BULLET_LINK_LINE_RE = re.compile(r"^[*\-]\s*\[(.*?)\]\(.*?\)\s*$")
_STANDALONE_LINK_LINE_RE = re.compile(r"^\[(.*?)\]\(.*?\)$")

# A markdown table separator row (``| --- | :---: |``). Carries no information
# and is safe to drop even when the surrounding table is kept.
_TABLE_SEPARATOR_RE = re.compile(r"^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$")

# ---------------------------------------------------------------------------
# Prompt-injection defence (indirect injection via crawled/ingested content)
# ---------------------------------------------------------------------------
# Crawled web pages and uploaded documents end up inside the LLM's context
# window. A malicious or compromised source can embed instructions designed
# to hijack the model ("ignore previous instructions and …"). We strip the
# obvious markers. Model chat-template tokens and the most common
# instruction-override phrases. This is intentionally conservative: it can
# only catch the easy cases. A determined attacker can still evade these
# patterns; defence-in-depth (structured prompting with XML-tagged context
# blocks, content-safety filters) is the right long-term fix.
#
# Chat-template / control tokens used by major model families. If any of
# these appear in ingested content it's almost certainly malicious.
_CONTROL_TOKEN_RE = re.compile(
    r"<\|(?:im_start|im_end|endoftext|system|user|assistant|begin_of_text|end_of_text)\|>|"
    r"\[INST\]|\[/INST\]|<\|start_header_id\|>|<\|end_header_id\|>|"
    r"<\|eot_id\|>",
    re.IGNORECASE,
)

# Phrases that try to override the system prompt. Anchored to start-of-line
# (after optional whitespace and quote/punctuation) to avoid false positives
# in legitimate writing like "we should not ignore previous feedback". Phrase
# list is shared with rag_service.py's visitor-input detector (AR-17).
# See app/security/injection_patterns.py for why and where to add a new one.
_INJECTION_PHRASES_RE = compile_line_anchored_strip_pattern()


def _strip_injection_markers(text: str) -> str:
    """Remove obvious prompt-injection markers from ingested content.

    Conservative pattern-based strip. Does not catch sophisticated attacks,
    but blocks the copy-paste injections that show up in the wild.
    """
    text = _CONTROL_TOKEN_RE.sub("", text)
    text = _INJECTION_PHRASES_RE.sub("", text)
    return text


def _is_nav_bar_row(line: str) -> bool:
    """Return True for pipe-separated rows whose cells are all bare nav links.

    A real data-table row contains substantive cell content. A nav bar row
    looks like ``| [Home](/) | [About](/about) | [Pricing](/pricing) |``.
    Every non-empty cell is a single markdown link with no surrounding text.
    """
    cells = [c.strip() for c in line.split("|")]
    cells = [c for c in cells if c]
    if not cells:
        return True  # ``| | |``. Separators with no content
    return all(_NAV_LINK_CELL_RE.match(c) for c in cells)


def _nav_row_labels(line: str) -> list[str]:
    """The anchor texts of a link-only pipe row, in order, blanks dropped."""
    labels = []
    for cell in line.split("|"):
        match = _NAV_LINK_CELL_RE.match(cell.strip())
        if match:
            label = match.group(1).strip()
            if label:
                labels.append(label)
    return labels


def clean_text(text: str) -> str:
    """
    Cleans text by removing markdown noise (images, navigation links) and normalizing whitespace.
    Preserves bullet lists that contain substantive text (not just links) and
    markdown data tables (whose rows happen to start with ``|`` just like nav bars).
    """
    # 0. Strip prompt-injection markers BEFORE any other processing so
    #    the patterns can match before whitespace normalisation changes them.
    text = _strip_injection_markers(text)

    # 1. Remove Markdown Images: ![Alt](URL)
    text = re.sub(r"!\[.*?\]\(.*?\)", "", text)

    # 2. Split into lines to process line-by-line
    lines = text.split("\n")
    cleaned_lines = []

    for line in lines:
        line = line.strip()
        if not line:
            continue

        # 3. Filter Navigation & Menu Items
        # Lines that are PURELY a link (no descriptive text) lose the URL but
        # KEEP the anchor text. e.g. "* [Home](/)" becomes "Home", while
        # "* [Learn more](/pricing). Our flexible plans" is kept whole.
        # Dropping the whole line destroyed real content: a product or blog
        # index is a list of nothing but links, so it cleaned to '' and the
        # ingest pipeline skipped it with no log, no counter and no
        # user-visible signal, leaving the bot unable to say what the
        # customer even sells. A label with no text left is still dropped.
        bullet_link = _BULLET_LINK_LINE_RE.match(line)
        if bullet_link:
            label = bullet_link.group(1).strip()
            if label:
                cleaned_lines.append(label)
            continue

        # Pipe-prefixed lines need careful handling: reduce nav bars to their
        # labels, drop table separator rows, but PRESERVE real markdown data
        # tables (pricing, specs, comparisons) whose cells contain
        # substantive text.
        if line.startswith("|"):
            if _TABLE_SEPARATOR_RE.match(line):
                continue
            if _is_nav_bar_row(line):
                labels = _nav_row_labels(line)
                if labels:
                    cleaned_lines.append(" | ".join(labels))
                continue
            # Real data-table row. Keep it.

        # Lines that are JUST a standalone link "[Link](Url)" keep the label.
        standalone_link = _STANDALONE_LINK_LINE_RE.match(line)
        if standalone_link:
            label = standalone_link.group(1).strip()
            if label:
                cleaned_lines.append(label)
            continue

        cleaned_lines.append(line)

    # 4. Join back with newlines to preserve paragraph structure for chunking
    text = "\n".join(cleaned_lines)

    return text


# ---------------------------------------------------------------------------
# Reference-context hygiene (applied when the answer prompt is built)
# ---------------------------------------------------------------------------
# Crawled page furniture that the answer model reads as company facts. Both are
# applied to chunk text in ``rag_service._build_reference_context``, so stored
# chunks need no re-crawl; ``clean_text`` could call them at ingest too.

# One option of a phone country-code picker: "*    France+33", "United States +1".
# A contact form lists about 250 of them, and read as prose they say the company
# serves every country listed (production, 2026-09-17: "We serve France." from
# the Eventus Security contact form). The optional ``[Document: ...] [Page: n]``
# prefix is the header a chunk that opens inside the picker carries. Every
# quantifier is bounded or separated from its neighbour by a required character,
# so a hostile line costs linear time. The name must be a country or territory
# (``kb_quality.starts_with_country_name``), so "Revenue +40" is never one.
_PHONE_CODE_LINE_RE = re.compile(
    r"(?P<prefix>\[Document: [^\]\n]*\](?:[ \t]*\[Page: \d+\])?)?"
    r"[ \t]*(?:[*\-•][ \t]+)?"
    r"(?P<name>[^\W\d_](?:[^\W\d_]|[ .'’()&,\-]){0,59})"
    r"\+\d{1,4}[ \t]*"
)

# Fewer lines than this are an address or a list of offices, not a picker. A
# crawled picker runs to hundreds of lines; the shortest run in the Eventus
# Security knowledge base, cut by a chunk edge, is six. A chunk edge that
# leaves a shorter tail keeps those few lines.
_PHONE_CODE_MIN_RUN = 5


def _phone_code_line(line: str) -> re.Match[str] | None:
    if "+" not in line:
        return None
    match = _PHONE_CODE_LINE_RE.fullmatch(line)
    if match is None or not starts_with_country_name(match.group("name")):
        return None
    return match


def _strip_runs(lines: list[str], matches: list[re.Match[str] | None], min_run: int) -> list[str]:
    """``lines`` without each run of at least ``min_run`` consecutive matched lines.

    A dropped line's ``prefix`` group (a chunk's document header) is kept on
    its own line.
    """
    kept: list[str] = []
    start = 0
    while start < len(lines):
        if matches[start] is None:
            kept.append(lines[start])
            start += 1
            continue
        end = start
        while end < len(lines) and matches[end] is not None:
            end += 1
        if end - start < min_run:
            kept.extend(lines[start:end])
        else:
            for match in matches[start:end]:
                prefix = match.group("prefix") if match else None
                if prefix:
                    kept.append(prefix)
        start = end
    return kept


def strip_phone_code_runs(text: str) -> str:
    """Drop runs of five or more consecutive country-code picker lines.

    Every line of a run names a country or territory before its code. A lone
    "India +91" in an address block, a short office list, a results list such
    as "Revenue +40" and a full number such as "France +33 1 23 45 67 89" are
    kept. When a dropped line carries a chunk's document header, the header is
    kept on its own line.
    """
    if "+" not in text:
        return text
    lines = text.split("\n")
    return "\n".join(_strip_runs(lines, [_phone_code_line(line) for line in lines], _PHONE_CODE_MIN_RUN))


# One option of a plain country dropdown: a line that is only a country or
# territory name, with an optional bullet ("France", "*   Saint Martin (Dutch
# part)"). A form on an Eventus Security page lists about 250 of them, and the
# model read "France" there as a country the company serves (production,
# 2026-09-17 14:25 UTC, after the phone-code picker was already dropped). The
# name holds no digit and is bounded, the header prefix ends on a required
# "]", so a hostile line costs linear time.
_COUNTRY_LINE_RE = re.compile(
    r"(?P<prefix>\[Document: [^\]\n]*\](?:[ \t]*\[Page: \d+\])?)?"
    r"[ \t]*(?:[*\-•][ \t]+)?"
    r"(?P<name>[^\W\d_][^\d\n]{0,79})"
)
# A line longer than this is never a dropdown option, header included.
_COUNTRY_LINE_MAX_CHARS = 600

# Fewer lines than this are a list someone wrote ("regions we serve", a set of
# offices), not a form's dropdown, which runs to hundreds of lines. In the
# 2026-09-17 knowledge base exports the shortest dropdown run, cut by a chunk
# edge, is 19 lines, and no other run of name-only lines is longer than 3.
_COUNTRY_LINE_MIN_RUN = 10


def _country_line(line: str) -> re.Match[str] | None:
    if not line or len(line) > _COUNTRY_LINE_MAX_CHARS:
        return None
    match = _COUNTRY_LINE_RE.fullmatch(line)
    if match is None or not is_country_name(match.group("name").strip()):
        return None
    return match


def strip_country_name_runs(text: str) -> str:
    """Drop runs of ten or more consecutive lines that are each only a country or territory name.

    Every line of a run is a whole name (``kb_quality.is_country_name``) with
    an optional bullet. A shorter list, an office list ("India: Ahmedabad"),
    an address block and prose are kept. When a dropped line carries a chunk's
    document header, the header is kept on its own line.
    """
    lines = text.split("\n")
    if len(lines) < _COUNTRY_LINE_MIN_RUN:
        return text
    return "\n".join(_strip_runs(lines, [_country_line(line) for line in lines], _COUNTRY_LINE_MIN_RUN))


# ``[label](mailto:address)`` and ``[label](tel:number)``. The label may not be
# the address: CleanStart's pages link "careers@" to careers@cleanstart.com, so
# the model saw no careers address and opened the message form instead
# (production, 2026-09-17). Label and target exclude the characters that end
# them, and both are bounded, so the scan is linear.
_CONTACT_LINK_RE = re.compile(
    r"\[(?P<label>[^\[\]\n]{0,200})\]\((?P<scheme>mailto|tel):(?P<target>[^()\s]{1,320})\)",
    re.IGNORECASE,
)
_EMAIL_ADDRESS_RE = re.compile(r"[A-Za-z0-9._%+'\-]+@[A-Za-z0-9\-]+(?:\.[A-Za-z0-9\-]+)+")
_PHONE_NUMBER_RE = re.compile(r"\+?[\d().\- ]{5,40}")
_NON_DIGIT_RE = re.compile(r"\D")


def _contact_link_text(match: re.Match[str]) -> str:
    """The visible text for one contact link, or the link unchanged when its
    target is not a usable address or number."""
    label = match.group("label").strip().strip("*_").strip()
    target = unquote(match.group("target").split("?", 1)[0]).strip()
    if match.group("scheme").lower() == "mailto":
        if not _EMAIL_ADDRESS_RE.fullmatch(target):
            return match.group(0)
        # A label with an "@" or one that is part of the address ("careers@",
        # "careers") is the address itself, possibly cut short.
        if not label or "@" in label or label.lower() in target.lower():
            return target
        return f"{label} ({target})"
    digits = _NON_DIGIT_RE.sub("", target)
    if len(digits) < 5 or not _PHONE_NUMBER_RE.fullmatch(target):
        return match.group(0)
    if not label:
        return target
    label_digits = _NON_DIGIT_RE.sub("", label)
    if label_digits == digits:
        return label
    if label_digits:
        return target
    return f"{label} ({target})"


def expand_contact_links(text: str) -> str:
    """Rewrite mailto and tel links so the full address or number is visible."""
    if "mailto:" not in text.lower() and "tel:" not in text.lower():
        return text
    return _CONTACT_LINK_RE.sub(_contact_link_text, text)


def tidy_reference_text(text: str) -> str:
    """Chunk text as the answer model should read it."""
    return expand_contact_links(strip_country_name_runs(strip_phone_code_runs(text)))
