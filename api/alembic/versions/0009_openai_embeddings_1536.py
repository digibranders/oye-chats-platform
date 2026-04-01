"""Switch embeddings from FastEmbed 384-dim to OpenAI 1536-dim.

Deletes all existing document rows (embeddings are incompatible across
dimensions). Users must re-upload / re-crawl their knowledge bases after
this migration.

Revision ID: 0009
Revises: 0008
Create Date: 2026-04-01
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0009"
down_revision: str = "0008"
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None


def upgrade() -> None:
    # Wipe all document chunks — old 384-dim embeddings are incompatible
    op.execute("DELETE FROM documents")

    # Change the embedding column from vector(384) to vector(1536)
    op.execute("ALTER TABLE documents ALTER COLUMN embedding TYPE vector(1536)")


def downgrade() -> None:
    # Wipe documents again — 1536-dim embeddings can't fit in 384-dim column
    op.execute("DELETE FROM documents")

    # Revert to 384-dim
    op.execute("ALTER TABLE documents ALTER COLUMN embedding TYPE vector(384)")
