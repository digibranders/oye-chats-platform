"""add subscriptions.last_granted_period_end (per-period grant marker)

Phase 2 / remediation H4 — makes the renewal credit grant idempotent per
billing period, replacing the fragile 24h time-window heuristic.

Backfills existing active/trialing/past_due subscriptions with their current
period end so the next ``subscription.charged`` for the SAME (already-granted)
period is treated as a no-op rather than re-granting.

Revision ID: c4d9e2f7a1b8
Revises: b8e4d2f1a6c3
Create Date: 2026-06-30 10:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "c4d9e2f7a1b8"
down_revision: str | Sequence[str] | None = "b8e4d2f1a6c3"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column("subscriptions", sa.Column("last_granted_period_end", sa.DateTime(timezone=True), nullable=True))
    # Backfill: treat the current period of live subscriptions as already
    # granted (it was, at signup / last renewal) so we don't re-grant it.
    op.execute(
        """
        UPDATE subscriptions
        SET last_granted_period_end = current_period_end
        WHERE current_period_end IS NOT NULL
          AND status IN ('active', 'trialing', 'past_due')
        """
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column("subscriptions", "last_granted_period_end")
