"""Add services list and services_url to bots for service-scoped answers.

When ``services`` is non-empty the bot constrains its answers to those
service names; ``services_url`` is appended as a CTA under each on-scope
answer (auto-suggested from the URL crawl when not set explicitly).

Revision ID: a1b2c3d4e5f7
Revises: f9a0b1c2d3e4
Create Date: 2026-05-04
"""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "a1b2c3d4e5f7"
down_revision = "f9a0b1c2d3e4"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("bots", sa.Column("services", postgresql.JSONB(), nullable=True))
    op.add_column("bots", sa.Column("services_url", sa.String(), nullable=True))


def downgrade() -> None:
    op.drop_column("bots", "services_url")
    op.drop_column("bots", "services")
