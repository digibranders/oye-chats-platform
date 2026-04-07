"""add meeting booking support

Revision ID: 0019_meeting_booking
Revises: 0018_custom_frameworks
Create Date: 2026-04-06

"""

import sqlalchemy as sa

from alembic import op

revision = "0019_meeting_booking"
down_revision = "0018_custom_frameworks"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("bots", sa.Column("calendly_url", sa.String(), nullable=True))
    op.add_column(
        "bots",
        sa.Column("meeting_booking_enabled", sa.Boolean(), nullable=False, server_default="false"),
    )

    op.create_table(
        "meeting_bookings",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("session_id", sa.String(), nullable=False),
        sa.Column("bot_id", sa.Integer(), nullable=False),
        sa.Column("booking_url", sa.String(), nullable=True),
        sa.Column("meeting_time", sa.DateTime(timezone=True), nullable=True),
        sa.Column("attendee_email", sa.String(), nullable=True),
        sa.Column("status", sa.String(), nullable=False, server_default="scheduled"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=True),
        sa.ForeignKeyConstraint(["session_id"], ["chat_sessions.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["bot_id"], ["bots.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_meeting_bookings_session_id", "meeting_bookings", ["session_id"], unique=False)


def downgrade() -> None:
    op.drop_index("ix_meeting_bookings_session_id", table_name="meeting_bookings")
    op.drop_table("meeting_bookings")
    op.drop_column("bots", "meeting_booking_enabled")
    op.drop_column("bots", "calendly_url")
