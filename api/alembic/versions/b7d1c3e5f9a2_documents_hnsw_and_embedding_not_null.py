"""add HNSW + bot_id/client_id indexes on documents and restore embedding NOT NULL (IDX, NB-2)

Two production-readiness fixes for the ``documents`` table:

IDX — restore vector + filter indexes
  Migration ``3424f908d31a`` (the gemini/bge 768-dim switch) dropped the ANN
  index on ``embedding`` and nothing recreated it, so every chat turn
  seq-scanned the tenant's rows computing exact cosine distance, and the
  ``bot_id``/``client_id`` tenant filters were also unindexed. This recreates:
    * an HNSW index on ``embedding`` using ``vector_cosine_ops`` — matches the
      retrieval query's ``<=>`` cosine operator in ``repository.py``
    * b-tree indexes on ``bot_id`` and ``client_id`` for the tenant filter

NB-2 — restore embedding NOT NULL
  ``3424f908d31a`` deferred restoring the NOT NULL constraint on
  ``embedding`` until the re-embed backfill completed; no follow-up did it.
  A NULL-embedding row is non-functional — the vector search filters on
  ``embedding <=> ... < :max_dist`` so NULL rows silently drop out and are
  never retrievable. Before setting NOT NULL we DELETE any remaining
  NULL-embedding rows: they can never be searched, and the recovery path is a
  re-ingest of the source document (the ARQ re-embed task, or re-upload).

Operational note: HNSW index builds can be slow and take a heavy lock on a
large production ``documents`` table. On prod this may warrant running the
``CREATE INDEX`` as ``CONCURRENTLY`` inside a maintenance window (which cannot
run in Alembic's transactional migration). Kept simple/transactional here for
correctness; revisit if the prod table is large.

Revision ID: b7d1c3e5f9a2
Revises: 9c29a23f419a
Create Date: 2026-07-03
"""

from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "b7d1c3e5f9a2"
down_revision: str | Sequence[str] | None = "9c29a23f419a"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    # IDX — HNSW ANN index on the embedding, cosine ops to match the retrieval
    # query's ``<=>`` operator (see repository.py). Stable name so downgrade /
    # ORM metadata can reference it.
    op.execute(
        "CREATE INDEX IF NOT EXISTS documents_embedding_hnsw_idx ON documents USING hnsw (embedding vector_cosine_ops)"
    )

    # IDX — b-tree indexes on the tenant-filter columns.
    op.execute("CREATE INDEX IF NOT EXISTS ix_documents_bot_id ON documents (bot_id)")
    op.execute("CREATE INDEX IF NOT EXISTS ix_documents_client_id ON documents (client_id)")

    # NB-2 — remove non-functional NULL-embedding rows before restoring the
    # NOT NULL constraint. These rows can never be returned by vector search
    # (the query filters on ``embedding <=> ... < :max_dist``); the recovery
    # path is re-ingesting the source document. On the dev DB this is a no-op
    # (0 NULL rows).
    op.execute("DELETE FROM documents WHERE embedding IS NULL")
    op.alter_column("documents", "embedding", nullable=False)


def downgrade() -> None:
    """Downgrade schema.

    Note: the DELETE of NULL-embedding rows in ``upgrade()`` cannot be undone —
    downgrade only restores nullability and drops the indexes.
    """
    op.alter_column("documents", "embedding", nullable=True)

    op.execute("DROP INDEX IF EXISTS ix_documents_client_id")
    op.execute("DROP INDEX IF EXISTS ix_documents_bot_id")
    op.execute("DROP INDEX IF EXISTS documents_embedding_hnsw_idx")
