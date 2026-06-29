"""Add platform_feedback table for admin dashboard user feedback.

Revision ID: a1b2c3d4e5fa
Revises: f9a0b1c2d3e4
Create Date: 2026-06-26
"""

import sqlalchemy as sa

from alembic import op

revision = "a1b2c3d4e5fa"
down_revision = "f9a0b1c2d3e4"
branch_labels = None
depends_on = None


def upgrade():
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    if "platform_feedback" not in inspector.get_table_names():
        op.create_table(
            "platform_feedback",
            sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
            sa.Column("client_id", sa.Integer(), nullable=True),
            sa.Column("message", sa.Text(), nullable=False),
            sa.Column(
                "created_at",
                sa.DateTime(timezone=True),
                server_default=sa.func.now(),
                nullable=False,
            ),
            sa.ForeignKeyConstraint(["client_id"], ["clients.id"], ondelete="SET NULL"),
            sa.PrimaryKeyConstraint("id"),
        )
        op.create_index("ix_platform_feedback_client_id", "platform_feedback", ["client_id"])
        op.create_index("ix_platform_feedback_created_at", "platform_feedback", ["created_at"])


def downgrade():
    op.drop_index("ix_platform_feedback_created_at", table_name="platform_feedback")
    op.drop_index("ix_platform_feedback_client_id", table_name="platform_feedback")
    op.drop_table("platform_feedback")
