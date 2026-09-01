"""Coupon redemption: a duration on the coupon, standing attribution on the client.

Coupons existed as a superadmin CRUD table with no redemption path, so checkout
refused every code it was given, valid ones included. These two columns are what
redemption needs:

``coupons.duration_months``
    How many billing months the discount covers. NULL means for the life of the
    subscription. Only meaningful at ``percent_off = 100``; the API refuses the
    other combination, because a partial discount that expires would have to move
    the subscription onto the full-price plan, and a plan change here costs the
    customer a mandate re-authorisation.

``clients.coupon_id`` / ``clients.coupon_attributed_at``
    Standing attribution, the coupon twin of ``referral_code_id``. The discount
    amount lives in the Razorpay plan the subscription runs on, so a later plan
    change needs to know a coupon was in force or it would re-mint at full price.

Revision ID: b1000001coupon
Revises: a0000000baseline
Create Date: 2026-09-01

"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision: str = "b1000001coupon"
down_revision: str | None = "a0000000baseline"
branch_labels: None = None
depends_on: None = None


def upgrade() -> None:
    op.add_column("coupons", sa.Column("duration_months", sa.Integer(), nullable=True))
    # A duration is a count of months, so zero and negatives are not a shorter
    # offer, they are a coupon that expires before it starts.
    op.create_check_constraint(
        "ck_coupons_duration_months_positive",
        "coupons",
        "duration_months IS NULL OR duration_months > 0",
    )
    # The combination the redemption path cannot honour without a re-auth. The
    # API refuses it too; this is the half that survives a bad backfill or a
    # hand-written UPDATE.
    op.create_check_constraint(
        "ck_coupons_duration_requires_full_discount",
        "coupons",
        "duration_months IS NULL OR percent_off = 100",
    )

    op.add_column("clients", sa.Column("coupon_id", sa.Integer(), nullable=True))
    op.add_column(
        "clients",
        sa.Column("coupon_attributed_at", sa.DateTime(timezone=True), nullable=True),
    )
    # SET NULL rather than CASCADE: deleting a spent campaign must not delete the
    # accounts that used it.
    op.create_foreign_key(
        "clients_coupon_id_fkey",
        "clients",
        "coupons",
        ["coupon_id"],
        ["id"],
        ondelete="SET NULL",
    )
    # Deliberately NO index. `referral_code_id`, the exact twin of this column,
    # carries none either, and `clients` indexes only api_key, email and the
    # gateway customer id. An index here would also have to be declared on the
    # model or `alembic check` reports it as drift on every run forever, and the
    # only question ever asked of the column is a rare superadmin "which accounts
    # are on this coupon" over one row per account.


def downgrade() -> None:
    op.drop_constraint("clients_coupon_id_fkey", "clients", type_="foreignkey")
    op.drop_column("clients", "coupon_attributed_at")
    op.drop_column("clients", "coupon_id")
    op.drop_constraint("ck_coupons_duration_requires_full_discount", "coupons", type_="check")
    op.drop_constraint("ck_coupons_duration_months_positive", "coupons", type_="check")
    op.drop_column("coupons", "duration_months")
