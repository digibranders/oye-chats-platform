"""Shared prompt-injection phrase list (AR-17).

Before this module, two independently-maintained regexes covered the same
threat class in different places: ``app/ingestion/cleaner.py`` (destructively
stripping injection phrases from ingested/crawled content before embedding)
and ``app/services/rag_service.py`` (non-destructively detecting injection
attempts in visitor input and custom system prompts, to trigger a refusal).
They had already drifted apart. E.g. cleaner.py required "you are now
(different|new)" while rag_service.py only excluded "assistant|support"
after "you are now", and each had phrases the other lacked entirely ("SYSTEM:"
vs "system prompt:"). A new jailbreak phrasing added to one during incident
response was never mirrored to the other.

This module is the single edit point going forward, split into three tiers
by false-positive risk (a destructive strip against real crawled prose needs
a tighter bar than a non-destructive detection-and-refuse check):

- ``SHARED_FRAGMENTS``. Safe for both. Structural override attempts
  ("ignore previous instructions", "override the system prompt") that don't
  plausibly appear in ordinary marketing copy.
- ``STRIP_ONLY_FRAGMENTS``. Used by cleaner.py's destructive strip.
  Currently empty beyond what's shared; kept as an explicit extension point
  so a future ingest-specific phrase doesn't get bolted onto the detection
  pattern by habit.
- ``DETECTION_ONLY_FRAGMENTS``. Used by rag_service.py's non-destructive
  detector only. Phrases like "act as a doctor" or "pretend to be" have
  real false-positive risk against legitimate crawled prose ("act as your
  trusted advisor"). Acceptable for a refusal-triggering check, not for
  silently mangling a customer's real website content.
"""

import re

SHARED_FRAGMENTS: tuple[str, ...] = (
    r"ignore\s+(?:all\s+)?(?:previous|prior|above|earlier)\s+(?:instructions?|prompts?|rules?|context)",
    r"disregard\s+(?:all\s+)?(?:previous|prior|above|earlier)\s+(?:instructions?|prompts?|context)",
    r"forget\s+(?:everything|all)\s+(?:above|before|previous)",
    r"(?:your\s+new|new)\s+(?:instructions|system\s+prompt|role)\s*(?:is|are|:)",
    r"new\s+instructions\s*:",
    r"override\s+(?:the\s+)?(?:system|all)\s+(?:prompt|instructions?)",
    r"system\s+prompt\s*:",
    r"new\s+persona\s*:",
    # Broader than "you are now (different|new)" on purpose. Also catches
    # "you are now a pirate"/"you are now DAN", not just those two literal
    # words. Only excludes phrasings that would false-positive on this bot's
    # own legitimate self-description ("you are now talking to our
    # assistant/support").
    r"you\s+are\s+now\s+(?:a\s+)?(?!assistant|support)",
)

# Ingest-time-only extension point. Empty today; everything cleaner.py
# needed is already in SHARED_FRAGMENTS.
STRIP_ONLY_FRAGMENTS: tuple[str, ...] = ()

# Non-destructive-detection-only: real false-positive risk if used to
# silently strip ingested prose (see module docstring).
DETECTION_ONLY_FRAGMENTS: tuple[str, ...] = (
    r"act\s+as\s+(?!a\s+support|a\s+helpful)",
    r"pretend\s+(?:you\s+are|to\s+be)",
    # Bare "SYSTEM:" role-marker spoofing (ChatML-style), distinct from the
    # "system prompt:" phrasing above.
    r"SYSTEM\s*:",
)

# Common injection/role-marker delimiters seen in copy-pasted jailbreaks and
# raw chat-template syntax (ChatML/Llama-style). Detection-only: these
# delimiters can appear legitimately in crawled technical documentation
# about LLM prompting, so cleaner.py's ingest-time strip does not use them.
INJECTION_DELIMITER_FRAGMENTS: tuple[str, ...] = (
    r"<<<",
    r">>>",
    r"\[\[",
    r"\]\]",
    r"<\|",
    r"\|>",
)


def _alternation(fragments: tuple[str, ...]) -> str:
    return "|".join(f"(?:{frag})" for frag in fragments)


def compile_line_anchored_strip_pattern() -> re.Pattern:
    """cleaner.py's shape: anchored to start-of-line (after optional
    whitespace/quote/punctuation) so ingest-time stripping doesn't
    false-positive on legitimate prose like "we should not ignore previous
    feedback". Uses SHARED_FRAGMENTS + STRIP_ONLY_FRAGMENTS only, never
    DETECTION_ONLY_FRAGMENTS, which have real false-positive risk against
    real crawled marketing copy.
    """
    # Trailing \b (pre-existing in the original cleaner.py pattern this
    # replaces) never matches for colon-terminated fragments like
    # "system prompt:", a colon and the following whitespace are both
    # non-word characters, so no word-boundary transition exists there.
    # Dropped; the leading \b already prevents matching inside a larger word.
    phrases = _alternation(SHARED_FRAGMENTS + STRIP_ONLY_FRAGMENTS)
    return re.compile(r"(?im)^[\s>\-*\"']*\b(" + phrases + r").*$")


def compile_detection_pattern() -> re.Pattern:
    """rag_service.py's shape: unanchored boolean detection over visitor
    input / custom system prompts. Uses the full fragment set (shared +
    detection-only) plus common injection delimiters. False positives here
    only trigger a refusal, not silent content loss, so the broader net is
    an acceptable tradeoff.
    """
    phrases = _alternation(SHARED_FRAGMENTS + DETECTION_ONLY_FRAGMENTS)
    delimiters = "|".join(INJECTION_DELIMITER_FRAGMENTS)
    return re.compile(r"(" + phrases + r")|(" + delimiters + r")", re.IGNORECASE)
