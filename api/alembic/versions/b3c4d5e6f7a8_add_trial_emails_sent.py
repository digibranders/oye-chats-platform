"""Idempotency log for trial lifecycle emails.

PR4 introduces three crons (expiry, reminder cadence, hard-delete). Every
one of them may run dozens of times against the same subscription before
the trial finally ends, and Brevo charges per send — so we need a durable
"already sent" marker that survives worker restarts and double-fires.

A JSONB map on ``subscriptions`` is the right shape: small, indexed only
when needed, queryable for analytics ("how many customers got the day-7
email but didn't convert?"). Keys are lifecycle stage names
(``day_7``, ``day_11``, ``day_13``, ``trial_ended``, ``data_deleted``);
values are ISO-8601 send timestamps so support can prove what was sent
when. Missing key == not yet sent.

Default ``'{}'::jsonb`` keeps the column non-null and lets every
``trial_emails_sent.get("day_7")`` lookup return ``None`` cleanly without
any null-check.

Revision ID: b3c4d5e6f7a8
Revises: a2b3c4d5e6f7
Create Date: 2026-06-11
"""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "b3c4d5e6f7a8"
down_revision = "a2b3c4d5e6f7"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "subscriptions",
        sa.Column(
            "trial_emails_sent",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
    )
    # Tombstone column for the hard-delete cron. Set when the workspace's
    # bots / documents / sessions are purged after the trial retention
    # window lapses. We keep the Client row (email + this timestamp) for
    # support and GDPR-erasure audit; a separate endpoint can fully purge
    # it on explicit user request.
    op.add_column(
        "clients",
        sa.Column("deactivated_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("clients", "deactivated_at")
    op.drop_column("subscriptions", "trial_emails_sent")
