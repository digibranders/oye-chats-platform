"""add_calcom_url_to_bots

Cal.com joins Calendly and Zcal as a meeting-booking provider. Follows the
established one-URL-column-per-provider pattern (see 863170bc427c).

Revision ID: 5e5af3f3259d
Revises: a4c1e9f8b2d3
Create Date: 2026-07-02

"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "5e5af3f3259d"
down_revision: str | Sequence[str] | None = "a4c1e9f8b2d3"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column("bots", sa.Column("calcom_url", sa.String(), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column("bots", "calcom_url")
