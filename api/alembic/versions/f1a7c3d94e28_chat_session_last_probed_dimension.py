"""add chat_sessions.last_probed_dimension

Tracks the qualification dimension the bot probed on its most recent turn so the
next turn can (1) skip re-asking it and (2) bind a terse visitor reply to the
dimension actually asked. Nullable, no backfill: existing sessions start NULL,
which the selection logic treats as "nothing recently probed".

Revision ID: f1a7c3d94e28
Revises: c9e2a4f7b1d3
Create Date: 2026-08-14
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "f1a7c3d94e28"
down_revision: str | None = "c9e2a4f7b1d3"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "chat_sessions",
        sa.Column("last_probed_dimension", sa.String(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("chat_sessions", "last_probed_dimension")
