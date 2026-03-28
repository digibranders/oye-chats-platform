"""Add user_bubble_color column to bots table

Revision ID: 0003
Revises: f6237d8fa1db
Create Date: 2026-03-27
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0003"
down_revision: str | Sequence[str] | None = "f6237d8fa1db"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "bots",
        sa.Column("user_bubble_color", sa.String(), server_default="#DBE9FF", nullable=True),
    )


def downgrade() -> None:
    op.drop_column("bots", "user_bubble_color")
