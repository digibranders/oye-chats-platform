import re

# A "cell" that is nothing but a single markdown link — i.e. a nav-bar entry.
# Used to distinguish pipe-separated nav rows from real markdown data tables.
_NAV_LINK_CELL_RE = re.compile(r"^\s*\[[^\]]+\]\([^)]+\)\s*$")

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
# in legitimate writing like "we should not ignore previous feedback".
_INJECTION_PHRASES_RE = re.compile(
    r"(?im)^[\s>\-*\"']*\b("
    r"ignore\s+(?:all\s+)?(?:previous|prior|above)\s+(?:instructions|prompts?|context|rules)|"
    r"disregard\s+(?:all\s+)?(?:previous|prior|above)\s+(?:instructions|prompts?|context)|"
    r"forget\s+(?:everything|all)\s+(?:above|before|previous)|"
    r"your\s+new\s+(?:instructions|system\s+prompt|role)\s+(?:is|are)|"
    r"you\s+are\s+now\s+(?:a\s+)?(?:different|new)|"
    r"system\s+prompt\s*:|"
    r"new\s+instructions\s*:"
    r")\b.*$"
)


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
