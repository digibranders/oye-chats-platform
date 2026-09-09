"""Dead letter for emails the platform accepted and could not send.

Every send is fire-and-forget through ARQ. Three paths dropped a message with
no record anywhere: a failed enqueue, a provider rejection (deliberately not
retried, because a retry can deliver an OTP twice), and an exhausted retry
budget. This table keeps the row so a customer asking "I never got the reset
email" can be answered, and so a safe message can be replayed.

Revision ID: b1000011failedemails
Revises: b1000010dropqualflow
"""

from __future__ import annotations

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

from alembic import op

revision: str = "b1000011failedemails"
down_revision: str | None = "b1000010dropqualflow"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # A short lock timeout: this only creates a new table, but a DDL statement
    # that cannot get its lock should fail fast in a deploy rather than queue
    # behind a long transaction and block every writer behind it.
    op.execute("SET LOCAL lock_timeout = '5s'")
    op.create_table(
        "failed_emails",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("to_email", sa.Text(), nullable=False),
        sa.Column("subject", sa.Text(), nullable=False),
        # Nullable on purpose: credential-bearing mail (OTP, password reset,
        # invite) records everything except the body, so a live token is never
        # parked in a table an operator can read.
        sa.Column("body_html", sa.Text(), nullable=True),
        sa.Column("reply_to", sa.Text(), nullable=True),
        sa.Column("sender_name", sa.Text(), nullable=True),
        sa.Column("attachments", JSONB(), nullable=True),
        sa.Column("reason", sa.Text(), nullable=False),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("attempts", sa.Integer(), server_default="1", nullable=False),
        sa.Column("replayable", sa.Boolean(), server_default=sa.text("true"), nullable=False),
        sa.Column("status", sa.Text(), server_default="pending", nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("replayed_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_failed_emails_to_email", "failed_emails", ["to_email"])
    op.create_index("ix_failed_emails_reason", "failed_emails", ["reason"])
    op.create_index("ix_failed_emails_created_at", "failed_emails", ["created_at"])
    # The only query the purge and the operator view actually run: pending rows,
    # oldest first.
    op.create_index("ix_failed_emails_status_created", "failed_emails", ["status", "created_at"])


def downgrade() -> None:
    op.drop_index("ix_failed_emails_status_created", table_name="failed_emails")
    op.drop_index("ix_failed_emails_created_at", table_name="failed_emails")
    op.drop_index("ix_failed_emails_reason", table_name="failed_emails")
    op.drop_index("ix_failed_emails_to_email", table_name="failed_emails")
    op.drop_table("failed_emails")
