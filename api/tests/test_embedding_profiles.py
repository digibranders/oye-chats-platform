"""Embedding profiles: a vector is only ever compared with vectors made the same way.

``app/core/embedding_profiles.py`` names how a vector was made (model,
dimensions, Gemini task types). Every chunk and every bot records its profile,
vector search is scoped to the bot's profile, ingestion pins the profile it
stores under, and ``embedding_profile_service.migrate_bot`` moves a bot to a
newer profile without ever ranking two vector spaces against each other.
These tests pin each of those guarantees, from the request body Gemini sees
to the row lock that orders the flip against a running crawl.
"""

from __future__ import annotations

import asyncio
import inspect
import os
from contextlib import contextmanager
from unittest.mock import MagicMock

import pytest
from sqlalchemy import select, text, update

from app.core.embedding_profiles import (
    EMBEDDING_PROFILE_CURRENT,
    EMBEDDING_PROFILE_LEGACY,
    KNOWN_PROFILES,
    document_task_type,
    normalize_profile,
    query_task_type,
)
from app.db.models import Bot, Client, Document
from app.db.repository import insert_documents, search_similar_documents
from app.db.session import get_session
from app.ingestion import embedder, pipeline
from app.services import embedding_profile_service as svc
from app.services import rag_service as rs
from app.worker import tasks as worker_tasks

needs_db = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")

_DIM = 768
_seq = iter(range(1, 10_000))


def _unit_vector(dominant: int) -> list[float]:
    vec = [0.0] * _DIM
    vec[dominant % _DIM] = 1.0
    return vec


def _ids(rows) -> list[int]:
    return sorted(doc.id for doc, _distance in rows)


def _seed(db, *, profile: str | None = None) -> tuple[Client, Bot]:
    n = next(_seq)
    client = Client(
        name=f"Profiles {n}",
        email=f"profiles{n}@example.com",
        hashed_password="$2b$12$notarealhash",
        api_key=f"profiles-key-{n}",
    )
    db.add(client)
    db.flush()
    bot_kwargs = {} if profile is None else {"embedding_profile": profile}
    bot = Bot(client_id=client.id, name="Profiles bot", bot_key=f"bot-profiles-{n}", **bot_kwargs)
    db.add(bot)
    db.commit()
    return client, bot


def _add_doc(db, client, bot, content: str, *, profile: str, dominant: int, active: bool = True) -> Document:
    doc = Document(
        client_id=client.id,
        bot_id=bot.id if bot is not None else None,
        document_name=f"{content[:12]}.txt",
        source="upload",
        file_hash=f"hash-{next(_seq)}",
        content=content,
        embedding=_unit_vector(dominant),
        embedding_profile=profile,
        is_active=active,
    )
    db.add(doc)
    db.commit()
    return doc


def _profiles_of(db, bot) -> list[str]:
    return (
        db.execute(select(Document.embedding_profile).where(Document.bot_id == bot.id).order_by(Document.id))
        .scalars()
        .all()
    )


# ── The profile registry ─────────────────────────────────────────────────────


class TestProfileHelpers:
    def test_current_and_legacy_are_distinct_known_profiles(self):
        assert EMBEDDING_PROFILE_LEGACY != EMBEDDING_PROFILE_CURRENT
        assert {EMBEDDING_PROFILE_LEGACY, EMBEDDING_PROFILE_CURRENT} <= KNOWN_PROFILES

    def test_unknown_or_missing_profile_is_treated_as_legacy(self):
        """A row stamped by a newer deploy that was rolled back must be embedded
        the one way guaranteed to match un-stamped vectors, never with task
        types this code invented for a profile it does not know."""
        for value in (None, "", "gemini-embedding-9/768/v7", 42, object()):
            assert normalize_profile(value) == EMBEDDING_PROFILE_LEGACY
        assert normalize_profile(EMBEDDING_PROFILE_CURRENT) == EMBEDDING_PROFILE_CURRENT

    def test_task_types_follow_the_profile(self):
        assert document_task_type(EMBEDDING_PROFILE_LEGACY) is None
        assert query_task_type(EMBEDDING_PROFILE_LEGACY) is None
        assert document_task_type(EMBEDDING_PROFILE_CURRENT) == "RETRIEVAL_DOCUMENT"
        assert query_task_type(EMBEDDING_PROFILE_CURRENT) == "RETRIEVAL_QUERY"
        assert document_task_type("something/else/v9") is None
        assert query_task_type("something/else/v9") is None


# ── The embedder forwards the profile's task type ────────────────────────────


class TestEmbedderForwardsTaskType:
    def test_sync_path(self, monkeypatch):
        seen = {}

        def fake(texts, *, task_type=None, progress_cb=None, max_wait_s=None):
            seen.update(texts=list(texts), task_type=task_type, max_wait_s=max_wait_s)
            return [[0.0] * 3 for _ in texts]

        monkeypatch.setattr(embedder, "_google_embed", fake)
        monkeypatch.setattr(embedder, "EMBED_PROVIDER", "google")
        embedder.embed_chunks(["a"], task_type="RETRIEVAL_DOCUMENT", max_wait_s=2.0)
        assert seen == {"texts": ["a"], "task_type": "RETRIEVAL_DOCUMENT", "max_wait_s": 2.0}

    def test_async_path(self, monkeypatch):
        seen = {}

        def fake(texts, *, task_type=None, progress_cb=None, max_wait_s=None):
            seen.update(task_type=task_type)
            return [[0.0] * 3 for _ in texts]

        monkeypatch.setattr(embedder, "_google_embed", fake)
        monkeypatch.setattr(embedder, "EMBED_PROVIDER", "google")
        asyncio.run(embedder.embed_chunks_async(["a"], task_type="RETRIEVAL_QUERY"))
        assert seen == {"task_type": "RETRIEVAL_QUERY"}


# ── The query path embeds and searches under the bot's profile ───────────────


class TestQueryPathFollowsTheBotProfile:
    def test_query_task_type_and_cache_key_follow_the_profile(self, monkeypatch):
        task_types = []
        keys = []
        monkeypatch.setattr(rs, "cache_get", lambda key: None)
        monkeypatch.setattr(rs, "cache_set", lambda key, value, ttl: keys.append(key))

        def fake_embed(texts, **kw):
            task_types.append(kw.get("task_type"))
            return [[0.5] * _DIM]

        monkeypatch.setattr(rs, "embed_chunks", fake_embed)
        rs._embed_query_cached(7, None, "what do you sell?", embedding_profile=EMBEDDING_PROFILE_CURRENT)
        rs._embed_query_cached(7, None, "what do you sell?", embedding_profile=EMBEDDING_PROFILE_LEGACY)
        rs._embed_query_cached(7, None, "what do you sell?")
        assert task_types == ["RETRIEVAL_QUERY", None, None]
        # A vector cached for one profile must never be served for another;
        # no profile means legacy, the same key as legacy.
        assert keys[0] != keys[1]
        assert keys[1] == keys[2]

    def test_async_twin_matches(self, monkeypatch):
        task_types = []
        keys = []
        monkeypatch.setattr(rs, "cache_get", lambda key: None)
        monkeypatch.setattr(rs, "cache_set", lambda key, value, ttl: keys.append(key))

        async def fake_embed(texts, **kw):
            task_types.append(kw.get("task_type"))
            return [[0.5] * _DIM]

        monkeypatch.setattr(rs, "embed_chunks_async", fake_embed)
        asyncio.run(rs._embed_query_cached_async(7, None, "hi", embedding_profile=EMBEDDING_PROFILE_CURRENT))
        asyncio.run(rs._embed_query_cached_async(7, None, "hi", embedding_profile=EMBEDDING_PROFILE_LEGACY))
        assert task_types == ["RETRIEVAL_QUERY", None]
        assert keys == [
            rs._query_embed_cache_key(7, None, "hi", EMBEDDING_PROFILE_CURRENT),
            rs._query_embed_cache_key(7, None, "hi", EMBEDDING_PROFILE_LEGACY),
        ]

    def test_vector_search_scopes_the_repository_query_to_the_profile(self, monkeypatch):
        captured = {}

        def fake_search(session, **kwargs):
            captured.update(kwargs)
            return []

        @contextmanager
        def fake_session():
            yield object()

        monkeypatch.setattr(rs, "search_similar_documents", fake_search)
        monkeypatch.setattr(rs, "get_session", fake_session)
        rs._vector_search(1, 2, [0.0] * _DIM, k=15, embedding_profile=EMBEDDING_PROFILE_CURRENT)
        assert captured["embedding_profile"] == EMBEDDING_PROFILE_CURRENT
        assert captured["bot_id"] == 2 and captured["client_id"] == 1

    def test_zero_result_fallback_keeps_the_profile(self, monkeypatch):
        embeds = []
        searches = []
        monkeypatch.setattr(rs, "_generate_query_paraphrases", lambda q: ["p1"])

        def fake_embed(bid, cid, query, embedding_profile=None):
            embeds.append(embedding_profile)
            return "emb"

        def fake_search(cid, bid, embedding, k, embedding_profile=None):
            searches.append(embedding_profile)
            return []

        monkeypatch.setattr(rs, "_embed_query_cached", fake_embed)
        monkeypatch.setattr(rs, "_vector_search", fake_search)
        rs._zero_result_multi_query_fallback("Q", 1, 2, 5, embedding_profile=EMBEDDING_PROFILE_CURRENT)
        assert embeds == [EMBEDDING_PROFILE_CURRENT]
        assert searches == [EMBEDDING_PROFILE_CURRENT]

    def test_resolve_search_query_passes_the_profile_to_both_embeds(self, monkeypatch):
        seen = []

        async def fake_embed(bid, cid, query, embedding_profile=None):
            seen.append((query, embedding_profile))
            return [0.1] * _DIM

        monkeypatch.setattr(rs, "rewrite_query", lambda sid, q, h: "rewritten question")
        monkeypatch.setattr(rs, "_embed_query_cached_async", fake_embed)
        query, _embedding = asyncio.run(
            rs._resolve_search_query_and_embedding(
                "s1", "raw question", [], 1, None, None, embedding_profile=EMBEDDING_PROFILE_CURRENT
            )
        )
        assert query == "rewritten question"
        assert sorted(seen) == [
            ("raw question", EMBEDDING_PROFILE_CURRENT),
            ("rewritten question", EMBEDDING_PROFILE_CURRENT),
        ]

    def test_both_pipelines_resolve_the_profile_from_the_bot_and_thread_it(self):
        """The two pipelines mirror each other by hand. Each must derive the
        profile from the bot once and hand it to every retrieval step it
        runs; a call site that forgets it silently searches the legacy space."""
        for pipeline_fn, expected_uses in ((rs.rag_pipeline, 3), (rs.rag_pipeline_stream, 3)):
            source = inspect.getsource(pipeline_fn)
            assert source.count("_embedding_profile = (") == 1, pipeline_fn.__name__
            assert source.count("embedding_profile=_embedding_profile") == expected_uses, pipeline_fn.__name__


# ── The worker task ──────────────────────────────────────────────────────────


class TestMigrationTask:
    def test_runs_every_bot_that_needs_it_and_isolates_failures(self, monkeypatch):
        monkeypatch.setattr(svc, "bots_needing_migration", lambda: [1, 2, 3])

        def fake_migrate(bot_id, *, batch_size):
            if bot_id == 2:
                raise RuntimeError("gemini down")
            return {"bot_id": bot_id, "status": "migrated", "reembedded": 5, "remaining": 0}

        monkeypatch.setattr(svc, "migrate_bot", fake_migrate)
        result = asyncio.run(worker_tasks.task_migrate_embedding_profile({}))
        assert (result["bots"], result["migrated"], result["failed"], result["reembedded"]) == (3, 2, 1, 10)
        assert [r["status"] for r in result["results"]] == ["migrated", "failed", "migrated"]
        assert "gemini down" in result["results"][1]["error"]

    def test_a_named_bot_skips_discovery_and_keeps_the_batch_size(self, monkeypatch):
        monkeypatch.setattr(svc, "bots_needing_migration", lambda: pytest.fail("must not scan when a bot is named"))
        seen = {}

        def fake_migrate(bot_id, *, batch_size):
            seen.update(bot_id=bot_id, batch_size=batch_size)
            return {"bot_id": bot_id, "status": "already_current", "reembedded": 0, "remaining": 0}

        monkeypatch.setattr(svc, "migrate_bot", fake_migrate)
        result = asyncio.run(worker_tasks.task_migrate_embedding_profile({}, bot_id=9, batch_size=25))
        assert seen == {"bot_id": 9, "batch_size": 25}
        assert result["already_current"] == 1 and result["failed"] == 0

    def test_reembed_document_reports_an_embedding_failure_instead_of_raising(self, monkeypatch):
        def boom(document_id):
            raise RuntimeError("quota")

        monkeypatch.setattr(svc, "reembed_document", boom)
        result = asyncio.run(worker_tasks.task_reembed_document({}, 5))
        assert result == {"document_id": 5, "status": "failed", "error": "quota"}


# ── Ingestion pins the profile (unit) ────────────────────────────────────────


class TestProfilePinning:
    def test_gives_up_after_the_profile_keeps_changing(self):
        session = MagicMock()
        session.execute.return_value.scalar_one_or_none.side_effect = [
            EMBEDDING_PROFILE_CURRENT,
            EMBEDDING_PROFILE_LEGACY,
            EMBEDDING_PROFILE_CURRENT,
        ]
        reembeds = []
        with pytest.raises(RuntimeError, match="changed"):
            pipeline._pin_embedding_profile(session, 1, EMBEDDING_PROFILE_LEGACY, reembeds.append)
        # Each mismatch released the lock before re-embedding.
        assert session.rollback.call_count == pipeline._PROFILE_PIN_ATTEMPTS
        assert reembeds == [EMBEDDING_PROFILE_CURRENT, EMBEDDING_PROFILE_LEGACY, EMBEDDING_PROFILE_CURRENT]

    def test_matching_profile_takes_the_lock_once_and_never_re_embeds(self):
        session = MagicMock()
        session.execute.return_value.scalar_one_or_none.return_value = EMBEDDING_PROFILE_CURRENT
        result = pipeline._pin_embedding_profile(
            session, 1, EMBEDDING_PROFILE_CURRENT, lambda p: pytest.fail("no re-embed")
        )
        assert result == EMBEDDING_PROFILE_CURRENT
        assert session.execute.call_count == 1
        session.rollback.assert_not_called()

    def test_bot_less_ingestion_is_legacy_without_touching_the_db(self):
        session = MagicMock()
        assert pipeline._bot_embedding_profile(session, None, lock=True) == EMBEDDING_PROFILE_LEGACY
        session.execute.assert_not_called()


# ── Schema defaults ──────────────────────────────────────────────────────────


@needs_db
class TestSchemaDefaults:
    def test_new_rows_start_on_the_current_profile(self, db):
        client, bot = _seed(db)
        doc = Document(
            client_id=client.id,
            bot_id=bot.id,
            document_name="new.txt",
            file_hash=f"hash-{next(_seq)}",
            content="fresh chunk",
            embedding=_unit_vector(1),
        )
        db.add(doc)
        db.commit()
        db.expire_all()
        assert db.get(Bot, bot.id).embedding_profile == EMBEDDING_PROFILE_CURRENT
        assert db.get(Document, doc.id).embedding_profile == EMBEDDING_PROFILE_CURRENT

    def test_rows_that_predate_the_column_are_legacy(self, db):
        """The server default is what the migration backfilled existing rows
        with: a row written without the column is on the profile its vector
        was actually made under."""
        client, bot = _seed(db)
        db.execute(
            text(
                "INSERT INTO documents (client_id, bot_id, document_name, file_hash, content, embedding) "
                "VALUES (:client_id, :bot_id, 'old.txt', :file_hash, 'old chunk', CAST(:emb AS vector))"
            ),
            {
                "client_id": client.id,
                "bot_id": bot.id,
                "file_hash": f"hash-{next(_seq)}",
                "emb": "[" + ",".join(str(v) for v in _unit_vector(1)) + "]",
            },
        )
        db.commit()
        assert _profiles_of(db, bot) == [EMBEDDING_PROFILE_LEGACY]


# ── Vector search is profile-scoped ──────────────────────────────────────────


@needs_db
class TestVectorSearchIsProfileScoped:
    def test_only_chunks_on_the_requested_profile_are_candidates(self, db):
        client, bot = _seed(db)
        # Identical vectors on two profiles: only the filter can tell them apart.
        legacy = _add_doc(db, client, bot, "legacy chunk", profile=EMBEDDING_PROFILE_LEGACY, dominant=1)
        current = _add_doc(db, client, bot, "current chunk", profile=EMBEDDING_PROFILE_CURRENT, dominant=1)
        query = _unit_vector(1)

        both = search_similar_documents(db, bot_id=bot.id, client_id=client.id, query_embedding=query)
        assert _ids(both) == sorted([legacy.id, current.id])
        for kwargs in (
            {"bot_id": bot.id, "client_id": client.id},
            {"bot_id": bot.id},
            {"client_id": client.id},
        ):
            on_current = search_similar_documents(
                db, query_embedding=query, embedding_profile=EMBEDDING_PROFILE_CURRENT, **kwargs
            )
            on_legacy = search_similar_documents(
                db, query_embedding=query, embedding_profile=EMBEDDING_PROFILE_LEGACY, **kwargs
            )
            assert _ids(on_current) == [current.id], kwargs
            assert _ids(on_legacy) == [legacy.id], kwargs


# ── insert_documents stamps the profile ──────────────────────────────────────


@needs_db
class TestInsertDocumentsStampsTheProfile:
    def test_profile_is_required(self, db):
        client, bot = _seed(db)
        with pytest.raises(ValueError, match="embedding_profile"):
            insert_documents(db, client.id, "a.txt", "h1", ["chunk"], [_unit_vector(1)], [{}], bot_id=bot.id)

    def test_rows_carry_the_given_profile(self, db):
        client, bot = _seed(db)
        insert_documents(
            db,
            client.id,
            "a.txt",
            "h1",
            ["chunk one", "chunk two"],
            [_unit_vector(1), _unit_vector(2)],
            [{}, {}],
            bot_id=bot.id,
            embedding_profile=EMBEDDING_PROFILE_LEGACY,
        )
        db.commit()
        assert _profiles_of(db, bot) == [EMBEDDING_PROFILE_LEGACY, EMBEDDING_PROFILE_LEGACY]


# ── Migrating a bot ──────────────────────────────────────────────────────────


@needs_db
class TestMigrateBot:
    @staticmethod
    def _recording_embed(seen, dominant=9):
        def fake_embed(texts, *, task_type=None, **kw):
            seen.append((tuple(texts), task_type))
            return [_unit_vector(dominant) for _ in texts]

        return fake_embed

    def test_reembeds_every_chunk_active_first_then_flips_the_bot(self, db, monkeypatch):
        client, bot = _seed(db, profile=EMBEDDING_PROFILE_LEGACY)
        _add_doc(db, client, bot, "chunk one", profile=EMBEDDING_PROFILE_LEGACY, dominant=1)
        _add_doc(db, client, bot, "chunk two", profile=EMBEDDING_PROFILE_LEGACY, dominant=2, active=False)
        _add_doc(db, client, bot, "chunk three", profile=EMBEDDING_PROFILE_LEGACY, dominant=3)
        seen = []
        monkeypatch.setattr(svc, "embed_chunks", self._recording_embed(seen))

        result = svc.migrate_bot(bot.id, batch_size=2)

        assert result == {"bot_id": bot.id, "status": "migrated", "reembedded": 3, "remaining": 0}
        # Two batches; the live chunks go first so search improves as it runs;
        # every chunk is embedded as a stored document.
        assert [texts for texts, _ in seen] == [("chunk one", "chunk three"), ("chunk two",)]
        assert {task for _, task in seen} == {"RETRIEVAL_DOCUMENT"}
        db.expire_all()
        assert db.get(Bot, bot.id).embedding_profile == EMBEDDING_PROFILE_CURRENT
        assert _profiles_of(db, bot) == [EMBEDDING_PROFILE_CURRENT] * 3
        # The vectors themselves were rewritten: the new ones are found on the
        # current profile (the inactive chunk stays out, as always).
        hits = search_similar_documents(
            db,
            bot_id=bot.id,
            client_id=client.id,
            query_embedding=_unit_vector(9),
            embedding_profile=EMBEDDING_PROFILE_CURRENT,
        )
        assert [doc.content for doc, _ in sorted(hits, key=lambda pair: pair[0].id)] == ["chunk one", "chunk three"]

    def test_an_embedding_failure_keeps_the_bot_on_its_old_profile_and_is_resumable(self, db, monkeypatch):
        client, bot = _seed(db, profile=EMBEDDING_PROFILE_LEGACY)
        for i in (1, 2, 3):
            _add_doc(db, client, bot, f"chunk {i}", profile=EMBEDDING_PROFILE_LEGACY, dominant=i)
        calls = []

        def flaky_embed(texts, *, task_type=None, **kw):
            calls.append(len(texts))
            if len(calls) == 2:
                raise RuntimeError("Gemini embedding failed after 6 attempts")
            return [_unit_vector(9) for _ in texts]

        monkeypatch.setattr(svc, "embed_chunks", flaky_embed)
        result = svc.migrate_bot(bot.id, batch_size=2)
        assert result["status"] == "failed"
        assert (result["reembedded"], result["remaining"]) == (2, 1)
        assert "Gemini embedding failed" in result["error"]
        db.expire_all()
        # Searching stays on the old profile until every chunk is over.
        assert db.get(Bot, bot.id).embedding_profile == EMBEDDING_PROFILE_LEGACY
        assert sorted(_profiles_of(db, bot)) == sorted(
            [EMBEDDING_PROFILE_CURRENT, EMBEDDING_PROFILE_CURRENT, EMBEDDING_PROFILE_LEGACY]
        )

        # A re-run picks up the one chunk that was left.
        seen = []
        monkeypatch.setattr(svc, "embed_chunks", self._recording_embed(seen))
        result = svc.migrate_bot(bot.id, batch_size=2)
        assert result == {"bot_id": bot.id, "status": "migrated", "reembedded": 1, "remaining": 0}
        assert [texts for texts, _ in seen] == [("chunk 3",)]
        db.expire_all()
        assert db.get(Bot, bot.id).embedding_profile == EMBEDDING_PROFILE_CURRENT

    def test_a_chunk_that_lands_between_the_last_batch_and_the_lock_is_migrated_too(self, db, monkeypatch):
        """The window the row lock exists for: an ingest committed a chunk on
        the old profile after the last scan found nothing. The count under
        the bot-row lock sees it, the lock is released, and the next pass
        re-embeds it before the flip. The late insert is an ordinary ORM
        insert while the lock is held, which also pins the lock strength:
        ``FOR NO KEY UPDATE`` lets the insert's foreign-key ``KEY SHARE``
        through, where the plain ``FOR UPDATE`` strength would have made it
        wait on the migration."""
        client, bot = _seed(db, profile=EMBEDDING_PROFILE_LEGACY)
        _add_doc(db, client, bot, "first chunk", profile=EMBEDDING_PROFILE_LEGACY, dominant=1)
        seen = []
        monkeypatch.setattr(svc, "embed_chunks", self._recording_embed(seen))
        real_count = svc._count_off_profile
        injected = []

        def count_after_a_late_insert(session, bot_id, profile):
            if not injected:
                with get_session() as other:
                    other.add(
                        Document(
                            client_id=client.id,
                            bot_id=bot.id,
                            document_name="late.txt",
                            file_hash=f"hash-{next(_seq)}",
                            content="late chunk",
                            embedding=_unit_vector(2),
                            embedding_profile=EMBEDDING_PROFILE_LEGACY,
                        )
                    )
                    other.commit()
                injected.append(True)
            return real_count(session, bot_id, profile)

        monkeypatch.setattr(svc, "_count_off_profile", count_after_a_late_insert)
        result = svc.migrate_bot(bot.id, batch_size=10)
        assert result == {"bot_id": bot.id, "status": "migrated", "reembedded": 2, "remaining": 0}
        assert [texts for texts, _ in seen] == [("first chunk",), ("late chunk",)]
        db.expire_all()
        assert db.get(Bot, bot.id).embedding_profile == EMBEDDING_PROFILE_CURRENT
        assert _profiles_of(db, bot) == [EMBEDDING_PROFILE_CURRENT] * 2

    def test_gives_up_with_retry_when_ingestion_keeps_winning(self, db, monkeypatch):
        client, bot = _seed(db, profile=EMBEDDING_PROFILE_LEGACY)
        _add_doc(db, client, bot, "chunk", profile=EMBEDDING_PROFILE_LEGACY, dominant=1)
        monkeypatch.setattr(svc, "embed_chunks", self._recording_embed([]))
        monkeypatch.setattr(svc, "_count_off_profile", lambda session, bot_id, profile: 1)
        monkeypatch.setattr(svc, "MIGRATION_MAX_PASSES", 2)
        result = svc.migrate_bot(bot.id)
        assert result == {"bot_id": bot.id, "status": "retry", "reembedded": 1, "remaining": 1}
        db.expire_all()
        assert db.get(Bot, bot.id).embedding_profile == EMBEDDING_PROFILE_LEGACY

    def test_a_bot_already_on_the_current_profile_is_a_no_op(self, db, monkeypatch):
        client, bot = _seed(db)
        _add_doc(db, client, bot, "chunk", profile=EMBEDDING_PROFILE_CURRENT, dominant=1)
        monkeypatch.setattr(svc, "embed_chunks", lambda *a, **k: pytest.fail("nothing to embed"))
        assert svc.migrate_bot(bot.id) == {
            "bot_id": bot.id,
            "status": "already_current",
            "reembedded": 0,
            "remaining": 0,
        }

    def test_unknown_bot(self, db, monkeypatch):
        monkeypatch.setattr(svc, "embed_chunks", lambda *a, **k: pytest.fail("nothing to embed"))
        assert svc.migrate_bot(999_999)["status"] == "not_found"

    def test_bots_needing_migration_lists_legacy_bots_and_bots_holding_legacy_chunks(self, db):
        _client_a, bot_a = _seed(db, profile=EMBEDDING_PROFILE_LEGACY)
        client_b, bot_b = _seed(db)
        _add_doc(db, client_b, bot_b, "left behind", profile=EMBEDDING_PROFILE_LEGACY, dominant=1)
        client_c, bot_c = _seed(db)
        _add_doc(db, client_c, bot_c, "fine", profile=EMBEDDING_PROFILE_CURRENT, dominant=1)
        assert svc.bots_needing_migration() == sorted([bot_a.id, bot_b.id])


# ── Re-embedding one chunk ───────────────────────────────────────────────────


@needs_db
class TestReembedDocument:
    def test_uses_the_owning_bots_profile_and_stamps_the_row(self, db, monkeypatch):
        client, bot = _seed(db)
        doc = _add_doc(db, client, bot, "stale chunk", profile=EMBEDDING_PROFILE_LEGACY, dominant=1)
        seen = {}

        def fake_embed(texts, *, task_type=None, **kw):
            seen.update(texts=list(texts), task_type=task_type)
            return [_unit_vector(5) for _ in texts]

        monkeypatch.setattr(svc, "embed_chunks", fake_embed)
        result = svc.reembed_document(doc.id)
        assert result == {"document_id": doc.id, "status": "complete", "embedding_profile": EMBEDDING_PROFILE_CURRENT}
        assert seen == {"texts": ["stale chunk"], "task_type": "RETRIEVAL_DOCUMENT"}
        db.expire_all()
        assert db.get(Document, doc.id).embedding_profile == EMBEDDING_PROFILE_CURRENT
        hits = search_similar_documents(
            db, bot_id=bot.id, query_embedding=_unit_vector(5), embedding_profile=EMBEDDING_PROFILE_CURRENT
        )
        assert _ids(hits) == [doc.id]

    def test_a_chunk_with_no_bot_stays_legacy(self, db, monkeypatch):
        client, _bot = _seed(db)
        doc = _add_doc(db, client, None, "client-scoped chunk", profile=EMBEDDING_PROFILE_LEGACY, dominant=1)
        seen = {}

        def fake_embed(texts, *, task_type=None, **kw):
            seen.update(task_type=task_type)
            return [_unit_vector(5) for _ in texts]

        monkeypatch.setattr(svc, "embed_chunks", fake_embed)
        result = svc.reembed_document(doc.id)
        assert result["embedding_profile"] == EMBEDDING_PROFILE_LEGACY
        assert seen == {"task_type": None}

    def test_missing_document(self, db, monkeypatch):
        monkeypatch.setattr(svc, "embed_chunks", lambda *a, **k: pytest.fail("nothing to embed"))
        assert svc.reembed_document(999_999) == {"document_id": 999_999, "status": "not_found"}


# ── Ingestion embeds and stamps under the bot's profile ──────────────────────

_UPLOAD_TEXT = (
    "Acme sells industrial water pumps for farms and factories. Every pump ships with a two-year "
    "warranty and installation support from our engineers. Spare parts are stocked in three regional "
    "warehouses so a replacement impeller reaches any customer within two working days."
)


@needs_db
class TestIngestionPinsTheProfile:
    @staticmethod
    def _recording_embed(seen, on_first_call=None):
        def fake_embed(chunk_content_list, *, task_type=None, progress_cb=None, max_wait_s=None):
            seen.append(task_type)
            if len(seen) == 1 and on_first_call is not None:
                on_first_call()
            return [_unit_vector(2) for _ in chunk_content_list]

        return fake_embed

    @staticmethod
    def _flip_to_current(bot_id: int):
        def flip():
            # A separate, committed session: how the migration task's flip
            # reaches a crawl that is already embedding.
            with get_session() as other:
                other.execute(update(Bot).where(Bot.id == bot_id).values(embedding_profile=EMBEDDING_PROFILE_CURRENT))
                other.commit()

        return flip

    def test_upload_embeds_and_stamps_under_the_bots_profile(self, db, monkeypatch):
        client, bot = _seed(db)
        seen = []
        monkeypatch.setattr(pipeline, "embed_chunks", self._recording_embed(seen))
        chunks = pipeline._ingest_document(
            client.id, "guide.txt", _UPLOAD_TEXT, [{"text": _UPLOAD_TEXT, "metadata": {"page": 1}}], bot_id=bot.id
        )
        assert chunks >= 1
        assert seen == ["RETRIEVAL_DOCUMENT"]
        assert set(_profiles_of(db, bot)) == {EMBEDDING_PROFILE_CURRENT}

    def test_upload_re_embeds_when_the_bot_moved_while_it_was_embedding(self, db, monkeypatch):
        client, bot = _seed(db, profile=EMBEDDING_PROFILE_LEGACY)
        seen = []
        monkeypatch.setattr(pipeline, "embed_chunks", self._recording_embed(seen, self._flip_to_current(bot.id)))
        pipeline._ingest_document(
            client.id, "guide.txt", _UPLOAD_TEXT, [{"text": _UPLOAD_TEXT, "metadata": {"page": 1}}], bot_id=bot.id
        )
        # Embedded once the old way, then again the new way after the pinned
        # read saw the flip; the rows carry the profile they were made under.
        assert seen == [None, "RETRIEVAL_DOCUMENT"]
        assert set(_profiles_of(db, bot)) == {EMBEDDING_PROFILE_CURRENT}

    def test_crawl_re_embeds_the_remaining_pages_once_not_per_page(self, db, monkeypatch):
        client, bot = _seed(db, profile=EMBEDDING_PROFILE_LEGACY)
        seen = []
        monkeypatch.setattr(pipeline, "embed_chunks", self._recording_embed(seen, self._flip_to_current(bot.id)))
        pages = [
            {"url": f"https://acme.test/page-{i}", "content": f"# Page {i}\n{_UPLOAD_TEXT} Page {i} specifics."}
            for i in (1, 2, 3)
        ]
        result = pipeline.batch_web_ingestion(client.id, pages, bot_id=bot.id)
        assert result["pages_changed"] == 3 and result["pages_failed"] == 0
        # One batch embed (old profile), one re-embed of everything not yet
        # stored (new profile) at the first page's pin. Pages 2 and 3 found
        # their vectors already right.
        assert seen == [None, "RETRIEVAL_DOCUMENT"]
        assert set(_profiles_of(db, bot)) == {EMBEDDING_PROFILE_CURRENT}
