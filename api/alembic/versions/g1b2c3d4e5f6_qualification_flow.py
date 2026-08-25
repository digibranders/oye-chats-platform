"""add qualification flow columns

Adds ``bots.qualification_flow`` (admin-defined pre-handoff question flow) and
``chat_sessions.flow_state`` (per-session progress: idle | active | complete |
skipped, plus captured answers). Both are nullable JSONB with no backfill: a
NULL ``qualification_flow`` disables the feature for that bot, and a NULL
``flow_state`` starts a session in the implicit ``idle`` state.

Revision ID: g1b2c3d4e5f6
Revises: e8bf7678526d
Create Date: 2026-08-21
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "g1b2c3d4e5f6"
down_revision: str | Sequence[str] | None = "e8bf7678526d"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "bots",
        sa.Column("qualification_flow", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    )
    op.add_column(
        "chat_sessions",
        sa.Column("flow_state", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("chat_sessions", "flow_state")
    op.drop_column("bots", "qualification_flow")
