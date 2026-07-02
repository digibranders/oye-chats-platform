"""client_billing_tax_identity

Buyer-side tax identity for invoicing v2 (plan: docs/billing/
2026-07-02-invoicing-implementation-plan-v2.md Phase 1). All nullable —
capture is progressive (settings / checkout), never blocks signup.

Revision ID: b7e2d4f9a1c6
Revises: 5e5af3f3259d
Create Date: 2026-07-02

"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

from alembic import op

revision: str = "b7e2d4f9a1c6"
down_revision: str | Sequence[str] | None = "5e5af3f3259d"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column("clients", sa.Column("legal_name", sa.String(), nullable=True))
    op.add_column("clients", sa.Column("gstin", sa.String(15), nullable=True))
    op.add_column("clients", sa.Column("billing_address", JSONB(), nullable=True))
    op.add_column("clients", sa.Column("billing_country", sa.String(2), nullable=True))
    op.add_column("clients", sa.Column("billing_state_code", sa.String(2), nullable=True))
    op.add_column("clients", sa.Column("billing_email", sa.String(), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column("clients", "billing_email")
    op.drop_column("clients", "billing_state_code")
    op.drop_column("clients", "billing_country")
    op.drop_column("clients", "billing_address")
    op.drop_column("clients", "gstin")
    op.drop_column("clients", "legal_name")
