"""Add live_chat_enabled to bots, business_hours to bots

Revision ID: 0006
Revises: 0005
Create Date: 2026-03-28
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0006"
down_revision: str = "0005"
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("bots", sa.Column("live_chat_enabled", sa.Boolean(), server_default="true", nullable=False))
    op.add_column("bots", sa.Column("business_hours", sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column("bots", "business_hours")
    op.drop_column("bots", "live_chat_enabled")
