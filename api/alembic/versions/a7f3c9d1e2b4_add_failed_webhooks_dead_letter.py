"""add failed_webhooks dead-letter table

Phase 0 of the payment remediation plan — backs the C1 fix (persist the raw
signed webhook event when processing fails, so it can be replayed after the
provider's retries are exhausted).

Revision ID: a7f3c9d1e2b4
Revises: d52e4e4c6723
Create Date: 2026-06-29 17:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "a7f3c9d1e2b4"
down_revision: str | Sequence[str] | None = "d52e4e4c6723"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        "failed_webhooks",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("provider", sa.Text(), nullable=False),
        sa.Column("event_id", sa.Text(), nullable=True),
        sa.Column("event_type", sa.Text(), nullable=True),
        sa.Column("raw_payload", sa.LargeBinary(), nullable=False),
        sa.Column("signature", sa.Text(), nullable=True),
        sa.Column("headers", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("status", sa.Text(), server_default="pending", nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("replayed_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_failed_webhooks_provider", "failed_webhooks", ["provider"])
    op.create_index("ix_failed_webhooks_event_id", "failed_webhooks", ["event_id"])
    # Fast lookup of dead-letters awaiting replay.
    op.create_index(
        "ix_failed_webhooks_pending",
        "failed_webhooks",
        ["created_at"],
        postgresql_where=sa.text("status = 'pending'"),
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index("ix_failed_webhooks_pending", table_name="failed_webhooks")
    op.drop_index("ix_failed_webhooks_event_id", table_name="failed_webhooks")
    op.drop_index("ix_failed_webhooks_provider", table_name="failed_webhooks")
    op.drop_table("failed_webhooks")
