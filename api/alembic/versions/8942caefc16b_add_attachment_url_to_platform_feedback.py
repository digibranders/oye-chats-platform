"""add_attachment_url_to_platform_feedback

Revision ID: 8942caefc16b
Revises: cffc647f99b8
Create Date: 2026-06-26 17:11:46.775961

"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "8942caefc16b"
down_revision: str | Sequence[str] | None = "cffc647f99b8"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column("platform_feedback", sa.Column("attachment_url", sa.String(), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column("platform_feedback", "attachment_url")
