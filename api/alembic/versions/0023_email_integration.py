"""Add email integration columns to bots table.

Revision ID: 0023_email_integration
Revises: 0022_add_visitor_resolved
Create Date: 2026-04-07 18:00:00.000000

"""

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

from alembic import op

# revision identifiers, used by Alembic.
revision = "0023_email_integration"
down_revision = "0022_add_visitor_resolved"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Per-event notification recipient routing (JSONB)
    op.add_column("bots", sa.Column("notification_emails", JSONB, nullable=True))

    # Reply-To header for branded emails (Phase 1 sender identity)
    op.add_column("bots", sa.Column("reply_to_email", sa.String(), nullable=True))

    # Toggle: notify team on offline messages
    op.add_column(
        "bots",
        sa.Column(
            "email_on_offline",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("true"),
        ),
    )

    # Toggle: send confirmation email to visitor on offline message submission
    op.add_column(
        "bots",
        sa.Column(
            "email_visitor_confirmation",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("true"),
        ),
    )

    # Data migration: copy existing notification_email into notification_emails.default
    # Only for rows where notification_email is set and notification_emails is still null.
    op.execute(
        """
        UPDATE bots
        SET notification_emails = jsonb_build_object('default', jsonb_build_array(notification_email))
        WHERE notification_email IS NOT NULL
          AND notification_email != ''
          AND notification_emails IS NULL
        """
    )


def downgrade() -> None:
    op.drop_column("bots", "email_visitor_confirmation")
    op.drop_column("bots", "email_on_offline")
    op.drop_column("bots", "reply_to_email")
    op.drop_column("bots", "notification_emails")
