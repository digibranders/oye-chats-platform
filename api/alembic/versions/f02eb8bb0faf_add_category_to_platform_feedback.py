"""add_category_to_platform_feedback

Revision ID: f02eb8bb0faf
Revises: 8942caefc16b
Create Date: 2026-06-26 18:18:44.079118

"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "f02eb8bb0faf"
down_revision: str | Sequence[str] | None = "8942caefc16b"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column("platform_feedback", sa.Column("category", sa.String(), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column("platform_feedback", "category")
