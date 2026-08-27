"""add bots.quotation_catalog

Adds a nullable JSONB column that holds the bot's admin-defined quotation
catalog: an ordered list of billable services, each with its own price per
unit, unit label, optional default quantity, and per-service questions the
bot asks a qualified visitor to build a live quote. NULL disables the
feature entirely for the bot.

Revision ID: h2c3d4e5f6a7
Revises: g1b2c3d4e5f6
Create Date: 2026-08-22
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "h2c3d4e5f6a7"
down_revision: str | Sequence[str] | None = "g1b2c3d4e5f6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "bots",
        sa.Column("quotation_catalog", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("bots", "quotation_catalog")
