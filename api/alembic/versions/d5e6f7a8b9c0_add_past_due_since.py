"""Track when a subscription first entered past_due.

Today the webhook handlers flip status to ``past_due`` but never write down
when that flip happened. The audit gap matters because the auto-downgrade
cron added alongside this migration uses the elapsed time in ``past_due``
to decide when to hard-expire — without a stable anchor the cron would
have nothing better than ``updated_at``, which mutates on every unrelated
row touch (seat changes, plan swaps, etc.).

``past_due_since`` is set the first time a webhook flips an active row to
``past_due``. The cron only ever advances status forward (past_due →
expired), so a second flip-back-to-active after the customer rescues
their card resets this field to NULL.

Revision ID: d5e6f7a8b9c0
Revises: c4d5e6f7a8b9
Create Date: 2026-06-11
"""

import sqlalchemy as sa

from alembic import op

revision = "d5e6f7a8b9c0"
down_revision = "c4d5e6f7a8b9"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "subscriptions",
        sa.Column("past_due_since", sa.DateTime(timezone=True), nullable=True),
    )
    # Partial index — the auto-expire cron scans only ``past_due`` rows and
    # checks ``past_due_since + grace < now()``. A full index would be
    # mostly NULL; a partial index is small and exactly hits the scan.
    op.create_index(
        "ix_subscriptions_past_due_since_active",
        "subscriptions",
        ["past_due_since"],
        unique=False,
        postgresql_where=sa.text("status = 'past_due'"),
    )


def downgrade() -> None:
    op.drop_index(
        "ix_subscriptions_past_due_since_active",
        table_name="subscriptions",
        postgresql_where=sa.text("status = 'past_due'"),
    )
    op.drop_column("subscriptions", "past_due_since")
