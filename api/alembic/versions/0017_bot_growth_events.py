"""add bot growth events table

Revision ID: 0017_bot_growth_events
Revises: 0016_behavioral_scoring
Create Date: 2026-04-06

"""

import sqlalchemy as sa

from alembic import op

revision = "0017_bot_growth_events"
down_revision = "0016_behavioral_scoring"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "bot_growth_events",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("bot_id", sa.Integer(), nullable=False),
        sa.Column("event_type", sa.String(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=True),
        sa.CheckConstraint(
            "event_type IN ('demo_share_clicked', 'demo_link_opened')",
            name="ck_bot_growth_events_event_type",
        ),
        sa.ForeignKeyConstraint(["bot_id"], ["bots.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_bot_growth_events_bot_id", "bot_growth_events", ["bot_id"], unique=False)


def downgrade() -> None:
    op.drop_index("ix_bot_growth_events_bot_id", table_name="bot_growth_events")
    op.drop_table("bot_growth_events")
