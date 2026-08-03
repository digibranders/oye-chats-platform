"""subscription dunning emails sent

Adds ``subscriptions.dunning_emails_sent`` — the idempotency log for the
dunning cadence, mirroring the existing ``trial_emails_sent``. Keys are cadence
stages (``failed_0``, ``halted_3``, ``warning_5``, ``suspended``); values are
ISO-8601 send timestamps.

Additive and backfill-free: ``server_default='{}'`` means every existing row
reads as "no dunning email sent yet", which is exactly right — no dunning email
has ever been sent. NOT NULL is safe for the same reason.

A separate column rather than reusing ``trial_emails_sent`` because the two
lifecycles are independent: a customer who recovers, later churns, and returns
must get a fresh dunning sequence without their trial history being cleared.

Revision ID: f0b1b15caf1f
Revises: c5a8d3e0b912
Create Date: 2026-08-03
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "f0b1b15caf1f"
down_revision: str | Sequence[str] | None = "c5a8d3e0b912"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "subscriptions",
        sa.Column(
            "dunning_emails_sent",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default="{}",
            nullable=False,
        ),
    )


def downgrade() -> None:
    op.drop_column("subscriptions", "dunning_emails_sent")
