"""invoice_tax_document_columns

Invoicing v2 Phase 1: additive tax-document columns on ``invoices`` (existing
rows become invoice_type='legacy' via server default — INV-8/9/10 handling),
``invoice_counters`` for gapless per-FY numbering, and currency default
'usd'->'inr' (INV-10). Plan: docs/billing/2026-07-02-invoicing-implementation-plan-v2.md.

Revision ID: c9f3e5a7b2d8
Revises: b7e2d4f9a1c6
Create Date: 2026-07-02

"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

from alembic import op

revision: str = "c9f3e5a7b2d8"
down_revision: str | Sequence[str] | None = "b7e2d4f9a1c6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column("invoices", sa.Column("invoice_number", sa.String(20), nullable=True))
    op.create_index("ix_invoices_invoice_number", "invoices", ["invoice_number"], unique=True)
    op.add_column("invoices", sa.Column("invoice_type", sa.String(), nullable=False, server_default="legacy"))
    op.add_column("invoices", sa.Column("issued_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("invoices", sa.Column("seller_snapshot", JSONB(), nullable=True))
    op.add_column("invoices", sa.Column("buyer_snapshot", JSONB(), nullable=True))
    op.add_column("invoices", sa.Column("place_of_supply", sa.String(2), nullable=True))
    op.add_column("invoices", sa.Column("supply_kind", sa.String(), nullable=True))
    op.add_column("invoices", sa.Column("taxable_value_minor", sa.Integer(), nullable=True))
    op.add_column("invoices", sa.Column("tax_rate_bps", sa.Integer(), nullable=True))
    op.add_column("invoices", sa.Column("cgst_minor", sa.Integer(), nullable=True))
    op.add_column("invoices", sa.Column("sgst_minor", sa.Integer(), nullable=True))
    op.add_column("invoices", sa.Column("igst_minor", sa.Integer(), nullable=True))
    op.add_column("invoices", sa.Column("total_tax_minor", sa.Integer(), nullable=True))
    op.add_column("invoices", sa.Column("hsn_sac", sa.String(8), nullable=True))
    op.add_column("invoices", sa.Column("is_export", sa.Boolean(), nullable=False, server_default="false"))
    op.add_column("invoices", sa.Column("line_items", JSONB(), nullable=True))
    op.add_column(
        "invoices",
        sa.Column("credit_note_of_id", sa.Integer(), sa.ForeignKey("invoices.id", ondelete="SET NULL"), nullable=True),
    )
    op.add_column("invoices", sa.Column("razorpay_invoice_id", sa.String(), nullable=True))
    op.create_index("ix_invoices_razorpay_invoice_id", "invoices", ["razorpay_invoice_id"])
    op.add_column("invoices", sa.Column("irn", sa.String(), nullable=True))
    op.add_column("invoices", sa.Column("signed_qr", sa.Text(), nullable=True))
    op.alter_column("invoices", "currency", server_default="inr")

    op.create_table(
        "invoice_counters",
        sa.Column("financial_year", sa.String(5), primary_key=True),
        sa.Column("prefix", sa.String(3), primary_key=True),
        sa.Column("last_serial", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_table("invoice_counters")
    op.alter_column("invoices", "currency", server_default="usd")
    op.drop_column("invoices", "signed_qr")
    op.drop_column("invoices", "irn")
    op.drop_index("ix_invoices_razorpay_invoice_id", table_name="invoices")
    op.drop_column("invoices", "razorpay_invoice_id")
    op.drop_column("invoices", "credit_note_of_id")
    op.drop_column("invoices", "line_items")
    op.drop_column("invoices", "is_export")
    op.drop_column("invoices", "hsn_sac")
    op.drop_column("invoices", "total_tax_minor")
    op.drop_column("invoices", "igst_minor")
    op.drop_column("invoices", "sgst_minor")
    op.drop_column("invoices", "cgst_minor")
    op.drop_column("invoices", "tax_rate_bps")
    op.drop_column("invoices", "taxable_value_minor")
    op.drop_column("invoices", "supply_kind")
    op.drop_column("invoices", "place_of_supply")
    op.drop_column("invoices", "buyer_snapshot")
    op.drop_column("invoices", "seller_snapshot")
    op.drop_column("invoices", "issued_at")
    op.drop_column("invoices", "invoice_type")
    op.drop_index("ix_invoices_invoice_number", table_name="invoices")
    op.drop_column("invoices", "invoice_number")
