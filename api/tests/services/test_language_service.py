"""Unit tests for language_service and language schemas (Phase 1)."""

import pytest
from pydantic import ValidationError

from app.schemas.language import LanguageContext, LocaleInfo
from app.services import language_service as ls

# ── Locale Normalization Tests ───────────────────────────────────────────────


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("en-US", "en-US"),
        ("en_US", "en-US"),
        ("en-GB", "en-GB"),
        ("en-IN", "en-IN"),
        ("en_in", "en-IN"),
        ("hi-IN", "hi-IN"),
        ("hi_in", "hi-IN"),
        ("fr-FR", "fr-FR"),
        ("fr_fr", "fr-FR"),
        ("fr-CA", "fr-CA"),
        ("pt-BR", "pt-BR"),
        ("pt_pt", "pt-PT"),
        ("es-ES", "es-ES"),
        ("es-MX", "es-MX"),
        ("ar-SA", "ar-SA"),
        ("zh-CN", "zh-CN"),
        ("zh_tw", "zh-TW"),
        ("zh-hans-cn", "zh-Hans-CN"),
        ("zh_Hant_HK", "zh-Hant-HK"),
        ("en", "en"),
        ("HI", "hi"),
        ("  en-US  ", "en-US"),
        ("en-US.UTF-8", "en-US"),
        ("en-US,en;q=0.9", "en-US"),
        ("en;q=0.8", "en"),
    ],
)
def test_normalize_locale_valid(raw: str, expected: str):
    assert ls.normalize_locale(raw) == expected


@pytest.mark.parametrize(
    "invalid",
    [
        None,
        "",
        "   ",
        "123",
        "12-34",
        "toolonglanguagecode-US",
        "en-toolongregioncode12345",
        "!!!",
        "en_US_invalid_extra_extra_parts",
    ],
)
def test_normalize_locale_invalid(invalid):
    assert ls.normalize_locale(invalid) is None


# ── Language Code Extraction Tests ───────────────────────────────────────────


@pytest.mark.parametrize(
    ("locale", "expected_lang"),
    [
        ("en-IN", "en"),
        ("en-US", "en"),
        ("hi-IN", "hi"),
        ("fr-CA", "fr"),
        ("zh-CN", "zh"),
        ("zh-Hans-CN", "zh"),
        ("ar-SA", "ar"),
        ("de", "de"),
    ],
)
def test_language_from_locale_valid(locale: str, expected_lang: str):
    assert ls.language_from_locale(locale) == expected_lang


def test_language_from_locale_none():
    assert ls.language_from_locale(None) is None
    assert ls.language_from_locale("") is None


# ── RTL and Direction Resolution Tests ───────────────────────────────────────


@pytest.mark.parametrize("rtl_locale", ["ar", "ar-SA", "ar-AE", "he", "he-IL", "fa", "fa-IR", "ur", "ur-PK"])
def test_get_locale_direction_rtl(rtl_locale: str):
    assert ls.get_locale_direction(rtl_locale) == "rtl"


@pytest.mark.parametrize("ltr_locale", ["en", "en-US", "en-IN", "hi", "hi-IN", "fr", "es", "de", "zh-CN", "ja-JP"])
def test_get_locale_direction_ltr(ltr_locale: str):
    assert ls.get_locale_direction(ltr_locale) == "ltr"


def test_get_locale_direction_default_fallback():
    assert ls.get_locale_direction(None) == "ltr"
    assert ls.get_locale_direction("") == "ltr"


# ── Supported Locale & Best Match Tests ──────────────────────────────────────


def test_is_supported_locale():
    supported = ["en-IN", "hi-IN", "fr-FR"]
    assert ls.is_supported_locale("en-IN", supported) is True
    assert ls.is_supported_locale("hi-IN", supported) is True
    # Base language match
    assert ls.is_supported_locale("en-US", supported) is True
    assert ls.is_supported_locale("fr-CA", supported) is True
    # Unsupported
    assert ls.is_supported_locale("es-ES", supported) is False
    assert ls.is_supported_locale("ja-JP", supported) is False
    assert ls.is_supported_locale(None, supported) is False
    assert ls.is_supported_locale("en-IN", []) is False


def test_match_supported_locale():
    supported = ["en-IN", "hi-IN", "fr-FR", "pt-BR"]

    # Exact match
    assert ls.match_supported_locale("en-IN", supported) == "en-IN"
    assert ls.match_supported_locale("hi_IN", supported) == "hi-IN"

    # Base language fallback to first supported variant
    assert ls.match_supported_locale("en-US", supported) == "en-IN"
    assert ls.match_supported_locale("fr-CA", supported) == "fr-FR"
    assert ls.match_supported_locale("pt-PT", supported) == "pt-BR"

    # No match
    assert ls.match_supported_locale("es-ES", supported) is None
    assert ls.match_supported_locale(None, supported) is None
    assert ls.match_supported_locale("en-IN", []) is None


# ── Precedence Resolution Tests ──────────────────────────────────────────────


def test_resolve_initial_locale_precedence():
    supported = ["en-IN", "hi-IN", "fr-FR", "es-ES", "pt-BR", "de-DE", "ar-SA"]

    # 1. Explicit selection beats everything
    ctx = ls.resolve_initial_locale(
        explicit="hi-IN",
        site="fr-FR",
        html_lang="de-DE",
        browser="es-ES",
        persisted="pt-BR",
        supported=supported,
    )
    assert ctx.locale == "hi-IN"
    assert ctx.language == "hi"
    assert ctx.source == "explicit"
    assert ctx.confidence == 1.0
    assert ctx.locked is True
    assert ctx.direction == "ltr"

    # 2. Site beats html_lang, browser, persisted
    ctx = ls.resolve_initial_locale(
        site="fr-FR",
        html_lang="de-DE",
        browser="es-ES",
        persisted="pt-BR",
        supported=supported,
    )
    assert ctx.locale == "fr-FR"
    assert ctx.language == "fr"
    assert ctx.source == "site"
    assert ctx.confidence == 0.9
    assert ctx.locked is False

    # 3. html_lang beats browser, persisted
    ctx = ls.resolve_initial_locale(
        html_lang="de-DE",
        browser="es-ES",
        persisted="pt-BR",
        supported=supported,
    )
    assert ctx.locale == "de-DE"
    assert ctx.language == "de"
    assert ctx.source == "html_lang"
    assert ctx.confidence == 0.8
    assert ctx.locked is False

    # 4. browser beats persisted
    ctx = ls.resolve_initial_locale(
        browser="es-ES",
        persisted="pt-BR",
        supported=supported,
    )
    assert ctx.locale == "es-ES"
    assert ctx.language == "es"
    assert ctx.source == "browser"
    assert ctx.confidence == 0.7
    assert ctx.locked is False

    # 5. persisted used when higher signals absent
    ctx = ls.resolve_initial_locale(
        persisted="pt-BR",
        supported=supported,
    )
    assert ctx.locale == "pt-BR"
    assert ctx.language == "pt"
    assert ctx.source == "persisted"
    assert ctx.confidence == 0.85
    assert ctx.locked is False

    # 6. default used when no signals match
    ctx = ls.resolve_initial_locale(
        supported=supported,
        default="en-IN",
    )
    assert ctx.locale == "en-IN"
    assert ctx.language == "en"
    assert ctx.source == "default"
    assert ctx.confidence == 0.5
    assert ctx.locked is False


def test_resolve_initial_locale_unsupported_falls_through():
    # If a high-priority candidate is unsupported, resolution falls through to next supported candidate
    supported = ["en-IN", "hi-IN"]

    ctx = ls.resolve_initial_locale(
        explicit="ja-JP",  # unsupported
        browser="hi-IN",  # supported
        supported=supported,
        default="en-IN",
    )
    assert ctx.locale == "hi-IN"
    assert ctx.source == "browser"


def test_resolve_initial_locale_rtl_direction():
    supported = ["en-IN", "ar-SA"]
    ctx = ls.resolve_initial_locale(
        explicit="ar-SA",
        supported=supported,
    )
    assert ctx.locale == "ar-SA"
    assert ctx.language == "ar"
    assert ctx.direction == "rtl"


# ── Message Language Detection Stub Test ─────────────────────────────────────


def test_detect_message_language_stub():
    lang, conf = ls.detect_message_language("Hello, how are you?")
    assert lang is None
    assert conf == 0.0


# ── Schema Validation Tests ──────────────────────────────────────────────────


def test_locale_info_schema():
    info = LocaleInfo(
        code="hi",
        locale="hi-IN",
        name="Hindi (India)",
        native_name="हिन्दी",
        direction="ltr",
    )
    assert info.code == "hi"
    assert info.locale == "hi-IN"
    assert info.enabled is True


def test_language_context_schema():
    ctx = LanguageContext(
        language="hi",
        locale="hi-IN",
        source="explicit",
        confidence=1.0,
        direction="ltr",
        locked=True,
    )
    assert ctx.language == "hi"
    assert ctx.locked is True

    # Invalid direction or confidence range
    with pytest.raises(ValidationError):
        LanguageContext(
            language="hi",
            locale="hi-IN",
            source="explicit",
            confidence=1.5,  # > 1.0
            direction="ltr",
        )


# ── Cross-implementation parity ─────────────────────────────────────────────


def _shared_normalization_fixtures() -> list[tuple[str, str | None]]:
    """Read NORMALIZATION_FIXTURES out of the widget's locale catalog.

    The widget ships its own BCP-47 parser (it has to: locale resolution starts
    in the browser, before any request is made). Two independent parsers for one
    contract is how `zh-Hans-CN` ended up normalizing to `zh-HANS` on the client
    while the server produced `zh-Hans-CN`. Rather than duplicate the case table
    in two languages, both suites assert against the same literal list.
    """
    import ast
    import re
    from pathlib import Path

    catalog = Path(__file__).resolve().parents[3] / "widget" / "src" / "i18n" / "localeCatalog.js"
    if not catalog.exists():  # pragma: no cover - widget absent from a slim checkout
        pytest.skip("widget/src/i18n/localeCatalog.js not present")

    source = catalog.read_text(encoding="utf-8")
    match = re.search(r"NORMALIZATION_FIXTURES = \[(.*?)\n\];", source, re.DOTALL)
    assert match, "NORMALIZATION_FIXTURES not found in localeCatalog.js"

    cases: list[tuple[str, str | None]] = []
    for row in re.finditer(r"\[([^\]]*)\]", match.group(1)):
        # Parse each row as a literal rather than splitting on commas: one of
        # the fixture inputs is an Accept-Language string that contains a comma
        # of its own ('en-US,en;q=0.9'), which a naive split cuts in half.
        # JS single-quoted arrays are valid Python literals once `null` -> None.
        literal = re.sub(r"\bnull\b", "None", f"[{row.group(1)}]")
        pair = ast.literal_eval(literal)
        assert len(pair) == 2, f"malformed fixture row: {literal}"
        cases.append((pair[0], pair[1]))
    assert cases, "no fixture rows parsed"
    return cases


def test_normalize_locale_matches_widget_fixtures():
    """The Python and JavaScript normalizers must agree on every shared case."""
    for raw, expected in _shared_normalization_fixtures():
        assert ls.normalize_locale(raw) == expected, f"normalize_locale({raw!r})"


def test_normalize_locale_preserves_script_subtag():
    assert ls.normalize_locale("zh-Hans-CN") == "zh-Hans-CN"
    assert ls.normalize_locale("zh_hant_tw") == "zh-Hant-TW"


# ── Phase 3: message detection + display names ───────────────────────────────


def test_detect_message_language_scripts():
    assert ls.detect_message_language("नमस्ते मुझे मदद चाहिए")[0] == "hi"
    assert ls.detect_message_language("مرحبا أحتاج المساعدة")[0] == "ar"
    assert ls.detect_message_language("привет мне нужна помощь")[0] == "ru"
    assert ls.detect_message_language("こんにちは")[0] == "ja"
    # Latin cannot be disambiguated by script -> no detection.
    assert ls.detect_message_language("Hello there") == (None, 0.0)
    assert ls.detect_message_language("") == (None, 0.0)
    assert ls.detect_message_language("hi") == (None, 0.0)


def test_detect_message_language_confidence_is_script_share():
    _, conf = ls.detect_message_language("नमस्ते")
    assert conf >= 0.85
    _, conf_mixed = ls.detect_message_language("मुझे pricing चाहिए")
    assert conf_mixed < 0.85  # code-switched


def test_language_display_name():
    assert ls.language_display_name("hi-IN") == "Hindi (India)"
    assert ls.language_display_name("ar-SA") == "Arabic (Saudi Arabia)"
    # Base-language fallback for an unknown region.
    assert ls.language_display_name("hi-XX") == "Hindi (India)"
    # Unknown language -> None (caller supplies a safe generic phrase).
    assert ls.language_display_name("xx-YY") is None
    assert ls.language_display_name(None) is None
