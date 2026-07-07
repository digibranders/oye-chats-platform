"""add recrawl_history JSONB column to bots

Stores the most recent N (currently 20) auto-recrawl runs so the admin
UI can render a per-source expand-history block without a separate audit
table. Each entry is a small dict:

    {"ran_at": "...", "status": "success|partial|failed|empty",
     "total": int, "unchanged": int, "changed": int, "failed": int}

Older-than-20 entries are trimmed at write time in
``recrawl_service._persist_summary`` — the JSONB stays small and the
Bot row doesn't drift into ever-growing storage. Existing bots start
with an empty list (server default ``'[]'::jsonb``); the first sweep
after this migration lands will populate the first entry.

Revision ID: f6c3b1d9a8e4
Revises: e5b8a2c9d7f4
Create Date: 2026-07-07 13:30:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "f6c3b1d9a8e4"
down_revision: str | Sequence[str] | None = "e5b8a2c9d7f4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column(
        "bots",
        sa.Column(
            "recrawl_history",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column("bots", "recrawl_history")
