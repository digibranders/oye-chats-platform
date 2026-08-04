"""invoice FX / INR mirror columns

Adds the INR mirror a non-INR (export) invoice needs in order to be a GST
document at all:

    inr_amount_minor         Razorpay ``base_amount`` verbatim (paise)
    inr_taxable_value_minor  taxable value converted at the recorded rate
    inr_total_tax_minor      IGST in rupees (0 for a zero-rated LUT export)
    fx_rate_micros           INR per one foreign unit, x1e6, integer
    fx_rate_source           provenance, e.g. "razorpay_base_amount"

The document is issued in the currency of supply, but GSTR-1 Table 6A reports
exports in rupees and IGST on a non-LUT export is remitted in rupees, so the
rate used has to live on the document — Rule 34(2) makes it the GAAP rate at
the time of supply, and an assessing officer must be able to reproduce the
arithmetic years after the FX market has moved.

``fx_rate_micros`` is BIGINT: at 1e6 micros a rate only needs ~28 bits today,
but INTEGER would cap the column at ~2,147 INR per unit, which is a silly place
to put a ceiling on a currency column.

Additive, nullable, backfill-free. Existing rows are INR, where
``amount_cents`` / ``taxable_value_minor`` are already the reportable figures
and the mirror is meaningless — NULL is the correct value, not zero. Historical
non-INR rows are legacy (never finalized, because finalize refused non-INR
before this change); the self-heal sweep re-finalizes them once deployed, and
those without a captured ``base_amount`` stay legacy and surface as an
anomaly rather than being numbered off a guessed rate.

Revision ID: a71d9f4e5c38
Revises: c96e2d24b7b4
Create Date: 2026-08-04
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "a71d9f4e5c38"
down_revision: str | Sequence[str] | None = "c96e2d24b7b4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("invoices", sa.Column("inr_amount_minor", sa.Integer(), nullable=True))
    op.add_column("invoices", sa.Column("inr_taxable_value_minor", sa.Integer(), nullable=True))
    op.add_column("invoices", sa.Column("inr_total_tax_minor", sa.Integer(), nullable=True))
    op.add_column("invoices", sa.Column("fx_rate_micros", sa.BigInteger(), nullable=True))
    op.add_column("invoices", sa.Column("fx_rate_source", sa.String(length=32), nullable=True))


def downgrade() -> None:
    op.drop_column("invoices", "fx_rate_source")
    op.drop_column("invoices", "fx_rate_micros")
    op.drop_column("invoices", "inr_total_tax_minor")
    op.drop_column("invoices", "inr_taxable_value_minor")
    op.drop_column("invoices", "inr_amount_minor")
