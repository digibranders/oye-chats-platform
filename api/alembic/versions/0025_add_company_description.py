"""Add company_name and company_description columns to bots table

Revision ID: 0025_add_company_description
Revises: 0024_add_brand_tone
Create Date: 2026-04-09
"""

import sqlalchemy as sa

from alembic import op

revision = "0025_add_company_description"
down_revision = "0024_add_brand_tone"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("bots", sa.Column("company_name", sa.String(), nullable=True))
    op.add_column("bots", sa.Column("company_description", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("bots", "company_description")
    op.drop_column("bots", "company_name")
