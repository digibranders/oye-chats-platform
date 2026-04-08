"""Add brand_tone column to bots table

Revision ID: 0024_add_brand_tone
Revises: 0023_email_integration
Create Date: 2026-04-08
"""

import sqlalchemy as sa

from alembic import op

revision = "0024_add_brand_tone"
down_revision = "0023_email_integration"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("bots", sa.Column("brand_tone", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("bots", "brand_tone")
