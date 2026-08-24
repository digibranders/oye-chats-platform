"""Phase 4 end-to-end behaviour against a real database.

Covers the guarantees that only show up when persistence, the REST contract and
the socket ordering are exercised together:

* ``ChatMessage.content`` is canonical and immutable after insert.
* Translations survive a reload, because ``GET /chat/history`` returns them.
* The visitor's ``message_ack`` is emitted BEFORE any translation work starts.
* A translation failure never costs anyone their message.
* Tenant isolation and owner (``X-API-Key``) auth on the preview endpoint.
* The disabled-feature and NULL-language fallbacks are silent, not errors.
"""

import asyncio
import os

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.db.models import Bot, ChatMessage, ChatSession, Client, Operator
from app.db.repository import add_chat_message
from app.services import translation_service as ts

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")


@pytest.fixture(autouse=True)
def _no_translation_cache(monkeypatch):
    """Run every test in this file against an empty translation cache.

    A developer machine usually has Redis up, and the translation cache is
    keyed only on (source, target, text) - deliberately, so it can be shared
    across tenants. That makes it shared across TEST RUNS too: an entry written
    by one test is a hit in the next, and an assertion about what the stubbed
    provider returned silently starts passing (or failing) on a cached value
    from a previous iteration. Caching behaviour itself is covered in
    tests/test_translation_service.py, which controls both helpers explicitly.
    """
    monkeypatch.setattr(ts, "cache_get", lambda key: None)
    monkeypatch.setattr(ts, "cache_set", lambda key, value, ttl: True)


MULTILINGUAL_ON = {
    "enabled": True,
    "default_locale": "en-IN",
    "supported_locales": ["en-IN", "hi-IN"],
    "operator_translation_enabled": True,
}


def _seed(db, *, language_config=None, session_language="hi", operator_locale="en-IN"):
    """One workspace: client + bot + operator + a live Hindi session."""
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

    operator = Operator(
        client_id=client.id,
        bot_id=bot.id,
        name="Asha",
        email="asha@example.com",
        operator_api_key="op-key-acme",
        # role="owner" mirrors what the WS auth path auto-provisions for a
        # client key, and is what `_language_target` resolves "me" to for an
        # X-API-Key caller.
        role="owner",
        preferred_locale=operator_locale,
    )
    db.add(operator)
    db.flush()

    session = ChatSession(
        id="sess-1",
        client_id=client.id,
        bot_id=bot.id,
        status="live",
        assigned_operator_id=operator.id,
        language_code=session_language,
        locale="hi-IN" if session_language == "hi" else "en-IN",
    )
    db.add(session)
    db.commit()
    return client, bot, operator, session


# ── Canonical original ───────────────────────────────────────────────────────


class TestOriginalIsCanonical:
    def test_store_translation_never_touches_content(self, db):
        _seed(db)
        msg = add_chat_message(db, "sess-1", role="user", content="मुझे pricing चाहिए", source_language="hi")
        db.commit()
        original = msg.content
        message_id = msg.id

        ts.store_translation(message_id, "en", content="I need pricing information.", provider="stub", model="m")

        db.expire_all()
        reloaded = db.get(ChatMessage, message_id)
        assert reloaded.content == original  # byte-identical
        assert reloaded.source_language == "hi"
        assert reloaded.translations["en"]["content"] == "I need pricing information."
        assert reloaded.translations["en"]["status"] == "ok"

    def test_second_language_merges_rather_than_replaces(self, db):
        # A chat transferred to an operator working in another language must
        # add a key, not clobber the one the previous operator relied on.
        _seed(db)
        msg = add_chat_message(db, "sess-1", role="user", content="नमस्ते", source_language="hi")
        db.commit()

        ts.store_translation(msg.id, "en", content="Hello", provider="stub", model="m")
        ts.store_translation(msg.id, "fr", content="Bonjour", provider="stub", model="m")

        db.expire_all()
        reloaded = db.get(ChatMessage, msg.id)
        assert reloaded.translations["en"]["content"] == "Hello"
        assert reloaded.translations["fr"]["content"] == "Bonjour"
        assert reloaded.content == "नमस्ते"

    def test_failed_translation_is_recorded_without_content(self, db):
        _seed(db)
        msg = add_chat_message(db, "sess-1", role="user", content="नमस्ते", source_language="hi")
        db.commit()

        ts.store_translation(msg.id, "en", status="failed")

        db.expire_all()
        reloaded = db.get(ChatMessage, msg.id)
        assert reloaded.translations["en"]["status"] == "failed"
        assert "content" not in reloaded.translations["en"]
        assert reloaded.content == "नमस्ते"

    def test_add_chat_message_defaults_source_language_to_null(self, db):
        # Every pre-Phase-4 caller keeps working unchanged.
        _seed(db)
        msg = add_chat_message(db, "sess-1", role="bot", content="Answer")
        db.commit()
        assert msg.source_language is None
        assert msg.translations is None


# ── Credit metering, against a real ledger ───────────────────────────────────


class TestTranslationCharge:
    """`charge_for_translation` must actually be able to write a ledger row.

    Every other test in the Phase 4 suite monkeypatches this function, which is
    exactly how the original defect shipped: `credit_ledger.reason` is a native
    Postgres ENUM, `translation` was not one of its labels, and the insert died
    with InvalidTextRepresentation. Because the function deliberately swallows
    every exception (a billing problem must never break live chat) the failure
    was completely silent - translation simply never happened, in production,
    with nothing in the logs but one warning line.

    These tests are unmockable on purpose. They run the real deduction against
    the real enum.
    """

    def _client_with_credits(self, db, amount=100):
        from app.services import credit_service

        client = db.execute(select(Client).where(Client.api_key == "key-acme")).scalar_one()
        credit_service.grant_manual(db, client.id, amount, note="e2e translation test")
        db.commit()
        return client

    def test_charge_writes_a_real_ledger_row(self, db):
        from app.services import credit_service

        _seed(db)
        client = self._client_with_credits(db)
        bot = db.execute(select(Bot).where(Bot.bot_key == "bot-acme")).scalar_one()
        before = credit_service.get_balance(db, client.id, None)

        assert ts.charge_for_translation(bot, 101, "en") is True

        db.expire_all()
        after = credit_service.get_balance(db, client.id, None)
        assert after == before - 1, "the translation charge did not reach the ledger"

    def test_charge_is_idempotent_per_message_and_language(self, db):
        from app.services import credit_service

        _seed(db)
        client = self._client_with_credits(db)
        bot = db.execute(select(Bot).where(Bot.bot_key == "bot-acme")).scalar_one()

        ts.charge_for_translation(bot, 101, "en")
        db.expire_all()
        after_first = credit_service.get_balance(db, client.id, None)

        # An operator-initiated retry, or a duplicated task, must not re-charge.
        ts.charge_for_translation(bot, 101, "en")
        db.expire_all()
        assert credit_service.get_balance(db, client.id, None) == after_first

        # A DIFFERENT target language is a different billable unit.
        ts.charge_for_translation(bot, 101, "fr")
        db.expire_all()
        assert credit_service.get_balance(db, client.id, None) == after_first - 1

    def test_charge_declines_without_credits_and_never_raises(self, db):
        # A workspace at zero loses translation, never message delivery.
        _seed(db)
        bot = db.execute(select(Bot).where(Bot.bot_key == "bot-acme")).scalar_one()
        assert ts.charge_for_translation(bot, 101, "en") is False


# ── Target resolution reads authoritative server state ───────────────────────


class TestTargetResolution:
    def test_resolves_from_database_not_socket_state(self, db):
        _seed(db)
        target, bot, source = ts.resolve_incoming_target("sess-1")
        assert target == "en"  # operator's preferred_locale en-IN -> en
        assert source == "hi"
        assert bot is not None

    def test_no_target_when_operator_has_no_preference(self, db):
        _seed(db, operator_locale=None)
        target, _bot, source = ts.resolve_incoming_target("sess-1")
        assert target is None
        assert source == "hi"

    def test_no_target_when_session_language_is_null(self, db):
        # The NULL-language fallback: bot enabled multilingual mid-conversation,
        # or the session reached live chat without a REST turn.
        _seed(db, session_language=None)
        target, _bot, source = ts.resolve_incoming_target("sess-1")
        assert target is None
        assert source is None

    def test_no_target_when_translation_disabled_for_the_bot(self, db):
        _seed(db, language_config={"enabled": True, "operator_translation_enabled": False})
        target, bot, _source = ts.resolve_incoming_target("sess-1")
        assert target is None
        assert bot is None

    def test_no_target_when_multilingual_itself_is_off(self, db):
        # The half-configured combination: translation on, multilingual off.
        _seed(db, language_config={"enabled": False, "operator_translation_enabled": True})
        target, bot, _source = ts.resolve_incoming_target("sess-1")
        assert target is None
        assert bot is None

    def test_target_resolves_without_any_socket_state(self, db):
        """The multi-worker guarantee, asserted directly.

        ``resolve_incoming_target`` is called from the worker holding the
        VISITOR socket, which with WS_BACKPLANE_ENABLED routinely does not hold
        the operator's. Nothing it reads may come from ConnectionManager's
        per-process dicts, so we clear them all and require the answer to be
        unchanged.
        """
        _seed(db)
        from app.services.live_chat_service import manager

        manager.assignments.clear()
        manager.operator_connections.clear()
        manager._operator_names.clear()
        manager._operator_locales.clear()

        target, bot, source = ts.resolve_incoming_target("sess-1")
        assert target == "en"
        assert source == "hi"
        assert bot is not None

    def test_unknown_session_is_silent(self, db):
        assert ts.resolve_incoming_target("does-not-exist") == (None, None, None)


# ── History endpoint carries translations ────────────────────────────────────


def _history_app(db):
    """Minimal app exposing the real history route with widget (bot-key) auth."""
    from fastapi import FastAPI

    from app.api.chat_routes import router

    app = FastAPI()
    app.include_router(router)
    return app


class TestHistoryContract:
    def test_history_returns_source_language_and_translations(self, db, monkeypatch):
        _seed(db)
        msg = add_chat_message(db, "sess-1", role="user", content="मुझे pricing चाहिए", source_language="hi")
        db.commit()
        ts.store_translation(msg.id, "en", content="I need pricing information.", provider="stub", model="m")

        from app.core.rate_limit import limiter

        monkeypatch.setattr(limiter, "enabled", False)
        client = TestClient(_history_app(db))
        res = client.get("/chat/history/sess-1", headers={"X-Bot-Key": "bot-acme"})
        assert res.status_code == 200
        row = next(r for r in res.json() if r["id"] == msg.id)

        # The reload path. Without these two fields a refresh drops every
        # translation and the thread reverts to mixed languages.
        assert row["content"] == "मुझे pricing चाहिए"  # canonical original
        assert row["source_language"] == "hi"
        assert row["translations"]["en"]["content"] == "I need pricing information."
        assert row["translations"]["en"]["status"] == "ok"

    def test_history_hides_provider_and_model_from_clients(self, db, monkeypatch):
        # Stored for audit and cost attribution, never shipped to a caller
        # holding only the public bot key.
        _seed(db)
        msg = add_chat_message(db, "sess-1", role="user", content="नमस्ते", source_language="hi")
        db.commit()
        ts.store_translation(msg.id, "en", content="Hello", provider="litellm", model="gemini/gemini-2.5-flash")

        from app.core.rate_limit import limiter

        monkeypatch.setattr(limiter, "enabled", False)
        client = TestClient(_history_app(db))
        row = next(
            r for r in client.get("/chat/history/sess-1", headers={"X-Bot-Key": "bot-acme"}).json() if r["id"] == msg.id
        )
        entry = row["translations"]["en"]
        assert set(entry) == {"content", "status"}

    def test_untranslated_message_returns_nulls_not_errors(self, db, monkeypatch):
        _seed(db)
        add_chat_message(db, "sess-1", role="bot", content="Plain answer")
        db.commit()

        from app.core.rate_limit import limiter

        monkeypatch.setattr(limiter, "enabled", False)
        client = TestClient(_history_app(db))
        rows = client.get("/chat/history/sess-1", headers={"X-Bot-Key": "bot-acme"}).json()
        assert rows[0]["source_language"] is None
        assert rows[0]["translations"] is None


# ── Ordering: the ack must precede translation ───────────────────────────────


class TestOrdering:
    def test_spawn_is_fire_and_forget_and_never_blocks(self, monkeypatch):
        """``spawn_incoming_translation`` must return immediately.

        This is the structural guarantee behind "the ack is not delayed": the
        visitor loop calls it AFTER sending ``message_ack``, and it must not
        await the provider. A regression that turned it back into an await
        would make this test hang rather than fail, so it is bounded.
        """
        started = asyncio.Event()
        release = asyncio.Event()

        async def _slow(*_args, **_kwargs):
            started.set()
            await release.wait()

        monkeypatch.setattr(ts, "_translate_incoming", _slow)

        async def _scenario():
            ts.spawn_incoming_translation("sess-1", 1, "नमस्ते")
            # Control is back here with the task still pending. If spawn had
            # awaited, we would not reach this line until release fired.
            assert not release.is_set()
            await asyncio.wait_for(started.wait(), timeout=1)
            release.set()
            await asyncio.sleep(0)

        asyncio.run(_scenario())

    def test_spawn_outside_an_event_loop_is_a_noop(self):
        # Sync contexts (tests, a worker) must not blow up: the original has
        # already been delivered by the time this is called.
        ts.spawn_incoming_translation("sess-1", 1, "नमस्ते")

    def test_inflight_tasks_are_strongly_referenced(self, monkeypatch):
        # Without a strong reference the loop can garbage-collect a pending
        # task mid-await, which shows up as translations that silently never
        # arrive under load.
        release = asyncio.Event()

        async def _slow(*_args, **_kwargs):
            await release.wait()

        monkeypatch.setattr(ts, "_translate_incoming", _slow)

        async def _scenario():
            ts.spawn_incoming_translation("sess-1", 1, "नमस्ते")
            assert len(ts._inflight) == 1
            release.set()
            await asyncio.sleep(0)
            await asyncio.sleep(0)
            assert len(ts._inflight) == 0  # done-callback discarded it

        asyncio.run(_scenario())


# ── Preview / backfill endpoint ──────────────────────────────────────────────


def _operator_app():
    from fastapi import FastAPI

    from app.api.operator_routes import router

    app = FastAPI()
    app.include_router(router)
    return app


class TestTranslateEndpoint:
    @pytest.fixture(autouse=True)
    def _no_limit(self, monkeypatch):
        from app.core.rate_limit import limiter

        monkeypatch.setattr(limiter, "enabled", False)

    def test_owner_with_api_key_is_accepted(self, db, monkeypatch):
        """Regression for the audit's C5.

        The plan originally specified ``get_current_operator``, which accepts
        ``X-Operator-Key`` only. Workspace owners reach the console with
        ``X-API-Key``, so that dependency would have 401'd the most common
        persona.
        """
        _seed(db)
        monkeypatch.setattr(ts, "charge_for_translation", lambda *a, **k: True)
        monkeypatch.setattr(ts, "translation_service", ts.TranslationService(provider=_ok_provider("नमस्ते")))
        client = TestClient(_operator_app())
        res = client.post(
            "/operators/translate",
            json={"session_id": "sess-1", "text": "Hello"},
            headers={"X-API-Key": "key-acme"},
        )
        assert res.status_code == 200, res.text
        assert res.json()["translated"] == "नमस्ते"
        assert res.json()["target_locale"] == "hi"

    def test_operator_key_is_accepted(self, db, monkeypatch):
        _seed(db)
        monkeypatch.setattr(ts, "charge_for_translation", lambda *a, **k: True)
        monkeypatch.setattr(ts, "translation_service", ts.TranslationService(provider=_ok_provider("नमस्ते")))
        client = TestClient(_operator_app())
        res = client.post(
            "/operators/translate",
            json={"session_id": "sess-1", "text": "Hello"},
            headers={"X-Operator-Key": "op-key-acme"},
        )
        assert res.status_code == 200, res.text

    def test_other_tenants_session_is_rejected(self, db, monkeypatch):
        _seed(db)
        intruder = Client(name="Evil", email="evil@example.com", api_key="key-evil", hashed_password="x")
        db.add(intruder)
        db.flush()
        db.add(Bot(client_id=intruder.id, name="Evil Bot", bot_key="bot-evil", language_config=MULTILINGUAL_ON))
        db.commit()

        client = TestClient(_operator_app())
        res = client.post(
            "/operators/translate",
            json={"session_id": "sess-1", "text": "Hello"},
            headers={"X-API-Key": "key-evil"},
        )
        assert res.status_code == 403

    def test_requires_a_session_id(self, db):
        _seed(db)
        client = TestClient(_operator_app())
        res = client.post("/operators/translate", json={"text": "Hello"}, headers={"X-API-Key": "key-acme"})
        # Without a session there is nothing to scope or derive a target from:
        # that is what stops this being an open LLM proxy.
        assert res.status_code == 422

    def test_rejects_when_translation_disabled_for_the_bot(self, db):
        _seed(db, language_config={"enabled": True, "operator_translation_enabled": False})
        client = TestClient(_operator_app())
        res = client.post(
            "/operators/translate",
            json={"session_id": "sess-1", "text": "Hello"},
            headers={"X-API-Key": "key-acme"},
        )
        assert res.status_code == 403

    def test_provider_outage_is_a_503_not_a_500(self, db, monkeypatch):
        _seed(db)
        monkeypatch.setattr(ts, "charge_for_translation", lambda *a, **k: True)
        monkeypatch.setattr(
            ts,
            "translation_service",
            ts.TranslationService(provider=_failing_provider()),
        )
        client = TestClient(_operator_app())
        res = client.post(
            "/operators/translate",
            json={"session_id": "sess-1", "text": "Hello"},
            headers={"X-API-Key": "key-acme"},
        )
        assert res.status_code == 503

    def test_backfill_persists_onto_the_named_message(self, db, monkeypatch):
        _seed(db)
        msg = add_chat_message(db, "sess-1", role="user", content="नमस्ते", source_language="hi")
        db.commit()
        monkeypatch.setattr(ts, "charge_for_translation", lambda *a, **k: True)
        monkeypatch.setattr(ts, "translation_service", ts.TranslationService(provider=_ok_provider("Hello")))

        client = TestClient(_operator_app())
        res = client.post(
            "/operators/translate",
            json={"session_id": "sess-1", "text": "नमस्ते", "message_id": msg.id},
            headers={"X-Operator-Key": "op-key-acme"},
        )
        assert res.status_code == 200, res.text
        db.expire_all()
        reloaded = db.get(ChatMessage, msg.id)
        assert reloaded.translations["en"]["content"] == "Hello"
        assert reloaded.content == "नमस्ते"  # still canonical

    def test_backfill_rejects_a_message_from_another_session(self, db):
        _seed(db)
        other = ChatSession(id="sess-2", client_id=1, bot_id=1, status="bot")
        db.add(other)
        db.commit()
        stray = add_chat_message(db, "sess-2", role="user", content="hi", source_language="hi")
        db.commit()

        client = TestClient(_operator_app())
        res = client.post(
            "/operators/translate",
            json={"session_id": "sess-1", "text": "hi", "message_id": stray.id},
            headers={"X-API-Key": "key-acme"},
        )
        assert res.status_code == 404


# ── Operator language self-service ───────────────────────────────────────────


class TestOperatorLanguageApi:
    @pytest.fixture(autouse=True)
    def _no_limit(self, monkeypatch):
        from app.core.rate_limit import limiter

        monkeypatch.setattr(limiter, "enabled", False)

    def test_operator_can_set_their_own_language(self, db):
        _seed(db, operator_locale=None)
        client = TestClient(_operator_app())
        res = client.put(
            "/operators/me/language",
            json={"preferred_locale": "hi_in"},
            headers={"X-Operator-Key": "op-key-acme"},
        )
        assert res.status_code == 200
        # Normalized on write so downstream comparisons never re-parse.
        assert res.json()["preferred_locale"] == "hi-IN"

        db.expire_all()
        operator = db.execute(select(Operator).where(Operator.operator_api_key == "op-key-acme")).scalar_one()
        assert operator.preferred_locale == "hi-IN"

    def test_invalid_locale_is_rejected(self, db):
        _seed(db)
        client = TestClient(_operator_app())
        res = client.put(
            "/operators/me/language",
            json={"preferred_locale": "not a locale!!"},
            headers={"X-Operator-Key": "op-key-acme"},
        )
        assert res.status_code == 422

    def test_empty_string_clears_the_preference(self, db):
        _seed(db, operator_locale="hi-IN")
        client = TestClient(_operator_app())
        res = client.put(
            "/operators/me/language",
            json={"preferred_locale": ""},
            headers={"X-Operator-Key": "op-key-acme"},
        )
        assert res.status_code == 200
        assert res.json()["preferred_locale"] is None

    def test_get_returns_current_state(self, db):
        _seed(db, operator_locale="en-IN")
        client = TestClient(_operator_app())
        res = client.get("/operators/me/language", headers={"X-Operator-Key": "op-key-acme"})
        assert res.status_code == 200
        # ``available_locales`` (Phase 5A) is what the picker may offer, derived
        # from the bot's supported list. Covered in tests/test_locale_routes.py.
        assert res.json() == {
            "preferred_locale": "en-IN",
            "supported_languages": [],
            "available_locales": ["en-IN", "hi-IN"],
        }


# ── Session details exposes the conversation language ────────────────────────


class TestSessionDetails:
    def test_details_include_language_code_and_locale(self, db, monkeypatch):
        from app.core.rate_limit import limiter

        monkeypatch.setattr(limiter, "enabled", False)
        _seed(db)
        client = TestClient(_operator_app())
        res = client.get("/operators/session/sess-1/details", headers={"X-API-Key": "key-acme"})
        assert res.status_code == 200, res.text
        assert res.json()["language_code"] == "hi"
        assert res.json()["locale"] == "hi-IN"


# ── Helpers ──────────────────────────────────────────────────────────────────


def _ok_provider(text):
    class _P:
        provider_name = "stub"
        model = "stub-model"

        async def translate(self, _text, _source, _target, timeout=None):
            return ts.TranslationResult(content=text, provider=self.provider_name, model=self.model, cached=False)

    return _P()


def _failing_provider():
    class _P:
        provider_name = "stub"
        model = "stub-model"

        async def translate(self, _text, _source, _target, timeout=None):
            raise ts.TranslationUnavailable("provider down")

    return _P()


# ── Pre-handoff transcript backfill ──────────────────────────────────────────


class TestTranscriptBackfill:
    """An operator picking up a chat must be able to READ the conversation.

    Before this, only messages sent AFTER the handoff were translated. An
    operator inherited the entire AI conversation in a language they may not
    read, with a single translated line at the bottom - and that transcript is
    precisely the context explaining why the visitor asked for a human.
    """

    def _stub(self, text="TRANSLATED"):
        class _P:
            provider_name = "stub"
            model = "stub-model"

            async def translate(self, _t, _s, _target, timeout=None):
                return ts.TranslationResult(content=text, provider=self.provider_name, model=self.model, cached=False)

        return _P()

    def test_backfills_untranslated_visitor_turns(self, db, monkeypatch):
        _seed(db)
        ids = []
        for text in ("नमस्ते", "कीमत क्या है", "मुझे मदद चाहिए"):
            m = add_chat_message(db, "sess-1", role="user", content=text, source_language="hi")
            ids.append(m.id)
        # Bot turns are NOT the operator's to act on and are already native to
        # the visitor's language, so they must be left alone.
        bot_msg = add_chat_message(db, "sess-1", role="bot", content="नमस्ते जी", source_language="hi")
        db.commit()

        monkeypatch.setattr(ts, "charge_for_translation", lambda *a, **k: True)
        monkeypatch.setattr(ts, "translation_service", ts.TranslationService(provider=self._stub()))
        asyncio.run(ts._backfill_transcript("sess-1"))

        db.expire_all()
        for mid in ids:
            row = db.get(ChatMessage, mid)
            assert row.translations["en"]["content"] == "TRANSLATED", f"message {mid} not backfilled"
        assert db.get(ChatMessage, bot_msg.id).translations is None

    def test_skips_messages_already_translated(self, db, monkeypatch):
        _seed(db)
        done = add_chat_message(db, "sess-1", role="user", content="नमस्ते", source_language="hi")
        db.commit()
        ts.store_translation(done.id, "en", content="Hello", provider="stub", model="m")

        calls = []
        monkeypatch.setattr(ts, "charge_for_translation", lambda *a, **k: calls.append(a) or True)
        monkeypatch.setattr(ts, "translation_service", ts.TranslationService(provider=self._stub("REDONE")))
        asyncio.run(ts._backfill_transcript("sess-1"))

        db.expire_all()
        # Untouched, and never charged for a second time.
        assert db.get(ChatMessage, done.id).translations["en"]["content"] == "Hello"
        assert calls == []

    def test_skips_messages_with_no_source_language(self, db, monkeypatch):
        # Rows written before Phase 4 have no source_language and are
        # untranslatable; they must be passed over silently, not guessed at.
        _seed(db)
        legacy = add_chat_message(db, "sess-1", role="user", content="नमस्ते")
        db.commit()
        monkeypatch.setattr(ts, "charge_for_translation", lambda *a, **k: True)
        monkeypatch.setattr(ts, "translation_service", ts.TranslationService(provider=self._stub()))
        asyncio.run(ts._backfill_transcript("sess-1"))
        db.expire_all()
        assert db.get(ChatMessage, legacy.id).translations is None

    def test_skips_messages_already_in_the_operator_language(self, db, monkeypatch):
        _seed(db)
        english = add_chat_message(db, "sess-1", role="user", content="Hello there", source_language="en")
        db.commit()
        calls = []
        monkeypatch.setattr(ts, "charge_for_translation", lambda *a, **k: calls.append(a) or True)
        monkeypatch.setattr(ts, "translation_service", ts.TranslationService(provider=self._stub()))
        asyncio.run(ts._backfill_transcript("sess-1"))
        db.expire_all()
        assert db.get(ChatMessage, english.id).translations is None
        assert calls == []

    def test_is_bounded_so_a_long_chat_cannot_run_up_the_bill(self, db, monkeypatch):
        _seed(db)
        for i in range(ts.TRANSCRIPT_BACKFILL_LIMIT + 8):
            add_chat_message(db, "sess-1", role="user", content=f"संदेश {i}", source_language="hi")
        db.commit()

        charged = []
        monkeypatch.setattr(ts, "charge_for_translation", lambda bot, mid, lang: charged.append(mid) or True)
        monkeypatch.setattr(ts, "translation_service", ts.TranslationService(provider=self._stub()))
        asyncio.run(ts._backfill_transcript("sess-1"))

        assert len(charged) == ts.TRANSCRIPT_BACKFILL_LIMIT

    def test_stops_when_credits_run_out_rather_than_hammering_the_ledger(self, db, monkeypatch):
        _seed(db)
        for i in range(5):
            add_chat_message(db, "sess-1", role="user", content=f"संदेश {i}", source_language="hi")
        db.commit()

        attempts = []

        def _charge(_bot, mid, _lang):
            attempts.append(mid)
            return len(attempts) <= 2  # the third call fails

        monkeypatch.setattr(ts, "charge_for_translation", _charge)
        monkeypatch.setattr(ts, "translation_service", ts.TranslationService(provider=self._stub()))
        asyncio.run(ts._backfill_transcript("sess-1"))
        assert len(attempts) == 3, "backfill must stop at the first refusal"

    def test_provider_failure_records_and_continues(self, db, monkeypatch):
        _seed(db)
        ids = [
            add_chat_message(db, "sess-1", role="user", content=f"संदेश {i}", source_language="hi").id for i in range(2)
        ]
        db.commit()

        class _Flaky:
            provider_name = "stub"
            model = "stub-model"
            calls = 0

            async def translate(self, _t, _s, _target, timeout=None):
                _Flaky.calls += 1
                if _Flaky.calls == 1:
                    raise ts.TranslationUnavailable("down")
                return ts.TranslationResult(content="OK", provider="stub", model="m", cached=False)

        monkeypatch.setattr(ts, "charge_for_translation", lambda *a, **k: True)
        monkeypatch.setattr(ts, "translation_service", ts.TranslationService(provider=_Flaky()))
        asyncio.run(ts._backfill_transcript("sess-1"))

        db.expire_all()
        # One failure recorded, the rest still processed.
        assert db.get(ChatMessage, ids[0]).translations["en"]["status"] == "failed"
        assert db.get(ChatMessage, ids[1]).translations["en"]["content"] == "OK"

    def test_noop_when_translation_is_disabled(self, db, monkeypatch):
        _seed(db, language_config={"enabled": True, "operator_translation_enabled": False})
        m = add_chat_message(db, "sess-1", role="user", content="नमस्ते", source_language="hi")
        db.commit()
        monkeypatch.setattr(ts, "charge_for_translation", lambda *a, **k: True)
        monkeypatch.setattr(ts, "translation_service", ts.TranslationService(provider=self._stub()))
        asyncio.run(ts._backfill_transcript("sess-1"))
        db.expire_all()
        assert db.get(ChatMessage, m.id).translations is None

    def test_spawn_outside_an_event_loop_is_a_noop(self):
        ts.spawn_transcript_backfill("sess-1")
