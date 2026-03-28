"""Raise max_bots default from 1 to 100 and update existing clients

Revision ID: 0005
Revises: 0004
Create Date: 2026-03-28
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0005"
down_revision: str = "0004"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Raise max_bots to 100 for all existing clients and change column default."""
    op.execute("UPDATE clients SET max_bots = 100 WHERE max_bots <= 1")
    op.alter_column(
        "clients",
        "max_bots",
        server_default="100",
        existing_type=sa.Integer(),
        existing_nullable=False,
    )


def downgrade() -> None:
    """Revert max_bots default back to 1."""
    op.alter_column(
        "clients",
        "max_bots",
        server_default="1",
        existing_type=sa.Integer(),
        existing_nullable=False,
    )
    op.execute("UPDATE clients SET max_bots = 1 WHERE max_bots = 100")
