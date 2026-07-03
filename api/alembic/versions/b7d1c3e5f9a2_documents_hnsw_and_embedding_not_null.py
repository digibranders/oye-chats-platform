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
  never retrievable. Rather than silently deleting those (customer-visible)
  document rows, this migration FAILS LOUDLY if any NULL-embedding rows
  remain: the operator must re-embed them (via the ARQ re-embed backfill) or
  explicitly purge them before running the migration. Only when zero NULL
  rows remain does it set the column NOT NULL.

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

import sqlalchemy as sa

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

    # NB-2 — restore the NOT NULL constraint, but refuse to silently destroy
    # data. NULL-embedding rows are non-functional (vector search filters on
    # ``embedding <=> ... < :max_dist`` so they never surface) yet they still
    # back the customer-visible knowledge-base listing. Fail loudly and let the
    # operator decide (re-embed via the ARQ re-embed backfill, or explicitly
    # purge) rather than deleting rows here with no audit trail and no undo.
    conn = op.get_bind()
    null_count = conn.execute(sa.text("SELECT COUNT(*) FROM documents WHERE embedding IS NULL")).scalar()
    if null_count:
        raise RuntimeError(
            f"{null_count} documents have NULL embedding. Re-embed them (ARQ re-embed "
            "backfill) or explicitly purge them before running this migration; refusing "
            "to silently delete customer document rows."
        )
    op.alter_column("documents", "embedding", nullable=False)


def downgrade() -> None:
    """Downgrade schema.

    ``upgrade()`` no longer deletes any rows (it fails loudly on NULL embeddings
    instead), so downgrade cleanly reverses it: restore nullability and drop the
    indexes.
    """
    op.alter_column("documents", "embedding", nullable=True)

    op.execute("DROP INDEX IF EXISTS ix_documents_client_id")
    op.execute("DROP INDEX IF EXISTS ix_documents_bot_id")
    op.execute("DROP INDEX IF EXISTS documents_embedding_hnsw_idx")
