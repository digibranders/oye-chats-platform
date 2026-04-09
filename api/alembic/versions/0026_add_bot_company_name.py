"""Add company_name column to bots table

Revision ID: 0026_add_bot_company_name
Revises: 0025_add_company_description
Create Date: 2026-04-09
"""

from alembic import op

revision = "0026_add_bot_company_name"
down_revision = "0025_add_company_description"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Use raw DDL so the migration is idempotent — safe to run even if the
    # column already exists in production (e.g. added manually or by a prior run).
    op.execute("ALTER TABLE bots ADD COLUMN IF NOT EXISTS company_name VARCHAR")


def downgrade() -> None:
    op.drop_column("bots", "company_name")
