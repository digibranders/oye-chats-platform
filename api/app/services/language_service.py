"""Language and locale foundation services for OyeChats Multilingual.

Provides locale normalization, BCP-47 canonicalization, direction resolution
(LTR / RTL), supported locale validation, initial locale precedence resolution,
and stub message language detection.
"""

from __future__ import annotations

import re
from typing import Literal

from app.schemas.language import LanguageContext, LocaleInfo

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

# Standard locale catalog with metadata
KNOWN_LOCALES: dict[str, LocaleInfo] = {
    "en-IN": LocaleInfo(code="en", locale="en-IN", name="English (India)", native_name="English (India)", direction="ltr"),
    "en-US": LocaleInfo(code="en", locale="en-US", name="English (United States)", native_name="English (US)", direction="ltr"),
    "en-GB": LocaleInfo(code="en", locale="en-GB", name="English (United Kingdom)", native_name="English (UK)", direction="ltr"),
    "hi-IN": LocaleInfo(code="hi", locale="hi-IN", name="Hindi (India)", native_name="हिन्दी", direction="ltr"),
    "es-ES": LocaleInfo(code="es", locale="es-ES", name="Spanish (Spain)", native_name="Español (España)", direction="ltr"),
    "es-MX": LocaleInfo(code="es", locale="es-MX", name="Spanish (Mexico)", native_name="Español (México)", direction="ltr"),
    "fr-FR": LocaleInfo(code="fr", locale="fr-FR", name="French (France)", native_name="Français (France)", direction="ltr"),
    "fr-CA": LocaleInfo(code="fr", locale="fr-CA", name="French (Canada)", native_name="Français (Canada)", direction="ltr"),
    "de-DE": LocaleInfo(code="de", locale="de-DE", name="German (Germany)", native_name="Deutsch", direction="ltr"),
    "pt-BR": LocaleInfo(code="pt", locale="pt-BR", name="Portuguese (Brazil)", native_name="Português (Brasil)", direction="ltr"),
    "pt-PT": LocaleInfo(code="pt", locale="pt-PT", name="Portuguese (Portugal)", native_name="Português (Portugal)", direction="ltr"),
    "it-IT": LocaleInfo(code="it", locale="it-IT", name="Italian (Italy)", native_name="Italiano", direction="ltr"),
    "nl-NL": LocaleInfo(code="nl", locale="nl-NL", name="Dutch (Netherlands)", native_name="Nederlands", direction="ltr"),
    "ja-JP": LocaleInfo(code="ja", locale="ja-JP", name="Japanese (Japan)", native_name="日本語", direction="ltr"),
    "ko-KR": LocaleInfo(code="ko", locale="ko-KR", name="Korean (South Korea)", native_name="한국어", direction="ltr"),
    "zh-CN": LocaleInfo(code="zh", locale="zh-CN", name="Chinese (Simplified)", native_name="简体中文", direction="ltr"),
    "zh-TW": LocaleInfo(code="zh", locale="zh-TW", name="Chinese (Traditional)", native_name="繁體中文", direction="ltr"),
    "ar-SA": LocaleInfo(code="ar", locale="ar-SA", name="Arabic (Saudi Arabia)", native_name="العربية", direction="rtl"),
    "ar-AE": LocaleInfo(code="ar", locale="ar-AE", name="Arabic (UAE)", native_name="العربية (الإمارات)", direction="rtl"),
    "tr-TR": LocaleInfo(code="tr", locale="tr-TR", name="Turkish (Turkey)", native_name="Türkçe", direction="ltr"),
    "id-ID": LocaleInfo(code="id", locale="id-ID", name="Indonesian (Indonesia)", native_name="Bahasa Indonesia", direction="ltr"),
    "vi-VN": LocaleInfo(code="vi", locale="vi-VN", name="Vietnamese (Vietnam)", native_name="Tiếng Việt", direction="ltr"),
    "th-TH": LocaleInfo(code="th", locale="th-TH", name="Thai (Thailand)", native_name="ไทย", direction="ltr"),
    "pl-PL": LocaleInfo(code="pl", locale="pl-PL", name="Polish (Poland)", native_name="Polski", direction="ltr"),
    "ru-RU": LocaleInfo(code="ru", locale="ru-RU", name="Russian (Russia)", native_name="Русский", direction="ltr"),
    "uk-UA": LocaleInfo(code="uk", locale="uk-UA", name="Ukrainian (Ukraine)", native_name="Українська", direction="ltr"),
    "he-IL": LocaleInfo(code="he", locale="he-IL", name="Hebrew (Israel)", native_name="עברית", direction="rtl"),
    "fa-IR": LocaleInfo(code="fa", locale="fa-IR", name="Persian (Iran)", native_name="فارسی", direction="rtl"),
    "ur-PK": LocaleInfo(code="ur", locale="ur-PK", name="Urdu (Pakistan)", native_name="اردو", direction="rtl"),
}

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


def detect_message_language(text: str) -> tuple[str | None, float]:
    """Stub message-level language detection for Phase 1.

    Returns (detected_language_code, confidence).
    Real heuristic/classifier implementation lands in Phase 3.
    """
    return (None, 0.0)
