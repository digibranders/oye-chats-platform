"""a plan row that is assignable but never listed

``plans.is_active`` already carries two meanings: "may be assigned" and "may be
shown". The signup trial needs those pulled apart. It has to satisfy
``get_default_plan``, which filters ``is_active``, while staying out of
``get_active_plans``, the feed behind ``/plans`` and ``GET
/public/pricing-catalog`` that renders oyechats.com/pricing.

``is_public`` is that third flag. It backfills true, so every existing row keeps
listing exactly as it does today, and only rows written as false (the trial)
disappear from the buying surfaces.

Revision ID: l6a7b8c9d0e1
Revises: k5f6a7b8c9d0
Create Date: 2026-08-28
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "l6a7b8c9d0e1"
down_revision: str | Sequence[str] | None = "k5f6a7b8c9d0"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("plans", sa.Column("is_public", sa.Boolean(), nullable=False, server_default="true"))


def downgrade() -> None:
    op.drop_column("plans", "is_public")
