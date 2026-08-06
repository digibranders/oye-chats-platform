"""First-checkout idempotency markers + one ReferralConversion per client (Wave 1.4)

``clients.pending_checkout_*`` records the in-flight first-checkout Razorpay
subscription so a sequential re-submit reuses it instead of minting a second
authorizable mandate (the H1 pattern /resume and the upgrade path already use).

``referral_conversions`` gains a unique constraint on ``client_id``: the insert
moves from checkout-create to the ``subscription.charged`` webhook, which fires
on every cycle — the constraint is what makes replays and later cycles no-ops.
Pre-existing duplicates (the old checkout-time insert could double-fire before
the billing lock landed) are collapsed to the EARLIEST row, which carries the
original snapshot terms payouts were computed against.

Revision ID: c8f3e6b24a71
Revises: b7e2d5a91c34
Create Date: 2026-08-06
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "c8f3e6b24a71"
down_revision: str | Sequence[str] | None = "b7e2d5a91c34"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("clients", sa.Column("pending_checkout_subscription_id", sa.String(), nullable=True))
    op.add_column("clients", sa.Column("pending_checkout_plan_id", sa.Integer(), nullable=True))
    op.add_column("clients", sa.Column("pending_checkout_cycle", sa.String(length=8), nullable=True))
    op.add_column("clients", sa.Column("pending_checkout_at", sa.DateTime(timezone=True), nullable=True))

    # Collapse duplicates to the earliest (original-terms) row, then enforce.
    op.execute(
        """
        DELETE FROM referral_conversions rc
        USING referral_conversions keep
        WHERE keep.client_id = rc.client_id
          AND keep.id < rc.id
        """
    )
    op.create_unique_constraint("uq_referral_conversions_client", "referral_conversions", ["client_id"])


def downgrade() -> None:
    op.drop_constraint("uq_referral_conversions_client", "referral_conversions", type_="unique")
    op.drop_column("clients", "pending_checkout_at")
    op.drop_column("clients", "pending_checkout_cycle")
    op.drop_column("clients", "pending_checkout_plan_id")
    op.drop_column("clients", "pending_checkout_subscription_id")
