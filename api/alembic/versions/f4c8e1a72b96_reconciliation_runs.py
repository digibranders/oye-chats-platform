"""reconciliation_runs — persisted results of the daily gateway reconciliation (Wave 3.5)

The blueprint §7 safety net: every Razorpay captured payment must have a local
invoice (and plan charges a credit grant); every live gateway mandate must
have a live local row, and vice versa. The cron ERROR-logs deltas for Sentry;
this table keeps the structured report so the superadmin surface can show the
latest run without grepping logs. Report data only — prunable.

Revision ID: f4c8e1a72b96
Revises: e2b7c9d45f18
Create Date: 2026-08-06
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

from alembic import op

revision: str = "f4c8e1a72b96"
down_revision: str | Sequence[str] | None = "e2b7c9d45f18"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "reconciliation_runs",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("ran_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("window_from", sa.DateTime(timezone=True), nullable=False),
        sa.Column("window_to", sa.DateTime(timezone=True), nullable=False),
        sa.Column("delta_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("report", JSONB(), nullable=False),
    )
    op.create_index("ix_reconciliation_runs_ran_at", "reconciliation_runs", ["ran_at"])


def downgrade() -> None:
    op.drop_index("ix_reconciliation_runs_ran_at", table_name="reconciliation_runs")
    op.drop_table("reconciliation_runs")
