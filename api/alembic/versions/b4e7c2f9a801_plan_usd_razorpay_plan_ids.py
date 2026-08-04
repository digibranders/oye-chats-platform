"""plans USD razorpay plan ids

Adds the USD (international) rail's Razorpay plan ids to ``plans``:

  - razorpay_plan_id_monthly_usd  VARCHAR NULL
  - razorpay_plan_id_annual_usd   VARCHAR NULL

A Razorpay plan's currency is fixed at creation and its amount is immutable, so
the USD rail needs its own plan objects — the existing ``razorpay_plan_id_*``
columns hold INR-only ids and cannot serve a USD charge. The USD headline
prices already live on ``monthly_price_usd_cents`` / ``annual_price_usd_cents``;
these columns are what turns those display prices into a chargeable rail.

Nullable by design: NULL means "USD not configured for this tier", which
checkout must treat as a hard error rather than falling back to the INR plan.
Values are per-environment (test vs live Razorpay accounts) and are populated
by ``scripts/set_razorpay_plan_ids.py``, never by a migration.

Revision ID: b4e7c2f9a801
Revises: a1b2c3d4e5f6
Create Date: 2026-08-03
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "b4e7c2f9a801"
down_revision: str | Sequence[str] | None = "a1b2c3d4e5f6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("plans", sa.Column("razorpay_plan_id_monthly_usd", sa.String(), nullable=True))
    op.add_column("plans", sa.Column("razorpay_plan_id_annual_usd", sa.String(), nullable=True))


def downgrade() -> None:
    op.drop_column("plans", "razorpay_plan_id_annual_usd")
    op.drop_column("plans", "razorpay_plan_id_monthly_usd")
