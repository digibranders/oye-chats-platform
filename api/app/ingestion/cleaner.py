import re


def clean_text(text: str) -> str:
    """
    Cleans text by removing markdown noise (images, navigation links) and normalizing whitespace.
    Preserves bullet lists that contain substantive text (not just links).
    """
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

        # Remove lines that start with "|" (table separators / nav bars)
        if line.startswith("|"):
            continue

        # Remove lines that are JUST a standalone link "[Link](Url)"
        if re.match(r"^\[.*?\]\(.*?\)$", line):
            continue

        cleaned_lines.append(line)

    # 4. Join back with newlines to preserve paragraph structure for chunking
    text = "\n".join(cleaned_lines)

    return text
