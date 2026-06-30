"""add explicit source column to documents (upload vs crawl)

Remediation M7 — replaces the ``document_name LIKE 'http%'`` heuristic for the
documents quota with an explicit ``source`` discriminator. Backfills existing
rows from the same heuristic so the switch is lossless.

Revision ID: f2d4b6a8c0e1
Revises: e1c3a5f7b9d2
Create Date: 2026-06-30 16:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "f2d4b6a8c0e1"
down_revision: str | Sequence[str] | None = "e1c3a5f7b9d2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column(
        "documents",
        sa.Column("source", sa.String(), nullable=False, server_default="upload"),
    )
    # Backfill from the legacy heuristic: a document_name that looks like a URL
    # was a crawled page; everything else was an uploaded file.
    op.execute("UPDATE documents SET source = 'crawl' WHERE document_name LIKE 'http%'")


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column("documents", "source")
