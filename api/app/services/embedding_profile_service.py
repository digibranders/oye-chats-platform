"""Moving bots between embedding profiles, and remaking single vectors.

A profile (``app/core/embedding_profiles.py``) is how a vector was made. Every
chunk records the profile its vector is on, every bot records the profile its
queries and new chunks use, and vector search only ever compares like with
like. Moving a bot to a newer profile is therefore a three-step affair that
this module owns:

1. re-embed the bot's chunks that are not on the target profile, in batches,
   each committed on its own (active chunks first, so the corpus that answers
   questions moves first);
2. lock the bot row (``FOR NO KEY UPDATE``) and count what is still
   off-profile. Ingestion pins the profile it stores under with ``FOR SHARE``
   on the same row (``pipeline._pin_embedding_profile``), so the lock waits
   for in-flight inserts, and any insert that starts after the flip sees the
   new profile. ``NO KEY`` is deliberate: the plain ``FOR UPDATE`` strength
   also conflicts with the ``KEY SHARE`` lock every ``documents`` insert takes
   through its foreign key, which would stall unrelated writers for the
   window, and a flip only changes a non-key column;
3. flip ``bots.embedding_profile`` if the count is zero, otherwise release the
   lock and go back to step 1 for the chunks that slipped in.

Until the flip the bot keeps searching under its old profile, so its already
re-embedded chunks are invisible to the vector arm (the keyword arm still
finds them) rather than mis-ranked against the rest. That is the price of
never ranking two vector spaces together, and it lasts one migration run.

Everything here is synchronous: the ARQ task runs it in a worker thread, and
the super-admin reindex endpoint runs ``reembed_document`` inline when there
is no worker.
"""

from __future__ import annotations

import logging

from sqlalchemy import select, text

from app.core.embedding_profiles import EMBEDDING_PROFILE_CURRENT, document_task_type, normalize_profile
from app.db.models import Bot
from app.db.session import get_session
from app.ingestion.embedder import embed_chunks

logger = logging.getLogger(__name__)

# Chunks re-embedded per Gemini call, and per commit, inside ``migrate_bot``.
# ``embed_chunks`` sends sub-batches of 100 regardless, so this is the unit of
# durable progress, not of concurrency.
MIGRATION_BATCH = 100
# How many times ``migrate_bot`` re-scans for off-profile chunks before giving
# up on flipping the bot this run. A pass only repeats when an ingest landed a
# chunk on the old profile between the last batch and the lock; a bot being
# crawled continuously might never drain, and that is a retry-later, not a
# reason to spin.
MIGRATION_MAX_PASSES = 5

_OFF_PROFILE_BATCH_SQL = text(
    "SELECT id, content FROM documents "
    "WHERE bot_id = :bot_id AND embedding_profile <> :profile "
    "ORDER BY is_active DESC, id "
    "LIMIT :limit"
)
_OFF_PROFILE_COUNT_SQL = text("SELECT count(*) FROM documents WHERE bot_id = :bot_id AND embedding_profile <> :profile")
_WRITE_VECTOR_SQL = text(
    "UPDATE documents SET embedding = CAST(:emb AS vector), embedding_profile = :profile WHERE id = :id"
)
_DOCUMENT_WITH_PROFILE_SQL = text(
    "SELECT d.content, b.embedding_profile FROM documents d LEFT JOIN bots b ON b.id = d.bot_id WHERE d.id = :id"
)
_BOTS_NEEDING_MIGRATION_SQL = text(
    "SELECT id FROM bots WHERE embedding_profile <> :profile "
    "UNION "
    "SELECT DISTINCT bot_id FROM documents WHERE bot_id IS NOT NULL AND embedding_profile <> :profile "
    "ORDER BY 1"
)


def _vector_literal(vector: list[float]) -> str:
    return "[" + ",".join(str(v) for v in vector) + "]"


def _fetch_off_profile_batch(session, bot_id: int, profile: str, limit: int) -> list[tuple[int, str]]:
    rows = session.execute(_OFF_PROFILE_BATCH_SQL, {"bot_id": bot_id, "profile": profile, "limit": limit}).fetchall()
    return [(int(row[0]), row[1] or "") for row in rows]


def _count_off_profile(session, bot_id: int, profile: str) -> int:
    return int(session.execute(_OFF_PROFILE_COUNT_SQL, {"bot_id": bot_id, "profile": profile}).scalar_one())


def _write_vectors(session, rows: list[tuple[int, str]], embeddings: list[list[float]], profile: str) -> None:
    for (doc_id, _content), embedding in zip(rows, embeddings, strict=True):
        session.execute(_WRITE_VECTOR_SQL, {"emb": _vector_literal(embedding), "profile": profile, "id": doc_id})


def bots_needing_migration() -> list[int]:
    """Ids of every bot not on the current profile, plus any bot that still
    owns a chunk that is not (a bot flipped by hand, or a run that failed
    after its bot had already moved). Ascending, so a run is resumable by eye."""
    with get_session() as session:
        rows = session.execute(_BOTS_NEEDING_MIGRATION_SQL, {"profile": EMBEDDING_PROFILE_CURRENT}).fetchall()
    return [int(row[0]) for row in rows]


def migrate_bot(bot_id: int, *, batch_size: int = MIGRATION_BATCH) -> dict:
    """Move one bot to the current embedding profile (module docstring).

    Returns ``{"bot_id", "status", "reembedded", "remaining"}``. ``status`` is
    ``migrated`` (the bot is on the current profile and so is every chunk),
    ``already_current`` (nothing to do), ``retry`` (``MIGRATION_MAX_PASSES``
    passes were not enough because ingestion kept adding chunks on the old
    profile), ``failed`` (an embed call raised; batches committed before it
    stay stamped, the bot stays on its old profile, and a re-run resumes) or
    ``not_found``. ``remaining`` is the off-profile chunk count at the end.
    """
    target = EMBEDDING_PROFILE_CURRENT
    task_type = document_task_type(target)
    reembedded = 0
    remaining = 0
    with get_session() as session:
        for _pass in range(MIGRATION_MAX_PASSES):
            while True:
                rows = _fetch_off_profile_batch(session, bot_id, target, batch_size)
                if not rows:
                    break
                try:
                    embeddings = embed_chunks([content for _id, content in rows], task_type=task_type)
                except Exception as exc:
                    session.rollback()
                    logger.error(
                        "embedding profile migration: bot %s batch from document %d failed after %d chunk(s) - %s: %s",
                        bot_id,
                        rows[0][0],
                        reembedded,
                        type(exc).__name__,
                        exc,
                    )
                    return {
                        "bot_id": bot_id,
                        "status": "failed",
                        "reembedded": reembedded,
                        "remaining": _count_off_profile(session, bot_id, target),
                        "error": f"{type(exc).__name__}: {exc}",
                    }
                _write_vectors(session, rows, embeddings, target)
                session.commit()
                reembedded += len(rows)
                logger.info("embedding profile migration: bot %s re-embedded %d chunk(s) so far", bot_id, reembedded)

            # Nothing off-profile as of the last scan. Take the bot row so no
            # insert can pin the old profile while the count and the flip run
            # (``key_share=True`` renders ``FOR NO KEY UPDATE``, module docstring).
            bot = session.execute(
                select(Bot).where(Bot.id == bot_id).with_for_update(key_share=True)
            ).scalar_one_or_none()
            if bot is None:
                session.rollback()
                return {"bot_id": bot_id, "status": "not_found", "reembedded": reembedded, "remaining": 0}
            remaining = _count_off_profile(session, bot_id, target)
            if remaining == 0:
                flipped = bot.embedding_profile != target
                bot.embedding_profile = target
                session.commit()
                status = "migrated" if flipped or reembedded else "already_current"
                logger.info(
                    "embedding profile migration: bot %s %s (%d chunk(s) re-embedded)", bot_id, status, reembedded
                )
                return {"bot_id": bot_id, "status": status, "reembedded": reembedded, "remaining": 0}
            # An ingest landed chunks on the old profile between the last batch
            # and the lock. Release the row (embedding under a bot-row lock is
            # what the pipeline itself refuses to do) and take another pass.
            session.rollback()
            logger.info(
                "embedding profile migration: bot %s has %d chunk(s) added since the last scan, pass %d/%d",
                bot_id,
                remaining,
                _pass + 1,
                MIGRATION_MAX_PASSES,
            )
    logger.warning(
        "embedding profile migration: bot %s still has %d chunk(s) off-profile after %d passes. Run again later",
        bot_id,
        remaining,
        MIGRATION_MAX_PASSES,
    )
    return {"bot_id": bot_id, "status": "retry", "reembedded": reembedded, "remaining": remaining}


def reembed_document(document_id: int) -> dict:
    """Recompute one chunk's vector under its bot's profile and stamp it.

    Documents are stored one chunk per row. The super-admin "reindex" action
    lands here (via ``task_reembed_document`` or inline when no worker runs).
    A chunk with no bot (legacy client-scoped rows) is on the legacy profile.
    Raises when embedding fails; callers decide how to report that.
    """
    with get_session() as session:
        row = session.execute(_DOCUMENT_WITH_PROFILE_SQL, {"id": document_id}).fetchone()
    if row is None:
        return {"document_id": document_id, "status": "not_found"}
    content = row[0] or ""
    profile = normalize_profile(row[1])
    embeddings = embed_chunks([content], task_type=document_task_type(profile))
    with get_session() as session:
        session.execute(
            _WRITE_VECTOR_SQL, {"emb": _vector_literal(embeddings[0]), "profile": profile, "id": document_id}
        )
        session.commit()
    return {"document_id": document_id, "status": "complete", "embedding_profile": profile}
