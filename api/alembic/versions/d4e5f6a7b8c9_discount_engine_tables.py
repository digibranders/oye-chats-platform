"""Discount engine tables: discounted_plan_cache, referral_conversions.

Adds the two tables that power the affiliate/coupon discount engine:

* ``discounted_plan_cache`` — dedup cache for API-created discounted Razorpay
  plans. Key: (base_plan_id, billing_cycle, discount_bps). The same discount
  on the same plan+cycle always reuses one Razorpay plan object, shared across
  all customers and affiliates (~100 plans max even at millions of users).

* ``referral_conversions`` — immutable snapshot of commission + discount terms
  at the moment a referral converts to a paid subscription. Editing a code's
  percentages later never retroactively changes historical payouts.

Also adds ``subscriptions.razorpay_billing_plan_id`` — the Razorpay plan
actually billed (discounted or base). Entitlements still follow
``subscriptions.plan_id`` (always the base plan).

Revision ID: d4e5f6a7b8c9
Revises: b1c2d3e4f5a6
Create Date: 2026-06-26
"""

import sqlalchemy as sa

from alembic import op

revision = "d4e5f6a7b8c9"
down_revision = "b1c2d3e4f5a6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "discounted_plan_cache",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column(
            "base_plan_id",
            sa.Integer(),
            sa.ForeignKey("plans.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("billing_cycle", sa.String(), nullable=False),
        sa.Column("discount_bps", sa.Integer(), nullable=False),
        sa.Column("razorpay_plan_id", sa.String(), nullable=False),
        sa.Column("amount_paise", sa.Integer(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
        ),
        sa.UniqueConstraint(
            "base_plan_id",
            "billing_cycle",
            "discount_bps",
            name="uq_discounted_plan",
        ),
        sa.CheckConstraint(
            "discount_bps > 0 AND discount_bps < 10000",
            name="chk_discount_bps_range",
        ),
    )

    op.create_table(
        "referral_conversions",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column(
            "client_id",
            sa.Integer(),
            sa.ForeignKey("clients.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "referral_code_id",
            sa.Integer(),
            sa.ForeignKey("referral_codes.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "affiliate_id",
            sa.Integer(),
            sa.ForeignKey("affiliates.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("commission_bps", sa.Integer(), nullable=False),
        sa.Column("customer_discount_bps", sa.Integer(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
        ),
    )
    op.create_index(
        "ix_referral_conversions_client_id",
        "referral_conversions",
        ["client_id"],
    )

    op.add_column(
        "subscriptions",
        sa.Column("razorpay_billing_plan_id", sa.String(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("subscriptions", "razorpay_billing_plan_id")
    op.drop_index("ix_referral_conversions_client_id", table_name="referral_conversions")
    op.drop_table("referral_conversions")
    op.drop_table("discounted_plan_cache")
