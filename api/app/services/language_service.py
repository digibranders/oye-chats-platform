"""Language and locale foundation services for OyeChats Multilingual.

Provides locale normalization, BCP-47 canonicalization, direction resolution
(LTR / RTL), supported locale validation, initial locale precedence resolution,
and stub message language detection.
"""

from __future__ import annotations

import logging
import re
from typing import Literal

from app.schemas.language import LanguageContext, LocaleInfo

logger = logging.getLogger(__name__)

# Standard BCP-47 supported language base codes
SUPPORTED_LANGUAGE_CODES: frozenset[str] = frozenset(
    {
        "en",
        "hi",
        "es",
        "fr",
        "de",
        "pt",
        "it",
        "nl",
        "ja",
        "ko",
        "zh",
        "ar",
        "tr",
        "id",
        "vi",
        "th",
        "pl",
        "ru",
        "uk",
    }
)

# Right-to-left language base codes
RTL_LANGUAGES: frozenset[str] = frozenset({"ar", "he", "fa", "ur"})

#: Pricing-config feature name for the platform-wide multilingual switch.
#: Resolves to the ``feature.multilingual_chat_enabled`` key.
MULTILINGUAL_FEATURE = "multilingual_chat"


def is_multilingual_enabled(bot) -> bool:
    """True when this bot should resolve a conversation language at all.

    Two gates, checked in this order for a reason:

    1. ``bot.language_config.enabled`` - the customer's own control. Checked
       first because it needs no database access, so a bot with multilingual
       off takes exactly the same code path it did before this switch existed.
       That is what keeps disabled behaviour byte-identical.
    2. ``feature.multilingual_chat_enabled`` - the platform control, read from
       pricing config through the same 60-second in-process cache that serves
       ``feature.translation_enabled``. Only consulted for bots that already
       passed gate 1, so it never adds a session to the disabled fast path.

    Returning False makes the caller behave as if the customer had never
    enabled multilingual: no language directive in the prompt, the legacy QA
    cache key, English canned paths. It is a rollout lever, not a billing one;
    nothing is charged either way.

    Fails OPEN. A pricing row that is missing, or a database that cannot be
    reached, leaves the feature ON, matching ``is_feature_enabled``'s own
    stance: an operator who wants it off will have set the key, and a
    transient database problem must not silently change what language a live
    conversation is being held in.
    """
    cfg = getattr(bot, "language_config", None) or {}
    if not cfg.get("enabled", False):
        return False

    # Deferred import: credit_service imports the ORM, and this module is
    # imported by schema-level code. Same convention translation_service uses.
    from app.db.session import get_session
    from app.services import credit_service

    try:
        with get_session() as session:
            return credit_service.is_feature_enabled(session, MULTILINGUAL_FEATURE)
    except Exception:
        logger.warning("multilingual switch lookup failed; leaving the feature on", exc_info=True)
        return True


# Base languages the WIDGET ships a UI dictionary for.
#
# Distinct from SUPPORTED_LANGUAGE_CODES above, which is about what the AI can
# converse in. A locale can be in that set and absent here: the bot answers in
# the visitor's language while the widget's own buttons, forms and error
# messages stay English. On an RTL language that is worse than either half,
# because the widget flips to a right-to-left layout and then renders English
# into it.
#
# The authority is widget/src/i18n/i18n.js's DICTIONARY_LOADERS plus English,
# which needs no runtime dictionary because every call site carries an inline
# English default. tests/test_widget_ui_languages_contract.py reads the widget's
# locales directory and fails if the two drift.
WIDGET_UI_LANGUAGES: frozenset[str] = frozenset(
    {
        "ar",
        "de",
        "en",
        "es",
        "fr",
        "hi",
        "id",
        "it",
        "ja",
        "ko",
        "nl",
        "pl",
        "pt",
        "ru",
        "th",
        "tr",
        "uk",
        "vi",
        "zh",
    }
)

# Dictionaries that SHIP but are deliberately not offered yet.
#
# A machine translation of the widget's chrome is not fit to put in front of a
# customer's visitors until a native speaker has read it. This set is where a
# finished dictionary waits for that sign-off: the file is in the repo, the
# loader imports it, the parity and placeholder guards run against it, and
# `ui_translated` stays False so the admin's language picker does not offer it.
#
# Promotion is one line - move the code from here to WIDGET_UI_LANGUAGES - and
# that line is the reviewable record that someone signed the language off.
#
# Empty today: the 17 languages that waited here have all been promoted. It
# stays as the mechanism, because the next translation will need it.
#
# Without this set the contract test refuses the state entirely: it asserts the
# shipped dictionaries and WIDGET_UI_LANGUAGES match in BOTH directions, so an
# unreviewed translation could only be committed by also offering it.
WIDGET_UI_LANGUAGES_PENDING_REVIEW: frozenset[str] = frozenset()

# Base languages the ADMIN DASHBOARD ships an interface for (Phase 7).
#
# Separate from WIDGET_UI_LANGUAGES above and never derived from it. They are
# different applications with different dictionaries: the widget translates a
# visitor's chat chrome, the dashboard translates the customer's own console.
# Either can reach a language before the other, and reusing one flag for both
# would offer a language that one of the two surfaces renders in English.
#
# The authority is app/src/i18n/i18n.ts's DICTIONARY_LOADERS plus English,
# which needs no runtime dictionary because every call site carries an inline
# English default. tests/test_admin_ui_languages_contract.py reads the admin's
# locales directory and fails if the two drift.
ADMIN_UI_LANGUAGES: frozenset[str] = frozenset({"en", "hi", "ar"})

# Standard locale catalog with metadata
KNOWN_LOCALES: dict[str, LocaleInfo] = {
    "en-IN": LocaleInfo(
        code="en", locale="en-IN", name="English (India)", native_name="English (India)", direction="ltr"
    ),
    "en-US": LocaleInfo(
        code="en", locale="en-US", name="English (United States)", native_name="English (US)", direction="ltr"
    ),
    "en-GB": LocaleInfo(
        code="en", locale="en-GB", name="English (United Kingdom)", native_name="English (UK)", direction="ltr"
    ),
    "hi-IN": LocaleInfo(code="hi", locale="hi-IN", name="Hindi (India)", native_name="हिन्दी", direction="ltr"),
    "es-ES": LocaleInfo(
        code="es", locale="es-ES", name="Spanish (Spain)", native_name="Español (España)", direction="ltr"
    ),
    "es-MX": LocaleInfo(
        code="es", locale="es-MX", name="Spanish (Mexico)", native_name="Español (México)", direction="ltr"
    ),
    "fr-FR": LocaleInfo(
        code="fr", locale="fr-FR", name="French (France)", native_name="Français (France)", direction="ltr"
    ),
    "fr-CA": LocaleInfo(
        code="fr", locale="fr-CA", name="French (Canada)", native_name="Français (Canada)", direction="ltr"
    ),
    "de-DE": LocaleInfo(code="de", locale="de-DE", name="German (Germany)", native_name="Deutsch", direction="ltr"),
    "pt-BR": LocaleInfo(
        code="pt", locale="pt-BR", name="Portuguese (Brazil)", native_name="Português (Brasil)", direction="ltr"
    ),
    "pt-PT": LocaleInfo(
        code="pt", locale="pt-PT", name="Portuguese (Portugal)", native_name="Português (Portugal)", direction="ltr"
    ),
    "it-IT": LocaleInfo(code="it", locale="it-IT", name="Italian (Italy)", native_name="Italiano", direction="ltr"),
    "nl-NL": LocaleInfo(
        code="nl", locale="nl-NL", name="Dutch (Netherlands)", native_name="Nederlands", direction="ltr"
    ),
    "ja-JP": LocaleInfo(code="ja", locale="ja-JP", name="Japanese (Japan)", native_name="日本語", direction="ltr"),
    "ko-KR": LocaleInfo(code="ko", locale="ko-KR", name="Korean (South Korea)", native_name="한국어", direction="ltr"),
    "zh-CN": LocaleInfo(
        code="zh", locale="zh-CN", name="Chinese (Simplified)", native_name="简体中文", direction="ltr"
    ),
    "zh-TW": LocaleInfo(
        code="zh", locale="zh-TW", name="Chinese (Traditional)", native_name="繁體中文", direction="ltr"
    ),
    "ar-SA": LocaleInfo(
        code="ar", locale="ar-SA", name="Arabic (Saudi Arabia)", native_name="العربية", direction="rtl"
    ),
    "ar-AE": LocaleInfo(
        code="ar", locale="ar-AE", name="Arabic (UAE)", native_name="العربية (الإمارات)", direction="rtl"
    ),
    "tr-TR": LocaleInfo(code="tr", locale="tr-TR", name="Turkish (Turkey)", native_name="Türkçe", direction="ltr"),
    "id-ID": LocaleInfo(
        code="id", locale="id-ID", name="Indonesian (Indonesia)", native_name="Bahasa Indonesia", direction="ltr"
    ),
    "vi-VN": LocaleInfo(
        code="vi", locale="vi-VN", name="Vietnamese (Vietnam)", native_name="Tiếng Việt", direction="ltr"
    ),
    "th-TH": LocaleInfo(code="th", locale="th-TH", name="Thai (Thailand)", native_name="ไทย", direction="ltr"),
    "pl-PL": LocaleInfo(code="pl", locale="pl-PL", name="Polish (Poland)", native_name="Polski", direction="ltr"),
    "ru-RU": LocaleInfo(code="ru", locale="ru-RU", name="Russian (Russia)", native_name="Русский", direction="ltr"),
    "uk-UA": LocaleInfo(
        code="uk", locale="uk-UA", name="Ukrainian (Ukraine)", native_name="Українська", direction="ltr"
    ),
    "he-IL": LocaleInfo(code="he", locale="he-IL", name="Hebrew (Israel)", native_name="עברית", direction="rtl"),
    "fa-IR": LocaleInfo(code="fa", locale="fa-IR", name="Persian (Iran)", native_name="فارسی", direction="rtl"),
    "ur-PK": LocaleInfo(code="ur", locale="ur-PK", name="Urdu (Pakistan)", native_name="اردو", direction="rtl"),
}

# Derived rather than written on each of the 29 entries above: a hand-set flag
# repeated per row is a drift waiting to happen, and the rule is one line.
for _info in KNOWN_LOCALES.values():
    _info.ui_translated = _info.code in WIDGET_UI_LANGUAGES
    _info.admin_ui_translated = _info.code in ADMIN_UI_LANGUAGES
del _info

# ar-SA shares Arabic's `code` with ar-AE, so the per-code derivation above
# would mark it admin_ui_translated too - but ar-SA defaults to the Islamic
# (Hijri) calendar, a locale variant the admin's formatters were never
# verified against (see the Arabic rollout's "decisions already made": ar-AE
# was chosen specifically to get the Gregorian calendar and Latin digits).
# The dashboard's own language picker only ever offers `ar-AE` regardless of
# this flag, but the flag itself should say what was actually tested rather
# than overstate it for a tag nothing exercises.
KNOWN_LOCALES["ar-SA"].admin_ui_translated = False


def _derive_base_language_names() -> dict[str, str]:
    """English name per base language code, derived from ``KNOWN_LOCALES``.

    Catalogue names carry a region qualifier ("English (India)", "Chinese
    (Simplified)") because they name a *locale*. A base language code names the
    language alone, and that is what a detected ``source_language`` or a
    conversation badge carries, so the qualifier is dropped. The first
    catalogue entry for a base code wins, matching the base-language fallback
    ``language_display_name`` already uses.

    Derived rather than hand-maintained so there is exactly one place a locale
    is ever added.
    """
    names: dict[str, str] = {}
    for info in KNOWN_LOCALES.values():
        if info.code not in names:
            names[info.code] = info.name.split(" (", 1)[0]
    return names


# Base-language display names. Built once at import: ``KNOWN_LOCALES`` is a
# module constant, so this can never go stale relative to it.
LANGUAGE_NAMES: dict[str, str] = _derive_base_language_names()


_LOCALE_SPLIT_REGEX = re.compile(r"[-_]")


def normalize_locale(value: str | None) -> str | None:
    """Normalize a locale tag to canonical BCP-47 format.

    Examples:
        'en_US' -> 'en-US'
        'HI-in' -> 'hi-IN'
        'fr-ca' -> 'fr-CA'
        'zh_cn' -> 'zh-CN'
        'zh-hans-cn' -> 'zh-Hans-CN'
        'en' -> 'en'
        None / '' / invalid -> None
    """
    if not value or not isinstance(value, str):
        return None

    cleaned = value.strip()
    if not cleaned:
        return None

    # Strip character encodings if present (e.g. 'en_US.UTF-8' -> 'en_US')
    if "." in cleaned:
        cleaned = cleaned.split(".", 1)[0]
    # Strip quality values (e.g. 'en-US,en;q=0.9' -> 'en-US')
    if "," in cleaned:
        cleaned = cleaned.split(",", 1)[0].strip()
    if ";" in cleaned:
        cleaned = cleaned.split(";", 1)[0].strip()

    parts = _LOCALE_SPLIT_REGEX.split(cleaned)
    if not parts or not all(parts):
        return None

    # Max 3 parts (language, optional script, optional region)
    if len(parts) > 3:
        return None

    lang = parts[0].lower()
    if not lang.isalpha() or not (2 <= len(lang) <= 3):
        return None

    if len(parts) == 1:
        return lang

    formatted_parts = [lang]
    remaining = parts[1:]

    # Check script if 4 alpha chars (e.g. Hans, Hant)
    if len(remaining) > 0 and len(remaining[0]) == 4 and remaining[0].isalpha():
        formatted_parts.append(remaining[0].capitalize())
        remaining = remaining[1:]

    # Check region if 2 alpha chars or 3 digits (e.g. US, IN, 419)
    if len(remaining) > 0:
        region = remaining[0]
        if len(region) == 2 and region.isalpha():
            formatted_parts.append(region.upper())
            remaining = remaining[1:]
        elif len(region) == 3 and region.isdigit():
            formatted_parts.append(region)
            remaining = remaining[1:]
        else:
            return None

    # If any parts still remain, it's invalid
    if remaining:
        return None

    return "-".join(formatted_parts)


def language_from_locale(locale: str | None) -> str | None:
    """Extract the base language code (e.g. 'en', 'hi', 'zh') from a locale tag."""
    norm = normalize_locale(locale)
    if not norm:
        return None
    return norm.split("-", 1)[0]


def get_locale_direction(locale: str | None) -> Literal["ltr", "rtl"]:
    """Determine text direction ('ltr' or 'rtl') from a locale or language code."""
    lang = language_from_locale(locale)
    if lang and lang in RTL_LANGUAGES:
        return "rtl"
    return "ltr"


def is_supported_locale(locale: str, supported: list[str]) -> bool:
    """Check if a locale is directly supported or matches a supported base language."""
    if not locale or not supported:
        return False

    norm_target = normalize_locale(locale)
    if not norm_target:
        return False

    norm_supported = {normalize_locale(s) for s in supported} - {None}
    if norm_target in norm_supported:
        return True

    # Base language match
    target_lang = language_from_locale(norm_target)
    supported_langs = {language_from_locale(s) for s in norm_supported}
    return target_lang in supported_langs


def match_supported_locale(candidate: str | None, supported: list[str]) -> str | None:
    """Find the best matching supported locale for a candidate string.

    1. Exact normalized match (e.g. candidate 'fr-CA' matches supported 'fr-CA').
    2. Base language match (e.g. candidate 'fr-CA' matches supported 'fr-FR' if only 'fr-FR' is supported).
    3. Return None if no match.
    """
    norm_candidate = normalize_locale(candidate)
    if not norm_candidate or not supported:
        return None

    # Normalized supported list preserving order
    clean_supported = [normalize_locale(s) for s in supported]
    valid_supported = [s for s in clean_supported if s is not None]

    # 1. Exact match
    for sup in valid_supported:
        if norm_candidate == sup:
            return sup

    # 2. Base language match
    candidate_lang = language_from_locale(norm_candidate)
    for sup in valid_supported:
        if candidate_lang == language_from_locale(sup):
            return sup

    return None


def resolve_initial_locale(
    *,
    explicit: str | None = None,
    site: str | None = None,
    html_lang: str | None = None,
    browser: str | None = None,
    persisted: str | None = None,
    supported: list[str] | None = None,
    default: str = "en-IN",
) -> LanguageContext:
    """Resolve the initial conversation language following the strict precedence hierarchy:

    1. explicit (manual visitor selection)
    2. site (host website API configuration)
    3. html_lang (host page <html lang="...">)
    4. browser (navigator.language)
    5. persisted (previous session / localStorage preference)
    6. default (bot default locale)

    Resolution checks against the bot's ``supported_locales`` list.
    """
    supported_list = supported or [default]

    candidates = [
        ("explicit", explicit, 1.0),
        ("site", site, 0.9),
        ("html_lang", html_lang, 0.8),
        ("browser", browser, 0.7),
        ("persisted", persisted, 0.85),
    ]

    for source_name, candidate_val, confidence in candidates:
        if candidate_val:
            matched = match_supported_locale(candidate_val, supported_list)
            if matched:
                base_lang = language_from_locale(matched) or "en"
                direction = get_locale_direction(matched)
                locked = source_name == "explicit"
                return LanguageContext(
                    language=base_lang,
                    locale=matched,
                    source=source_name,
                    confidence=confidence,
                    direction=direction,
                    locked=locked,
                )

    # Fallback to default
    norm_default = match_supported_locale(default, supported_list) or normalize_locale(default) or "en-IN"
    base_lang = language_from_locale(norm_default) or "en"
    direction = get_locale_direction(norm_default)

    return LanguageContext(
        language=base_lang,
        locale=norm_default,
        source="default",
        confidence=0.5,
        direction=direction,
        locked=False,
    )


def language_display_name(locale: str | None) -> str | None:
    """English display name for a locale, resolved server-side from the catalog.

    Used to build the conversation-language prompt directive. The name comes
    from ``KNOWN_LOCALES`` (or a base-language match), never from
    request-supplied text, so a visitor cannot inject prompt content through the
    ``locale`` field. Returns None when the locale is not recognised.
    """
    norm = normalize_locale(locale)
    if not norm:
        return None
    info = KNOWN_LOCALES.get(norm)
    if info:
        return info.name
    # Base-language fallback: 'hi-XX' -> the first 'hi-*' catalogue entry's name.
    base = language_from_locale(norm)
    if base:
        for meta in KNOWN_LOCALES.values():
            if meta.code == base:
                return meta.name
    return None


# Unicode script ranges that map cleanly to a single base language for the
# supported catalogue. Detection is deliberately script-based and
# dependency-free: it reliably separates non-Latin scripts (the high-value
# case, e.g. a Devanagari or Arabic first message with no locale headers) from
# each other, and returns low confidence for Latin text, which it cannot
# disambiguate (English vs French vs Spanish share the Latin script). Latin
# languages are expected to resolve through the explicit / site / html_lang /
# browser tiers instead. This is a first-turn best-effort tier, not a general
# language classifier.
_SCRIPT_RANGES: tuple[tuple[int, int, str], ...] = (
    (0x0900, 0x097F, "hi"),  # Devanagari (Hindi, Marathi)
    (0x0600, 0x06FF, "ar"),  # Arabic
    (0x0750, 0x077F, "ar"),  # Arabic Supplement
    (0x0590, 0x05FF, "he"),  # Hebrew
    (0x0400, 0x04FF, "ru"),  # Cyrillic (Russian, Ukrainian)
    (0x0E00, 0x0E7F, "th"),  # Thai
    (0xAC00, 0xD7AF, "ko"),  # Hangul syllables
    (0x1100, 0x11FF, "ko"),  # Hangul Jamo
    (0x3040, 0x309F, "ja"),  # Hiragana
    (0x30A0, 0x30FF, "ja"),  # Katakana
    (0x4E00, 0x9FFF, "zh"),  # CJK Unified (shared Han; mapped to zh here)
)


def _script_language(codepoint: int) -> str | None:
    for start, end, lang in _SCRIPT_RANGES:
        if start <= codepoint <= end:
            return lang
    return None


def detect_message_language(text: str) -> tuple[str | None, float]:
    """Best-effort message-level language detection by Unicode script.

    Returns ``(base_language_code, confidence)`` where confidence is the share
    of script-bearing letters that belong to the dominant non-Latin script.
    Returns ``(None, 0.0)`` for empty, too-short, or Latin-dominant text, so the
    caller falls through to its own default rather than guessing a Latin
    language it cannot actually distinguish.

    This runs only on the first turn of an unresolved session (see
    ``_resolve_visitor_language_and_update_session``); it never overrides a
    locked or already-resolved session language.
    """
    language, confidence, _letters = detect_message_language_detail(text)
    return (language, confidence)


def detect_message_language_detail(text: str) -> tuple[str | None, float, int]:
    """:func:`detect_message_language` plus the raw evidence behind the score.

    The third element is the ABSOLUTE number of letters in the dominant
    non-Latin script. The share alone cannot decide whether a detection is
    trustworthy, because code-switched input dilutes it: "मुझे pricing चाहिए"
    is unambiguously Hindi and scores 0.42, while a single stray Devanagari
    glyph in an English sentence can score higher on a very short message. The
    caller combines the two (see ``chat_routes._detection_is_trusted``), which
    is why the count is returned rather than folded into the confidence,
    ``confidence`` is persisted on the session and must keep meaning "share of
    letters", not "how sure the caller decided to be".
    """
    if not text or not isinstance(text, str):
        return (None, 0.0, 0)

    counts: dict[str, int] = {}
    latin = 0
    scripted = 0
    for ch in text:
        if not ch.isalpha():
            continue
        cp = ord(ch)
        # Basic + Latin-1 + Latin Extended ranges.
        if cp < 0x0250 or (0x1E00 <= cp <= 0x1EFF):
            latin += 1
            continue
        lang = _script_language(cp)
        if lang:
            counts[lang] = counts.get(lang, 0) + 1
            scripted += 1

    # Require a minimal amount of non-Latin signal before committing.
    if scripted < 2:
        return (None, 0.0, 0)

    dominant = max(counts, key=counts.get)
    total_letters = scripted + latin
    confidence = counts[dominant] / total_letters if total_letters else 0.0
    return (dominant, round(confidence, 4), counts[dominant])
