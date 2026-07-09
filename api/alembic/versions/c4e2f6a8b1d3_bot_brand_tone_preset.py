"""add brand_tone_preset to bots (tone preset chip)

Records which brand-tone preset chip is active (a preset key, "custom", or NULL)
so the AI & Personality tab can highlight it. Metadata only — never fed to the
prompt. See app/services/brand_tone.py and the 2026-07-09 brand-tone spec.

Revision ID: c4e2f6a8b1d3
Revises: b3d1c5e7a9f2
Create Date: 2026-07-09 14:10:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "c4e2f6a8b1d3"
down_revision: str | Sequence[str] | None = "b3d1c5e7a9f2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column("bots", sa.Column("brand_tone_preset", sa.String(), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column("bots", "brand_tone_preset")
