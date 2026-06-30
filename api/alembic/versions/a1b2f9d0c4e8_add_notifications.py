"""Add notifications table for in-app notification center.

Workspace-scoped persistent notifications surfaced in the admin dashboard
bell + dropdown. Three triggers in this first version:

    plan_purchased           — billing webhook activated a paid plan
    bot_created              — workspace member created a bot
    offline_message_received — visitor submitted the offline form
    handoff_request          — visitor pressed "Talk to a human"

Also acts as a multi-head merge for the four open heads:
    a1b2c3d4e5fa  (platform_feedback)
    e7f8a9b0c1d2  (...)
    3424f908d31a  (bge_base_768 embedding switch)
    88155ee7a352  (push subscriptions allow client owner)

Revision ID: a1b2f9d0c4e8
Revises: a1b2c3d4e5fa, e7f8a9b0c1d2, 3424f908d31a, 88155ee7a352
Create Date: 2026-06-29
"""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "a1b2f9d0c4e8"
down_revision = ("a1b2c3d4e5fa", "e7f8a9b0c1d2", "3424f908d31a", "88155ee7a352")
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "notifications",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column(
            "client_id",
            sa.Integer(),
            sa.ForeignKey("clients.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "operator_id",
            sa.Integer(),
            sa.ForeignKey("operators.id", ondelete="CASCADE"),
            nullable=True,
        ),
        sa.Column("type", sa.String(), nullable=False),
        sa.Column("title", sa.String(), nullable=False),
        sa.Column("body", sa.Text(), nullable=True),
        sa.Column("link", sa.String(), nullable=True),
        sa.Column("data", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column(
            "is_read",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
        sa.Column("read_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )
    op.create_index("ix_notifications_client_id", "notifications", ["client_id"])
    op.create_index("ix_notifications_operator_id", "notifications", ["operator_id"])
    op.create_index("ix_notifications_type", "notifications", ["type"])
    op.create_index("ix_notifications_created_at", "notifications", ["created_at"])
    op.create_index(
        "ix_notifications_client_created",
        "notifications",
        ["client_id", "created_at"],
    )
    op.create_index(
        "ix_notifications_client_unread",
        "notifications",
        ["client_id", "is_read"],
    )


def downgrade() -> None:
    op.drop_index("ix_notifications_client_unread", table_name="notifications")
    op.drop_index("ix_notifications_client_created", table_name="notifications")
    op.drop_index("ix_notifications_created_at", table_name="notifications")
    op.drop_index("ix_notifications_type", table_name="notifications")
    op.drop_index("ix_notifications_operator_id", table_name="notifications")
    op.drop_index("ix_notifications_client_id", table_name="notifications")
    op.drop_table("notifications")
