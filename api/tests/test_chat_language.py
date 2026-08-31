"""Tests for multilingual chat language resolution and POST /chat/language (Phase 2).

These cover the remediation of the Phase 1/2 review findings:

  C2  a bot with multilingual disabled must not accept language writes at all
  C3  an explicit selection made before the first message must persist locked
  H3  the 'site' precedence tier must survive the round trip to the backend
  H4  a requested locale must be narrowed to the variant the bot offers
  H9  a settled session must not be rewritten on every turn
"""

from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.auth import get_bot_for_chat, get_current_bot
from app.api.chat_routes import _resolve_visitor_language_and_update_session, router
from app.core.exceptions import SessionOwnershipError
from app.schemas.chat import ChatRequest

SESSION_ID = "0194eb38-1234-7000-8000-000000000001"


@contextmanager
def _session_ctx(session):
    yield session


def _build_app(bot_override=None):
    app = FastAPI()
    app.include_router(router)
    if bot_override:
        app.dependency_overrides[get_current_bot] = lambda: bot_override
        app.dependency_overrides[get_bot_for_chat] = lambda: bot_override
    return app


_UNSET = object()


def _build_bot(bot_id=1, client_id=1, language_config=_UNSET):
    # Sentinel rather than `or`: an empty dict is a meaningful value here (a
    # legacy bot whose config was never populated) and must not fall through to
    # the enabled default.
    return SimpleNamespace(
        id=bot_id,
        client_id=client_id,
        name="Test Bot",
        bot_key="bot-test-key",
        is_active=True,
        language_config=language_config
        if language_config is not _UNSET
        else {
            "enabled": True,
            "default_locale": "en-IN",
            "supported_locales": ["en-IN", "hi-IN", "fr-FR", "es-ES"],
            "auto_detect": True,
            "allow_visitor_language_switch": True,
            "operator_translation_enabled": False,
        },
    )


def _mock_db(row=None):
    """A DB session whose language SELECT yields ``row`` (a tuple or None)."""
    db = MagicMock()
    db.execute.return_value.one_or_none.return_value = row
    return db


def _request_with_header(accept_language=None):
    req = MagicMock()
    req.headers = {"accept-language": accept_language} if accept_language else {}
    return req


class TestChangeChatLanguage:
    def test_change_language_success(self, monkeypatch):
        bot = _build_bot()
        app = _build_app(bot_override=bot)
        captured = {}

        def _capture(session, session_id, bot_id, **kwargs):
            captured.update(kwargs)
            captured["session_id"] = session_id
            captured["bot_id"] = bot_id

        monkeypatch.setattr("app.api.chat_routes.get_session", lambda: _session_ctx(MagicMock()))
        monkeypatch.setattr("app.api.chat_routes.update_chat_session_language", _capture)

        response = TestClient(app).post("/chat/language", json={"session_id": SESSION_ID, "locale": "hi-IN"})
        assert response.status_code == 200
        assert response.json() == {
            "language": "hi",
            "locale": "hi-IN",
            "source": "explicit",
            "locked": True,
        }
        # The write really happens, scoped to this bot, and locks the session.
        assert captured["locale"] == "hi-IN"
        assert captured["language_code"] == "hi"
        assert captured["language_locked"] is True
        assert captured["language_source"] == "explicit"
        assert captured["bot_id"] == bot.id
        assert captured["session_id"] == SESSION_ID

    def test_change_language_normalizes_case(self, monkeypatch):
        bot = _build_bot()
        app = _build_app(bot_override=bot)
        monkeypatch.setattr("app.api.chat_routes.get_session", lambda: _session_ctx(MagicMock()))
        monkeypatch.setattr("app.api.chat_routes.update_chat_session_language", MagicMock())

        response = TestClient(app).post("/chat/language", json={"session_id": SESSION_ID, "locale": "hi_in"})
        assert response.status_code == 200
        assert response.json()["locale"] == "hi-IN"

    def test_change_language_invalid_format(self):
        app = _build_app(bot_override=_build_bot())
        response = TestClient(app).post(
            "/chat/language",
            json={"session_id": SESSION_ID, "locale": "invalid-extra-parts-code"},
        )
        assert response.status_code == 400

    def test_change_language_unsupported_locale(self):
        bot = _build_bot(
            language_config={
                "enabled": True,
                "default_locale": "en-IN",
                "supported_locales": ["en-IN", "hi-IN"],
            }
        )
        app = _build_app(bot_override=bot)
        response = TestClient(app).post("/chat/language", json={"session_id": SESSION_ID, "locale": "ja-JP"})
        assert response.status_code == 400

    def test_regional_variant_is_narrowed_to_supported_locale(self, monkeypatch):
        """H4: fr-CA against a bot offering only fr-FR must store fr-FR.

        The base-language match previously short-circuited the narrowing, so the
        session ended up holding a locale the bot has no configuration for.
        """
        bot = _build_bot(
            language_config={
                "enabled": True,
                "default_locale": "en-IN",
                "supported_locales": ["en-IN", "fr-FR"],
            }
        )
        app = _build_app(bot_override=bot)
        captured = {}
        monkeypatch.setattr("app.api.chat_routes.get_session", lambda: _session_ctx(MagicMock()))
        monkeypatch.setattr(
            "app.api.chat_routes.update_chat_session_language",
            lambda session, sid, bid, **kw: captured.update(kw),
        )

        response = TestClient(app).post("/chat/language", json={"session_id": SESSION_ID, "locale": "fr-CA"})
        assert response.status_code == 200
        assert response.json()["locale"] == "fr-FR"
        assert captured["locale"] == "fr-FR"

    def test_disabled_bot_rejects_language_change(self, monkeypatch):
        """C2: a bot that never enabled multilingual accepts no language writes."""
        bot = _build_bot(language_config={"enabled": False, "supported_locales": ["en-IN"]})
        app = _build_app(bot_override=bot)

        write = MagicMock()
        monkeypatch.setattr("app.api.chat_routes.get_session", lambda: _session_ctx(MagicMock()))
        monkeypatch.setattr("app.api.chat_routes.update_chat_session_language", write)

        response = TestClient(app).post("/chat/language", json={"session_id": SESSION_ID, "locale": "ar-SA"})
        assert response.status_code == 403
        write.assert_not_called()

    def test_bot_with_no_language_config_rejects_language_change(self, monkeypatch):
        """C2: an untouched legacy bot (empty config) behaves as disabled."""
        bot = _build_bot(language_config={})
        app = _build_app(bot_override=bot)

        write = MagicMock()
        monkeypatch.setattr("app.api.chat_routes.get_session", lambda: _session_ctx(MagicMock()))
        monkeypatch.setattr("app.api.chat_routes.update_chat_session_language", write)

        response = TestClient(app).post("/chat/language", json={"session_id": SESSION_ID, "locale": "hi-IN"})
        assert response.status_code == 403
        write.assert_not_called()

    def test_change_language_session_ownership_error(self, monkeypatch):
        """A session belonging to another bot is not addressable."""
        bot = _build_bot()
        app = _build_app(bot_override=bot)

        def _raise(*args, **kwargs):
            raise SessionOwnershipError(SESSION_ID, bot.id, None)

        monkeypatch.setattr("app.api.chat_routes.get_session", lambda: _session_ctx(MagicMock()))
        monkeypatch.setattr("app.api.chat_routes.update_chat_session_language", _raise)

        response = TestClient(app).post("/chat/language", json={"session_id": SESSION_ID, "locale": "hi-IN"})
        assert response.status_code == 404


class TestResolveVisitorLanguage:
    def test_disabled_multilingual_touches_no_database(self):
        """A bot that has not opted in must not even open a session."""
        bot = _build_bot(language_config={"enabled": False})
        body = ChatRequest(question="Hello", session_id=SESSION_ID, locale="hi-IN")

        with patch("app.api.chat_routes.get_session") as mock_get_session:
            _resolve_visitor_language_and_update_session(_request_with_header(), body, bot, SESSION_ID)
            mock_get_session.assert_not_called()

    def test_first_turn_creates_session_from_accept_language(self, monkeypatch):
        bot = _build_bot()
        body = ChatRequest(question="Hello", session_id=SESSION_ID)
        db = _mock_db(row=None)
        monkeypatch.setattr("app.api.chat_routes.get_session", lambda: _session_ctx(db))
        ensure = MagicMock()
        monkeypatch.setattr("app.api.chat_routes.ensure_chat_session", ensure)

        _resolve_visitor_language_and_update_session(
            _request_with_header("hi-IN,hi;q=0.9,en;q=0.8"), body, bot, SESSION_ID
        )

        kwargs = ensure.call_args.kwargs
        assert kwargs["language_code"] == "hi"
        assert kwargs["locale"] == "hi-IN"
        assert kwargs["language_source"] == "browser"
        assert kwargs["language_locked"] is False
        assert db.commit.called

    def test_pre_session_explicit_selection_is_persisted_and_locked(self, monkeypatch):
        """C3: choosing a language before sending the first message must stick.

        The widget cannot call POST /chat/language yet (no session exists), so
        the choice rides the first /chat/stream call as language_source=explicit
        and must create the session already locked.
        """
        bot = _build_bot()
        body = ChatRequest(
            question="Hello",
            session_id=SESSION_ID,
            locale="hi-IN",
            language_source="explicit",
        )
        db = _mock_db(row=None)
        monkeypatch.setattr("app.api.chat_routes.get_session", lambda: _session_ctx(db))
        ensure = MagicMock()
        monkeypatch.setattr("app.api.chat_routes.ensure_chat_session", ensure)

        _resolve_visitor_language_and_update_session(
            # An English browser must not win over the visitor's own choice.
            _request_with_header("en-US,en;q=0.9"),
            body,
            bot,
            SESSION_ID,
        )

        kwargs = ensure.call_args.kwargs
        assert kwargs["locale"] == "hi-IN"
        assert kwargs["language_source"] == "explicit"
        assert kwargs["language_locked"] is True

    def test_site_source_outranks_browser(self, monkeypatch):
        """H3: a locale supplied by the host page must not be discarded."""
        bot = _build_bot()
        body = ChatRequest(question="Hello", session_id=SESSION_ID, locale="fr-FR", language_source="site")
        db = _mock_db(row=None)
        monkeypatch.setattr("app.api.chat_routes.get_session", lambda: _session_ctx(db))
        ensure = MagicMock()
        monkeypatch.setattr("app.api.chat_routes.ensure_chat_session", ensure)

        _resolve_visitor_language_and_update_session(_request_with_header("en-US,en;q=0.9"), body, bot, SESSION_ID)

        kwargs = ensure.call_args.kwargs
        assert kwargs["locale"] == "fr-FR"
        assert kwargs["language_source"] == "site"

    def test_locked_session_is_never_re_resolved(self, monkeypatch):
        bot = _build_bot()
        body = ChatRequest(question="Hello", session_id=SESSION_ID, language_source="browser")
        db = _mock_db(row=("hi", "hi-IN", True))
        monkeypatch.setattr("app.api.chat_routes.get_session", lambda: _session_ctx(db))

        _resolve_visitor_language_and_update_session(_request_with_header("es-ES,es;q=0.9"), body, bot, SESSION_ID)
        db.commit.assert_not_called()

    def test_settled_session_is_not_rewritten_on_every_turn(self, monkeypatch):
        """H9: steady-state turns are a single read with no transaction."""
        bot = _build_bot()
        body = ChatRequest(question="Hello", session_id=SESSION_ID, language_source="browser")
        db = _mock_db(row=("hi", "hi-IN", False))
        monkeypatch.setattr("app.api.chat_routes.get_session", lambda: _session_ctx(db))

        _resolve_visitor_language_and_update_session(_request_with_header("hi-IN,hi;q=0.9"), body, bot, SESSION_ID)
        db.commit.assert_not_called()

    def test_explicit_selection_overrides_a_settled_session(self, monkeypatch):
        """An unlocked session switches when the visitor picks a language."""
        bot = _build_bot()
        body = ChatRequest(
            question="Hello",
            session_id=SESSION_ID,
            locale="fr-FR",
            language_source="explicit",
        )
        db = _mock_db(row=("hi", "hi-IN", False))
        monkeypatch.setattr("app.api.chat_routes.get_session", lambda: _session_ctx(db))

        _resolve_visitor_language_and_update_session(_request_with_header("en-US"), body, bot, SESSION_ID)
        assert db.commit.called


class TestPhase3LanguageContextReturn:
    """Phase 3: the resolver now RETURNS the effective LanguageContext so the
    pipeline can consume it without a second DB read."""

    def test_disabled_bot_returns_none(self):
        bot = _build_bot(language_config={"enabled": False})
        body = ChatRequest(question="Hello", session_id=SESSION_ID, locale="hi-IN")
        with patch("app.api.chat_routes.get_session") as mock_get_session:
            result = _resolve_visitor_language_and_update_session(_request_with_header(), body, bot, SESSION_ID)
            assert result is None
            mock_get_session.assert_not_called()

    def test_enabled_first_turn_returns_context(self, monkeypatch):
        bot = _build_bot()
        body = ChatRequest(question="Hello", session_id=SESSION_ID)
        db = _mock_db(row=None)
        monkeypatch.setattr("app.api.chat_routes.get_session", lambda: _session_ctx(db))
        monkeypatch.setattr("app.api.chat_routes.ensure_chat_session", MagicMock())

        result = _resolve_visitor_language_and_update_session(
            _request_with_header("hi-IN,hi;q=0.9"), body, bot, SESSION_ID
        )
        assert result is not None
        assert result.language == "hi"
        assert result.locale == "hi-IN"

    def test_locked_session_returns_locked_context_without_write(self, monkeypatch):
        bot = _build_bot()
        body = ChatRequest(question="Hello", session_id=SESSION_ID, language_source="browser")
        db = _mock_db(row=("hi", "hi-IN", True))
        monkeypatch.setattr("app.api.chat_routes.get_session", lambda: _session_ctx(db))

        result = _resolve_visitor_language_and_update_session(_request_with_header("es-ES"), body, bot, SESSION_ID)
        assert result is not None
        assert result.locale == "hi-IN"
        assert result.locked is True
        db.commit.assert_not_called()

    def test_settled_session_returns_context_without_write(self, monkeypatch):
        bot = _build_bot()
        body = ChatRequest(question="Hello", session_id=SESSION_ID, language_source="browser")
        db = _mock_db(row=("hi", "hi-IN", False))
        monkeypatch.setattr("app.api.chat_routes.get_session", lambda: _session_ctx(db))

        result = _resolve_visitor_language_and_update_session(_request_with_header("hi-IN"), body, bot, SESSION_ID)
        assert result is not None
        assert result.locale == "hi-IN"
        db.commit.assert_not_called()


class TestPhase3FirstTurnDetection:
    """Phase 3: message-language detection runs ONLY on the first unresolved
    turn, and never overrides a locked or already-resolved session."""

    def test_devanagari_first_message_detected_when_no_other_signal(self, monkeypatch):
        # No Accept-Language header, no client locale, Devanagari question.
        bot = _build_bot(
            language_config={
                "enabled": True,
                "default_locale": "en-IN",
                "supported_locales": ["en-IN", "hi-IN"],
            }
        )
        body = ChatRequest(question="नमस्ते, मुझे कीमत बताइए", session_id=SESSION_ID)
        db = _mock_db(row=None)
        monkeypatch.setattr("app.api.chat_routes.get_session", lambda: _session_ctx(db))
        ensure = MagicMock()
        monkeypatch.setattr("app.api.chat_routes.ensure_chat_session", ensure)

        result = _resolve_visitor_language_and_update_session(_request_with_header(None), body, bot, SESSION_ID)
        assert result.language == "hi"
        assert result.source == "message_detected"
        assert ensure.call_args.kwargs["language_source"] == "message_detected"

    def test_confident_detection_outranks_the_browser_header(self, monkeypatch):
        """REPLACES an expectation that made detection unreachable in production.

        This previously asserted the Accept-Language header wins over a
        confident script detection. That is wrong about the product, and it
        made the whole feature dead code: ``resolve_initial_locale`` consults
        Accept-Language, every browser sends one, and any ``en-*`` header
        matches a bot offering ``en-IN``, so ``source`` was ``browser`` for
        essentially every real visitor and detection (gated on ``default``)
        never ran. A visitor typing pure Devanagari was answered in English.

        The header says what the visitor's BROWSER is configured to; the
        message says what they are actually typing. A confident script
        detection outranks the weak tiers (browser, persisted) and nothing
        else: an explicit choice and a customer-declared site locale still
        win, and are covered separately below.
        """
        bot = _build_bot()
        body = ChatRequest(question="नमस्ते", session_id=SESSION_ID)
        db = _mock_db(row=None)
        monkeypatch.setattr("app.api.chat_routes.get_session", lambda: _session_ctx(db))
        monkeypatch.setattr("app.api.chat_routes.ensure_chat_session", MagicMock())

        result = _resolve_visitor_language_and_update_session(
            _request_with_header("fr-FR,fr;q=0.9"), body, bot, SESSION_ID
        )
        assert result.source == "message_detected"
        assert result.locale == "hi-IN"

    def test_an_undetectable_message_leaves_the_browser_header_in_place(self, monkeypatch):
        """The browser tier still decides when the message carries no signal."""
        bot = _build_bot()
        body = ChatRequest(question="Bonjour, je voudrais des informations", session_id=SESSION_ID)
        db = _mock_db(row=None)
        monkeypatch.setattr("app.api.chat_routes.get_session", lambda: _session_ctx(db))
        monkeypatch.setattr("app.api.chat_routes.ensure_chat_session", MagicMock())

        result = _resolve_visitor_language_and_update_session(
            _request_with_header("fr-FR,fr;q=0.9"), body, bot, SESSION_ID
        )
        assert result.source == "browser"
        assert result.locale == "fr-FR"

    def test_an_explicit_choice_is_never_overridden_by_detection(self, monkeypatch):
        """Detection outranks the weak tiers only. A visitor's own pick wins."""
        bot = _build_bot()
        body = ChatRequest(
            question="नमस्ते मुझे मदद चाहिए",
            session_id=SESSION_ID,
            locale="fr-FR",
            language_source="explicit",
        )
        db = _mock_db(row=None)
        monkeypatch.setattr("app.api.chat_routes.get_session", lambda: _session_ctx(db))
        monkeypatch.setattr("app.api.chat_routes.ensure_chat_session", MagicMock())

        result = _resolve_visitor_language_and_update_session(_request_with_header(None), body, bot, SESSION_ID)
        assert result.source == "explicit"
        assert result.locale == "fr-FR"

    def test_a_site_declared_locale_is_never_overridden_by_detection(self, monkeypatch):
        bot = _build_bot()
        body = ChatRequest(
            question="नमस्ते मुझे मदद चाहिए",
            session_id=SESSION_ID,
            locale="fr-FR",
            language_source="site",
        )
        db = _mock_db(row=None)
        monkeypatch.setattr("app.api.chat_routes.get_session", lambda: _session_ctx(db))
        monkeypatch.setattr("app.api.chat_routes.ensure_chat_session", MagicMock())

        result = _resolve_visitor_language_and_update_session(_request_with_header(None), body, bot, SESSION_ID)
        assert result.source == "site"

    def test_detection_never_runs_for_locked_session(self, monkeypatch):
        bot = _build_bot()
        body = ChatRequest(question="नमस्ते मुझे मदद चाहिए", session_id=SESSION_ID)
        db = _mock_db(row=("en", "en-IN", True))
        monkeypatch.setattr("app.api.chat_routes.get_session", lambda: _session_ctx(db))

        called = {"detect": False}

        def _spy(text):
            called["detect"] = True
            return ("hi", 1.0, 6)

        monkeypatch.setattr("app.api.chat_routes.detect_message_language_detail", _spy)
        result = _resolve_visitor_language_and_update_session(_request_with_header(None), body, bot, SESSION_ID)
        assert called["detect"] is False
        assert result.locale == "en-IN"

    def test_code_switched_hinglish_is_detected(self, monkeypatch):
        """REPLACES an expectation that rejected the detector's main use case.

        This previously asserted "मुझे pricing चाहिए" falls to the bot default
        because its confidence (0.42, the share of letters in the dominant
        script) is under the 0.85 floor. Hindi is the only non-English
        language OyeChats actually ships, and Hinglish is how it is typed, so
        the floor as written excluded the input the feature exists for.

        Script PRESENCE is evidence a share cannot express: a visitor who
        types Devanagari at all is not writing English. The floor still
        applies, but a detection also clears the bar on absolute non-Latin
        letter count, which noise (one borrowed word, a signature) cannot
        reach. ``confidence`` itself keeps its meaning and is persisted
        unchanged, see ``test_persisted_confidence_is_still_the_raw_share``.
        """
        bot = _build_bot(
            language_config={
                "enabled": True,
                "default_locale": "en-IN",
                "supported_locales": ["en-IN", "hi-IN"],
            }
        )
        body = ChatRequest(question="मुझे pricing चाहिए", session_id=SESSION_ID)
        db = _mock_db(row=None)
        monkeypatch.setattr("app.api.chat_routes.get_session", lambda: _session_ctx(db))
        ensure = MagicMock()
        monkeypatch.setattr("app.api.chat_routes.ensure_chat_session", ensure)

        result = _resolve_visitor_language_and_update_session(_request_with_header(None), body, bot, SESSION_ID)
        assert result.source == "message_detected"
        assert result.language == "hi"

    def test_persisted_confidence_is_still_the_raw_share(self, monkeypatch):
        """The relaxed bar must not launder a 0.42 detection into a 0.85 one."""
        bot = _build_bot(
            language_config={
                "enabled": True,
                "default_locale": "en-IN",
                "supported_locales": ["en-IN", "hi-IN"],
            }
        )
        body = ChatRequest(question="मुझे pricing चाहिए", session_id=SESSION_ID)
        db = _mock_db(row=None)
        monkeypatch.setattr("app.api.chat_routes.get_session", lambda: _session_ctx(db))
        ensure = MagicMock()
        monkeypatch.setattr("app.api.chat_routes.ensure_chat_session", ensure)

        result = _resolve_visitor_language_and_update_session(_request_with_header(None), body, bot, SESSION_ID)
        assert result.confidence < 0.85
        assert ensure.call_args.kwargs["language_confidence"] == result.confidence

    def test_a_single_stray_glyph_does_not_flip_an_english_message(self, monkeypatch):
        """The absolute-count floor is what keeps the relaxed bar honest."""
        bot = _build_bot(
            language_config={
                "enabled": True,
                "default_locale": "en-IN",
                "supported_locales": ["en-IN", "hi-IN"],
            }
        )
        body = ChatRequest(
            question="Please send the pricing plan, thanks — क्या",
            session_id=SESSION_ID,
        )
        db = _mock_db(row=None)
        monkeypatch.setattr("app.api.chat_routes.get_session", lambda: _session_ctx(db))
        monkeypatch.setattr("app.api.chat_routes.ensure_chat_session", MagicMock())

        result = _resolve_visitor_language_and_update_session(_request_with_header(None), body, bot, SESSION_ID)
        assert result.source == "default"
        assert result.language == "en"

    def test_unsupported_detected_language_not_persisted(self, monkeypatch):
        # Bot supports only en/hi; a Russian first message must not be stored.
        bot = _build_bot(
            language_config={
                "enabled": True,
                "default_locale": "en-IN",
                "supported_locales": ["en-IN", "hi-IN"],
            }
        )
        body = ChatRequest(question="привет мне нужна помощь", session_id=SESSION_ID)
        db = _mock_db(row=None)
        monkeypatch.setattr("app.api.chat_routes.get_session", lambda: _session_ctx(db))
        monkeypatch.setattr("app.api.chat_routes.ensure_chat_session", MagicMock())

        result = _resolve_visitor_language_and_update_session(_request_with_header(None), body, bot, SESSION_ID)
        assert result.source == "default"
        assert result.language == "en"


class TestAutoDetectToggleIsHonoured:
    """``language_config.auto_detect`` is written by the dashboard's "Detect the
    visitor's language" switch, described there as "From their browser, the page
    they are on, and their first message." It was persisted and read by nothing:
    the only grep hit in the backend was the column default, so a customer who
    turned it off still got every one of those three tiers.
    """

    def _bot(self, auto_detect):
        return _build_bot(
            language_config={
                "enabled": True,
                "default_locale": "en-IN",
                "supported_locales": ["en-IN", "hi-IN", "fr-FR"],
                "auto_detect": auto_detect,
            }
        )

    def test_browser_header_is_ignored_when_detection_is_off(self, monkeypatch):
        body = ChatRequest(question="Hello", session_id=SESSION_ID)
        db = _mock_db(row=None)
        monkeypatch.setattr("app.api.chat_routes.get_session", lambda: _session_ctx(db))
        monkeypatch.setattr("app.api.chat_routes.ensure_chat_session", MagicMock())

        result = _resolve_visitor_language_and_update_session(
            _request_with_header("fr-FR,fr;q=0.9"), body, self._bot(False), SESSION_ID
        )
        assert result.source == "default"
        assert result.locale == "en-IN"

    def test_html_lang_is_ignored_when_detection_is_off(self, monkeypatch):
        body = ChatRequest(question="Hello", session_id=SESSION_ID, locale="fr-FR", language_source="html_lang")
        db = _mock_db(row=None)
        monkeypatch.setattr("app.api.chat_routes.get_session", lambda: _session_ctx(db))
        monkeypatch.setattr("app.api.chat_routes.ensure_chat_session", MagicMock())

        result = _resolve_visitor_language_and_update_session(
            _request_with_header(None), body, self._bot(False), SESSION_ID
        )
        assert result.source == "default"

    def test_message_detection_is_skipped_when_detection_is_off(self, monkeypatch):
        body = ChatRequest(question="नमस्ते मुझे मदद चाहिए", session_id=SESSION_ID)
        db = _mock_db(row=None)
        monkeypatch.setattr("app.api.chat_routes.get_session", lambda: _session_ctx(db))
        monkeypatch.setattr("app.api.chat_routes.ensure_chat_session", MagicMock())

        result = _resolve_visitor_language_and_update_session(
            _request_with_header(None), body, self._bot(False), SESSION_ID
        )
        assert result.source == "default"
        assert result.language == "en"

    def test_an_explicit_choice_still_works_with_detection_off(self, monkeypatch):
        """The switch turns off DETECTION, not the visitor's own selection."""
        body = ChatRequest(question="Hello", session_id=SESSION_ID, locale="hi-IN", language_source="explicit")
        db = _mock_db(row=None)
        monkeypatch.setattr("app.api.chat_routes.get_session", lambda: _session_ctx(db))
        monkeypatch.setattr("app.api.chat_routes.ensure_chat_session", MagicMock())

        result = _resolve_visitor_language_and_update_session(
            _request_with_header(None), body, self._bot(False), SESSION_ID
        )
        assert result.source == "explicit"
        assert result.locale == "hi-IN"

    def test_a_config_without_the_key_still_detects(self, monkeypatch):
        """Absent means on, so no existing bot changes behaviour."""
        bot = _build_bot(
            language_config={
                "enabled": True,
                "default_locale": "en-IN",
                "supported_locales": ["en-IN", "hi-IN"],
            }
        )
        body = ChatRequest(question="Hello", session_id=SESSION_ID)
        db = _mock_db(row=None)
        monkeypatch.setattr("app.api.chat_routes.get_session", lambda: _session_ctx(db))
        monkeypatch.setattr("app.api.chat_routes.ensure_chat_session", MagicMock())

        result = _resolve_visitor_language_and_update_session(
            _request_with_header("hi-IN,hi;q=0.9"), body, bot, SESSION_ID
        )
        assert result.source == "browser"


class TestVisitorLanguageSwitchIsEnforcedServerSide:
    """``allow_visitor_language_switch`` was checked only by the widget, which
    hides its picker. The endpoint authenticates with the PUBLIC bot key, so
    anyone reading a customer's page source could switch and lock a session
    language for a bot whose owner had turned switching off.
    """

    def _bot(self, allow):
        return _build_bot(
            language_config={
                "enabled": True,
                "default_locale": "en-IN",
                "supported_locales": ["en-IN", "hi-IN"],
                "allow_visitor_language_switch": allow,
            }
        )

    def test_switching_is_refused_when_the_customer_disabled_it(self, monkeypatch):
        write = MagicMock()
        monkeypatch.setattr("app.api.chat_routes.get_session", lambda: _session_ctx(MagicMock()))
        monkeypatch.setattr("app.api.chat_routes.update_chat_session_language", write)

        response = TestClient(_build_app(bot_override=self._bot(False))).post(
            "/chat/language", json={"session_id": SESSION_ID, "locale": "hi-IN"}
        )
        assert response.status_code == 403
        write.assert_not_called()

    def test_switching_still_works_when_enabled(self, monkeypatch):
        monkeypatch.setattr("app.api.chat_routes.get_session", lambda: _session_ctx(MagicMock()))
        monkeypatch.setattr("app.api.chat_routes.update_chat_session_language", MagicMock())

        response = TestClient(_build_app(bot_override=self._bot(True))).post(
            "/chat/language", json={"session_id": SESSION_ID, "locale": "hi-IN"}
        )
        assert response.status_code == 200

    def test_the_pre_session_explicit_tier_is_gated_too(self, monkeypatch):
        """The picker rides the first /chat/stream turn when no session exists
        yet, so enforcing only at the endpoint left the same bypass open."""
        body = ChatRequest(question="Hello", session_id=SESSION_ID, locale="hi-IN", language_source="explicit")
        db = _mock_db(row=None)
        monkeypatch.setattr("app.api.chat_routes.get_session", lambda: _session_ctx(db))
        ensure = MagicMock()
        monkeypatch.setattr("app.api.chat_routes.ensure_chat_session", ensure)

        result = _resolve_visitor_language_and_update_session(
            _request_with_header("en-US,en;q=0.9"), body, self._bot(False), SESSION_ID
        )
        assert result.locked is False
        assert result.source != "explicit"
        assert result.locale != "hi-IN"
