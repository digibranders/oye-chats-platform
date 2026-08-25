"""The widget's UI dictionaries and the backend's catalogue must agree.

``WIDGET_UI_LANGUAGES`` decides which locales the admin's language picker
offers. It is a hand-maintained copy of a fact that lives in another project:
the set of dictionaries ``widget/src/i18n/`` actually ships. Nothing stops the
two drifting except this test.

Drift in either direction is a real defect:

- A language listed here with no widget dictionary is offered to customers and
  produces a half-translated widget. On an RTL language it is worse than that:
  the layout mirrors and the chrome stays English. That is exactly how
  ``ar-SA``, ``ur-PK``, ``es-ES`` and ``ru-RU`` reached two live bots.
- A dictionary shipped but not listed here is invisible: the translation work
  is done and paid for, and no customer can select it.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from app.services.language_service import KNOWN_LOCALES, WIDGET_UI_LANGUAGES

# api/tests/ -> api/ -> platform/ -> widget/src/i18n
_WIDGET_I18N = Path(__file__).resolve().parents[2] / "widget" / "src" / "i18n"
_LOCALES_DIR = _WIDGET_I18N / "locales"

# English ships no runtime dictionary on purpose: every t() call site carries an
# inline English default, so loading one would send the same strings twice to
# every visitor. locales/en.js is the canonical source translators work from and
# is present in the directory, so the directory listing already accounts for it.


def _widget_dictionary_languages() -> set[str]:
    if not _LOCALES_DIR.is_dir():
        pytest.skip(f"widget checkout not present at {_LOCALES_DIR}")
    return {path.stem for path in _LOCALES_DIR.glob("*.js") if not path.stem.endswith(".test")}


def test_widget_ui_languages_matches_the_shipped_dictionaries() -> None:
    shipped = _widget_dictionary_languages()
    assert shipped, "no widget dictionaries found; the glob or the path is wrong"

    missing_dictionary = WIDGET_UI_LANGUAGES - shipped
    assert not missing_dictionary, (
        f"{sorted(missing_dictionary)} are offered to customers but the widget has no "
        "dictionary for them, so its chrome would render in English"
    )

    unlisted = shipped - WIDGET_UI_LANGUAGES
    assert not unlisted, (
        f"{sorted(unlisted)} have a widget dictionary but are not in WIDGET_UI_LANGUAGES, "
        "so no customer can select them"
    )


def test_the_dictionary_loader_registers_every_non_english_dictionary() -> None:
    """A dictionary file is inert until i18n.js knows how to import it."""
    source = (_WIDGET_I18N / "i18n.js").read_text(encoding="utf-8")
    for language in _widget_dictionary_languages() - {"en"}:
        assert f"{language}: () => import('./locales/{language}.js')" in source, (
            f"locales/{language}.js exists but DICTIONARY_LOADERS never imports it"
        )


def test_every_ui_translated_locale_resolves_to_a_listed_language() -> None:
    flagged = {info.code for info in KNOWN_LOCALES.values() if info.ui_translated}
    assert flagged == WIDGET_UI_LANGUAGES & {info.code for info in KNOWN_LOCALES.values()}


def test_locales_without_a_dictionary_are_flagged_false() -> None:
    # The catalogue still lists them: the AI converses in them, and a bot that
    # already has one configured must keep rendering its name in the admin.
    for tag in ("es-ES", "ru-RU", "ar-SA", "ur-PK"):
        assert tag in KNOWN_LOCALES, f"{tag} should stay in the catalogue"
        assert KNOWN_LOCALES[tag].ui_translated is False
