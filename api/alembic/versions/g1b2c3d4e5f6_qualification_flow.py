"""add qualification flow columns

Adds ``bots.qualification_flow`` (admin-defined pre-handoff question flow) and
``chat_sessions.flow_state`` (per-session progress: idle | active | complete |
skipped, plus captured answers). Both are nullable JSONB with no backfill: a
NULL ``qualification_flow`` disables the feature for that bot, and a NULL
``flow_state`` starts a session in the implicit ``idle`` state.

Revision ID: g1b2c3d4e5f6
Revises: d1b4f7a2c9e6
Create Date: 2026-08-21

Originally branched from e8bf7678526d, in parallel with the multilingual
chain (b7e4a1c9d2f8 -> c8f5b2e0a3d9 -> d1b4f7a2c9e6). Merging the two left
the tree with two heads. Re-parented onto the multilingual head rather than
joined with a merge revision: a merge revision at the head makes
``alembic downgrade -1`` an ambiguous walk, which is exactly what CI's
"migrations apply, match the models, and reverse" step exercises.

Safe to re-parent because this chain is unreleased: no deployed environment
has applied it, while every one of them is already at or past d1b4f7a2c9e6.
The two chains touch disjoint tables, so the order between them is free.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "g1b2c3d4e5f6"
down_revision: str | Sequence[str] | None = "d1b4f7a2c9e6"
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
