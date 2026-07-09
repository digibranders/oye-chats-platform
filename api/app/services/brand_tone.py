"""Brand-tone presets — the single source of truth for tone templates.

The admin "AI & Personality" tab lets a customer pick a tone from a curated set
of presets; the website crawl classifies the site into the closest one. The
customer-facing free-text ``Bot.brand_tone`` remains what actually steers the
LLM (injected as ``BRAND TONE: {brand_tone[:300]}`` in rag_service) — a preset
merely *fills* that text with a polished, prompt-ready description. ``Bot.
brand_tone_preset`` records which preset key is active (or ``"custom"``) so the
UI can highlight the right chip.

Design: docs/superpowers/specs/2026-07-09-brand-tone-presets-design.md

Each preset ``text`` is authored <= 280 chars so it survives the 300-char prompt
truncation intact (enforced by a unit test).
"""

# Ordered for display. Keys are stable identifiers persisted on the bot row —
# do not rename an existing key without a data migration.
BRAND_TONE_PRESETS: list[dict[str, str]] = [
    {
        "key": "professional",
        "label": "Professional",
        "text": (
            "Professional and polished. Clear, competent, and businesslike. Avoids slang and "
            "filler; stays respectful and confident without being stiff."
        ),
    },
    {
        "key": "friendly",
        "label": "Friendly",
        "text": (
            "Warm, friendly, and approachable. Conversational and personable, like a helpful "
            "teammate. Uses plain language and a positive, encouraging tone."
        ),
    },
    {
        "key": "playful",
        "label": "Playful",
        "text": (
            "Playful and lighthearted. Casual, witty, and upbeat, with the occasional tasteful "
            "emoji. Keeps things fun while still being genuinely helpful."
        ),
    },
    {
        "key": "concise",
        "label": "Concise & Direct",
        "text": (
            "Concise and direct. Gets to the point fast with short sentences and no filler. "
            "Prioritizes clear answers over pleasantries."
        ),
    },
    {
        "key": "empathetic",
        "label": "Empathetic",
        "text": (
            "Empathetic and reassuring. Patient, understanding, and supportive. Acknowledges the "
            "visitor's concern and offers calm, caring guidance."
        ),
    },
    {
        "key": "technical",
        "label": "Technical / Expert",
        "text": (
            "Technical and precise. Speaks with domain expertise and correct terminology, "
            "assuming a knowledgeable audience. Prioritizes accuracy over simplification."
        ),
    },
    {
        "key": "luxury",
        "label": "Luxury / Premium",
        "text": (
            "Refined and premium. Elegant, polished, and aspirational language that conveys "
            "quality and exclusivity. Understated confidence, never pushy."
        ),
    },
    {
        "key": "bold",
        "label": "Bold / Confident",
        "text": (
            "Bold and confident. Assertive, punchy, and opinionated. Makes strong, direct "
            "statements and champions the brand with energy."
        ),
    },
]

# Valid preset keys. ``"custom"`` (text edited away from any preset) and ``None``
# are also valid values for ``Bot.brand_tone_preset`` but are not preset keys.
PRESET_KEYS: frozenset[str] = frozenset(p["key"] for p in BRAND_TONE_PRESETS)

# The value stored on the bot when the customer hand-edits the tone text.
CUSTOM_PRESET: str = "custom"

_PRESET_TEXT_BY_KEY: dict[str, str] = {p["key"]: p["text"] for p in BRAND_TONE_PRESETS}


def preset_text(key: str | None) -> str | None:
    """Return the canonical prompt-ready text for a preset key, or ``None``.

    ``None`` for an unknown key (including ``"custom"``/``None``), so callers can
    safely ignore a classifier that returns something off-menu.
    """
    if not key:
        return None
    return _PRESET_TEXT_BY_KEY.get(key)


def is_valid_preset_value(value: str | None) -> bool:
    """True if ``value`` is an acceptable ``brand_tone_preset`` (key, custom, or None)."""
    return value is None or value == CUSTOM_PRESET or value in PRESET_KEYS
