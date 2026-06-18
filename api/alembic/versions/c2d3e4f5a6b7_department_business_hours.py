"""Per-department business hours.

Moves the business hours configuration from workspace-wide (``bots.business_hours``)
to per-department (``departments.business_hours``). Different departments often
have genuinely different schedules — Sales 9-6, Support 24/7, Billing 10-4 —
and forcing them into a shared bot-level config didn't reflect that.

* ``departments.business_hours`` — same JSONB shape as bot.business_hours
  (``{"timezone": "Asia/Kolkata", "mon": {"start": "09:00", "end": "17:00"}, ...}``)

Backfill: NOT applied. Workspaces that had bot-level business hours configured
keep them on ``bots.business_hours`` as the workspace-wide fallback. New
configuration happens at the department level; the state resolver checks
department hours first when a session has a ``department_id``, else falls back
to the bot-level hours.

Revision ID: c2d3e4f5a6b7
Revises: b1f2a3c4d5e6
Create Date: 2026-06-18
"""

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

from alembic import op

revision = "c2d3e4f5a6b7"
down_revision = "b1f2a3c4d5e6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "departments",
        sa.Column("business_hours", JSONB(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("departments", "business_hours")
