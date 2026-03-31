"""Add company_name to clients

Revision ID: 0007
Revises: 0006
Create Date: 2026-03-31
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0007"
down_revision: str = "0006"
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("clients", sa.Column("company_name", sa.String(), nullable=True))


def downgrade() -> None:
    op.drop_column("clients", "company_name")
