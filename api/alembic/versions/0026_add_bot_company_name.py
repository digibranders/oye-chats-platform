"""Add company_name column to bots table

Revision ID: 0026_add_bot_company_name
Revises: 0025_add_company_description
Create Date: 2026-04-09
"""

import sqlalchemy as sa

from alembic import op

revision = "0026_add_bot_company_name"
down_revision = "0025_add_company_description"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("bots", sa.Column("company_name", sa.String(), nullable=True))


def downgrade() -> None:
    op.drop_column("bots", "company_name")
