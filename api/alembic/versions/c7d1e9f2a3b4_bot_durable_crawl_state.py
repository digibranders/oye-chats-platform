"""bot durable crawl state

Adds durable per-bot ingestion state to ``bots`` so the frontend can read a
persistent "trained" fact instead of racing the ephemeral, client-scoped
``/crawl/progress`` toast (which CrawlContext clears seconds after completion):

  - last_crawl_status   VARCHAR NULL   ('done' | 'failed' | 'cancelled')
  - crawl_completed_at  TIMESTAMPTZ NULL
  - indexed_chunk_count INTEGER NOT NULL DEFAULT 0

Written by ``crawl_orchestrator`` on each terminal crawl state; read via
``BotResponse``.

Revision ID: c7d1e9f2a3b4
Revises: b6c86b4c8434
Create Date: 2026-07-16
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "c7d1e9f2a3b4"
down_revision: str | Sequence[str] | None = "b6c86b4c8434"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("bots", sa.Column("last_crawl_status", sa.String(), nullable=True))
    op.add_column("bots", sa.Column("crawl_completed_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column(
        "bots",
        sa.Column("indexed_chunk_count", sa.Integer(), server_default="0", nullable=False),
    )


def downgrade() -> None:
    op.drop_column("bots", "indexed_chunk_count")
    op.drop_column("bots", "crawl_completed_at")
    op.drop_column("bots", "last_crawl_status")
