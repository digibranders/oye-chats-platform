"""subscription: pending-upgrade idempotency marker (finding D)

Adds upgrade_pending_subscription_id + upgrade_pending_plan_id so a sequential
double-submit of a paid→paid upgrade reuses the in-flight checkout instead of
minting a second Razorpay subscription (double first-cycle charge). See
transition_service.execute_paid_upgrade and
docs/billing/2026-07-11-billing-remediation-plan.md.

Revision ID: c2a7f4e91b83
Revises: b8f3d21a9c47
Create Date: 2026-07-11 11:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "c2a7f4e91b83"
down_revision: str | Sequence[str] | None = "b8f3d21a9c47"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column("subscriptions", sa.Column("upgrade_pending_subscription_id", sa.String(), nullable=True))
    op.add_column("subscriptions", sa.Column("upgrade_pending_plan_id", sa.Integer(), nullable=True))
    op.create_foreign_key(
        "fk_subscriptions_upgrade_pending_plan_id_plans",
        "subscriptions",
        "plans",
        ["upgrade_pending_plan_id"],
        ["id"],
        ondelete="SET NULL",
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_constraint("fk_subscriptions_upgrade_pending_plan_id_plans", "subscriptions", type_="foreignkey")
    op.drop_column("subscriptions", "upgrade_pending_plan_id")
    op.drop_column("subscriptions", "upgrade_pending_subscription_id")
