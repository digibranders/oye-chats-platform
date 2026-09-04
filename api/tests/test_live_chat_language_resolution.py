"""A session that reaches live chat without ever taking a bot turn.

``chat_routes._resolve_visitor_language_and_update_session`` runs on the bot
turn and was, until this module's subject existed, the only writer of
``ChatSession.language_code``. So a visitor who never asked the chatbot
anything - "talk to a human" straight off the launcher, a proactive operator
invitation, an out-of-hours form picked up later - arrived in a live
conversation with a NULL language.

Every translation gate reads that column, and all of them fail SILENTLY when it
is NULL: no target resolves, no frame is sent, and the message row is stamped
``source_language=NULL``, which is also what the console keys the
original/translation toggle on. The operator therefore sees an untranslated
thread with no control on it and nothing anywhere saying why. Reported from
production on 2026-09-04 against ``bot-cd72ea98fd30``, whose
``language_config`` had multilingual and operator translation both ON.

These tests are about the RESOLVER, not the provider: what gets written to the
session, and when it must refuse to write.
"""

import os

import pytest

from app.db.models import Bot, ChatSession, Client
from app.services.language_service import resolve_live_chat_language

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")


MULTILINGUAL_ON = {
    "enabled": True,
    "default_locale": "en-IN",
    "supported_locales": ["en-IN", "hi-IN", "ar-SA"],
    "operator_translation_enabled": True,
}


def _seed(db, *, language_config=None, session_language=None, session_id="sess-live"):
    """One workspace and one live session, language deliberately unset."""
    client = Client(name="Acme", email="acme@example.com", api_key="key-acme", hashed_password="x")
    db.add(client)
    db.flush()

    bot = Bot(
        client_id=client.id,
        name="Acme Bot",
        bot_key="bot-acme",
        language_config=MULTILINGUAL_ON if language_config is None else language_config,
    )
    db.add(bot)
    db.flush()

    db.add(
        ChatSession(
            id=session_id,
            client_id=client.id,
            bot_id=bot.id,
            status="live",
            language_code=session_language,
        )
    )
    db.commit()
    return bot


class TestItResolvesWhatTheBotTurnNeverDid:
    def test_a_null_language_session_gets_one_from_the_visitors_own_words(self, db):
        # The production case exactly: multilingual on, operator translation
        # on, and a session that went straight to a human. Before this
        # resolver existed the column stayed NULL for the life of the chat.
        bot = _seed(db)

        assert resolve_live_chat_language(db, "sess-live", bot, "मुझे मदद चाहिए") == "hi"
        db.commit()

        row = db.get(ChatSession, "sess-live")
        assert row.language_code == "hi"
        assert row.locale == "hi-IN"
        assert row.language_source == "message_detected"

    def test_latin_text_falls_back_to_the_bots_default_rather_than_nothing(self, db):
        # "hello" is the message that was actually sent. The detector cannot
        # tell Latin languages apart and returns nothing for it, which is
        # correct - but "no detection" must still leave the session with a
        # language, because NULL is what disables the whole feature.
        bot = _seed(db)

        assert resolve_live_chat_language(db, "sess-live", bot, "hello") == "en"
        db.commit()

        row = db.get(ChatSession, "sess-live")
        assert row.language_code == "en"
        assert row.locale == "en-IN"
        assert row.language_source == "default"

    def test_a_detected_language_the_bot_does_not_support_falls_back(self, db):
        # Arabic is supported by this bot; Tamil is not. An unsupported
        # detection must not be persisted, because nothing downstream can
        # translate to or from a language the bot was never configured for.
        bot = _seed(db)

        assert resolve_live_chat_language(db, "sess-live", bot, "எனக்கு உதவி வேண்டும்") == "en"
        db.commit()

        assert db.get(ChatSession, "sess-live").language_code == "en"

    def test_it_writes_a_supported_rtl_detection_through(self, db):
        bot = _seed(db)

        assert resolve_live_chat_language(db, "sess-live", bot, "أحتاج إلى مساعدة") == "ar"
        db.commit()

        row = db.get(ChatSession, "sess-live")
        assert row.language_code == "ar"
        assert row.locale == "ar-SA"


class TestItRefusesToOverrule:
    def test_a_session_that_already_has_a_language_is_left_alone(self, db):
        # The bot turn, an explicit visitor selection and a lock all outrank a
        # guess made from one live-chat line. The UPDATE is guarded on the
        # column still being NULL, so this holds even against a concurrent
        # write that lands between the caller's read and this one.
        bot = _seed(db, session_language="hi")

        assert resolve_live_chat_language(db, "sess-live", bot, "hello there") is None
        db.commit()

        assert db.get(ChatSession, "sess-live").language_code == "hi"

    def test_multilingual_off_writes_nothing(self, db):
        # Not a silent skip for its own sake: `is_translation_enabled` requires
        # `enabled` too, so there is nothing to translate to or from, and a
        # language written here would be a column nothing reads.
        bot = _seed(db, language_config={"enabled": False, "default_locale": "en-IN"})

        assert resolve_live_chat_language(db, "sess-live", bot, "मुझे मदद चाहिए") is None
        db.commit()

        assert db.get(ChatSession, "sess-live").language_code is None

    def test_auto_detect_off_still_leaves_a_language(self, db):
        # "Detect the visitor's language" off means the bot's default is the
        # answer, not that there is no answer.
        bot = _seed(db, language_config={**MULTILINGUAL_ON, "auto_detect": False})

        assert resolve_live_chat_language(db, "sess-live", bot, "मुझे मदद चाहिए") == "en"
        db.commit()

        assert db.get(ChatSession, "sess-live").language_code == "en"

    def test_a_missing_session_is_not_an_error(self, db):
        bot = _seed(db)

        assert resolve_live_chat_language(db, "no-such-session", bot, "hello") is None

    def test_no_bot_is_not_an_error(self, db):
        _seed(db)

        assert resolve_live_chat_language(db, "sess-live", None, "hello") is None


class TestTheVisitorSocketActuallyCallsIt:
    """The resolver is only worth having if the live path invokes it.

    Read as source rather than driven over a real socket, deliberately: this
    suite has no visitor-WebSocket harness (auth rides a subprotocol, and the
    handler is gated on origin and workspace checks), so standing one up to
    assert one call would be a larger and more fragile thing than the fix. The
    ORDER is the part worth pinning - the language has to exist before the row
    is written, because ``add_chat_message`` stamps ``source_language`` from it
    and a NULL stamp is not repaired later.
    """

    @staticmethod
    def _visitor_handler() -> str:
        import inspect

        from app.api import ws_routes

        source = inspect.getsource(ws_routes)
        start = source.index('@router.websocket("/ws/chat/{session_id}")')
        return source[start : source.index('@router.websocket("/ws/operator")')]

    def test_the_visitor_message_path_resolves_a_missing_language(self):
        handler = self._visitor_handler()
        assert "resolve_live_chat_language(" in handler, (
            "the visitor socket must resolve a session language when it has none, "
            "or live-chat-only sessions translate in neither direction"
        )

    def test_it_resolves_before_the_message_row_is_written(self):
        handler = self._visitor_handler()
        resolved_at = handler.index("resolve_live_chat_language(")
        stamped_at = handler.index("add_chat_message(")
        assert resolved_at < stamped_at, (
            "resolve the language BEFORE add_chat_message, which stamps "
            "source_language from it; a row stamped NULL stays NULL"
        )
