"""A retrieved chunk that states a placeholder never reaches the model.

Production, 2026-09-11: CleanStart's bot told a visitor "The enterprise phone
number is +1 (555) 123-4567 for Enterprise tier customers only." The number
came from a crawled draft page that was retrieved and put in the prompt like
any other chunk.

The chunk is dropped from the context, not edited: on the retrieval path the
results are ORM rows bound to the request session, so rewriting their text
could be flushed back into the customer's knowledge base. Dropping changes
nothing stored. Every path that feeds the prompt is covered: hybrid retrieval,
the zero-result fallback, CAG-lite, and the non-streaming collector.
"""

from types import SimpleNamespace

import pytest

from app.db.models import Document
from app.services import rag_service as rs
from tests.test_rag_pipeline_defects import (
    _doc,
    _drive_stream,
    _make_bot,
    _make_client,
    _make_session,
    _stub_pipeline,
)

DRAFT = "The enterprise phone number is +1 (555) 123-4567 for Enterprise tier customers only."
TEMPLATE = "Our SOC 2 Type II audit is performed every year by [Big 4 Firm Name]."
REAL = "Enterprise customers get a named success manager and a one hour P1 response."
CODE = "Create a contact from the CLI:\n```bash\nacme contacts create --phone 555-123-4567\n```"
QUESTION = "how do enterprise customers get support"


@pytest.fixture()
def dropped(monkeypatch):
    calls: list[tuple[str, int, int | None]] = []
    monkeypatch.setattr(
        rs,
        "increment_metric_counter_by",
        lambda name, amount, bot_id=None: calls.append((name, amount, bot_id)),
    )
    return calls


def _prompt_text(captured) -> str:
    return "\n".join(prompt for _system, prompt in captured["prompts"])


# ── The filter ───────────────────────────────────────────────────────────────


def test_only_placeholder_chunks_are_dropped_and_order_is_kept(dropped):
    docs = [_doc(REAL), _doc(DRAFT), _doc(CODE), _doc(TEMPLATE)]

    kept = rs._drop_placeholder_chunks(docs, 7)

    assert [doc.content for doc in kept] == [REAL, CODE]
    assert dropped == [("kb_placeholder_chunk_dropped", 2, 7)]


def test_a_clean_bundle_is_returned_as_is_without_a_metric(dropped):
    docs = [_doc(REAL), _doc(CODE)]

    assert rs._drop_placeholder_chunks(docs, 7) == docs
    assert dropped == []


def test_a_chunk_without_content_is_kept(dropped):
    empty = SimpleNamespace(id=1, content=None, document_name="empty.txt")

    assert rs._drop_placeholder_chunks([empty], 7) == [empty]
    assert dropped == []


def test_the_drop_log_names_chunks_and_kinds_but_not_their_text(dropped, caplog):
    draft = _doc(DRAFT)

    with caplog.at_level("INFO", logger=rs.logger.name):
        rs._drop_placeholder_chunks([draft], 7)

    assert f"{draft.id}:phone" in caplog.text
    assert "555" not in caplog.text


# ── Every path that builds the prompt ────────────────────────────────────────


@pytest.mark.asyncio
async def test_the_retrieval_path_never_shows_the_model_a_placeholder_chunk(db, monkeypatch, dropped):
    client = _make_client(db)
    bot = _make_bot(db, client)
    _make_session(db, bot, client, "placeholder-hybrid")
    captured = _stub_pipeline(monkeypatch, retrieved=(_doc(DRAFT), _doc(REAL)))

    await _drive_stream(bot, QUESTION, "placeholder-hybrid")

    prompt = _prompt_text(captured)
    assert REAL in prompt
    assert "(555) 123-4567" not in prompt
    assert ("kb_placeholder_chunk_dropped", 1, bot.id) in dropped


@pytest.mark.asyncio
async def test_the_zero_result_fallback_is_filtered_too(db, monkeypatch, dropped):
    client = _make_client(db)
    bot = _make_bot(db, client)
    _make_session(db, bot, client, "placeholder-fallback")
    captured = _stub_pipeline(monkeypatch, retrieved=())
    monkeypatch.setattr(rs, "_zero_result_multi_query_fallback", lambda *a, **k: [_doc(TEMPLATE), _doc(REAL)])

    await _drive_stream(bot, QUESTION, "placeholder-fallback")

    prompt = _prompt_text(captured)
    assert REAL in prompt
    assert "[Big 4 Firm Name]" not in prompt
    assert ("kb_placeholder_chunk_dropped", 1, bot.id) in dropped


@pytest.mark.asyncio
async def test_the_cag_lite_path_never_shows_the_model_a_placeholder_chunk(db, monkeypatch, dropped):
    client = _make_client(db)
    bot = _make_bot(db, client)
    _make_session(db, bot, client, "placeholder-cag")
    for n, content in enumerate((DRAFT, REAL, TEMPLATE)):
        db.add(
            Document(
                client_id=client.id,
                bot_id=bot.id,
                document_name=f"knowledge-hub-{n}.txt",
                file_hash=f"placeholder-cag-{bot.id}-{n}",
                content=content,
                embedding=[0.0] * 768,
            )
        )
    db.commit()
    captured = _stub_pipeline(monkeypatch)
    monkeypatch.setattr(rs, "CAG_LITE_THRESHOLD", 20)
    fetched: list[int | None] = []
    real_fetch = rs.get_all_documents_for_bot

    def fetch_all(session, bot_id=None, client_id=None):
        fetched.append(bot_id)
        return real_fetch(session, bot_id=bot_id, client_id=client_id)

    monkeypatch.setattr(rs, "get_all_documents_for_bot", fetch_all)

    await _drive_stream(bot, QUESTION, "placeholder-cag")

    assert fetched == [bot.id], "the turn must take the CAG-lite path"
    prompt = _prompt_text(captured)
    assert REAL in prompt
    assert "(555) 123-4567" not in prompt
    assert "[Big 4 Firm Name]" not in prompt
    assert ("kb_placeholder_chunk_dropped", 2, bot.id) in dropped


def test_the_non_streaming_path_is_filtered_too(db, monkeypatch, dropped):
    client = _make_client(db)
    bot = _make_bot(db, client)
    _make_session(db, bot, client, "placeholder-sync")
    captured = _stub_pipeline(monkeypatch, retrieved=(_doc(DRAFT), _doc(REAL)))

    rs.rag_pipeline(bot, QUESTION, session_id="placeholder-sync", bot_id=bot.id)

    prompt = _prompt_text(captured)
    assert REAL in prompt
    assert "(555) 123-4567" not in prompt
    assert ("kb_placeholder_chunk_dropped", 1, bot.id) in dropped
