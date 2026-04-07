"""Add visitor_resolved column to chat_sessions.

Revision ID: 0022_add_visitor_resolved
Revises: 0021_add_widget_config_and_branding
Create Date: 2026-04-07 12:00:00.000000

"""

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision = "0022_add_visitor_resolved"
down_revision = "0021_widget_config_branding"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "chat_sessions",
        sa.Column("visitor_resolved", sa.Boolean(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("chat_sessions", "visitor_resolved")
