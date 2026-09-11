"""The topical media card through both real paths: generation and cache hit.

``test_topical_media_card.py`` pins which asset a question matches. These pin
where the pipeline applies it, and the two ways it had to be wired to be
visible on production at all. A generated answer gets the card; so does a
cached one, because the cache stores only text and sources and would otherwise
serve every visitor after the first the same answer with the card silently gone.
"""

from __future__ import annotations

import itertools

import pytest

from app.services import document_request
from app.services import rag_service as rs
from tests.test_rag_pipeline_defects import (
    _anonymous_visitor,
    _answer_text,
    _Cache,
    _Doc,
    _drive_stream,
    _final_meta,
    _make_bot,
    _make_client,
    _make_session,
    _stub_pipeline,
)

_PDF = "https://acme.com/wp-content/uploads/2023/07/Red-Teaming.pdf"
_OTHER = "https://acme.com/wp-content/uploads/2023/09/Penetration-Testing.pdf"
_CATALOG = [
    {"files": [{"url": _PDF, "name": "Red-Teaming.pdf"}]},
    {"files": [{"url": _OTHER, "name": "Penetration-Testing.pdf"}]},
]
_ids = itertools.count(90_000)


def _chunk(text: str, *, url: str = _PDF, name: str = "Red-Teaming.pdf") -> _Doc:
    return _Doc(
        content=text,
        document_name="https://acme.com/red-teaming/",
        media_urls=None,
        id=next(_ids),
        metadata_info={"media_urls": {"files": [{"url": url, "name": name}]}},
    )


def _bot_with_session(db, sid):
    client = _make_client(db)
    bot = _make_bot(db, client)
    _make_session(db, bot, client, sid)
    return bot, client


@pytest.fixture
def catalog(monkeypatch):
    monkeypatch.setattr(rs, "get_bot_media_urls", lambda *a, **k: _CATALOG)
    return _CATALOG


class TestGeneratedAnswers:
    @pytest.mark.asyncio
    async def test_a_topical_question_gets_the_matching_card(self, db, monkeypatch, catalog):
        bot, _ = _bot_with_session(db, "topical-gen-1")
        _stub_pipeline(monkeypatch, chunks=("Red teaming is an adversarial exercise.",), retrieved=(_chunk("x"),))

        frames = await _drive_stream(bot, "what is red teaming", "topical-gen-1")

        assert _final_meta(frames)["media_card"]["url"] == _PDF
        # The attach decides the card only; the words the model wrote stand.
        answer = _answer_text(frames)
        assert "adversarial exercise" in answer
        assert "DOWNLOAD_CARD" not in answer

    @pytest.mark.asyncio
    async def test_a_card_the_model_chose_is_not_replaced(self, db, monkeypatch, catalog):
        bot, _ = _bot_with_session(db, "topical-gen-2")
        emitted = f"Here is the pen-test datasheet.\n\n[DOWNLOAD_CARD:{_OTHER}|Penetration-Testing.pdf]"
        _stub_pipeline(
            monkeypatch,
            chunks=(emitted,),
            retrieved=(_chunk("x"), _chunk("y", url=_OTHER, name="Penetration-Testing.pdf")),
        )

        frames = await _drive_stream(bot, "what is red teaming", "topical-gen-2")

        assert _final_meta(frames)["media_card"]["url"] == _OTHER

    @pytest.mark.asyncio
    async def test_no_card_on_a_refusal(self, db, monkeypatch, catalog):
        bot, _ = _bot_with_session(db, "topical-gen-3")
        _stub_pipeline(monkeypatch, chunks=("That is outside what I can help with.",), retrieved=(_chunk("x"),))
        monkeypatch.setattr(rs, "_is_known_refusal", lambda *a, **k: True)

        frames = await _drive_stream(bot, "what is red teaming", "topical-gen-3")

        assert "media_card" not in _final_meta(frames)

    @pytest.mark.asyncio
    async def test_no_card_when_a_leave_message_card_is_on_the_turn(self, db, monkeypatch, catalog):
        """Precedence the prompt already states: a leave-message card outranks a
        media card. The server must not smuggle one in beside it."""
        bot, _ = _bot_with_session(db, "topical-gen-4")
        _stub_pipeline(
            monkeypatch, chunks=("I'll open a message form.\n\n[LEAVE_MESSAGE_CARD]",), retrieved=(_chunk("x"),)
        )

        frames = await _drive_stream(bot, "what is red teaming", "topical-gen-4")

        assert "media_card" not in _final_meta(frames)

    @pytest.mark.asyncio
    async def test_a_question_that_names_no_asset_gets_no_card(self, db, monkeypatch, catalog):
        bot, _ = _bot_with_session(db, "topical-gen-5")
        _stub_pipeline(monkeypatch, chunks=("We are open nine to five.",), retrieved=(_chunk("x"),))

        frames = await _drive_stream(bot, "what are your office hours", "topical-gen-5")

        assert "media_card" not in _final_meta(frames)


class TestCachedAnswers:
    @pytest.mark.asyncio
    async def test_a_cache_hit_carries_the_card_the_generated_turn_had(self, db, monkeypatch, catalog):
        cache = _Cache()
        client = _make_client(db)
        bot = _make_bot(db, client)
        _make_session(db, bot, client, "topical-cache-a")
        _make_session(db, bot, client, "topical-cache-b")
        captured = _stub_pipeline(
            monkeypatch, chunks=("Red teaming is an adversarial exercise.",), retrieved=(_chunk("x"),), cache=cache
        )
        # Only an impersonal answer is cacheable; the default stub names the visitor.
        _anonymous_visitor(monkeypatch)

        first = await _drive_stream(bot, "what is red teaming", "topical-cache-a")
        assert cache.store, "the first turn must have written the answer cache"
        again = await _drive_stream(bot, "what is red teaming", "topical-cache-b")

        assert len(captured["prompts"]) == 1, "the second visitor must be served from the cache"
        assert _final_meta(first)["media_card"]["url"] == _PDF
        assert _final_meta(again).get("media_card", {}).get("url") == _PDF

    @pytest.mark.asyncio
    async def test_a_cached_card_is_not_shown_twice_in_one_conversation(self, db, monkeypatch, catalog):
        cache = _Cache()
        client = _make_client(db)
        bot = _make_bot(db, client)
        _make_session(db, bot, client, "topical-dedupe-a")
        _make_session(db, bot, client, "topical-dedupe-b")
        _stub_pipeline(
            monkeypatch, chunks=("Red teaming is an adversarial exercise.",), retrieved=(_chunk("x"),), cache=cache
        )
        _anonymous_visitor(monkeypatch)

        await _drive_stream(bot, "what is red teaming", "topical-dedupe-a")
        shown = await _drive_stream(bot, "what is red teaming", "topical-dedupe-b")
        repeat = await _drive_stream(bot, "what is red teaming", "topical-dedupe-b")

        assert _final_meta(shown).get("media_card", {}).get("url") == _PDF
        assert "media_card" not in _final_meta(repeat)


class TestWhichCardedTurnsTheCacheMayHold:
    """The cache stores text and sources, never a card, so a carded turn was kept
    out of it entirely. That is still right for a card the model chose: nothing on
    a cache hit can know which asset the model would have picked. It is wrong for a
    card the server attached, because that card is a pure function of the question
    and the catalog, and the cache hit recomputes exactly the same one. Keeping
    those turns out of the cache would cost an LLM call on every repeat of the
    most common topical questions, for no gain.
    """

    @pytest.mark.asyncio
    async def test_a_card_the_model_chose_still_keeps_its_turn_out_of_the_cache(self, db, monkeypatch, catalog):
        cache = _Cache()
        bot, _ = _bot_with_session(db, "topical-model-card")
        emitted = f"Here is the pen-test datasheet.\n\n[DOWNLOAD_CARD:{_OTHER}|Penetration-Testing.pdf]"
        _stub_pipeline(
            monkeypatch,
            chunks=(emitted,),
            retrieved=(_chunk("x", url=_OTHER, name="Penetration-Testing.pdf"),),
            cache=cache,
        )
        _anonymous_visitor(monkeypatch)
        # The question names a document, so the document classifier runs; no test
        # reaches a real model. NO keeps the turn on the generated path this test
        # is about: asked whether a document exists, with the exact file in the
        # catalog, the document route would answer with the card before generation.
        monkeypatch.setattr(document_request, "_classify_document_request_raw", lambda _question: "no")

        frames = await _drive_stream(bot, "do you have the penetration testing datasheet", "topical-model-card")

        assert _final_meta(frames)["media_card"]["url"] == _OTHER
        assert cache.store == {}, "a model-chosen card cannot be recomputed on a cache hit"

    @pytest.mark.asyncio
    async def test_a_server_attached_card_lets_its_turn_be_cached(self, db, monkeypatch, catalog):
        cache = _Cache()
        bot, _ = _bot_with_session(db, "topical-attached-card")
        _stub_pipeline(
            monkeypatch, chunks=("Red teaming is an adversarial exercise.",), retrieved=(_chunk("x"),), cache=cache
        )
        _anonymous_visitor(monkeypatch)

        frames = await _drive_stream(bot, "what is red teaming", "topical-attached-card")

        assert _final_meta(frames)["media_card"]["url"] == _PDF
        assert cache.store, "a server-attached card is recomputed on a hit, so its turn may be cached"
        cached = next(iter(cache.store.values()))
        assert "media_card" not in cached and "DOWNLOAD_CARD" not in cached["answer"]
