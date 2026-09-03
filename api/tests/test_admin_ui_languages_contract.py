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
    for tag in ("es-ES", "ru-RU", "ur-PK"):
        assert tag in KNOWN_LOCALES, f"{tag} should stay in the catalogue"
        assert KNOWN_LOCALES[tag].admin_ui_translated is False


def test_ar_sa_stays_untranslated_despite_sharing_ar_aes_dictionary() -> None:
    """A per-CODE derivation would otherwise mark ar-SA translated too.

    ar-SA and ar-AE share the base language code `ar`, and the general rule
    (`_info.admin_ui_translated = _info.code in ADMIN_UI_LANGUAGES`) is by
    code, not by tag - the same rule that correctly marks en-IN, en-US and
    en-GB all translated together. Arabic is deliberately different: ar-SA
    defaults to the Islamic calendar, which was never part of what got
    tested (`ar-AE` was chosen specifically for its Gregorian default), so
    `language_service.py` overrides it back to `False` after the derivation.
    """
    assert KNOWN_LOCALES["ar-SA"].admin_ui_translated is False
    assert KNOWN_LOCALES["ar-AE"].admin_ui_translated is True
    assert KNOWN_LOCALES["ar-SA"].code == KNOWN_LOCALES["ar-AE"].code


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


def test_an_rtl_locale_is_admin_ui_translated_only_where_the_console_actually_mirrors() -> None:
    """RTL is no longer deferred - the admin dashboard now renders `dir="rtl"`.

    The physical-direction Tailwind classes that used to make this unsafe
    (``ml-``, ``text-right``, ``rounded-tl-`` and friends) were converted to
    Tailwind v4's logical equivalents (``ms-``, ``text-start``,
    ``rounded-ss-``, ...), and `app/src/i18n/I18nProvider.tsx` resolves `dir`
    per locale through `directionForLocale` instead of pinning it to `ltr`.
    The guard that makes offering an RTL language safe now is
    `app/scripts/rtl-physical-classes.mjs` plus its vitest regression test
    `app/src/rtl.test.ts`: together they fail the admin's own `lint`/`test`
    gate the moment a new physical-direction class ships without either being
    converted or carrying a reviewed `rtl-ok:` exception.

    So the new truth is narrower than "never": an RTL locale may be
    ``admin_ui_translated`` exactly when BOTH the console can render its
    direction (proven by the guard above, which this test cannot itself run
    from the API's test suite) AND a real Arabic dictionary exists for it
    (`app/src/i18n/locales/ar.ts`, proven by
    `test_admin_ui_languages_matches_the_shipped_dictionaries`). `ar` is the
    only language that currently satisfies both; the other RTL locales in the
    catalogue (`he-IL`, `fa-IR`, `ur-PK`) have no admin dictionary at all yet
    and must stay `False` until one ships for them too.
    """
    # Tag-precise, not code-precise: `ar-AE` and `ar-SA` share the code `ar`
    # but must not share this flag (see `test_ar_sa_stays_untranslated...`
    # below), so "which RTL tags are admin-translated" cannot be answered by
    # checking `info.code` alone.
    rtl_tags_expected_translated = {"ar-AE"}
    for tag, info in KNOWN_LOCALES.items():
        if info.direction != "rtl":
            continue
        expected = tag in rtl_tags_expected_translated
        assert info.admin_ui_translated is expected, (
            f"{tag}: admin_ui_translated={info.admin_ui_translated}, expected {expected} - "
            "an RTL locale is admin-translated only for the specific tag whose direction "
            "and formatting were actually verified, per the guard named above"
        )
