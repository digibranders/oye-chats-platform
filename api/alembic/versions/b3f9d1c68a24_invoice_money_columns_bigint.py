"""Invoice money columns Integer→BigInteger (L-4)

Invoice amounts are stored in minor units (paise/cents); int32 caps a single
document at ₹2.14 crore. Ordinary SaaS charges never get close, but the INR
mirror columns multiply through FX rates and a future enterprise/annual
consolidated document should not be one overflow away from a failed webhook.
Widening now is a table rewrite measured in milliseconds (the table is small);
widening after the first overflow is an incident. Plan price columns stay
int32 — they are operator-entered configuration with natural bounds.

Revision ID: b3f9d1c68a24
Revises: a6d2e8f95c47
Create Date: 2026-08-06
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "b3f9d1c68a24"
down_revision: str | Sequence[str] | None = "a6d2e8f95c47"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_MONEY_COLUMNS = (
    "amount_cents",
    "refunded_minor",
    "taxable_value_minor",
    "cgst_minor",
    "sgst_minor",
    "igst_minor",
    "total_tax_minor",
    "inr_amount_minor",
    "inr_taxable_value_minor",
    "inr_total_tax_minor",
)


def upgrade() -> None:
    for column in _MONEY_COLUMNS:
        op.alter_column("invoices", column, type_=sa.BigInteger(), existing_nullable=True)


def downgrade() -> None:
    for column in _MONEY_COLUMNS:
        op.alter_column("invoices", column, type_=sa.Integer(), existing_nullable=True)
