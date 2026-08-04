"""discounted_plan_cache currency

Adds ``currency`` to ``discounted_plan_cache`` and widens the dedup key to
include it.

The cache maps (base plan, cycle, discount) → one Razorpay plan. With the USD
rail live that key is ambiguous: a Razorpay plan's currency is fixed at
creation, so the INR and USD discounted plans for the same base/cycle/discount
are *different* plan objects. Sharing one cache row would hand an international
customer the rupee plan (or vice versa) — a referral customer silently charged
in the wrong currency.

Existing rows are all INR (the only rail that existed), so backfilling the
column to 'INR' before adding the NOT NULL is exact, not a guess.

Revision ID: c5a8d3e0b912
Revises: b4e7c2f9a801
Create Date: 2026-08-03
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "c5a8d3e0b912"
down_revision: str | Sequence[str] | None = "b4e7c2f9a801"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "discounted_plan_cache",
        sa.Column("currency", sa.String(length=3), nullable=False, server_default="INR"),
    )
    # Widen the dedup key so the two rails cache independently.
    op.drop_constraint("uq_discounted_plan", "discounted_plan_cache", type_="unique")
    op.create_unique_constraint(
        "uq_discounted_plan",
        "discounted_plan_cache",
        ["base_plan_id", "billing_cycle", "discount_bps", "currency"],
    )


def downgrade() -> None:
    # Narrowing the key can collide if both rails cached the same base/cycle/
    # discount, so drop the USD rows first — they are a rebuildable cache, and
    # the INR rows are the ones the pre-USD code path expects to find.
    op.execute(sa.text("DELETE FROM discounted_plan_cache WHERE currency <> 'INR'"))
    op.drop_constraint("uq_discounted_plan", "discounted_plan_cache", type_="unique")
    op.create_unique_constraint(
        "uq_discounted_plan",
        "discounted_plan_cache",
        ["base_plan_id", "billing_cycle", "discount_bps"],
    )
    op.drop_column("discounted_plan_cache", "currency")
