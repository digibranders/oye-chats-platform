"""subscription: seat_addon_pending_quantity (finding A)

Extra seats awaiting mandate authorization on a first seat purchase. Entitlement
(operator_quantity) is gated on the seat add-on's activated webhook so seats
never run free before Razorpay charges. See razorpay_service seat handlers and
docs/billing/2026-07-11-billing-remediation-plan.md.

Revision ID: e3c9a17f2b64
Revises: c2a7f4e91b83
Create Date: 2026-07-11 11:30:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "e3c9a17f2b64"
down_revision: str | Sequence[str] | None = "c2a7f4e91b83"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column("subscriptions", sa.Column("seat_addon_pending_quantity", sa.Integer(), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column("subscriptions", "seat_addon_pending_quantity")
