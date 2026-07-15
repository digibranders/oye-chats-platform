"""add seed_questions cache column to bots

Revision ID: c3f8a1d6e5b2
Revises: af89fad8962d
Create Date: 2026-07-15

"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "c3f8a1d6e5b2"
down_revision: str | Sequence[str] | None = "af89fad8962d"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "bots",
        sa.Column("seed_questions", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("bots", "seed_questions")
