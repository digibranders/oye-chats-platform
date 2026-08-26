"""Phase 5A - the locale catalogue endpoint and the operator's available locales.

The point of these tests is not that ``GET /locales`` returns JSON. It is that
the dashboard can stop carrying its own copy of the locale list: the response
has to cover everything the old hardcoded tables covered, or deleting them is a
regression rather than a consolidation.
"""

import os

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.locale_routes import router as locale_router
from app.api.operator_routes import router as operator_router
from app.db.models import Bot, Client, Operator
from app.services.language_service import KNOWN_LOCALES, LANGUAGE_NAMES

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")

REQUIRED_FIELDS = ("code", "locale", "name", "native_name", "direction")


@pytest.fixture(autouse=True)
def _no_limit(monkeypatch):
    from app.core.rate_limit import limiter

    monkeypatch.setattr(limiter, "enabled", False)


def _locale_app() -> FastAPI:
    app = FastAPI()
    app.include_router(locale_router)
    return app


def _operator_app() -> FastAPI:
    app = FastAPI()
    app.include_router(operator_router)
    return app


def _seed(db, *, language_config, api_key="key-acme", operator_key="op-key-acme", email="acme@example.com"):
    """One workspace: client + bot + the owner's operator row."""
    client = Client(name="Acme", email=email, api_key=api_key, hashed_password="x")
    db.add(client)
    db.flush()

    bot = Bot(
        client_id=client.id,
        name="Acme Bot",
        bot_key=f"bot-{api_key}",
        language_config=language_config,
    )
    db.add(bot)
    db.flush()

    operator = Operator(
        client_id=client.id,
        bot_id=bot.id,
        name="Asha",
        email=f"asha-{api_key}@example.com",
        operator_api_key=operator_key,
        role="owner",
        preferred_locale="en-IN",
    )
    db.add(operator)
    db.commit()
    return client, bot, operator


# ── The catalogue itself ─────────────────────────────────────────────────────


class TestLocaleCatalogue:
    def test_returns_every_known_locale_with_every_field(self, db):
        _seed(db, language_config={"enabled": True, "supported_locales": ["en-IN"]})
        res = TestClient(_locale_app()).get("/locales", headers={"X-API-Key": "key-acme"})

        assert res.status_code == 200, res.text
        locales = res.json()["locales"]
        assert {row["locale"] for row in locales} == set(KNOWN_LOCALES)
        for row in locales:
            for field in REQUIRED_FIELDS:
                assert row.get(field), f"{row.get('locale')} is missing {field}"
            assert row["direction"] in {"ltr", "rtl"}

    def test_base_language_names_cover_every_locale_in_the_catalogue(self, db):
        """A conversation carries a BASE code, not a locale tag.

        ``ChatSession.language_code`` and ``ChatMessage.source_language`` are
        base codes, so the locale rows alone cannot label them. If this map
        ever stops covering a catalogued locale, the conversation badge starts
        rendering "HI" instead of "Hindi".
        """
        _seed(db, language_config={"enabled": True, "supported_locales": ["en-IN"]})
        res = TestClient(_locale_app()).get("/locales", headers={"X-API-Key": "key-acme"})

        languages = res.json()["languages"]
        assert {row["code"] for row in res.json()["locales"]} <= set(languages)
        # Names are the language alone: the region qualifier belongs to a
        # locale ("English (India)"), not to a language ("English").
        for name in languages.values():
            assert "(" not in name

    def test_names_match_what_the_dashboard_used_to_hardcode(self, db):
        """Deleting the admin's `LOCALE_NAMES` must not change what is shown."""
        _seed(db, language_config={"enabled": True, "supported_locales": ["en-IN"]})
        res = TestClient(_locale_app()).get("/locales", headers={"X-API-Key": "key-acme"})

        languages = res.json()["languages"]
        assert languages["en"] == "English"
        assert languages["hi"] == "Hindi"
        assert languages["zh"] == "Chinese"
        assert languages["ar"] == "Arabic"
        assert languages == LANGUAGE_NAMES

    def test_requires_authentication(self):
        assert TestClient(_locale_app()).get("/locales").status_code in (401, 403)

    def test_is_cacheable_because_it_only_changes_on_deploy(self, db):
        _seed(db, language_config={"enabled": True, "supported_locales": ["en-IN"]})
        res = TestClient(_locale_app()).get("/locales", headers={"X-API-Key": "key-acme"})
        assert "max-age" in res.headers.get("cache-control", "")


# ── What the Support translation picker may offer ────────────────────────────


class TestAvailableLocales:
    def test_returns_the_bots_supported_locales(self, db):
        _seed(
            db,
            language_config={
                "enabled": True,
                "default_locale": "en-IN",
                "supported_locales": ["en-IN", "hi-IN"],
            },
        )
        res = TestClient(_operator_app()).get("/operators/me/language", headers={"X-Operator-Key": "op-key-acme"})
        assert res.status_code == 200, res.text
        assert res.json()["available_locales"] == ["en-IN", "hi-IN"]

    def test_a_single_locale_bot_offers_exactly_that_locale(self, db):
        _seed(db, language_config={"enabled": True, "supported_locales": ["hi-IN"]})
        res = TestClient(_operator_app()).get("/operators/me/language", headers={"X-Operator-Key": "op-key-acme"})
        assert res.json()["available_locales"] == ["hi-IN"]

    def test_locales_are_normalised_and_deduplicated(self, db):
        """Stored config is customer data, so it can hold `hi_in` or a repeat."""
        _seed(db, language_config={"enabled": True, "supported_locales": ["hi_in", "HI-in", "en_US"]})
        res = TestClient(_operator_app()).get("/operators/me/language", headers={"X-Operator-Key": "op-key-acme"})
        assert res.json()["available_locales"] == ["hi-IN", "en-US"]

    def test_falls_back_to_the_default_locale(self, db):
        _seed(db, language_config={"enabled": True, "default_locale": "fr-FR"})
        res = TestClient(_operator_app()).get("/operators/me/language", headers={"X-Operator-Key": "op-key-acme"})
        assert res.json()["available_locales"] == ["fr-FR"]

    def test_not_gated_on_multilingual_being_enabled(self, db):
        """A bot mid-setup has a supported list before the master toggle is on.

        Emptying every operator's picker in that window would look broken.
        Whether translation actually runs is decided by
        ``is_translation_enabled``, which checks both flags.
        """
        _seed(db, language_config={"enabled": False, "supported_locales": ["en-IN", "hi-IN"]})
        res = TestClient(_operator_app()).get("/operators/me/language", headers={"X-Operator-Key": "op-key-acme"})
        assert res.json()["available_locales"] == ["en-IN", "hi-IN"]

    def test_an_unconfigured_bot_offers_nothing(self, db):
        _seed(db, language_config={})
        res = TestClient(_operator_app()).get("/operators/me/language", headers={"X-Operator-Key": "op-key-acme"})
        assert res.json()["available_locales"] == []

    def test_garbage_in_stored_config_is_dropped_not_served(self, db):
        _seed(db, language_config={"supported_locales": ["en-IN", 7, None, "not a locale!!"]})
        res = TestClient(_operator_app()).get("/operators/me/language", headers={"X-Operator-Key": "op-key-acme"})
        assert res.json()["available_locales"] == ["en-IN"]

    def test_scoped_to_the_callers_own_bot(self, db):
        _seed(db, language_config={"enabled": True, "supported_locales": ["en-IN"]})
        _seed(
            db,
            language_config={"enabled": True, "supported_locales": ["ja-JP"]},
            api_key="key-other",
            operator_key="op-key-other",
            email="other@example.com",
        )
        res = TestClient(_operator_app()).get("/operators/me/language", headers={"X-Operator-Key": "op-key-acme"})
        assert res.json()["available_locales"] == ["en-IN"]


# ── The team list carries language state ─────────────────────────────────────


class TestOperatorListLanguageFields:
    def test_rows_expose_preferred_locale_and_supported_languages(self, db):
        _seed(db, language_config={"enabled": True, "supported_locales": ["en-IN"]})
        res = TestClient(_operator_app()).get("/operators", headers={"X-API-Key": "key-acme"})

        assert res.status_code == 200, res.text
        row = res.json()["operators"][0]
        assert row["preferred_locale"] == "en-IN"
        assert row["supported_languages"] == []
