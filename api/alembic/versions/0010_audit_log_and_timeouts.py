"""BUG-11: Add configurable disconnect timeouts to bots.
BUG-12: Add chat_audit_logs table for live chat audit trail.

Revision ID: 0010
Revises: 0009
Create Date: 2026-04-02
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0010"
down_revision: str = "0009"
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None


def upgrade() -> None:
    # BUG-11: Add configurable disconnect timeouts to bots table
    op.add_column("bots", sa.Column("visitor_disconnect_timeout", sa.Integer(), server_default="120", nullable=False))
    op.add_column("bots", sa.Column("operator_disconnect_timeout", sa.Integer(), server_default="60", nullable=False))

    # BUG-12: Create chat_audit_logs table
    op.create_table(
        "chat_audit_logs",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column(
            "session_id",
            sa.String(),
            sa.ForeignKey("chat_sessions.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "operator_id",
            sa.Integer(),
            sa.ForeignKey("operators.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("action", sa.String(), nullable=False),
        sa.Column("metadata", sa.dialects.postgresql.JSONB(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )


def downgrade() -> None:
    op.drop_table("chat_audit_logs")
    op.drop_column("bots", "operator_disconnect_timeout")
    op.drop_column("bots", "visitor_disconnect_timeout")
