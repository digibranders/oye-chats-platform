"""invoice_emailed_at

Delivery marker for invoice emails (invoicing v2 Phase 6 review B1): the PDF
sweep auto-emails only when NULL, so a PDF regeneration never re-emails the
customer, and superadmin resends are recorded.

Revision ID: e8c4a6b2d9f1
Revises: d7b3f9e2c5a8
Create Date: 2026-07-02

"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "e8c4a6b2d9f1"
down_revision: str | Sequence[str] | None = "d7b3f9e2c5a8"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column("invoices", sa.Column("emailed_at", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column("invoices", "emailed_at")
