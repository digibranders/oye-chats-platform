"""add bot message fields: welcome_title, welcome_subtitle, waiting_message, offline_message, handoff_delay_seconds

Revision ID: 0014_add_bot_message_fields
Revises: 0013_add_fk_indexes
Create Date: 2026-04-04

"""

import sqlalchemy as sa

from alembic import op

revision = "0014_add_bot_message_fields"
down_revision = "0013"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "bots",
        sa.Column("welcome_title", sa.String(), nullable=False, server_default="Hi there 👋"),
    )
    op.add_column(
        "bots",
        sa.Column("welcome_subtitle", sa.String(), nullable=False, server_default="How can we help you today?"),
    )
    op.add_column(
        "bots",
        sa.Column("waiting_message", sa.String(), nullable=False, server_default="Connecting you to support..."),
    )
    op.add_column(
        "bots",
        sa.Column("offline_message", sa.String(), nullable=False, server_default="Our team is currently unavailable."),
    )
    op.add_column(
        "bots",
        sa.Column("handoff_delay_seconds", sa.Integer(), nullable=False, server_default="0"),
    )


def downgrade() -> None:
    op.drop_column("bots", "handoff_delay_seconds")
    op.drop_column("bots", "offline_message")
    op.drop_column("bots", "waiting_message")
    op.drop_column("bots", "welcome_subtitle")
    op.drop_column("bots", "welcome_title")
