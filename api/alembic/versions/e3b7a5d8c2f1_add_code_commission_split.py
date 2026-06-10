"""Per-code commission split: my-commission + friends-reward.

Adds two columns to ``referral_codes``:

* ``affiliate_commission_bps`` — what the affiliate keeps (basis points)
* ``customer_discount_bps``    — what the referred customer gets

Both default to 0 (no payout — backward-compatible with v1 money-free
semantics). The application layer enforces
``affiliate_commission_bps + customer_discount_bps <= affiliates.commission_bps``
(the pool the super-admin sets per affiliate) — we don't do a multi-table
CHECK at the DB layer because Postgres can't express it cleanly.

Revision ID: e3b7a5d8c2f1
Revises: d5e8a2c4f7b9
Create Date: 2026-06-09
"""

import sqlalchemy as sa

from alembic import op

revision = "e3b7a5d8c2f1"
down_revision = "d5e8a2c4f7b9"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "referral_codes",
        sa.Column(
            "affiliate_commission_bps",
            sa.Integer(),
            nullable=False,
            server_default="0",
        ),
    )
    op.add_column(
        "referral_codes",
        sa.Column(
            "customer_discount_bps",
            sa.Integer(),
            nullable=False,
            server_default="0",
        ),
    )
    op.create_check_constraint(
        "chk_code_split_range",
        "referral_codes",
        "affiliate_commission_bps >= 0 AND affiliate_commission_bps <= 10000 "
        "AND customer_discount_bps >= 0 AND customer_discount_bps <= 10000 "
        "AND (affiliate_commission_bps + customer_discount_bps) <= 10000",
    )


def downgrade() -> None:
    op.drop_constraint("chk_code_split_range", "referral_codes", type_="check")
    op.drop_column("referral_codes", "customer_discount_bps")
    op.drop_column("referral_codes", "affiliate_commission_bps")
