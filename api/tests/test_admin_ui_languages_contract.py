"""The admin dashboard's UI dictionaries and the backend's catalogue must agree.

``ADMIN_UI_LANGUAGES`` decides which languages the dashboard's own language
selector offers. Like its widget counterpart it is a hand-maintained copy of a
fact that lives in another project: the set of dictionaries ``app/src/i18n/``
actually ships. Nothing stops the two drifting except this test.

Drift in either direction is a real defect:

- A language listed here with no admin dictionary is offered to the customer
  and produces a half-translated dashboard, which reads as breakage rather than
  as a language the product does not yet speak.
- A dictionary shipped but not listed here is invisible: the translation work
  is done and nobody can select it.

The separation from ``WIDGET_UI_LANGUAGES`` is itself part of the contract and
is asserted below. The two surfaces ship different dictionaries covering
different copy; one reaching a language first must never imply the other has.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from app.services.language_service import (
    ADMIN_UI_LANGUAGES,
    KNOWN_LOCALES,
    WIDGET_UI_LANGUAGES,
)

# api/tests/ -> api/ -> platform/ -> app/src/i18n
_ADMIN_I18N = Path(__file__).resolve().parents[2] / "app" / "src" / "i18n"
_LOCALES_DIR = _ADMIN_I18N / "locales"

# English ships no runtime dictionary on purpose: every t() call site carries an
# inline English default, so loading one would send the same strings twice.
# locales/en.ts is the canonical translator source and IS present in the
# directory, so the listing below already accounts for it.


def _admin_dictionary_languages() -> set[str]:
    if not _LOCALES_DIR.is_dir():
        pytest.skip(f"admin checkout not present at {_LOCALES_DIR}")
    return {path.stem for path in _LOCALES_DIR.glob("*.ts") if not path.stem.endswith(".test")}


def test_admin_ui_languages_matches_the_shipped_dictionaries() -> None:
    shipped = _admin_dictionary_languages()
    assert shipped, "no admin dictionaries found; the glob or the path is wrong"

    missing_dictionary = ADMIN_UI_LANGUAGES - shipped
    assert not missing_dictionary, (
        f"{sorted(missing_dictionary)} are offered in the dashboard's language selector but "
        "the admin has no dictionary for them, so the console would render in English"
    )

    unlisted = shipped - ADMIN_UI_LANGUAGES
    assert not unlisted, (
        f"{sorted(unlisted)} have an admin dictionary but are not in ADMIN_UI_LANGUAGES, so nobody can select them"
    )


def test_the_dictionary_loader_registers_every_non_english_dictionary() -> None:
    """A dictionary file is inert until i18n.ts knows how to import it."""
    source = (_ADMIN_I18N / "i18n.ts").read_text(encoding="utf-8")
    for language in _admin_dictionary_languages() - {"en"}:
        assert re.search(rf"{language}:\s*\(\)\s*=>\s*import\('\./locales/{language}'\)", source), (
            f"locales/{language}.ts exists but DICTIONARY_LOADERS never imports it"
        )


def test_english_has_no_runtime_loader() -> None:
    """Loading en.ts at runtime would ship every string twice.

    Every call site already carries `t('key') || 'English'`, so English is
    present in the component that renders it. A loader entry for `en` would
    also quietly make the inline defaults unreachable, which is what keeps
    "English output is unchanged" structurally true rather than merely claimed.
    """
    source = (_ADMIN_I18N / "i18n.ts").read_text(encoding="utf-8")
    # The declaration carries a type annotation containing "=>", so anchor on
    # the identifier and take everything up to the closing brace instead of
    # trying to skip past an assignment that regex cannot reliably find.
    loaders = re.search(r"DICTIONARY_LOADERS.*?\{(.*?)\n\};", source, re.S)
    assert loaders, "DICTIONARY_LOADERS not found in app/src/i18n/i18n.ts"
    assert "en:" not in loaders.group(1), "English must not have a runtime dictionary loader"


def test_every_admin_ui_translated_locale_resolves_to_a_listed_language() -> None:
    flagged = {info.code for info in KNOWN_LOCALES.values() if info.admin_ui_translated}
    assert flagged == ADMIN_UI_LANGUAGES & {info.code for info in KNOWN_LOCALES.values()}


def test_locales_without_an_admin_dictionary_are_flagged_false() -> None:
    # The catalogue still lists them: the AI converses in them, and a bot that
    # already has one configured must keep rendering its name in the admin.
    for tag in ("es-ES", "ru-RU", "ar-SA", "ur-PK"):
        assert tag in KNOWN_LOCALES, f"{tag} should stay in the catalogue"
        assert KNOWN_LOCALES[tag].admin_ui_translated is False


def test_admin_and_widget_capabilities_are_independent_flags() -> None:
    """The two must not be the same object, or the same field, by accident.

    They happen to hold the same launch languages today. That is a coincidence
    of scheduling, not a rule, and the moment one ships a language first this
    test is what stops the other silently claiming it too.
    """
    assert ADMIN_UI_LANGUAGES is not WIDGET_UI_LANGUAGES

    for info in KNOWN_LOCALES.values():
        assert isinstance(info.admin_ui_translated, bool)
        assert isinstance(info.ui_translated, bool)

    # Field identity: flipping one on a copied model must not move the other.
    sample = KNOWN_LOCALES["hi-IN"].model_copy()
    sample.admin_ui_translated = False
    assert sample.ui_translated is True, "admin_ui_translated is aliasing ui_translated"


def test_rtl_locales_are_never_admin_ui_translated() -> None:
    """RTL is explicitly deferred: 216 physical direction classes, 7 logical.

    Offering an RTL language would mirror the layout and then render the
    untranslated remainder into it. The flag is the enforcement point, so this
    stays until the direction conversion is done as its own piece of work.
    """
    for tag, info in KNOWN_LOCALES.items():
        if info.direction == "rtl":
            assert info.admin_ui_translated is False, (
                f"{tag} is RTL and must not be offered as an admin UI language yet"
            )
