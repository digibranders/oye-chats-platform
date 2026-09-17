"""Download cards through the streaming pipeline: once per file, back-references, and only the bot's own files.

``test_media_cards.py`` pins the identity and ownership rules. These pin where
the pipeline applies them (evaluation and prompt review, 2026-09-17):

* "is there a pdf of this i can share with my boss" right after a reply that
  carried a card was answered "I don't have a downloadable document for that
  here".
* The same case study at a second URL reached the visitor again.
* Third-party PDFs a bot's pages link (NIST, IBM, SEBI) could be offered as the
  bot's own downloads.
"""

from __future__ import annotations

import itertools

import pytest

from app.db.models import ChatSession
from app.services import document_request, media_cards
from app.services import rag_service as rs
from tests.test_rag_pipeline_defects import (
    _answer_text,
    _Doc,
    _drive_stream,
    _final_meta,
    _make_bot,
    _make_client,
    _make_session,
    _stub_pipeline,
)

RED = "https://acme.com/files/Red-Teaming-Guide.pdf"
RED_COPY = "https://cdn.acme.com/web/Red-Teaming-Guide-29330f6b.pdf"
RED_ASSESSMENT = "https://acme.com/files/Red-Team-Assessment.pdf"
IBM = "https://www.ibm.com/downloads/Threat-Intelligence-Index.pdf"
BACK_REFERENCE = "is there a pdf of this i can share with my boss"
_ids = itertools.count(95_000)


@pytest.fixture(autouse=True)
def classifier(monkeypatch):
    """No test here reaches a real model: every message that names a document is a request to send it."""
    monkeypatch.setattr(document_request, "_classify_document_request_raw", lambda _q: "send")


def _chunk(text: str, files: list[dict] | None = None) -> _Doc:
    return _Doc(
        content=text,
        document_name="https://acme.com/red-teaming/",
        media_urls=None,
        id=next(_ids),
        metadata_info={"media_urls": {"files": files or []}},
    )


def _bot(db, session_id, **bot_kwargs):
    client = _make_client(db)
    bot = _make_bot(db, client, **bot_kwargs)
    _make_session(db, bot, client, session_id)
    return bot


def _catalog(monkeypatch, files):
    monkeypatch.setattr(rs, "get_bot_media_urls", lambda *_a, **_k: [{"files": files}])


def _cards(db, session_id):
    db.expire_all()
    return db.query(ChatSession).filter(ChatSession.id == session_id).one().inline_cards_shown or {}


@pytest.mark.asyncio
async def test_a_request_for_a_pdf_of_this_gets_the_file_the_last_reply_carried(db, monkeypatch):
    bot = _bot(db, "cards-this")
    _stub_pipeline(
        monkeypatch, retrieved=(_chunk("Red teaming tests defences."),), chunks=("Red teaming tests defences.",)
    )
    _catalog(monkeypatch, [{"url": RED, "name": "Red-Teaming-Guide.pdf"}])

    first = await _drive_stream(bot, "tell me about red teaming", "cards-this")
    assert _final_meta(first)["media_card"]["url"] == RED, "precondition: the reply carried the guide"
    second = await _drive_stream(bot, BACK_REFERENCE, "cards-this")

    meta = _final_meta(second)
    assert meta["media_card"]["url"] == RED
    assert "Here you go: **Red Teaming Guide** is ready to download below." in _answer_text(second)
    assert "don't have a downloadable document" not in _answer_text(second)


@pytest.mark.asyncio
async def test_a_request_for_a_pdf_of_this_after_a_reply_without_a_card_uses_the_previous_topic(db, monkeypatch):
    bot = _bot(db, "cards-topic")
    _stub_pipeline(
        monkeypatch, retrieved=(_chunk("Red teaming tests defences."),), chunks=("Red teaming tests defences.",)
    )
    # One word in common with the question: too little for a card on the first reply.
    _catalog(monkeypatch, [{"url": RED_ASSESSMENT, "name": "Red-Team-Assessment.pdf"}])

    first = await _drive_stream(bot, "tell me about red teaming", "cards-topic")
    assert "media_card" not in _final_meta(first), "precondition: no card on the first reply"
    second = await _drive_stream(bot, BACK_REFERENCE, "cards-topic")

    assert _final_meta(second)["media_card"]["url"] == RED_ASSESSMENT
    assert "don't have a downloadable document" not in _answer_text(second)


@pytest.mark.asyncio
async def test_a_request_that_names_its_own_file_is_not_redirected(db, monkeypatch):
    bot = _bot(db, "cards-named")
    _stub_pipeline(
        monkeypatch, retrieved=(_chunk("Red teaming tests defences."),), chunks=("Red teaming tests defences.",)
    )
    _catalog(
        monkeypatch,
        [{"url": RED, "name": "Red-Teaming-Guide.pdf"}, {"url": RED_ASSESSMENT, "name": "Red-Team-Assessment.pdf"}],
    )

    await _drive_stream(bot, "tell me about red teaming", "cards-named")
    second = await _drive_stream(bot, "send me the red team assessment pdf of it", "cards-named")

    assert _final_meta(second)["media_card"]["url"] == RED_ASSESSMENT


@pytest.mark.asyncio
async def test_a_file_already_shown_under_another_url_is_not_attached_again(db, monkeypatch):
    bot = _bot(db, "cards-copy")
    _stub_pipeline(
        monkeypatch, retrieved=(_chunk("Red teaming tests defences."),), chunks=("Red teaming tests defences.",)
    )
    _catalog(monkeypatch, [{"url": RED, "name": "Red-Teaming-Guide.pdf"}])
    first = await _drive_stream(bot, "can you send me the red teaming guide pdf", "cards-copy")
    assert _final_meta(first)["media_card"]["url"] == RED, "precondition: the document route sent the guide"

    _catalog(monkeypatch, [{"url": RED_COPY, "name": "Red-Teaming-Guide-29330f6b.pdf"}])
    second = await _drive_stream(bot, "how does red teaming work", "cards-copy")

    assert "media_card" not in _final_meta(second)
    assert _cards(db, "cards-copy").get("media:download:title:red teaming guide") is True


@pytest.mark.parametrize("enforce", [True, False])
@pytest.mark.parametrize("website", ["https://acme.com", None])
@pytest.mark.asyncio
async def test_a_third_party_file_is_offered_only_by_a_bot_that_names_no_website(db, monkeypatch, website, enforce):
    """Enforced, a bot with a website never offers a foreign file. Log-only (the shipped mode) it still does."""
    monkeypatch.setattr(media_cards, "ENFORCE_OWNED_FILES", enforce)
    session_id = f"cards-owned-{bool(website)}-{enforce}"
    bot = _bot(db, session_id, website=website)
    cap = _stub_pipeline(
        monkeypatch,
        retrieved=(
            _chunk(
                "The threat intelligence index tracks attackers.",
                [{"url": IBM, "name": "Threat-Intelligence-Index.pdf"}],
            ),
        ),
        chunks=(f"The index tracks attackers. [DOWNLOAD_CARD:{IBM}|Threat-Intelligence-Index.pdf]",),
    )
    _catalog(monkeypatch, [{"url": IBM, "name": "Threat-Intelligence-Index.pdf"}])

    generated = await _drive_stream(bot, "tell me about the threat intelligence index", session_id)
    requested = await _drive_stream(bot, "can you send me the threat intelligence index pdf", session_id)

    system_prompt, prompt = cap["prompts"][0]
    if website and enforce:
        assert "media_card" not in _final_meta(generated)
        assert IBM not in f"{system_prompt}{prompt}"
        assert "media_card" not in _final_meta(requested)
        assert "don't have a downloadable document" in _answer_text(requested)
    else:
        assert _final_meta(generated)["media_card"]["url"] == IBM
        assert _final_meta(requested)["media_card"]["url"] == IBM
