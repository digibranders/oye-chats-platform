"""The fence rule for a visitor's text inside a gate-tier classifier prompt.

The urgent, document and handoff classifiers put the visitor's message between
``<<<...>>>`` marker lines and tell the model that everything inside is data. A
message holding its own closing marker ("<<<END VISITOR MESSAGE>>>") would end
the fence early and have the rest read as instructions, so every run of three or
more ``<`` or ``>`` is split into pairs before the message goes in.
"""

from __future__ import annotations

import re

#: A run of three or more fence characters.
_FENCE_RUN_RE = re.compile(r"<{3,}|>{3,}")


def _in_pairs(run: re.Match[str]) -> str:
    text = run.group(0)
    return " ".join(text[start : start + 2] for start in range(0, len(text), 2))


def neutralise_fence(text: str | None) -> str:
    """``text`` with every run of three or more ``<`` or ``>`` split into pairs.

    "<<<<<<" becomes "<< << <<". Unlike a single replace, which turns a run of
    five or six into one that still holds "<<<", no run of any length leaves a
    marker behind, and no character is dropped. ``None`` is an empty string.
    """
    return _FENCE_RUN_RE.sub(_in_pairs, text or "")
