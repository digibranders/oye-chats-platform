"""remove_stripe_vestiges

Razorpay is the only payment provider. The Stripe integration code was removed
earlier; this drops the vestigial columns (all confirmed to have zero code
consumers) and flips the subscriptions.payment_provider default to 'razorpay'.
Existing row VALUES are left untouched (there should be none with 'stripe';
verify before deploying if in doubt — dropped column data is unrecoverable).

Revision ID: d7b3f9e2c5a8
Revises: c9f3e5a7b2d8
Create Date: 2026-07-02

"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "d7b3f9e2c5a8"
down_revision: str | Sequence[str] | None = "c9f3e5a7b2d8"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.drop_column("plans", "stripe_product_id")
    op.drop_column("plans", "stripe_monthly_price_id")
    op.drop_column("plans", "stripe_annual_price_id")
    op.drop_column("subscriptions", "stripe_subscription_id")
    op.drop_column("subscriptions", "stripe_customer_id")
    op.alter_column("subscriptions", "payment_provider", server_default="razorpay")
    op.drop_column("invoices", "stripe_invoice_id")
    op.drop_column("payment_methods", "stripe_payment_method_id")


def downgrade() -> None:
    """Downgrade schema (column data is not restored)."""
    op.add_column("payment_methods", sa.Column("stripe_payment_method_id", sa.String(), nullable=True))
    op.create_index(
        "ix_payment_methods_stripe_payment_method_id",
        "payment_methods",
        ["stripe_payment_method_id"],
        unique=True,
    )
    op.add_column("invoices", sa.Column("stripe_invoice_id", sa.String(), nullable=True))
    op.create_index("ix_invoices_stripe_invoice_id", "invoices", ["stripe_invoice_id"], unique=True)
    op.alter_column("subscriptions", "payment_provider", server_default="stripe")
    op.add_column("subscriptions", sa.Column("stripe_customer_id", sa.String(), nullable=True))
    op.create_index("ix_subscriptions_stripe_customer_id", "subscriptions", ["stripe_customer_id"])
    op.add_column("subscriptions", sa.Column("stripe_subscription_id", sa.String(), nullable=True))
    op.create_index(
        "ix_subscriptions_stripe_subscription_id",
        "subscriptions",
        ["stripe_subscription_id"],
        unique=True,
    )
    op.add_column("plans", sa.Column("stripe_annual_price_id", sa.String(), nullable=True))
    op.add_column("plans", sa.Column("stripe_monthly_price_id", sa.String(), nullable=True))
    op.add_column("plans", sa.Column("stripe_product_id", sa.String(), nullable=True))
