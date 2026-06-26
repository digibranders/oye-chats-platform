"""Switch document embeddings from OpenAI 1536-dim to FastEmbed bge-base 768-dim.

Changes:
  * documents.embedding resized from vector(1536) → vector(768)
  * Column is temporarily made nullable so existing rows are not blocked
  * All existing embeddings are set to NULL — the task_reembed_all_documents
    ARQ task must be triggered after this migration to backfill them

After running this migration:
  1. Deploy the updated API (FastEmbed primary, OpenAI fallback)
  2. Trigger re-embedding: enqueue task_reembed_all_documents via the ARQ CLI
     or admin endpoint
  3. Once backfill is confirmed complete, the NOT NULL constraint can be
     restored with a follow-up migration

Revision ID: a1b2c3d4e5f6
Revises: f7e6d5c4b3a2
Create Date: 2026-06-26
"""

from alembic import op

revision = "a1b2c3d4e5f6"
down_revision = "f7e6d5c4b3a2"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Drop any HNSW or IVFFlat index on the embedding column — these are
    # dimension-specific and must be recreated after the column resize.
    op.execute("DROP INDEX IF EXISTS ix_documents_embedding")
    op.execute("DROP INDEX IF EXISTS documents_embedding_hnsw_idx")
    op.execute("DROP INDEX IF EXISTS documents_embedding_ivfflat_idx")

    # Allow NULL so rows aren't blocked during the transition.
    op.alter_column("documents", "embedding", nullable=True)

    # Wipe existing 1536-dim vectors (incompatible with vector(768)) and
    # resize the column type. The ARQ task_reembed_all_documents backfills
    # fresh 768-dim vectors after deploy.
    op.execute("UPDATE documents SET embedding = NULL")
    op.execute("ALTER TABLE documents ALTER COLUMN embedding TYPE vector(768)")


def downgrade() -> None:
    op.execute("UPDATE documents SET embedding = NULL")
    op.execute("ALTER TABLE documents ALTER COLUMN embedding TYPE vector(1536)")
    op.alter_column("documents", "embedding", nullable=False)
