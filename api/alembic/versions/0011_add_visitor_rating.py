"""P3-24: Add visitor_rating column to chat_sessions for post-chat satisfaction survey.

Revision ID: 0011
Revises: 0010
Create Date: 2026-04-02
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0011"
down_revision: str = "0010"
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "chat_sessions",
        sa.Column("visitor_rating", sa.Integer(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("chat_sessions", "visitor_rating")
