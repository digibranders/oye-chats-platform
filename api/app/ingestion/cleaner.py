import re

from app.security.injection_patterns import compile_line_anchored_strip_pattern

# A "cell" that is nothing but a single markdown link — i.e. a nav-bar entry.
# Used to distinguish pipe-separated nav rows from real markdown data tables.
_NAV_LINK_CELL_RE = re.compile(r"^\s*\[[^\]]+\]\([^)]+\)\s*$")

# ---------------------------------------------------------------------------
# Media URL extraction
# ---------------------------------------------------------------------------
# Runs BEFORE clean_text so we capture URLs that live inside markdown links
# (``[Watch the demo](https://youtube.com/…)``). The cleaner strips those
# link wrappers a few lines below, so if we don't capture here they are lost
# forever. Plain-URL occurrences survive cleaning too and would still be
# caught, but many crawled pages format their video/file references as
# markdown links, which is why this pass is unconditional at ingest time.

# YouTube URL patterns — canonical, short, embed, and shorts forms. The
# 11-char video ID is YouTube's stable identifier and is what the widget
# uses to build the thumbnail URL, so extraction focuses on that.
_YOUTUBE_URL_RE = re.compile(
    r"https?://(?:www\.|m\.)?"
    r"(?:youtube\.com/(?:watch\?(?:[^\s\"'<>()\[\]]*&)?v=|embed/|v/|shorts/)|youtu\.be/)"
    r"([A-Za-z0-9_-]{11})"
    r"(?:[?&#][^\s\"'<>()\[\]]*)?",
    re.IGNORECASE,
)

# Downloadable file URLs — extensions we surface as attachment cards in
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
# sequence — but ALLOWS a trailing ``.`` at the end of a sentence
# (``.pdf.`` followed by whitespace or end of string), which is
# subsequently swept off by ``_URL_TRAILING_PUNCT`` on the caller side.
# Result: real URLs — ``foo.pdf``, ``foo.pdf/preview``, ``foo.pdf?v=1``,
# ``foo.pdf#page=3``, ``foo.pdf.`` at end of sentence — all match; domain
# labels containing an extension prefix — ``hub.docker.com``,
# ``help.xlsx.io`` — do not.
_FILE_URL_RE = re.compile(
    r"https?://[^\s\"'<>()\[\]]+\.(?:" + "|".join(_DOWNLOAD_EXTENSIONS) + r")"
    r"(?!(?:[A-Za-z0-9]|\.[A-Za-z0-9]))"
    r"(?:\?[^\s\"'<>()\[\]]*)?",
    re.IGNORECASE,
)

# Trailing punctuation that URL regexes commonly sweep up — strip before
# using the URL so we don't emit ``https://example.com/file.pdf.`` etc.
_URL_TRAILING_PUNCT = ".,;:!?)]}>\"'"

# YouTube CHANNEL URL — the ``@handle`` / ``/c/`` / ``/user/`` / ``/channel/UC...``
# shapes. Almost every content-producing customer's website links to
# their channel from a "Follow us" section, header, or footer. Detecting
# that channel URL at ingest time lets Layer 1.5 auto-expand it into the
# full list of videos on that channel (see
# ``enrich_media_urls_with_channel_videos`` in youtube_metadata.py).
#
# The four capture groups match the four URL forms. At least ONE group
# is always populated on a match — the caller doesn't need to
# distinguish which, just needs the full matched URL to hand to the
# channel fetcher.
_YOUTUBE_CHANNEL_URL_RE = re.compile(
    r"https?://(?:www\.|m\.)?youtube\.com/"
    r"(?:@([A-Za-z0-9_\-.]{1,64})"
    r"|c/([A-Za-z0-9_\-.]{1,64})"
    r"|user/([A-Za-z0-9_\-.]{1,64})"
    r"|channel/(UC[A-Za-z0-9_-]{22}))"
    r"(?![A-Za-z0-9_\-.])",  # boundary — @cleanstart shouldn't match @cleanstart2 as a prefix
    re.IGNORECASE,
)


def extract_media_urls(text: str) -> dict:
    """Scan raw text for YouTube video URLs and downloadable file URLs.

    MUST run BEFORE :func:`clean_text` — the cleaner strips markdown link
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

    # YouTube channel URLs — Layer 1.5 auto-discover. Almost every content
    # customer links to their YouTube channel somewhere on their site
    # ("Follow us on YouTube" in the footer, social icons, About page).
    # We capture those URLs here so the ingestion pipeline can auto-fetch
    # every video on the channel and inject them into the bot's media
    # catalog — customers get their full video library surfaced without
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


# A markdown table separator row (``| --- | :---: |``). Carries no information
# and is safe to drop even when the surrounding table is kept.
_TABLE_SEPARATOR_RE = re.compile(r"^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$")

# ---------------------------------------------------------------------------
# Prompt-injection defence (indirect injection via crawled/ingested content)
# ---------------------------------------------------------------------------
# Crawled web pages and uploaded documents end up inside the LLM's context
# window. A malicious or compromised source can embed instructions designed
# to hijack the model ("ignore previous instructions and …"). We strip the
# obvious markers — model chat-template tokens and the most common
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
# list is shared with rag_service.py's visitor-input detector (AR-17) —
# see app/security/injection_patterns.py for why and where to add a new one.
_INJECTION_PHRASES_RE = compile_line_anchored_strip_pattern()


def _strip_injection_markers(text: str) -> str:
    """Remove obvious prompt-injection markers from ingested content.

    Conservative pattern-based strip — does not catch sophisticated attacks,
    but blocks the copy-paste injections that show up in the wild.
    """
    text = _CONTROL_TOKEN_RE.sub("", text)
    text = _INJECTION_PHRASES_RE.sub("", text)
    return text


def _is_nav_bar_row(line: str) -> bool:
    """Return True for pipe-separated rows whose cells are all bare nav links.

    A real data-table row contains substantive cell content. A nav bar row
    looks like ``| [Home](/) | [About](/about) | [Pricing](/pricing) |`` —
    every non-empty cell is a single markdown link with no surrounding text.
    """
    cells = [c.strip() for c in line.split("|")]
    cells = [c for c in cells if c]
    if not cells:
        return True  # ``| | |`` — separators with no content
    return all(_NAV_LINK_CELL_RE.match(c) for c in cells)


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
        # Only remove lines that are PURELY a navigation link (no descriptive text).
        # e.g., "* [Home](/)" is stripped, but "* [Learn more](/pricing) — our flexible plans" is kept.
        if re.match(r"^[*\-]\s*\[.*?\]\(.*?\)\s*$", line):
            continue

        # Pipe-prefixed lines need careful handling: drop nav bars, drop
        # table separator rows, but PRESERVE real markdown data tables
        # (pricing, specs, comparisons) whose cells contain substantive text.
        if line.startswith("|"):
            if _TABLE_SEPARATOR_RE.match(line):
                continue
            if _is_nav_bar_row(line):
                continue
            # Real data-table row — keep it.

        # Remove lines that are JUST a standalone link "[Link](Url)"
        if re.match(r"^\[.*?\]\(.*?\)$", line):
            continue

        cleaned_lines.append(line)

    # 4. Join back with newlines to preserve paragraph structure for chunking
    text = "\n".join(cleaned_lines)

    return text
